/**
 * A stand-in Flowith (Supabase auth + PostgREST + worker) for running the real CLI end to end in tests: it serves a
 * small canvas and catalogue, records every request, and answers generation calls as each test says.
 */
import { copyFileSync, mkdtempSync, writeFileSync } from "fs";
import { isDeepStrictEqual } from "node:util";
import { tmpdir } from "os";
import { join } from "path";
import { b64url, openWith, sealWith } from "../lib/realtime.ts";

/**
 * The runtime the real CLI runs under in these tests: Bun by default, `CW_TEST_RUNTIME=node` for Node
 * (`node scripts/index.ts`, type stripping), so the suite proves both.
 */
export const RUNTIME = process.env.CW_TEST_RUNTIME || "bun";
export const cliCommand = (...args: string[]) => [RUNTIME, join(import.meta.dir, "..", "index.ts"), ...args];

export const USER = "11111111-1111-4111-8111-111111111111";
export const CONV = "22222222-2222-4222-8222-222222222222";
const agentKey = b64url(crypto.getRandomValues(new Uint8Array(32)));
export const ids = {
	group: "a0000000-0000-4000-8000-000000000001",
	image: "a1000000-0000-4000-8000-000000000002",
	running: "a2000000-0000-4000-8000-000000000003",
	failed: "a3000000-0000-4000-8000-000000000004",
	video: "a4000000-0000-4000-8000-000000000005",
	text: "a5000000-0000-4000-8000-000000000006",
	finishedAgent: "a6000000-0000-4000-8000-000000000007",
};

const imageRequest = { kind: "image", body: { target_feature: "image_generation", model: "z-image-turbo", messages: [{ role: "user", content: "a cat" }] } };
const at = "2026-11-17T00:00:00.000Z";
const row = (id: string, type: string, data: Record<string, unknown>, x = 0, y = 0, width = 384, height = 384) => ({
	id, conv_id: CONV, type, p_id: CONV, position: { x, y }, width, height, data, created_at: at, prompt: null,
});

export function canvasRows() {
	return [
		row(ids.group, "11", { name: "Group" }, 2000, 0, 464, 560),
		row(ids.image, "2", { isImage: true, mode: "image_generation", value: "https://cdn.test/a.png", status: "finished", model: "z-image-turbo", title: "Cat", aspect_ratio: "1:1" }, 0, 0),
		row(ids.running, "2", { isImage: true, mode: "image_generation", value: "", status: "running", model: "z-image-turbo", title: "Running", madeBy: "claude-code", agentRequest: imageRequest }, 500, 0),
		row(ids.failed, "2", { isImage: true, mode: "image_generation", value: "", status: "failed", error: "provider_error", model: "z-image-turbo", title: "Failed", madeBy: "claude-code", agentRequest: imageRequest }, 1000, 0),
		row(ids.video, "13", { videoId: "https://cdn.test/v.mp4", status: "finished", model: "seedance-2.5-flash", title: "Clip", aspect_ratio: "16:9", duration: 5 }, 0, 600, 384, 216),
		row(ids.text, "2", { value: "hello there", mode: "text", status: "finished", title: "Note", tag: { text: "User Upload" } }, 500, 600, 384, 520),
		row(ids.finishedAgent, "2", { isImage: true, mode: "image_generation", value: "https://cdn.test/b.png", status: "finished", model: "z-image-turbo", title: "Done", madeBy: "claude-code", agentRequest: imageRequest }, 1500, 0),
	];
}

