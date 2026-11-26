/**
 * A minimal Supabase Realtime (Phoenix channel) client for broadcast topics: enough to receive the
 * sealed login from the browser and to hand canvas operations to the user's open canvas window.
 * Native WebSocket only.
 */

type Message = { topic: string; event: string; payload: any; ref: string | null };

export class Realtime {
	private ws!: WebSocket;
	private ref = 0;
	private listeners = new Set<(m: Message) => void>();
	private heartbeat?: ReturnType<typeof setInterval>;
	private joined = new Map<string, string>();
	private url: string;
	private key: string;
	private token?: string;

	constructor(url: string, key: string, token?: string) {
		this.url = url;
		this.key = key;
		this.token = token;
	}

	async connect(): Promise<void> {
		const ws = `${this.url.replace(/^http/, "ws").replace(/\/$/, "")}/realtime/v1/websocket?apikey=${encodeURIComponent(this.key)}&vsn=1.0.0`;
		await new Promise<void>((resolve, reject) => {
			this.ws = new WebSocket(ws);
			const timer = setTimeout(() => reject(new Error("Realtime connection timed out")), 15_000);
			this.ws.onopen = () => {
				clearTimeout(timer);
				this.heartbeat = setInterval(() => this.push("phoenix", "heartbeat", {}), 25_000);
				resolve();
			};
			this.ws.onerror = () => {
				clearTimeout(timer);
				reject(new Error("Realtime connection failed"));
			};
			this.ws.onmessage = (e) => {
				let m: Message;
				try {
					m = JSON.parse(String(e.data));
				} catch {
					return;
				}
				for (const l of this.listeners) l(m);
			};
			this.ws.onclose = () => {
				if (this.heartbeat) clearInterval(this.heartbeat);
			};
		});
	}

	private push(topic: string, event: string, payload: unknown, ref = String(++this.ref), joinRef: string | null = null) {
		if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ topic, event, payload, ref, join_ref: joinRef }));
		return ref;
	}

	async join(topic: string): Promise<void> {
		const full = `realtime:${topic}`;
		const ref = String(++this.ref);
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.listeners.delete(onReply);
				reject(new Error(`Joining ${topic} timed out`));
			}, 15_000);
			const onReply = (m: Message) => {
				if (m.ref !== ref || m.event !== "phx_reply") return;
				clearTimeout(timer);
				this.listeners.delete(onReply);
				if (m.payload?.status === "ok") resolve();
				else reject(new Error(`Joining ${topic} was refused`));
			};
			this.listeners.add(onReply);
			this.push(
				full,
				"phx_join",
				{ config: { broadcast: { self: false }, presence: { key: "" }, postgres_changes: [], private: false }, ...(this.token ? { access_token: this.token } : {}) },
				ref,
				ref,
			);
		});
		this.joined.set(full, ref);
	}

	broadcast(topic: string, event: string, payload: unknown) {
		const full = `realtime:${topic}`;
		this.push(full, "broadcast", { type: "broadcast", event, payload }, undefined, this.joined.get(full) ?? null);
	}

	/** Calls back on every broadcast `event` on `topic`; returns an unsubscribe function. */
	on(topic: string, event: string, cb: (payload: any) => void): () => void {
		const full = `realtime:${topic}`;
		const l = (m: Message) => {
			if (m.topic === full && m.event === "broadcast" && m.payload?.event === event) cb(m.payload.payload);
		};
		this.listeners.add(l);
		return () => this.listeners.delete(l);
	}

	close() {
		if (this.heartbeat) clearInterval(this.heartbeat);
		try {
			this.ws.close();
		} catch {}
	}
}

// ---------- sealed login (ECDH P-256 + AES-GCM, the browser's cli-handshake.ts sealForCli) ----------

export const b64url = (bytes: ArrayBuffer | Uint8Array) => Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString("base64url");
const fromB64url = (text: string) => new Uint8Array(Buffer.from(text, "base64url"));

export async function loginKeys() {
	const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
	const publicKey = b64url(await crypto.subtle.exportKey("raw", pair.publicKey));
	return { privateKey: pair.privateKey, publicKey };
}

/** Opens the browser's sealed session; also returns the shared key, which signs the acknowledgement. */
export async function openSealed(privateKey: CryptoKey, code: string, sealed: { epk: string; iv: string; ct: string }): Promise<{ message: unknown; key: CryptoKey }> {
	const sender = await crypto.subtle.importKey("raw", fromB64url(sealed.epk), { name: "ECDH", namedCurve: "P-256" }, false, []);
	// HKDF-SHA-256 over the ECDH secret, bound to this login's code (the page's cli-handshake.ts relayKey).
	const material = await crypto.subtle.importKey("raw", await crypto.subtle.deriveBits({ name: "ECDH", public: sender }, privateKey, 256), "HKDF", false, ["deriveKey"]);
	const key = await crypto.subtle.deriveKey(
		{ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode(`flowith-cli-login:${code}`) },
		material,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt", "decrypt"],
	);
	const plain = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv: fromB64url(sealed.iv), additionalData: new TextEncoder().encode(code) },
		key,
		fromB64url(sealed.ct),
	);
	return { message: JSON.parse(new TextDecoder().decode(plain)), key };
}

/** "ack:<nonce>" under the shared key: the page believes the login only when this CLI really opened it. */
export async function ackProof(key: CryptoKey, code: string, nonce: string) {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(`${code}:ack`) }, key, new TextEncoder().encode(`ack:${nonce}`));
	return { iv: b64url(iv), ct: b64url(ct) };
}

/** A one-time login code in letters and digits that don't look alike; its first six are what the user types. */
export function loginCode(length = 24) {
	const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
	return Array.from(crypto.getRandomValues(new Uint8Array(length)), (b) => alphabet[b % alphabet.length]).join("");
}

// ---------- the agent key (canvas operations, hypergpt-frontend canvas-bot/agent-keys.ts) ----------

const aesKey = (key: string) => crypto.subtle.importKey("raw", fromB64url(key), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);

export async function sealWith(key: string, context: string, message: unknown) {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(context) }, await aesKey(key), new TextEncoder().encode(JSON.stringify(message)));
	return { iv: b64url(iv), ct: b64url(ct) };
}

export async function openWith<T>(key: string, context: string, sealed: { iv?: string; ct?: string } | undefined): Promise<T | null> {
	if (!sealed?.iv || !sealed.ct) return null;
	try {
		const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64url(sealed.iv), additionalData: new TextEncoder().encode(context) }, await aesKey(key), fromB64url(sealed.ct));
		return JSON.parse(new TextDecoder().decode(plain)) as T;
	} catch {
		return null;
	}
}

/** What the browser shows on its connect page for this code (cli-handshake.ts cliVerificationCode). */
export const verificationCode = (code: string) => {
	const head = code.replace(/[^A-Za-z0-9]/g, "").slice(0, 6).toUpperCase();
	return `${head.slice(0, 3)}-${head.slice(3)}`;
};