export const catalog = {
	"z-image-turbo": { media: "image", title: "Z Image Turbo", consume_num: 5, price: { completion: 5000, prompt: 0 }, supportedAspectRatios: ["1:1", "16:9"], supportsImageInput: true },
	"unpriced-image": { media: "image", title: "Unpriced Image", supportedAspectRatios: ["1:1"] },
	"seedance-2.5-flash": {
		media: "video", title: "Seedance 2.5 Flash", supportedDurations: ["-1", "4", "5", "10"], supportedResolutions: ["480p", "720p"],
		supportedAspectRatios: ["adaptive", "16:9", "9:16", "1:1"], pricePerSecond: { audioOff: 80704, audioOn: 80704 }, price: { completion: 403520, prompt: 0 },
		estimatedPricePer5s: 406.88, supportsAudio: true, supportsMultimodalRef: true, supportsFirstFrame: true,
	},
	"seedance-2.5": {
		media: "video", title: "Seedance 2.5", supportedDurations: ["-1", "4", "5", "10"], supportedResolutions: ["480p", "720p", "1080p"],
		supportedAspectRatios: ["adaptive", "16:9", "9:16", "1:1"], pricePerSecond: { audioOff: 123600, audioOn: 123600 }, price: { completion: 616800, prompt: 0 },
		estimatedPricePer5s: 621.944, supportsAudio: true, supportsMultimodalRef: true, supportsFirstFrame: true,
	},
	"kling-video/v4": {
		media: "video", title: "Kling 4.0", supportedDurations: ["3", "5", "10"], supportedResolutions: ["720p", "1080p"], supportedAspectRatios: ["16:9", "9:16", "1:1"],
		pricePerSecond: { audioOff: 305500, audioOn: 305500 }, pricePerSecondByResolution: { "720p": { audioOff: 204100, audioOn: 204100 }, "1080p": { audioOff: 305500, audioOn: 305500 } },
		price: { completion: 1527500, prompt: 0 }, supportsMultimodalRef: true, supportsFirstFrame: true,
		referenceAssetLimits: { total: 15, image: 10, video: 5, audio: 0 },
	},
	"muse-video": { media: "video", title: "Muse Video", supportedDurations: ["5"], supportedResolutions: ["720p"], supportedAspectRatios: ["16:9"], pricePerSecond: { audioOff: 3000, audioOn: 3000 }, price: { completion: 15000, prompt: 0 } },
	"gemini-3.8-flash": { media: "text", title: "Gemini 3.8 Flash", price: { prompt: 1, completion: 4 } },
	"elevenlabs-v3": { media: "tool", title: "ElevenLabs v3", audioPricing: { credits: 100, per: "1k_chars" } },
	"suno-chirp-v6": { media: "tool", title: "Suno v6", audioPricing: { credits: 120, per: "song" } },
};

/**
 * The worker's own clip price (flo-workers calculateVideoPrice, dev 8ccc1028) for the stand-in /video/price:
 * Seedance by tokens (width × height × (24 s + 1) / 1024, ceiled) at its rate per resolution; 422 for a source clip
 * the worker would measure.
 */
const SEEDANCE_RATES: Record<string, Record<string, number>> = {
	"seedance-2.5-flash": { base: 8.4 },
	"seedance-2.5": { base: 12.84, "1080p": 14.04 },
};
const PIXELS: Record<string, Record<string, [number, number]>> = {
	"480p": { "16:9": [854, 480] },
	"720p": { "16:9": [1280, 720], "9:16": [720, 1280] },
	"1080p": { "16:9": [1920, 1080] },
};
export function workerVideoPrice(input: any, model: string): number | undefined {
	if (input.video_urls?.length && model.startsWith("kling")) return undefined;
	const rates = SEEDANCE_RATES[model];
	if (!rates) return undefined;
	const [w, h] = PIXELS[input.resolution ?? "720p"]![input.aspect_ratio ?? "16:9"] ?? PIXELS["720p"]!["16:9"]!;
	const tokens = Math.ceil((w * h * (Number(input.duration ?? 5) * 24 + 1)) / 1024);
	return (tokens * (rates[input.resolution] ?? rates.base!)) / 1000;
}

export interface Recorded {
	method: string;
	path: string;
	body: unknown;
}

export interface UsageRecord {
	model: string;
	req_id: string;
	tokens_used: number;
	billing_unit_price: number | null;
	created_at: string;
	conv_id: string;
	reason?: string | null;
}

export interface FakeOptions {
	/** The responding canvas window; omitted to leave the command unanswered. */
	browser?: (command: Record<string, unknown>) => { ack?: boolean; result?: Record<string, unknown> };
	/**
	 * How a generation submit is answered: ok; an HTTP refusal; the gateway giving up on the worker (504); or the
	 * connection breaking off mid-answer (the CLI sees a network error).
	 */
	submit?: "ok" | "drop" | "reset" | { status: number; body: unknown };
	/** Usage records the canvas has (they may be added while a test runs). */
	usage?: UsageRecord[];
	/** A usage record the worker writes when a submit is accepted (the precharge). */
	precharge?: (model: string) => UsageRecord | undefined;
	/** Supabase's answer about the sign-in (403: it was ended, e.g. a Disconnect in Flowith). */
	userStatus?: number;
	/** false: the worker doesn't know this login as an agent sign-in (an older page gave the browser's own). */
	agentSession?: boolean;
	/** A team canvas (its charges go to the team's payer, out of the user's sight). */
	team?: boolean;
	/** false: a submitted card stays generating (the worker hasn't written its result yet). */
	finish?: boolean;
	/**
	 * A retry's claim (a PATCH conditioned on the retry mark) gets no answer (504): "drop" after it was made,
	 * "drop-unmade" without it having been made.
	 */
	claimAnswer?: "drop" | "drop-unmade";
	/** The user may read the canvas but not change it (row-level security): every PATCH changes nothing. */
	readOnly?: boolean;
	/** Only these cards may not be changed (row-level security on some rows). */
	readOnlyIds?: string[];
	/** Pause a read of cards after its answer is made (it answers with the cards as they were), or a PATCH before it applies. */
	afterNodeRead?: () => Promise<void>;
	beforeNodePatch?: () => Promise<void>;
	/** Reads of cards fail with this status. */
	nodeReadStatus?: number;
	/** PATCHes of cards are refused with this status, changing nothing. */
	patchStatus?: number;
	/** A PATCH of cards is made, but its answer never comes back (504). */
	dropPatchReply?: boolean;
}

/** A filter the stand-in doesn't know fails the test instead of passing every row. */
function unsupported(key: string, cond: string): never {
	throw new Error(`fake PostgREST: unsupported filter ${key}=${cond}`);
}

/** Whether a row passes PostgREST filters (`col=eq.v`, `is.null`, `in.(…)`, `not.is.true`; `data->>key` reads data). */
function passes(row: Record<string, any>, params: URLSearchParams) {
	for (const [key, cond] of params) {
		if (["select", "order", "limit", "offset"].includes(key)) continue;
		// The whole data compared as jsonb (key order doesn't matter).
		if (key === "data") {
			if (cond === "is.null" ? row.data !== null && row.data !== undefined : !cond.startsWith("eq.") ? unsupported(key, cond) : !isDeepStrictEqual(row.data, JSON.parse(cond.slice(3)))) return false;
			continue;
		}
		const json = /^data->>(.+)$/.exec(key);
		const raw = json ? row.data?.[json[1]!] : row[key];
		const value = raw === undefined || raw === null ? null : typeof raw === "object" ? JSON.stringify(raw) : String(raw);
		if (cond === "is.null" ? value !== null
			: cond === "not.is.true" ? value === "true"
			: cond.startsWith("eq.") ? value !== cond.slice(3)
			: cond.startsWith("neq.") ? value === null || value === cond.slice(4)
			: cond.startsWith("in.(") ? !cond.slice(4, -1).split(",").includes(value ?? "")
			: unsupported(key, cond)) return false;
	}
	return true;
}

/** A precharge record as the worker writes it when it takes a request: now, under a fresh attempt id. */
export const precharge = (credits: number) => (model: string): UsageRecord => ({
	model, req_id: crypto.randomUUID(), tokens_used: credits * 1000, billing_unit_price: null, created_at: new Date().toISOString(), conv_id: CONV,
});

export function fakeFlowith(opts: FakeOptions = {}) {
	const requests: Recorded[] = [];
	const rows = canvasRows();
	const usage = opts.usage ?? [];
	const hangUp = Bun.listen({ hostname: "localhost", port: 0, socket: { open: (socket) => void socket.end(), data: () => {} } });
	const holds: Array<{ match: (method: string, url: URL) => boolean; arrive: () => void; gate: Promise<void>; taken?: boolean }> = [];
	/**
	 * Holds back the answer to the next request that matches: it is made when the request arrives (so a read answers
	 * with the canvas as it was then) and delivered on release — a slow network, as the CLI meets it.
	 */
	const hold = (match: (method: string, url: URL) => boolean) => {
		let arrive!: () => void;
		let release!: () => void;
		const arrived = new Promise<void>((r) => (arrive = r));
		holds.push({ match, arrive, gate: new Promise<void>((r) => (release = r)) });
		return { arrived, release };
	};
	let title = "Test canvas";
	const server = Bun.serve<undefined>({
		hostname: "localhost",
		port: 0,
		async fetch(req, server) {
			const url = new URL(req.url);
			if (url.pathname === "/realtime/v1/websocket" && server.upgrade(req)) return;
			const body = req.method === "GET" ? undefined : await req.text().then((t) => { try { return JSON.parse(t); } catch { return t; } });
			requests.push({ method: req.method, path: url.pathname + url.search, body });
			const answer = await handle(req, url, body);
			const held = holds.find((h) => !h.taken && h.match(req.method, url));
			if (held) {
				held.taken = true;
				held.arrive();
				await held.gate;
			}
			return answer;
		},
		websocket: {
			async message(ws, raw) {
				const { topic, event, payload, ref } = JSON.parse(String(raw));
				if (event === "phx_join") {
					ws.subscribe(topic);
					ws.send(JSON.stringify({ topic, ref, event: "phx_reply", payload: { status: "ok" } }));
					return;
				}
				// Broadcasts reach every other socket on the topic (as Realtime's `self: false`): the login relay.
				if (event === "broadcast" && payload?.event !== "bot_action") {
					ws.publish(topic, String(raw));
					return;
				}
				if (payload?.event !== "bot_action" || !opts.browser) return;
				const { sessionId, actionId, sealed } = payload.payload;
				const context = `${sessionId}:${actionId}`;
				const opened = await openWith<{ command: Record<string, unknown> }>(agentKey, context, sealed);
				if (!opened) return;
				const { command } = opened;
				const { ack, result } = opts.browser(command);
				const respond = (response: Record<string, unknown>) => ws.send(JSON.stringify({ topic, event: "broadcast", payload: { event: "bot_response", payload: { actionId, ...response } } }));
				if (ack) respond({ type: "ack" });
				if (result) respond({ type: "result", sealed: await sealWith(agentKey, `${context}:result`, { operationId: command.operationId, ...result }) });
			},
		},
	});
	async function handle(req: Request, url: URL, body: unknown): Promise<Response> {
			const p = url.pathname;
			if (p === "/auth/v1/user") return Response.json(opts.userStatus && opts.userStatus !== 200 ? { error_code: "session_not_found" } : { id: USER }, { status: opts.userStatus ?? 200 });
			if (p === "/auth/v1/logout") return new Response(null, { status: 204 });
			if (p === "/auth/v1/token") return Response.json({ access_token: jwt(), refresh_token: "r2", expires_in: 3600 });
			if (p === "/models") return Response.json(catalog);
			if (p.startsWith("/rest/v1/conversation")) {
				if (req.method !== "GET" && body && typeof body === "object" && "title" in body && typeof body.title === "string") title = body.title;
				return Response.json([{ id: CONV, title, updated_at: at, metadata: {}, team_id: opts.team ? "33333333-3333-4333-8333-333333333333" : null }]);
			}
			if (p.startsWith("/rest/v1/flow_node")) {
				if (req.method === "GET") {
					if (opts.nodeReadStatus) return new Response("read unavailable", { status: opts.nodeReadStatus });
					const offset = Number(url.searchParams.get("offset") ?? 0);
					const limit = Number(url.searchParams.get("limit") ?? rows.length);
					const matches = rows.filter((r) => passes(r, url.searchParams));
					const snapshot = Response.json(matches.slice(offset, offset + limit));
					await opts.afterNodeRead?.();
					return snapshot;
				}
				// Placed cards are kept (and read back) like the real table; a PATCH changes the card it names.
				if (req.method === "POST") {
					const placed = (Array.isArray(body) ? body : [body]).map((b: any) => ({ ...row(b.id, b.type ?? "2", {}), ...b, created_at: b.created_at ?? new Date().toISOString() }));
					rows.push(...placed);
					return Response.json(placed);
				}
				// Only the rows every filter passes are changed, in one step (as PostgreSQL's UPDATE … WHERE).
				await opts.beforeNodePatch?.();
				if (opts.patchStatus) return Response.json({ message: "patch refused" }, { status: opts.patchStatus });
				if (opts.readOnly) return Response.json([]);
				if (opts.claimAnswer === "drop-unmade" && url.searchParams.has("data->>agentAttempt")) return new Response("upstream timed out", { status: 504 });
				const hit = rows.filter((r) => passes(r, url.searchParams) && !opts.readOnlyIds?.includes(r.id));
				for (const r of hit) Object.assign(r, structuredClone(body));
				if ((opts.claimAnswer === "drop" && url.searchParams.has("data->>agentAttempt")) || opts.dropPatchReply) return new Response("upstream timed out", { status: 504 });
				return Response.json(hit);
			}
			if (p === "/user/model-usage/group-records") return Response.json({ success: true, data: usage });
			if (p === "/video/price") {
				const credits = workerVideoPrice((body as any)?.input ?? {}, String((body as any)?.model));
				return credits === undefined ? Response.json({ reason: "priced_on_submit" }, { status: 422 }) : Response.json({ credits });
			}
			if (p === "/user/agent-session/end") {
				const asked = ((body as any)?.sessionIds ?? []) as string[];
				return Response.json(opts.agentSession === false ? { ended: [], refused: asked } : { ended: asked, refused: [] });
			}
			if (p === "/user/credits") return Response.json([]);
			if (["/image_gen/async", "/video/async", "/completion/async"].includes(p)) {
				const submit = opts.submit ?? "ok";
				if (submit === "reset") {
					const pre = opts.precharge?.(String((body as any)?.model));
					if (pre) usage.unshift(pre);
					// Sent on to a socket that hangs up: the CLI's fetch fails with a network error, no answer at all.
					return new Response(null, { status: 307, headers: { location: `http://localhost:${hangUp.port}/` } });
				}
				if (submit === "drop") {
					const pre = opts.precharge?.(String((body as any)?.model));
					if (pre) usage.unshift(pre);
					// The worker's answer never reaches the CLI: the gateway answers for it.
					return new Response("upstream timed out", { status: 504 });
				}
				if (submit !== "ok") return Response.json(submit.body, { status: submit.status });
				const pre = opts.precharge?.(String((body as any)?.model));
				if (pre) usage.unshift(pre);
				// The result lands on the card a moment later, as the worker's workflow writes it.
				const card = opts.finish === false ? undefined : rows.find((r) => r.id === (body as any)?.nodeId);
				if (card) setTimeout(() => Object.assign(card.data, p === "/video/async" ? { status: "finished", videoId: "https://cdn.test/new.mp4" } : { status: "finished", value: p === "/completion/async" ? "an answer" : "https://cdn.test/new.png" }), 100);
				return Response.json({ nodeId: (body as any)?.nodeId, convId: CONV, status: "processing" });
			}
			return Response.json({});
	}
	const origin = `http://localhost:${server.port}`;
	const home = mkdtempSync(join(tmpdir(), "cw-test-"));
	writeFileSync(
		join(home, "canvas-session.json"),
		JSON.stringify({ site: origin, supabaseUrl: origin, supabaseKey: "k", accessToken: jwt(), refreshToken: "r1", workerURL: origin, canvas: CONV, savedAt: at, botSessionId: "bot-test", agentKey }),
		{ mode: 0o600 },
	);
	/** Another machine logged in to the same account: a home of its own (its own send records and retry locks). */
	const newHome = () => {
		const other = mkdtempSync(join(tmpdir(), "cw-test-"));
		copyFileSync(join(home, "canvas-session.json"), join(other, "canvas-session.json"));
		return other;
	};
	/** Runs the real CLI against this fake; resolves with its JSON output (or error line) and exit code. */
	const run = (...args: string[]) => runWith({}, ...args);
	const runFrom = (directory: string, ...args: string[]) => runWith({ home: directory }, ...args);
	const runWith = async (at: { home?: string; env?: Record<string, string> }, ...args: string[]) => {
		const env = { ...process.env, FLOWITH_HOME: at.home ?? home, FLOWITH_AGENT: "claude-code", ...at.env } as Record<string, string | undefined>;
		delete env.FLOWITH_URL;
		delete env.FLOWITH_CANVAS;
		const proc = Bun.spawn(cliCommand(...args, "--json", "--quiet"), { env, stdout: "pipe", stderr: "pipe" });
		const [stdout, code] = [await new Response(proc.stdout).text(), await proc.exited];
		let json: any;
		try { json = JSON.parse(stdout.trim().split("\n").at(-1) ?? ""); } catch { json = stdout; }
		return { json, code };
	};
	const writes = () => requests.filter((r) => r.method !== "GET" && !r.path.startsWith("/auth/v1/"));
	return { origin, home, requests, writes, usage, opts, rows, run, runWith, runFrom, newHome, hold, stop: () => (server.stop(true), hangUp.stop(true)) };
}

/** A token the CLI accepts as unexpired (it only reads the claims). */
function jwt() {
	const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
	return `${b64({ alg: "HS256" })}.${b64({ sub: USER, exp: Math.floor(Date.now() / 1000) + 3600, session_id: "s-1", email: "t@test" })}.sig`;
}

/**
 * What the connect page does on Allow (hypergpt-frontend canvas-bot/cli-handshake.ts): seals the session to the
 * CLI's one-time key, broadcasts it on `cli-login:<code>` and waits for the CLI's proof that it opened it.
 */
export async function approveLogin(origin: string, link: string, session: Record<string, unknown>): Promise<boolean> {
	const url = new URL(link);
	const code = url.searchParams.get("cli_code")!;
	const cliKey = url.searchParams.get("cli_key")!;
	const nonce = url.searchParams.get("cli_nonce")!;
	const text = new TextEncoder();
	const fromB64 = (v: string) => new Uint8Array(Buffer.from(v, "base64url"));
	const recipient = await crypto.subtle.importKey("raw", fromB64(cliKey), { name: "ECDH", namedCurve: "P-256" }, false, []);
	const ephemeral = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
	const secret = await crypto.subtle.deriveBits({ name: "ECDH", public: recipient }, ephemeral.privateKey, 256);
	const material = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
	const key = await crypto.subtle.deriveKey(
		{ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: text.encode(`flowith-cli-login:${code}`) },
		material,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt", "decrypt"],
	);
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const message = { type: "session", data: { ...session, nonce } };
	const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: text.encode(code) }, key, text.encode(JSON.stringify(message)));
	const sealed = { type: "sealed", epk: b64url(await crypto.subtle.exportKey("raw", ephemeral.publicKey)), iv: b64url(iv), ct: b64url(ct) };

	const topic = `realtime:cli-login:${code}`;
	const socket = new WebSocket(`${origin.replace(/^http/, "ws")}/realtime/v1/websocket?apikey=k&vsn=1.0.0`);
	try {
		return await new Promise<boolean>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("The CLI never acknowledged the sealed login.")), 10_000);
			socket.onerror = () => reject(new Error("The test login socket failed."));
			socket.onopen = () => socket.send(JSON.stringify({ topic, event: "phx_join", payload: {}, ref: "1", join_ref: "1" }));
			socket.onmessage = async (e) => {
				const m = JSON.parse(String(e.data));
				if (m.event === "phx_reply" && m.ref === "1")
					socket.send(JSON.stringify({ topic, event: "broadcast", payload: { type: "broadcast", event: "cli_login", payload: sealed }, ref: "2", join_ref: "1" }));
				if (m.event === "broadcast" && m.payload?.event === "cli_login_ack") {
					const proof = m.payload.payload as { iv: string; ct: string };
					try {
						const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(proof.iv), additionalData: text.encode(`${code}:ack`) }, key, fromB64(proof.ct));
						clearTimeout(timer);
						resolve(new TextDecoder().decode(plain) === `ack:${nonce}`);
					} catch {
						clearTimeout(timer);
						resolve(false);
					}
				}
			};
		});
	} finally {
		socket.close();
	}
}
