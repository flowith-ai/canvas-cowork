#!/usr/bin/env bun
/**
 * Canvas Bot CLI — Zero-dependency Flowith canvas control
 *
 * Native WebSocket + fetch + http only. No npm packages.
 * Works with: Bun (any), Node 22+
 *
 * Session is auto-created via browser handshake — no credentials needed.
 */

import {
	existsSync,
	readFileSync,
	writeFileSync,
	statSync,
	chmodSync,
	unlinkSync,
	mkdirSync,
	renameSync,
} from "fs";
import { createServer } from "http";
import { resolve, join, basename, extname } from "path";
import { homedir } from "os";

// ============ Runtime check ============

if (typeof globalThis.WebSocket === "undefined") {
	console.error("Error: WebSocket not available. Use bun or Node 22+.");
	process.exit(1);
}

// ============ Types ============

interface CanvasBotSession {
	sessionId: string;
	sessionSecret: string;
	supabaseUrl: string;
	supabaseKey: string;
	accessToken: string;
	workerURL?: string;
	activeConvId?: string;
	createdAt: string;
	expiresAt: string;
	lastBrowserOpenAt?: string;
	browserOpenCount?: number;
	flowithUrl?: string;
}

interface BotActionBase {
	actionId: string;
	sessionId: string;
	timestamp: string;
	agentId?: string;
}
type BotAction = BotActionBase &
	(
		| { type: "ping" }
		| {
				type: "register_session";
				expiresAt: string;
				sessionSecret: string;
				botClient?: string;
		  }
		| { type: "create_canvas"; title?: string }
		| { type: "switch_canvas"; convId: string }
		| { type: "list_models"; chatMode?: string }
		| { type: "list_canvases" }
		| { type: "search_canvases"; query: string }
		| {
				type: "read_nodes";
				convId: string;
				nodeId?: string;
				full?: boolean;
				failed?: boolean;
		  }
		| {
				type: "poll_generation";
				convId: string;
				createdAfter: string;
				parentId?: string;
		  }
		| {
				type: "recall";
				query: string;
				limit?: number;
				filters?: Record<string, unknown>;
		  }
		| { type: "recall_node"; convId: string; nodeId: string }
		| { type: "clean_failed"; convId: string }
		| { type: "get_current_canvas"; includeTitle?: boolean }
		| { type: "set_mode"; mode: string }
		| { type: "set_model"; model: string }
		| {
				type: "submit";
				value: string;
				files?: Array<{ url: string; name: string; type?: string }>;
				follow?: string;
				aspectRatio?: string;
				imageSize?: string;
				videoDuration?: string;
				videoLoop?: boolean;
				videoAudio?: boolean;
		  }
		| { type: "comment"; nodeId: string; text: string }
		| { type: "delete_node"; nodeId: string }
		| { type: "delete_nodes"; nodeIds: string[] }
		| { type: "read_node"; nodeId: string }
		| { type: "read_all_nodes" }
	);
type BotActionPayload<T = BotAction> = T extends BotActionBase
	? Omit<T, keyof BotActionBase>
	: never;
type BotResponse =
	| { type: "ack"; actionId: string }
	| { type: "result"; actionId: string; data: unknown }
	| { type: "error"; actionId: string; code: string; message: string }
	| { type: "pong"; actionId: string };

// ============ Constants ============

const SESSION_DIR = join(homedir(), ".flowith");
const SESSION_FILE = join(SESSION_DIR, "bot-session.json");
const BATCH_DIR = join(SESSION_DIR, "batches");
const SESSION_LOCK_FILE = join(SESSION_DIR, "bot-session.lock");
const LEGACY_SESSION_FILE = ".flowith-bot-session.json";
const BOT_EVENTS = { ACTION: "bot_action", RESPONSE: "bot_response" } as const;
const ACTION_TIMEOUT_MS = 30_000;
const ORACLE_TIMEOUT_MS = 120_000;
const HEARTBEAT_MS = 29_000;
const QUICK_PING_MS = 3_000;
const BROWSER_OPEN_WAIT_MS = 25_000;
const BROWSER_POLL_MS = 2_000;
const BROWSER_OPEN_COOLDOWN_MS = 60_000;
const BROWSER_MAX_OPENS = 3; // Max auto-opens per session before giving up
const BATCH_LOCKED_RETRIES = 2; // Retries when the frontend rate-limits a batch submit
const VALID_MODES = new Set(["text", "image", "video", "agent", "neo"]);

// Input validation
const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function assertUUID(value: string, label: string) {
	if (!UUID_RE.test(value))
		throw new Error(`Invalid ${label}: expected UUID, got "${value}"`);
}

// Resolve Flowith URL: env override or deployed preview
async function detectFlowithUrl(): Promise<string> {
	if (process.env.FLOWITH_URL) return process.env.FLOWITH_URL;
	return "https://flowith.io/blank";
}
let _flowithUrl: string | null = null;
async function getFlowithUrl(): Promise<string> {
	if (!_flowithUrl) _flowithUrl = await detectFlowithUrl();
	return _flowithUrl;
}

// ============ Minimal Supabase Realtime (Phoenix Channel) ============

class RealtimeLite {
	private ws!: WebSocket;
	private ref = 0;
	private joinRefs = new Map<string, string>();
	private hb?: ReturnType<typeof setInterval>;
	private listeners: Array<(m: any) => void> = [];
	private joinedSet = new Set<string>();
	constructor(
		private url: string,
		private key: string,
		private token: string,
	) {}
	connect(): Promise<void> {
		const ws = this.url
			.replace("https://", "wss://")
			.replace("http://", "ws://");
		return new Promise((res, rej) => {
			this.ws = new WebSocket(
				`${ws}/realtime/v1/websocket?apikey=${encodeURIComponent(this.key)}&vsn=1.0.0`,
			);
			const t = setTimeout(() => rej(new Error("WS timeout")), 10_000);
			this.ws.onopen = () => {
				clearTimeout(t);
				this.hb = setInterval(
					() => this.push("phoenix", "heartbeat", {}),
					HEARTBEAT_MS,
				);
				res();
			};
			this.ws.onmessage = (e: MessageEvent) => {
				try {
					const m = JSON.parse(String(e.data));
					for (const f of this.listeners) f(m);
				} catch {}
			};
			this.ws.onerror = () => {
				clearTimeout(t);
				rej(new Error("WS failed"));
			};
			this.ws.onclose = () => {
				if (this.hb) clearInterval(this.hb);
			};
		});
	}
	join(ch: string): Promise<void> {
		if (this.joinedSet.has(ch)) return Promise.resolve();
		const ref = String(++this.ref);
		this.joinRefs.set(ch, ref);
		return new Promise((res, rej) => {
			const t = setTimeout(() => rej(new Error(`Join timeout: ${ch}`)), 10_000);
			const h = (m: any) => {
				if (m.ref === ref && m.event === "phx_reply") {
					clearTimeout(t);
					this.listeners = this.listeners.filter((l) => l !== h);
					if (m.payload?.status === "ok") {
						this.joinedSet.add(ch);
						res();
					} else rej(new Error("Join failed"));
				}
			};
			this.listeners.push(h);
			this.push(
				`realtime:${ch}`,
				"phx_join",
				{
					config: {
						broadcast: { self: false },
						presence: { key: "" },
						postgres_changes: [],
					},
					access_token: this.token,
				},
				ref,
				ref,
			);
		});
	}
	broadcast(ch: string, event: string, payload: unknown) {
		this.push(
			`realtime:${ch}`,
			"broadcast",
			{ type: "broadcast", event, payload },
			undefined,
			this.joinRefs.get(ch),
		);
	}
	onBroadcast(ch: string, event: string, cb: (p: any) => void): () => void {
		const h = (m: any) => {
			if (
				m.topic === `realtime:${ch}` &&
				m.event === "broadcast" &&
				m.payload?.event === event
			)
				cb(m.payload.payload);
		};
		this.listeners.push(h);
		return () => {
			this.listeners = this.listeners.filter((l) => l !== h);
		};
	}
	close() {
		if (this.hb) clearInterval(this.hb);
		try {
			this.ws?.close();
		} catch {}
	}
	private push(
		topic: string,
		event: string,
		payload: unknown,
		ref?: string,
		jr?: string,
	) {
		if (this.ws.readyState === WebSocket.OPEN)
			this.ws.send(
				JSON.stringify({
					topic,
					event,
					payload,
					ref: ref ?? String(++this.ref),
					join_ref: jr ?? null,
				}),
			);
	}
}

// ============ Bot client identity ============

function parseBotClient(rawArgs: string[]): {
	args: string[];
	botClient: string;
} {
	const idx = rawArgs.indexOf("--bot");
	if (idx !== -1 && rawArgs[idx + 1]) {
		return {
			botClient: rawArgs[idx + 1],
			args: [...rawArgs.slice(0, idx), ...rawArgs.slice(idx + 2)],
		};
	}
	return { botClient: process.env.BOT_CLIENT || "other", args: rawArgs };
}

// ============ Canvas & parallel flags ============

function parseCanvasFlag(rawArgs: string[]): {
	args: string[];
	canvasId?: string;
} {
	const idx = rawArgs.indexOf("--canvas");
	if (idx !== -1 && rawArgs[idx + 1]) {
		return {
			canvasId: rawArgs[idx + 1],
			args: [...rawArgs.slice(0, idx), ...rawArgs.slice(idx + 2)],
		};
	}
	return { args: rawArgs };
}

function parseParallelFlag(rawArgs: string[]): {
	args: string[];
	parallel: boolean;
} {
	const idx = rawArgs.indexOf("--parallel");
	if (idx !== -1) {
		return {
			parallel: true,
			args: [...rawArgs.slice(0, idx), ...rawArgs.slice(idx + 1)],
		};
	}
	return { parallel: false, args: rawArgs };
}

function parseAgentIdFlag(rawArgs: string[]): {
	args: string[];
	agentId?: string;
} {
	const idx = rawArgs.indexOf("--agent-id");
	if (idx !== -1 && rawArgs[idx + 1]) {
		return {
			agentId: rawArgs[idx + 1],
			args: [...rawArgs.slice(0, idx), ...rawArgs.slice(idx + 2)],
		};
	}
	return { args: rawArgs };
}

// ============ Browser open helper ============

/**
 * On macOS, detect if the default HTTPS handler is Safari.
 * If so, find an installed Chromium-based browser to use instead
 * (Safari blocks ws://127.0.0.1 from HTTPS pages — mixed content).
 * Returns the app name to use with `open -a`, null if default is fine,
 * or "SAFARI_ONLY" if Safari is default and no Chromium is available.
 */
const SAFARI_ONLY = "SAFARI_ONLY" as const;
let _macBrowserOverride: string | null | undefined; // undefined = not checked yet
function getMacBrowserOverride(): string | typeof SAFARI_ONLY | null {
	if (process.platform !== "darwin") return null;
	if (_macBrowserOverride !== undefined) return _macBrowserOverride;

	const { execSync } = require("child_process");

	// Check default browser via Launch Services
	let isSafariDefault = false;
	try {
		const out = execSync(
			`defaults read com.apple.LaunchServices/com.apple.launchservices.secure LSHandlers 2>/dev/null`,
			{ encoding: "utf-8", timeout: 1000 },
		);
		// If no custom handler overrides https, Safari is the system default
		// Look for an https handler that is NOT safari
		const httpsSection = out.match(
			/LSHandlerURLScheme = https;[\s\S]*?LSHandlerRoleAll = "([^"]+)"/,
		)?.[1];
		isSafariDefault = !httpsSection || httpsSection.includes("safari");
	} catch {
		isSafariDefault = false; // can't detect — assume non-Safari
	}

	if (!isSafariDefault) {
		_macBrowserOverride = null;
		return null;
	}

	// Safari is default — find a Chromium browser
	const candidates = [
		"Google Chrome",
		"Google Chrome Canary",
		"Chrome",
		"Chromium",
		"Microsoft Edge",
		"Arc",
		"Brave Browser",
		"Opera",
	];
	for (const app of candidates) {
		if (existsSync(`/Applications/${app}.app`)) {
			console.error(
				`Default browser is Safari (incompatible). Using ${app} instead.`,
			);
			_macBrowserOverride = app;
			return app;
		}
	}

	// Safari-only — no compatible browser found
	_macBrowserOverride = SAFARI_ONLY;
	return SAFARI_ONLY;
}

/**
 * Try to find an existing Flowith tab in the browser and navigate it,
 * instead of opening a new tab. Returns true if an existing tab was reused.
 */
function tryReuseExistingTab(url: string): boolean {
	if (process.platform !== "darwin") return false;
	const { spawnSync } = require("child_process");

	let origin: string;
	try {
		origin = new URL(url).origin;
	} catch {
		return false;
	}

	// Determine which browser to target
	const override = getMacBrowserOverride();
	const browsers =
		override && override !== SAFARI_ONLY
			? [override]
			: ["Google Chrome", "Arc", "Brave Browser", "Microsoft Edge"];

	for (const browser of browsers) {
		// Use escaped values to prevent AppleScript injection
		const safeOrigin = origin.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
		const safeUrl = url.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
		const script = [
			`tell application "System Events"`,
			`  if not (exists process "${browser}") then error "not running"`,
			`end tell`,
			`tell application "${browser}"`,
			`  repeat with w in windows`,
			`    set tabIdx to 0`,
			`    repeat with t in tabs of w`,
			`      set tabIdx to tabIdx + 1`,
			`      try`,
			`        if URL of t starts with "${safeOrigin}" then`,
			`          set URL of t to "${safeUrl}"`,
			`          set active tab index of w to tabIdx`,
			`          set index of w to 1`,
			`          activate`,
			`          return`,
			`        end if`,
			`      end try`,
			`    end repeat`,
			`  end repeat`,
			`end tell`,
			`error "no match"`,
		].join("\n");
		const result = spawnSync("osascript", ["-e", script], {
			timeout: 3_000,
			stdio: ["ignore", "pipe", "pipe"],
		});
		if (result.status === 0) return true;
	}
	return false;
}

async function openInBrowser(url: string) {
	const { spawnSync } = await import("child_process");

	// On macOS, try to navigate an existing Flowith tab first (no new tab)
	if (process.platform === "darwin" && tryReuseExistingTab(url)) return;

	if (process.platform === "darwin") {
		if (url.startsWith("https://")) {
			const override = getMacBrowserOverride();
			if (override === SAFARI_ONLY) {
				throw new BrowserConnectionError("Safari is not supported");
			}
			if (override) {
				const result = spawnSync("open", ["-a", override, url], {
					stdio: "ignore",
				});
				if (result.status === 0) return;
				console.error(
					`Failed to launch ${override}, falling back to default browser`,
				);
			}
		}
		spawnSync("open", [url], { stdio: "ignore" });
	} else if (process.platform === "win32") {
		// cmd.exe treats & | < > ^ as metacharacters; escape with ^ to prevent URL breakage
		const escaped = url.replace(/[&|<>^]/g, "^$&");
		spawnSync("cmd", ["/c", "start", "", escaped], { stdio: "ignore" });
	} else {
		spawnSync("xdg-open", [url], { stdio: "ignore" });
	}
}

// ============ JWT helpers ============

function decodeJwt(jwt: string): any {
	try {
		return JSON.parse(
			atob(jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")),
		);
	} catch {
		return null;
	}
}
function getJwtUserId(jwt: string): string | null {
	return decodeJwt(jwt)?.sub ?? null;
}
function isJwtExpired(jwt: string): boolean {
	const p = decodeJwt(jwt);
	return p?.exp ? p.exp * 1000 < Date.now() : false;
}

// ============ Session I/O ============

function saveSession(s: CanvasBotSession) {
	mkdirSync(SESSION_DIR, { recursive: true });
	writeFileSync(SESSION_FILE, JSON.stringify(s, null, 2));
	try {
		chmodSync(SESSION_FILE, 0o600);
	} catch {}
}

function loadSession(): CanvasBotSession | null {
	// Migrate legacy session from cwd if new location doesn't exist
	if (!existsSync(SESSION_FILE)) {
		const legacy = resolve(process.cwd(), LEGACY_SESSION_FILE);
		if (existsSync(legacy)) {
			try {
				mkdirSync(SESSION_DIR, { recursive: true });
				writeFileSync(SESSION_FILE, readFileSync(legacy, "utf-8"));
				try {
					chmodSync(SESSION_FILE, 0o600);
				} catch {}
				unlinkSync(legacy);
				console.error(`Migrated session from ${legacy} to ${SESSION_FILE}`);
			} catch {}
		}
	}
	if (!existsSync(SESSION_FILE)) return null;
	try {
		const s = statSync(SESSION_FILE);
		if (s.mode & 0o077) chmodSync(SESSION_FILE, 0o600);
	} catch {}
	try {
		const s: CanvasBotSession = JSON.parse(readFileSync(SESSION_FILE, "utf-8"));
		if (!s.sessionId || !s.sessionSecret || !s.supabaseUrl || !s.accessToken)
			return null;
		if (
			new Date(s.expiresAt).getTime() < Date.now() ||
			isJwtExpired(s.accessToken)
		)
			return null;
		return s;
	} catch {
		return null;
	}
}

// ============ Token validation ============

async function validateToken(session: CanvasBotSession): Promise<boolean> {
	try {
		const r = await fetch(
			`${session.supabaseUrl}/rest/v1/conversation?select=id&limit=1`,
			{
				headers: {
					apikey: session.supabaseKey,
					Authorization: `Bearer ${session.accessToken}`,
				},
				signal: AbortSignal.timeout(5_000),
			},
		);
		// 401/403 = token revoked or expired server-side
		return r.status !== 401 && r.status !== 403;
	} catch {
		// Network error — don't block, let it fail naturally later
		return true;
	}
}

// ============ Browser handshake: local WebSocket server receives session from frontend ============

async function acquireSession(botClient = "other"): Promise<CanvasBotSession> {
	const currentFlowithUrl = await getFlowithUrl();
	const existing = loadSession();
	if (existing) {
		// If FLOWITH_URL changed (e.g. switched to localhost), the browser at the
		// new origin won't be logged in. Force re-auth so the user gets a proper
		// login prompt instead of silent "browser not responding" failures.
		if (existing.flowithUrl && existing.flowithUrl !== currentFlowithUrl) {
			deleteSessionFile();
			console.error(
				`Flowith URL changed (${existing.flowithUrl} → ${currentFlowithUrl}). Re-authenticating...`,
			);
		} else {
			// Quick server-side token validation (catches revoked/expired tokens the JWT check misses)
			const valid = await validateToken(existing);
			if (valid) return existing;
			// Token rejected — clear stale session
			deleteSessionFile();
			console.error("Session token expired or revoked. Re-authenticating...");
		}
	}

	// Lockfile guard: if another CLI process is already opening the browser, wait for it
	if (!tryAcquireSessionLock()) {
		return waitForSessionFromOtherProcess();
	}

	console.error("No valid session. Opening Flowith in your browser...");
	console.error(
		"Please log in if needed — the connection will complete automatically.\n",
	);

	// One-time nonce: browser must echo this back to prove it was opened by this CLI instance
	const nonce = crypto.randomUUID();

	return new Promise((resolvePromise, reject) => {
		let settled = false;
		let serverRef: { close: () => void } | null = null;
		const fail = (msg: string, code?: string) => {
			if (!settled) {
				settled = true;
				clearTimeout(timeout);
				serverRef?.close();
				releaseSessionLock();
				reject(code ? new BrowserConnectionError(msg, code) : new Error(msg));
			}
		};
		const succeed = (s: CanvasBotSession) => {
			if (!settled) {
				settled = true;
				clearTimeout(timeout);
				serverRef?.close();
				releaseSessionLock();
				resolvePromise(s);
			}
		};

		const timeout = setTimeout(
			() =>
				fail(
					"Browser did not send session within 2 minutes.\n\n" +
						"This usually means you are not logged in to Flowith.\n" +
						"Please log in at the browser window that was opened, then re-run this command.",
					"NOT_LOGGED_IN",
				),
			120_000,
		);

		// Use WebSocket server instead of HTTP for the session handshake.
		// Note: Safari blocks both fetch() and ws:// to 127.0.0.1 from HTTPS pages (mixed content).
		// Safari is detected and rejected before reaching this point.
		const handleWsMessage = (
			ws: { send: (data: string) => void; close: () => void },
			raw: string | Buffer,
		) => {
			try {
				const msg = JSON.parse(
					typeof raw === "string" ? raw : raw.toString("utf-8"),
				);

				if (msg.type === "not_logged_in") {
					ws.send(JSON.stringify({ ok: true }));
					ws.close();
					fail(
						"You are not logged in. Please log in at the browser, then re-run this command.",
						"NOT_LOGGED_IN",
					);
					return;
				}

				if (msg.type === "session") {
					const parsed = msg.data;
					if (parsed.nonce !== nonce) {
						ws.send(JSON.stringify({ error: "Invalid nonce" }));
						return;
					}
					const { nonce: _, ...sessionData } = parsed as CanvasBotSession & {
						nonce: string;
					};
					const session: CanvasBotSession = {
						...sessionData,
						sessionSecret: crypto.randomUUID(),
						lastBrowserOpenAt: new Date().toISOString(),
						flowithUrl: currentFlowithUrl,
					};
					saveSession(session);
					ws.send(JSON.stringify({ ok: true }));
					console.error("Session received from browser. Connected!");
					ws.close();
					succeed(session);
				}
			} catch {
				ws.send(JSON.stringify({ error: "Invalid message" }));
			}
		};

		const isBun = typeof (globalThis as any).Bun !== "undefined";

		if (isBun) {
			const bunServer = (globalThis as any).Bun.serve({
				port: 0,
				hostname: "127.0.0.1",
				fetch(req: Request, srv: any) {
					if (srv.upgrade(req)) return undefined as any;
					return new Response("Not a WebSocket request", { status: 400 });
				},
				websocket: {
					open() {},
					message(ws: any, msg: string | Buffer) {
						handleWsMessage(ws, msg);
					},
					close() {},
				},
			});
			serverRef = { close: () => bunServer.stop() };

			getFlowithUrl().then(async (base) => {
				const url = `${base}?cli_port=${bunServer.port}&cli_nonce=${nonce}&cli_bot=${encodeURIComponent(botClient)}`;
				await openInBrowser(url);
				console.error(`Waiting for browser at ${url} ...`);
			});
		} else {
			const nodeServer = createServer();
			serverRef = nodeServer;
			const nodeCrypto = require("crypto");

			nodeServer.on("upgrade", (req: any, socket: any) => {
				const key = req.headers["sec-websocket-key"];
				if (!key) {
					socket.destroy();
					return;
				}
				const acceptHash = nodeCrypto
					.createHash("sha1")
					.update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
					.digest("base64");
				socket.write(
					"HTTP/1.1 101 Switching Protocols\r\n" +
						"Upgrade: websocket\r\n" +
						"Connection: Upgrade\r\n" +
						`Sec-WebSocket-Accept: ${acceptHash}\r\n` +
						"\r\n",
				);

				const sendFrame = (data: string) => {
					const buf = Buffer.from(data, "utf-8");
					const frame: number[] = [0x81];
					if (buf.length < 126) frame.push(buf.length);
					else if (buf.length < 65536) {
						frame.push(126, (buf.length >> 8) & 0xff, buf.length & 0xff);
					} else {
						frame.push(127);
						for (let i = 7; i >= 0; i--)
							frame.push((buf.length >> (i * 8)) & 0xff);
					}
					socket.write(Buffer.concat([Buffer.from(frame), buf]));
				};

				const MAX_WS_BUFFER = 64 * 1024; // 64KB — session payload is ~2KB
				let buffer = Buffer.alloc(0);
				socket.on("data", (chunk: Buffer) => {
					if (buffer.length + chunk.length > MAX_WS_BUFFER) {
						socket.destroy();
						return;
					}
					buffer = Buffer.concat([buffer, chunk]);
					while (buffer.length >= 2) {
						const opcode = buffer[0] & 0x0f;
						const masked = (buffer[1] & 0x80) !== 0;
						let payloadLen = buffer[1] & 0x7f;
						let offset = 2;
						if (payloadLen === 126) {
							if (buffer.length < 4) return;
							payloadLen = (buffer[2] << 8) | buffer[3];
							offset = 4;
						} else if (payloadLen === 127) {
							if (buffer.length < 10) return;
							payloadLen = 0;
							for (let i = 0; i < 8; i++)
								payloadLen = payloadLen * 256 + buffer[2 + i];
							offset = 10;
						}
						const maskSize = masked ? 4 : 0;
						const totalLen = offset + maskSize + payloadLen;
						if (buffer.length < totalLen) return;
						const mask = masked
							? buffer.subarray(offset, offset + maskSize)
							: null;
						const payload = buffer.subarray(offset + maskSize, totalLen);
						if (mask)
							for (let i = 0; i < payload.length; i++)
								payload[i] ^= mask[i % 4];
						buffer = buffer.subarray(totalLen);
						if (opcode === 0x08) {
							socket.end();
							return;
						}
						// Respond to ping with pong
						if (opcode === 0x09) {
							const pong = Buffer.alloc(2 + payload.length);
							pong[0] = 0x8a; // pong frame
							pong[1] = payload.length;
							payload.copy(pong, 2);
							socket.write(pong);
							continue;
						}
						if (opcode !== 0x01) continue;
						handleWsMessage(
							{ send: sendFrame, close: () => socket.end() },
							payload,
						);
					}
				});
				socket.on("error", () => {});
			});

			nodeServer.listen(0, "127.0.0.1", async () => {
				const port = (nodeServer.address() as any).port;
				const base = await getFlowithUrl();
				const url = `${base}?cli_port=${port}&cli_nonce=${nonce}&cli_bot=${encodeURIComponent(botClient)}`;
				await openInBrowser(url);
				console.error(`Waiting for browser at ${url} ...`);
			});
		}
	});
}

// ============ Register session with frontend via broadcast ============

async function registerWithFrontend(
	client: RealtimeLite,
	session: CanvasBotSession,
	userId: string,
	botClient: string,
) {
	const ch = `bot_ctrl:${userId}`;
	await client.join(ch);
	const actionId = crypto.randomUUID();
	const action: BotAction = {
		actionId,
		sessionId: session.sessionId,
		timestamp: new Date().toISOString(),
		type: "register_session",
		expiresAt: session.expiresAt,
		sessionSecret: session.sessionSecret,
		botClient,
	};
	let cleanup: (() => void) | undefined;
	await Promise.race([
		new Promise<void>((resolve, reject) => {
			cleanup = client.onBroadcast(
				ch,
				BOT_EVENTS.RESPONSE,
				(resp: BotResponse) => {
					if (resp.actionId !== actionId) return;
					cleanup?.();
					if (resp.type === "ack") resolve();
					else if (resp.type === "error")
						reject(
							new Error(
								`Session registration rejected: ${(resp as any).message || (resp as any).code}`,
							),
						);
				},
			);
			client.broadcast(ch, BOT_EVENTS.ACTION, action);
		}),
		new Promise<void>((r) => setTimeout(r, 3_000)), // No browser yet — ensureBrowserConnected will handle it
	]);
	cleanup?.(); // Clean up listener if timeout won the race
}

// ============ Typed errors ============

class BrowserConnectionError extends Error {
	constructor(
		message: string,
		public code: string = "BROWSER_CONNECTION_ERROR",
	) {
		super(message);
		this.name = "BrowserConnectionError";
	}
}

function deleteSessionFile() {
	try {
		unlinkSync(SESSION_FILE);
	} catch {}
}

// ============ Session lock (prevents concurrent browser opens) ============

const SESSION_LOCK_MAX_AGE_MS = 120_000;
const SESSION_LOCK_POLL_MS = 1_000;

/** Try to acquire the session lock. Returns false if another process holds it. */
function tryAcquireSessionLock(): boolean {
	mkdirSync(SESSION_DIR, { recursive: true });
	if (existsSync(SESSION_LOCK_FILE)) {
		try {
			const s = statSync(SESSION_LOCK_FILE);
			if (Date.now() - s.mtimeMs < SESSION_LOCK_MAX_AGE_MS) {
				// Check if the holding process is still alive
				try {
					const pid = parseInt(
						readFileSync(SESSION_LOCK_FILE, "utf-8").trim(),
						10,
					);
					if (pid && pid !== process.pid) {
						try {
							process.kill(pid, 0); // signal 0 = check existence only
							return false; // process alive, lock valid
						} catch {
							console.error("Stale lock (process dead). Taking over...");
						}
					}
				} catch {
					return false; // can't read PID, treat as held
				}
			}
		} catch {}
	}
	try {
		writeFileSync(SESSION_LOCK_FILE, String(process.pid));
		return true;
	} catch {
		return false;
	}
}

function releaseSessionLock() {
	try {
		unlinkSync(SESSION_LOCK_FILE);
	} catch {}
}

/** Wait for another process to finish acquiring the session. */
async function waitForSessionFromOtherProcess(): Promise<CanvasBotSession> {
	console.error(
		"Another process is opening the browser. Waiting for session...",
	);
	const deadline = Date.now() + SESSION_LOCK_MAX_AGE_MS;
	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, SESSION_LOCK_POLL_MS));
		const session = loadSession();
		if (session) {
			const valid = await validateToken(session);
			if (valid) {
				console.error("Session ready.");
				return session;
			}
		}
		// Lock released but no valid session → stale lock, break and proceed
		if (!existsSync(SESSION_LOCK_FILE)) break;
	}
	throw new Error(
		"Timed out waiting for session from another process. Please retry.",
	);
}

// ============ Creative Dream (journal I/O) ============

const JOURNAL_FILE = join(SESSION_DIR, "creative-journal.md");

// ============ Pre-flight: auto-detect & auto-open browser ============

async function quickPing(
	client: RealtimeLite,
	ch: string,
	session: CanvasBotSession,
): Promise<boolean> {
	try {
		const action: BotAction = {
			actionId: crypto.randomUUID(),
			sessionId: session.sessionId,
			timestamp: new Date().toISOString(),
			type: "ping",
		};
		await sendAndWait(client, ch, action, QUICK_PING_MS);
		return true;
	} catch {
		return false;
	}
}

/**
 * Read-only liveness probe: is a logged-in Flowith tab actually responding?
 * Unlike ensureBrowserConnected, this never opens a browser — used by
 * `status --live` and `login` to report true connection state.
 */
async function liveBrowserPing(session: CanvasBotSession): Promise<boolean> {
	const userId = getJwtUserId(session.accessToken);
	if (!userId) return false;
	const client = new RealtimeLite(
		session.supabaseUrl,
		session.supabaseKey,
		session.accessToken,
	);
	try {
		await client.connect();
		const ch = `bot_ctrl:${userId}`;
		await client.join(ch);
		return await quickPing(client, ch, session);
	} catch {
		return false;
	} finally {
		client.close();
	}
}

async function ensureBrowserConnected(
	client: RealtimeLite,
	session: CanvasBotSession,
	userId: string,
	botClient: string,
): Promise<void> {
	const ch = `bot_ctrl:${userId}`;
	if (await quickPing(client, ch, session)) return;

	// Grace period: browser may be transitioning after a page navigation (e.g. switch_canvas).
	// A brief retry avoids a false "not connected" that triggers a redundant browser open.
	await new Promise((r) => setTimeout(r, 2_000));
	if (await quickPing(client, ch, session)) return;

	// Decide: open browser or just wait (if we or another process already opened it recently)
	// session is passed by reference — in-process retries see the updated timestamp without re-reading the file.
	// saveSession() persists it so separate CLI invocations also respect the cooldown.
	const now = Date.now();
	const recentlyOpened =
		session.lastBrowserOpenAt &&
		now - new Date(session.lastBrowserOpenAt).getTime() <
			BROWSER_OPEN_COOLDOWN_MS;

	const openCount = session.browserOpenCount || 0;
	if (!recentlyOpened) {
		if (openCount >= BROWSER_MAX_OPENS) {
			throw new BrowserConnectionError(
				`Already opened the browser ${BROWSER_MAX_OPENS} times without a successful connection.\n\n` +
					"Please make sure a Flowith tab is open and loaded, then re-run this command.",
				"TOO_MANY_OPENS",
			);
		}
		const base = await getFlowithUrl();
		const target = session.activeConvId
			? `${base}/conv/${session.activeConvId}`
			: base;
		console.error("Browser not connected. Opening Flowith...");
		await openInBrowser(target);
		session.browserOpenCount = openCount + 1;
		session.lastBrowserOpenAt = new Date().toISOString();
		saveSession(session);
	} else {
		console.error("Browser was recently opened. Waiting for it to connect...");
	}

	// Poll until browser mounts and responds
	const deadline = Date.now() + BROWSER_OPEN_WAIT_MS;
	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, BROWSER_POLL_MS));
		await registerWithFrontend(client, session, userId, botClient);
		if (await quickPing(client, ch, session)) {
			if (session.browserOpenCount) {
				session.browserOpenCount = 0;
				saveSession(session);
			}
			console.error("Connected!");
			return;
		}
	}

	// Timed out — determine root cause: token expired (not logged in) vs browser issue
	const tokenValid = await validateToken(session);
	if (!tokenValid) {
		// Token rejected → user is not logged in or session expired
		deleteSessionFile();
		throw new BrowserConnectionError(
			"Your Flowith session has expired or you are not logged in.\n\n" +
				"Please open Flowith in your browser, log in, then re-run this command.",
			"NOT_LOGGED_IN",
		);
	}
	throw new BrowserConnectionError(
		"Browser opened but did not respond.\n\n" +
			"Please ensure the Flowith tab is fully loaded and you are logged in.",
		"BROWSER_NOT_CONNECTED",
	);
}

// ============ Connect + Execute with auto-retry ============

const MAX_RETRIES = 2;

async function connectAndExecute(
	session: CanvasBotSession,
	userId: string,
	channelName: string,
	action: BotAction,
	timeout: number,
	botClient: string,
	options?: { parallel?: boolean },
): Promise<BotResponse> {
	let lastError: Error | null = null;
	const isParallel = options?.parallel ?? false;

	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		const client = new RealtimeLite(
			session.supabaseUrl,
			session.supabaseKey,
			session.accessToken,
		);
		try {
			await client.connect();
			await registerWithFrontend(client, session, userId, botClient);
			if (!isParallel || channelName.startsWith("bot_ctrl:")) {
				await ensureBrowserConnected(client, session, userId, botClient);
			}
			if (!channelName.startsWith("bot_ctrl:") && !isParallel) {
				// Auto-align: ask the browser what canvas it's on and follow it.
				// Skipped in parallel mode — canvas is explicit via --canvas flag.
				const ctrlCh = `bot_ctrl:${userId}`;
				await client.join(ctrlCh);
				const queryAction: BotAction = {
					actionId: crypto.randomUUID(),
					sessionId: session.sessionId,
					timestamp: new Date().toISOString(),
					type: "get_current_canvas",
				};
				try {
					const resp = await sendAndWait(
						client,
						ctrlCh,
						queryAction,
						QUICK_PING_MS,
					);
					const browserConvId = (resp as any).data?.convId;
					if (browserConvId) {
						if (browserConvId !== channelName.replace("bot:", "")) {
							// Browser is on a different canvas — follow it
							channelName = `bot:${browserConvId}`;
							session.activeConvId = browserConvId;
							saveSession(session);
						}
					} else {
						// Browser is not on a canvas page — throw clear error
						throw new BrowserConnectionError(
							"No canvas is open in the browser. Please navigate to a canvas, then re-run.",
							"NO_CANVAS",
						);
					}
				} catch (e) {
					if (e instanceof BrowserConnectionError) throw e;
					// Query failed — proceed with original target
				}
			}
			if (!channelName.startsWith("bot_ctrl:")) {
				await client.join(channelName);
			}
			return await sendAndWait(client, channelName, action, timeout);
		} catch (e: any) {
			lastError = e;
			// Browser timeout = we already opened + waited long enough — retrying won't help
			if (e instanceof BrowserConnectionError) throw e;
			if (attempt < MAX_RETRIES) {
				console.error(
					`Connection failed (${e.message}), retrying... (${attempt + 1}/${MAX_RETRIES})`,
				);
			}
		} finally {
			client.close();
		}
	}

	throw lastError ?? new Error("Connection failed after retries");
}

// ============ Image upload ============

const IMAGE_EXTS = new Set([
	"jpg",
	"jpeg",
	"png",
	"webp",
	"gif",
	"svg",
	"bmp",
	"avif",
	"heic",
]);
const IMAGE_MIME: Record<string, string> = {
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	png: "image/png",
	webp: "image/webp",
	gif: "image/gif",
	svg: "image/svg+xml",
	bmp: "image/bmp",
	avif: "image/avif",
	heic: "image/heic",
};
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

function isUrl(s: string): boolean {
	return /^https?:\/\//i.test(s);
}

type SubmitFile = { url: string; name: string; type?: string };

/** Upload a local file via the same /file/store endpoint the frontend uses. */
async function uploadToWorker(
	filePath: string,
	session: CanvasBotSession,
): Promise<SubmitFile> {
	const workerURL = session.workerURL;
	if (!workerURL)
		throw new Error(
			"Session missing workerURL — re-run to get a fresh session from the browser",
		);

	const absPath = resolve(filePath);
	if (!existsSync(absPath)) throw new Error(`File not found: ${filePath}`);

	const ext = extname(absPath).slice(1).toLowerCase();
	if (!IMAGE_EXTS.has(ext))
		throw new Error(
			`Not an image file: ${filePath} (supported: ${Array.from(IMAGE_EXTS).join(", ")})`,
		);

	const fileData = readFileSync(absPath);
	if (fileData.byteLength > MAX_UPLOAD_BYTES) {
		throw new Error(
			`File too large: ${(fileData.byteLength / 1024 / 1024).toFixed(1)}MB (max ${MAX_UPLOAD_BYTES / 1024 / 1024}MB)`,
		);
	}

	const fileName = basename(absPath);
	const contentType = IMAGE_MIME[ext] || "application/octet-stream";
	console.error(
		`Uploading ${fileName} (${(fileData.byteLength / 1024).toFixed(0)}KB)...`,
	);

	// Replicate what the frontend's storeFile() does: POST FormData to /file/store
	const blob = new Blob([fileData], { type: contentType });
	const formData = new FormData();
	formData.append("file", blob, fileName);

	const resp = await fetch(`${workerURL}/file/store`, {
		method: "POST",
		headers: { Authorization: session.accessToken },
		body: formData,
		signal: AbortSignal.timeout(30_000),
	});
	if (!resp.ok) {
		const text = await resp.text().catch(() => "");
		throw new Error(`Upload failed (${resp.status}): ${text}`);
	}

	const { url } = (await resp.json()) as { url: string };
	console.error(`Uploaded → ${url}`);
	return { url, name: fileName, type: contentType };
}

async function resolveImages(
	paths: string[],
	session: CanvasBotSession,
): Promise<SubmitFile[]> {
	return Promise.all(
		paths.map(async (p): Promise<SubmitFile> => {
			if (isUrl(p)) {
				return { url: p, name: p.split("/").pop()?.split("?")[0] || "image" };
			}
			return uploadToWorker(p, session);
		}),
	);
}

function extractFlag(
	args: string[],
	flag: string,
): { values: string[]; rest: string[] } {
	const values: string[] = [],
		rest: string[] = [];
	for (let i = 0; i < args.length; i++) {
		if (args[i] === flag && args[i + 1] && !args[i + 1].startsWith("--")) {
			values.push(args[i + 1]);
			i++;
		} else {
			rest.push(args[i]);
		}
	}
	return { values, rest };
}

// ============ Batch journal (crash/interrupt recovery) ============

interface BatchRecord {
	batchId: string;
	convId: string;
	mode?: string;
	models: string[];
	createdAt: string;
	updatedAt: string;
	total: number;
	items: Array<{
		index: number;
		prompt: string;
		status: "pending" | "submitted" | "failed";
		questionNodeId?: string;
		// Why a failed item failed, so a re-run can tell "rate-limited, retry later"
		// (rate_limited) apart from a real error and avoid re-submitting blindly.
		reason?: "rate_limited" | "error";
	}>;
}

function batchFile(batchId: string): string {
	return join(BATCH_DIR, `${batchId}.json`);
}

/**
 * Persist the batch record after every item so an interrupt leaves an audit
 * trail. Writes atomically (temp file + rename) so an interrupt mid-write can
 * never leave a half-written JSON that loadBatch would silently drop. A write
 * failure is warned (not swallowed) since it means recovery won't be available.
 */
let _batchSaveWarned = false;
function saveBatch(rec: BatchRecord) {
	try {
		mkdirSync(BATCH_DIR, { recursive: true });
		rec.updatedAt = new Date().toISOString();
		const dest = batchFile(rec.batchId);
		const tmp = `${dest}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify(rec, null, 2));
		renameSync(tmp, dest); // atomic on the same filesystem
	} catch (e: any) {
		if (!_batchSaveWarned) {
			_batchSaveWarned = true;
			console.error(
				`[canvas-cowork] WARNING: failed to write batch journal (${e?.message ?? e}). ` +
					`Recovery via 'batches ${rec.batchId}' may be unavailable.`,
			);
		}
	}
}

function loadBatch(batchId: string): BatchRecord | null {
	try {
		return JSON.parse(readFileSync(batchFile(batchId), "utf-8")) as BatchRecord;
	} catch (e: any) {
		// ENOENT is expected (no such batch); anything else means a corrupt or
		// unreadable journal — surface it so a bad audit isn't mistaken for "none".
		if (e?.code !== "ENOENT") {
			console.error(
				`[canvas-cowork] WARNING: batch journal for ${batchId} is unreadable (${e?.message ?? e}).`,
			);
		}
		return null;
	}
}

function listBatches(limit = 20): BatchRecord[] {
	try {
		const { readdirSync } = require("fs");
		return (readdirSync(BATCH_DIR) as string[])
			.filter((f) => f.endsWith(".json"))
			.map((f) => {
				try {
					return JSON.parse(
						readFileSync(join(BATCH_DIR, f), "utf-8"),
					) as BatchRecord;
				} catch {
					return null;
				}
			})
			.filter((r): r is BatchRecord => r !== null)
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
			.slice(0, limit);
	} catch {
		return [];
	}
}

// ============ Main ============

async function main() {
	const { args: args0, botClient } = parseBotClient(process.argv.slice(2));
	const { args: args1, canvasId: explicitCanvasId } = parseCanvasFlag(args0);
	const { args: args2, parallel: parallelMode } = parseParallelFlag(args1);
	const { args, agentId } = parseAgentIdFlag(args2);

	if (parallelMode && !explicitCanvasId) {
		console.error("Error: --parallel requires --canvas <convId>.");
		process.exit(1);
	}

	if (!args.length || args[0] === "-h" || args[0] === "--help") {
		printUsage();
		process.exit(args.length ? 0 : 1);
	}
	const cmd = args[0];

	// ---- status ----
	// Default: fast, file-only snapshot. --live: also probe the browser tab so
	// the reported state reflects reality (the file alone can lie mid-login).
	if (cmd === "status") {
		const s = loadSession();
		if (!s) {
			console.log(JSON.stringify({ status: "no_session" }));
			return;
		}
		const base: Record<string, unknown> = {
			status: "ok",
			activeUser: getJwtUserId(s.accessToken) ?? null,
			activeConvId: s.activeConvId ?? null,
			expiresAt: s.expiresAt,
		};
		if (args.includes("--live")) {
			const connected = await liveBrowserPing(s);
			base.browser = connected ? "connected" : "disconnected";
		}
		console.log(JSON.stringify(base));
		return;
	}

	// ---- whoami: identify the logged-in user without side effects ----
	if (cmd === "whoami") {
		const s = loadSession();
		console.log(
			JSON.stringify(
				s
					? { userId: getJwtUserId(s.accessToken), expiresAt: s.expiresAt }
					: { userId: null, status: "no_session" },
			),
		);
		return;
	}

	// ---- login / connect: explicit session handshake (no other side effects) ----
	// Replaces the old pattern of triggering login as a side effect of
	// list-models. Establishes (or reuses) a session, then reports browser state.
	if (cmd === "login" || cmd === "connect") {
		const s = await acquireSession(botClient);
		const connected = await liveBrowserPing(s);
		console.log(
			JSON.stringify({
				status: "connected",
				activeUser: getJwtUserId(s.accessToken),
				activeConvId: s.activeConvId ?? null,
				expiresAt: s.expiresAt,
				browser: connected ? "connected" : "disconnected",
			}),
		);
		return;
	}

	// ---- open ----
	if (cmd === "open") {
		const existing = loadSession();
		const arg = args[1];

		// Full URL mode: open directly in browser, preserving all query params (invitation links etc.)
		if (arg && /^https?:\/\//i.test(arg)) {
			await openInBrowser(arg);
			if (existing) {
				existing.lastBrowserOpenAt = new Date().toISOString();
				const m = arg.match(/\/conv\/([0-9a-f-]{36})/i);
				if (m) existing.activeConvId = m[1];
				saveSession(existing);
			}
			console.error(`Opened ${arg} (full URL)`);
			return;
		}

		const convId = arg || existing?.activeConvId;

		// If we have a session and a convId, try same-tab navigation via broadcast first
		if (existing && convId) {
			const uid = getJwtUserId(existing.accessToken);
			if (uid) {
				const client = new RealtimeLite(
					existing.supabaseUrl,
					existing.supabaseKey,
					existing.accessToken,
				);
				try {
					await client.connect();
					const ch = `bot_ctrl:${uid}`;
					await client.join(ch);
					if (await quickPing(client, ch, existing)) {
						// Browser is alive — navigate in same tab
						assertUUID(convId, "convId");
						const action: BotAction = {
							actionId: crypto.randomUUID(),
							sessionId: existing.sessionId,
							timestamp: new Date().toISOString(),
							type: "switch_canvas",
							convId,
						};
						await sendAndWait(client, ch, action, ACTION_TIMEOUT_MS);
						if (args[1]) existing.activeConvId = args[1];
						saveSession(existing);
						console.error(`Navigated to canvas ${convId} (same tab)`);
						return;
					}
				} catch (e: any) {
					// Any failure (WS connect, ping, switch) — fall through to openInBrowser
					if (e?.message)
						console.error(`Same-tab navigation failed: ${e.message}`);
				} finally {
					client.close();
				}
			}
		}

		// Fallback: open new browser tab (no browser connected or no session)
		const base = await getFlowithUrl();
		const target = convId ? `${base}/conv/${convId}` : base;
		await openInBrowser(target);
		if (existing) {
			existing.lastBrowserOpenAt = new Date().toISOString();
			if (args[1]) existing.activeConvId = args[1];
			saveSession(existing);
		}
		console.error(`Opened ${target} (new tab)`);
		return;
	}

	// ---- batches (file I/O only, no session needed) ----
	// Audit submit-batch runs after a timeout/interrupt: which prompts landed
	// as nodes (questionNodeId set) vs. never submitted.
	if (cmd === "batches") {
		const id = args.find((a, i) => i > 0 && !a.startsWith("--"));
		if (id) {
			const rec = loadBatch(id);
			if (!rec) {
				console.log(
					JSON.stringify({ type: "error", code: "NOT_FOUND", batchId: id }),
				);
				process.exit(1);
			}
			console.log(JSON.stringify(rec, null, 2));
		} else {
			console.log(
				JSON.stringify(
					listBatches().map((r) => ({
						batchId: r.batchId,
						convId: r.convId,
						updatedAt: r.updatedAt,
						submitted: r.items.filter((it) => it.status === "submitted").length,
						total: r.total,
					})),
					null,
					2,
				),
			);
		}
		return;
	}

	// ---- dream-init (file I/O only, no session needed) ----
	if (cmd === "dream-init") {
		const theme = args[1];
		if (!theme) {
			console.error('Usage: dream-init "theme" [--mode image|video|text]');
			process.exit(1);
		}
		const mi = args.indexOf("--mode");
		const mode = mi !== -1 && args[mi + 1] ? args[mi + 1] : "image";
		const el = theme.split(/[\s×x+&,、·:]+/).filter(Boolean);
		const elStr = el.join(", ");
		const md = [
			`# Creative Journal`,
			``,
			`## Meta`,
			`- theme: ${theme}`,
			`- mode: ${mode}`,
			`- round: 0`,
			`- canvasId:`,
			`- createdAt: ${new Date().toISOString()}`,
			``,
			`## Directions`,
			``,
			`### d1: ${theme}`,
			`- base: ${theme}`,
			`- elements: ${elStr}`,
			`- status: new`,
			`- score: 0`,
			`- rounds: 0`,
			``,
			`## History`,
			``,
			`(none yet)`,
			``,
			`## Config`,
			`- pauseStreakBelow: 4`,
			`- pauseStreakLength: 3`,
			``,
		].join("\n");
		mkdirSync(SESSION_DIR, { recursive: true });
		writeFileSync(JOURNAL_FILE, md);
		console.log(
			JSON.stringify(
				{
					type: "result",
					actionId: crypto.randomUUID(),
					data: { theme, mode, directions: ["d1"], journal: JOURNAL_FILE },
				},
				null,
				2,
			),
		);
		return;
	}

	// ---- All other commands: acquire session (auto-handshake if needed) ----
	const session = await acquireSession(botClient);
	const userId = getJwtUserId(session.accessToken);
	if (!userId) {
		console.error("Error: Invalid token.");
		process.exit(1);
	}

	// --canvas: explicitly target a canvas (skip auto-alignment)
	if (explicitCanvasId) {
		session.activeConvId = explicitCanvasId;
	}

	// ---- current: ask browser what canvas user is viewing ----
	if (cmd === "current") {
		const action: BotAction = {
			actionId: crypto.randomUUID(),
			sessionId: session.sessionId,
			timestamp: new Date().toISOString(),
			type: "get_current_canvas",
			includeTitle: true,
		};
		const result = await connectAndExecute(
			session,
			userId,
			`bot_ctrl:${userId}`,
			action,
			QUICK_PING_MS,
			botClient,
		);
		console.log(JSON.stringify(result, null, 2));
		return;
	}

	// ---- list ----
	if (cmd === "list") {
		const action: BotAction = {
			actionId: crypto.randomUUID(),
			sessionId: session.sessionId,
			timestamp: new Date().toISOString(),
			type: "list_canvases",
		};
		const result = await connectAndExecute(
			session,
			userId,
			`bot_ctrl:${userId}`,
			action,
			ACTION_TIMEOUT_MS,
			botClient,
		);
		console.log(JSON.stringify(result, null, 2));
		return;
	}

	// ---- search ----
	if (cmd === "search") {
		if (!args[1]) {
			console.error("Error: search requires a query string.");
			process.exit(1);
		}
		const action: BotAction = {
			actionId: crypto.randomUUID(),
			sessionId: session.sessionId,
			timestamp: new Date().toISOString(),
			type: "search_canvases",
			query: args[1],
		};
		const result = await connectAndExecute(
			session,
			userId,
			`bot_ctrl:${userId}`,
			action,
			ACTION_TIMEOUT_MS,
			botClient,
		);
		console.log(JSON.stringify(result, null, 2));
		return;
	}

	// ---- recall (via browser control channel) ----
	if (cmd === "recall") {
		const hasQuery = args[1] !== undefined && !args[1].startsWith("--");
		const query = hasQuery ? args[1] : "";
		const flags = args.slice(hasQuery ? 2 : 1);
		let limit = 10;
		let filterType: string | undefined;
		let filterConvId: string | undefined;
		for (let i = 0; i < flags.length; i++) {
			if (flags[i] === "--limit" && flags[i + 1]) {
				limit = parseInt(flags[i + 1], 10);
				i++;
			} else if (flags[i] === "--type" && flags[i + 1]) {
				filterType = flags[i + 1];
				i++;
			} else if (flags[i] === "--conv" && flags[i + 1]) {
				filterConvId = flags[i + 1];
				i++;
			}
		}
		if (filterConvId) assertUUID(filterConvId, "convId");
		const filters: Record<string, unknown> = {};
		if (filterType) filters.types = [filterType];
		if (filterConvId) filters.convId = filterConvId;
		const action: BotAction = {
			actionId: crypto.randomUUID(),
			sessionId: session.sessionId,
			timestamp: new Date().toISOString(),
			type: "recall",
			query,
			limit,
			filters: Object.keys(filters).length > 0 ? filters : undefined,
		};
		const result = await connectAndExecute(
			session,
			userId,
			`bot_ctrl:${userId}`,
			action,
			ACTION_TIMEOUT_MS,
			botClient,
		);
		console.log(JSON.stringify(result, null, 2));
		return;
	}

	// ---- recall-node (via browser control channel) ----
	if (cmd === "recall-node") {
		const convId = args[1];
		const nodeId = args[2];
		if (!convId || !nodeId) {
			console.error("Error: recall-node requires <convId> <nodeId>.");
			process.exit(1);
		}
		assertUUID(convId, "convId");
		assertUUID(nodeId, "nodeId");
		const action: BotAction = {
			actionId: crypto.randomUUID(),
			sessionId: session.sessionId,
			timestamp: new Date().toISOString(),
			type: "recall_node",
			convId,
			nodeId,
		};
		const result = await connectAndExecute(
			session,
			userId,
			`bot_ctrl:${userId}`,
			action,
			ACTION_TIMEOUT_MS,
			botClient,
		);
		console.log(JSON.stringify(result, null, 2));
		return;
	}

	// ---- read-db (via browser) ----
	if (cmd === "read-db") {
		// --conv <id> allows reading any canvas without switching away from the current one
		const { values: convValues, rest: readDbRest } = extractFlag(
			args.slice(1),
			"--conv",
		);
		const explicitConvId = convValues[0];
		if (explicitConvId) assertUUID(explicitConvId, "convId");
		const convId = explicitConvId || session.activeConvId;
		if (!convId) {
			console.error(
				"Error: No active canvas. Run: create-canvas or list → switch <id>",
			);
			process.exit(1);
		}
		assertUUID(convId, "convId");
		const flags = new Set(readDbRest.filter((a) => a.startsWith("--")));
		const positional = readDbRest.find((a) => !a.startsWith("--"));
		if (positional) assertUUID(positional, "nodeId");
		const action: BotAction = {
			actionId: crypto.randomUUID(),
			sessionId: session.sessionId,
			timestamp: new Date().toISOString(),
			type: "read_nodes",
			convId,
			nodeId: positional,
			full: flags.has("--full"),
			failed: flags.has("--failed"),
		};
		const result = await connectAndExecute(
			session,
			userId,
			`bot_ctrl:${userId}`,
			action,
			ACTION_TIMEOUT_MS,
			botClient,
		);
		console.log(JSON.stringify(result, null, 2));
		return;
	}

	// ---- clean-failed (via browser control channel) ----
	if (cmd === "clean-failed") {
		if (!session.activeConvId) {
			console.error(
				"Error: No active canvas. Run: create-canvas or list → switch <id>",
			);
			process.exit(1);
		}
		assertUUID(session.activeConvId, "activeConvId");
		const action: BotAction = {
			actionId: crypto.randomUUID(),
			sessionId: session.sessionId,
			timestamp: new Date().toISOString(),
			type: "clean_failed",
			convId: session.activeConvId,
		};
		const result = await connectAndExecute(
			session,
			userId,
			`bot_ctrl:${userId}`,
			action,
			ACTION_TIMEOUT_MS,
			botClient,
		);
		console.log(JSON.stringify(result, null, 2));
		return;
	}

	// ---- submit-batch: fire N submits over one connection ----
	if (cmd === "submit-batch") {
		// POSIX-style "--" separator: everything after the first bare "--" is a
		// literal prompt, never parsed as a flag. Lets users submit prompts that
		// legitimately start with "--" (otherwise the unknown-flag guard rejects them).
		const rawBatchArgs = args.slice(1);
		const sepIdx = rawBatchArgs.indexOf("--");
		const flagSegment =
			sepIdx === -1 ? rawBatchArgs : rawBatchArgs.slice(0, sepIdx);
		const literalPrompts =
			sepIdx === -1 ? [] : rawBatchArgs.slice(sepIdx + 1);

		const { values: followFlag, rest: batchRest0 } = extractFlag(
			flagSegment,
			"--follow",
		);
		const { values: modesBatchFlag, rest: batchRest1 } = extractFlag(
			batchRest0,
			"--mode",
		);
		const { values: modelsBatchFlag, rest: batchRest2 } = extractFlag(
			batchRest1,
			"--models",
		);
		// --model (singular) is a forgiving alias for --models with one model.
		// Without it, "--model x" leaks the flag value "x" as an extra prompt.
		const { values: modelBatchFlag, rest: batchRest3 } = extractFlag(
			batchRest2,
			"--model",
		);
		const { values: ratioBatchFlag, rest: batchRest4 } = extractFlag(
			batchRest3,
			"--ratio",
		);
		const { values: sizeBatchFlag, rest: batchRest } = extractFlag(
			batchRest4,
			"--size",
		);
		const follow = followFlag[0];
		if (follow) assertUUID(follow, "follow nodeId");
		const batchMode = modesBatchFlag[0]; // e.g. "image"
		if (batchMode && !VALID_MODES.has(batchMode)) {
			console.error(
				`Error: invalid mode "${batchMode}". Valid: ${Array.from(VALID_MODES).join(", ")}`,
			);
			process.exit(1);
		}
		// --model and --models are redundant ways to say the same thing; if both
		// are given the merge order is non-obvious, so warn rather than guess.
		if (modelsBatchFlag.length > 0 && modelBatchFlag.length > 0) {
			console.error(
				"[canvas-cowork] WARNING: both --models and --model given; merging both (--models first).",
			);
		}
		// Accept both --models "a,b" and --model "a"; merge into one list.
		const modelList = [
			...(modelsBatchFlag[0]?.split(",") ?? []),
			...modelBatchFlag,
		]
			.map((m) => m.trim())
			.filter(Boolean); // e.g. ["gpt-image-1.5", "seedream-v4.5"]
		// A model flag was supplied but resolved to nothing (e.g. --models "" or
		// --model "  "): that's a usage error, not a silent fall-through to default.
		if (
			(modelsBatchFlag.length > 0 || modelBatchFlag.length > 0) &&
			modelList.length === 0
		) {
			console.error(
				"Error: --models/--model was given but empty. Pass at least one model id, or omit the flag.",
			);
			process.exit(1);
		}
		const aspectRatio = ratioBatchFlag[0];
		const imageSize = sizeBatchFlag[0];

		// Fail fast on any leftover flag: never silently treat a flag value as a
		// prompt (historically "--size 2K" leaked "2K" as an extra generation).
		// A value-taking flag with no value (e.g. trailing "--ratio") also lands
		// here, since extractFlag only consumes a following non-flag token.
		const unknownFlag = batchRest.find((a) => a.startsWith("--"));
		if (unknownFlag) {
			console.error(
				`Error: submit-batch does not support "${unknownFlag}" (or it was given without a value).\n` +
					'Supported flags: --follow <nodeId> --mode <m> --models "m1,m2,..." (or --model <m>) --ratio <r> --size <s>\n' +
					'To submit a prompt that starts with "--", put it after a "--" separator.',
			);
			process.exit(1);
		}
		const prompts = [...batchRest, ...literalPrompts];
		if (!prompts.length) {
			console.error(
				'Error: submit-batch requires at least one prompt.\nUsage: submit-batch [--follow <nodeId>] [--mode <m>] [--models "m1,m2,..."] [--ratio <r>] [--size <s>] "prompt1" "prompt2" ...',
			);
			process.exit(1);
		}

		// Same footgun guard as single submit: image/video without a model lets
		// the canvas pick a default that has historically misrouted credits.
		if (
			batchMode &&
			modelList.length === 0 &&
			(batchMode === "image" || batchMode === "video")
		) {
			console.error(
				`[canvas-cowork] WARNING: submit-batch --mode ${batchMode} without --models/--model.`,
			);
			console.error(
				`  The canvas will pick a default model (bot default → first available).`,
			);
			console.error(
				`  Pass --models "<id>" (or --model <id>) to control which model runs;`,
			);
			console.error(`  run list-models ${batchMode} to see the active options.`);
		}

		if (!session.activeConvId) {
			session.activeConvId = "00000000-0000-0000-0000-000000000000";
		}
		assertUUID(session.activeConvId!, "activeConvId");
		const ch = `bot:${session.activeConvId}`;

		const client = new RealtimeLite(
			session.supabaseUrl,
			session.supabaseKey,
			session.accessToken,
		);
		try {
			await client.connect();
			await registerWithFrontend(client, session, userId, botClient);
			await ensureBrowserConnected(client, session, userId, botClient);
			await client.join(ch);

			// Journal the batch up front so an interrupt mid-run is recoverable:
			// each item flips pending → submitted/failed and is persisted as it lands.
			const batch: BatchRecord = {
				batchId: crypto.randomUUID(),
				convId: session.activeConvId!,
				mode: batchMode,
				models: modelList,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				total: prompts.length,
				items: prompts.map((prompt, index) => ({
					index,
					prompt,
					status: "pending" as const,
				})),
			};
			saveBatch(batch);
			console.error(
				`Batch ${batch.batchId} — ${prompts.length} prompts. ` +
					`Recover with: batches ${batch.batchId}`,
			);

			const makeAction = (fields: BotActionPayload): BotAction =>
				({
					actionId: crypto.randomUUID(),
					sessionId: session.sessionId,
					timestamp: new Date().toISOString(),
					...fields,
				}) as BotAction;

			for (let i = 0; i < prompts.length; i++) {
				const perModel =
					modelList.length > 0
						? modelList[Math.min(i, modelList.length - 1)]
						: undefined;
				const submitAction = makeAction({
					type: "submit",
					value: prompts[i],
					...(follow ? { follow } : {}),
					...(batchMode ? { mode: batchMode } : {}),
					...(perModel ? { model: perModel } : {}),
					...(aspectRatio ? { aspectRatio } : {}),
					...(imageSize ? { imageSize } : {}),
				});
				let qid: string | undefined;
				let ok = false;
				let failReason: "rate_limited" | "error" = "error";
				// LOCKED is the frontend's rate-limit signal (>30 actions/10s), not a
				// real failure — back off and retry instead of dropping the prompt.
				for (let attempt = 0; attempt <= BATCH_LOCKED_RETRIES; attempt++) {
					try {
						const resp = await sendAndWait(
							client,
							ch,
							submitAction,
							ORACLE_TIMEOUT_MS,
						);
						if (resp.type === "error" && (resp as any).code === "LOCKED") {
							// Still rate-limited. Retry with backoff while budget remains;
							// once exhausted, record it as rate_limited (not a hard error)
							// so a re-run knows it was throttled, not broken.
							failReason = "rate_limited";
							if (attempt < BATCH_LOCKED_RETRIES) {
								const backoff = 4_000 * (attempt + 1);
								console.error(
									`  [${i + 1}/${prompts.length}] rate-limited, backing off ${backoff / 1000}s...`,
								);
								await new Promise((r) => setTimeout(r, backoff));
								continue;
							}
						}
						qid =
							resp.type === "result"
								? (resp.data as any)?.questionNodeId
								: undefined;
						ok = resp.type === "result" && (resp.data as any)?.success !== false;
					} catch (e: any) {
						// One slow/failed submit shouldn't sink the rest of the batch.
						failReason = "error";
						console.error(`  [${i + 1}/${prompts.length}] error: ${e.message}`);
					}
					break;
				}
				batch.items[i].status = ok ? "submitted" : "failed";
				batch.items[i].questionNodeId = qid;
				if (!ok) batch.items[i].reason = failReason;
				saveBatch(batch);
				console.error(
					`  [${i + 1}/${prompts.length}] ${ok ? "✓" : "✗"} ${prompts[i].slice(0, 40)}...`,
				);

				// Brief pause so the cursor doesn't look frantic
				if (i < prompts.length - 1)
					await new Promise((r) => setTimeout(r, 500));
			}
			const submitted = batch.items.filter(
				(it) => it.status === "submitted",
			).length;
			console.log(
				JSON.stringify(
					{
						type: "result",
						actionId: crypto.randomUUID(),
						data: {
							batchId: batch.batchId,
							submitted,
							total: batch.total,
							results: batch.items.map((it) => ({
								prompt: it.prompt,
								questionNodeId: it.questionNodeId,
								success: it.status === "submitted",
								...(it.reason ? { reason: it.reason } : {}),
							})),
						},
					},
					null,
					2,
				),
			);
		} finally {
			client.close();
		}
		return;
	}

	// Build action
	const actionId = crypto.randomUUID();
	const base: BotActionBase = {
		actionId,
		sessionId: session.sessionId,
		timestamp: new Date().toISOString(),
		...(agentId ? { agentId } : {}),
	};
	let action: BotAction;
	let channelName: string;
	let timeout = ACTION_TIMEOUT_MS;

	const requireCanvas = () => {
		// activeConvId may be null if session was created while browser was on homepage.
		// The auto-align in connectAndExecute will detect the browser's actual canvas
		// via get_current_canvas — so we only need a placeholder here.
		// Use a dummy UUID that connectAndExecute will override.
		if (!session.activeConvId) {
			session.activeConvId = "00000000-0000-0000-0000-000000000000";
		}
		assertUUID(session.activeConvId!, "activeConvId");
	};
	const canvasCh = () => `bot:${session.activeConvId}`;

	switch (cmd) {
		// -- Control channel (any page) --
		case "ping":
			action = { ...base, type: "ping" };
			channelName = `bot_ctrl:${userId}`;
			break;
		case "create-canvas": {
			const rawTitle = args[1] || "Untitled";
			const title = rawTitle.startsWith("[") ? rawTitle : `[Bot] ${rawTitle}`;
			action = { ...base, type: "create_canvas", title };
			channelName = `bot_ctrl:${userId}`;
			break;
		}
		case "switch": {
			if (!args[1]) {
				console.error("Error: switch requires convId.");
				process.exit(1);
			}
			assertUUID(args[1], "convId");
			session.activeConvId = args[1];
			saveSession(session);
			action = { ...base, type: "switch_canvas", convId: args[1] };
			channelName = `bot_ctrl:${userId}`;
			break;
		}
		case "list-models": {
			action = { ...base, type: "list_models", chatMode: args[1] };
			channelName = `bot_ctrl:${userId}`;
			break;
		}

		// -- Canvas channel: atomic store operations --
		case "set-mode": {
			if (!args[1]) {
				console.error(
					"Error: set-mode requires mode (text|image|video|agent|neo).",
				);
				process.exit(1);
			}
			if (!VALID_MODES.has(args[1])) {
				console.error(
					`Error: invalid mode "${args[1]}". Valid modes: ${Array.from(VALID_MODES).join(", ")}`,
				);
				process.exit(1);
			}
			requireCanvas();
			action = { ...base, type: "set_mode", mode: args[1] };
			channelName = canvasCh();
			break;
		}
		case "set-model": {
			if (!args[1]) {
				console.error("Error: set-model requires model id.");
				process.exit(1);
			}
			requireCanvas();
			action = { ...base, type: "set_model", model: args[1] };
			channelName = canvasCh();
			break;
		}
		case "comment": {
			if (!args[1]) {
				console.error("Error: comment requires nodeId.");
				process.exit(1);
			}
			if (!args[2]) {
				console.error("Error: comment requires text.");
				process.exit(1);
			}
			requireCanvas();
			action = { ...base, type: "comment", nodeId: args[1], text: args[2] };
			channelName = canvasCh();
			break;
		}

		// -- Canvas channel: submit (triggers the full generation pipeline) --
		case "submit": {
			if (!args[1]) {
				console.error("Error: submit requires text.");
				process.exit(1);
			}
			requireCanvas();
			const { values: imagePaths } = extractFlag(args.slice(2), "--image");
			const { values: modeFlag } = extractFlag(args.slice(2), "--mode");
			const { values: modelFlag } = extractFlag(args.slice(2), "--model");
			const { values: followFlag } = extractFlag(args.slice(2), "--follow");
			const { values: ratioFlag } = extractFlag(args.slice(2), "--ratio");
			const { values: sizeFlag } = extractFlag(args.slice(2), "--size");
			const { values: durationFlag } = extractFlag(args.slice(2), "--duration");
			const hasLoop = args.slice(2).includes("--loop");
			const hasNoAudio = args.slice(2).includes("--no-audio");

			// Validate mode if provided
			let inlineMode: string | undefined;
			if (modeFlag.length > 0) {
				if (!VALID_MODES.has(modeFlag[0])) {
					console.error(
						`Error: invalid mode "${modeFlag[0]}". Valid: ${Array.from(VALID_MODES).join(", ")}`,
					);
					process.exit(1);
				}
				inlineMode = modeFlag[0] === "neo" ? "agent" : modeFlag[0];
			}
			const inlineModel = modelFlag[0];

			// Warn when --mode is supplied without --model on a billable generation
			// mode (image/video). Without --model the canvas picks a bot-default or
			// first-available model, which has historically routed traffic to the
			// wrong model and burned credits. Agent mode has no chargeable model.
			if (inlineMode && !inlineModel && (inlineMode === "image" || inlineMode === "video")) {
				console.error(
					`[canvas-cowork] WARNING: submit --mode ${inlineMode} without --model.`,
				);
				console.error(
					`  The canvas will pick a default model (bot default → first available).`,
				);
				console.error(
					`  To control which model runs, pass --model <id> explicitly, or run`,
				);
				console.error(
					`  list-models ${inlineMode} to see the active options.`,
				);
			}

			// In parallel mode or when --model is provided, bundle mode+model into
			// the submit action for atomic execution (no separate set_mode call).
			// In non-parallel mode without --model, fall back to separate set_mode
			// for backward compatibility with frontends that don't support inline mode.
			if (!parallelMode && inlineMode && !inlineModel) {
				const modeAction: BotAction = {
					...base,
					actionId: crypto.randomUUID(),
					type: "set_mode",
					mode: inlineMode,
				};
				const modeResult = await connectAndExecute(
					session,
					userId,
					canvasCh(),
					modeAction,
					ACTION_TIMEOUT_MS,
					botClient,
				);
				console.log(JSON.stringify(modeResult, null, 2));
				inlineMode = undefined; // Already applied, don't send again
			}

			// --follow: specify parent node for follow-up
			const follow = followFlag[0];
			if (follow) assertUUID(follow, "follow nodeId");
			const files =
				imagePaths.length > 0
					? await resolveImages(imagePaths, session)
					: undefined;
			const aspectRatio = ratioFlag[0];
			const imageSize = sizeFlag[0];
			const videoDuration = durationFlag[0];
			action = {
				...base,
				type: "submit",
				value: args[1],
				...(files ? { files } : {}),
				...(follow ? { follow } : {}),
				...(aspectRatio ? { aspectRatio } : {}),
				...(imageSize ? { imageSize } : {}),
				...(videoDuration ? { videoDuration } : {}),
				...(hasLoop ? { videoLoop: true } : {}),
				...(hasNoAudio ? { videoAudio: false } : {}),
				...(inlineMode ? { mode: inlineMode } : {}),
				...(inlineModel ? { model: inlineModel } : {}),
			};
			channelName = canvasCh();
			timeout = ORACLE_TIMEOUT_MS;
			break;
		}

		// -- Canvas channel: read / delete --
		case "read": {
			requireCanvas();
			action =
				args[1] && args[1] !== "--all"
					? { ...base, type: "read_node", nodeId: args[1] }
					: { ...base, type: "read_all_nodes" };
			channelName = canvasCh();
			break;
		}
		case "delete": {
			if (!args[1]) {
				console.error("Error: delete requires nodeId.");
				process.exit(1);
			}
			requireCanvas();
			action = { ...base, type: "delete_node", nodeId: args[1] };
			channelName = canvasCh();
			break;
		}
		case "delete-many": {
			if (args.length < 2) {
				console.error("Error: delete-many requires nodeIds.");
				process.exit(1);
			}
			requireCanvas();
			action = { ...base, type: "delete_nodes", nodeIds: args.slice(1) };
			channelName = canvasCh();
			break;
		}

		default:
			console.error(`Unknown command: ${cmd}`);
			printUsage();
			process.exit(1);
	}

	// Record submit time BEFORE connectAndExecute: the browser awaits full generation
	// before responding, so nodes are created long before the CLI receives the response.
	const preSubmitTime = new Date(Date.now() - 10_000).toISOString();

	const result = await connectAndExecute(
		session,
		userId,
		channelName,
		action,
		timeout,
		botClient,
		parallelMode ? { parallel: true } : undefined,
	);

	// Auto-set activeConvId after successful create_canvas (skip in parallel mode)
	if (
		!parallelMode &&
		action.type === "create_canvas" &&
		result.type === "result" &&
		(result.data as any)?.convId
	) {
		session.activeConvId = (result.data as any).convId;
		saveSession(session);
	}

	// Echo the model(s) that actually ran for a submit, so the user/agent can
	// confirm it matches their intent (especially after --mode without --model).
	if (
		action.type === "submit" &&
		result.type === "result" &&
		Array.isArray((result.data as any)?.models) &&
		(result.data as any).models.length > 0
	) {
		const models = (result.data as any).models as string[];
		console.error(`[canvas-cowork] submitted with model(s): ${models.join(", ")}`);
	}

	console.log(JSON.stringify(result, null, 2));

	// --wait: poll database until the generated node is finished
	if (
		action.type === "submit" &&
		args.some((a) => a === "--wait" || a.startsWith("--wait="))
	) {
		const waitArg = args.find((a) => a.startsWith("--wait"))!;
		const parsed = waitArg.includes("=")
			? parseInt(waitArg.split("=")[1], 10)
			: 300;
		if (waitArg.includes("=") && (!Number.isFinite(parsed) || parsed <= 0)) {
			console.error(
				`Warning: invalid --wait value "${waitArg.split("=")[1]}", defaulting to 300s`,
			);
		}
		const waitSec = Number.isFinite(parsed) && parsed > 0 ? parsed : 300;
		const deadline = Date.now() + waitSec * 1000;
		const convId = session.activeConvId!; // Already validated by requireCanvas() in submit

		console.error(`Waiting for generation (timeout: ${waitSec}s)...`);

		const submitTime = preSubmitTime;
		// Extract questionNodeId from submit response for precise polling
		const questionNodeId =
			result.type === "result"
				? (result.data as any)?.questionNodeId
				: undefined;

		// Poll via browser broadcast
		const pollClient = new RealtimeLite(
			session.supabaseUrl,
			session.supabaseKey,
			session.accessToken,
		);
		await pollClient.connect();
		const ctrlCh = `bot_ctrl:${userId}`;
		await pollClient.join(ctrlCh);
		let interval = 2_000;
		let pollCount = 0;
		try {
			while (Date.now() < deadline) {
				await new Promise((r) => setTimeout(r, interval));
				interval = Math.min(interval + Math.floor(interval * 0.5), 10_000);
				pollCount++;

				try {
					const pollAction: BotAction = {
						actionId: crypto.randomUUID(),
						sessionId: session.sessionId,
						timestamp: new Date().toISOString(),
						type: "poll_generation",
						convId,
						createdAfter: submitTime,
						...(questionNodeId ? { parentId: questionNodeId } : {}),
					};
					const resp = await sendAndWait(
						pollClient,
						ctrlCh,
						pollAction,
						ACTION_TIMEOUT_MS,
					);

					if (resp.type === "error") {
						console.error(
							`  poll #${pollCount} error: ${(resp as any).message}`,
						);
						continue;
					}

					const data = (resp as any).data;
					const status = data?.status;

					if (pollCount === 1 || pollCount % 5 === 0) {
						console.error(`  poll #${pollCount}: status: ${status ?? "none"}`);
					}

					if (status === "finished") {
						console.error("Generation finished.");
						console.log(
							JSON.stringify(
								{ type: "result", actionId: action.actionId, data: data.node },
								null,
								2,
							),
						);
						return;
					}
					if (status === "failed") {
						if (data.isNoCredits) {
							console.error("No credits remaining.");
							console.log(
								JSON.stringify({
									type: "error",
									actionId: action.actionId,
									code: "NO_CREDITS",
									message:
										"It looks like you've run out of credits. Visit /pricing to subscribe and keep creating: https://flowith.io/pricing",
									data: data.node,
								}),
							);
						} else {
							console.error("Generation failed.");
							console.log(
								JSON.stringify({
									type: "error",
									actionId: action.actionId,
									code: "GENERATION_FAILED",
									message: "Generation failed",
									data: data.node,
								}),
							);
						}
						return;
					}
				} catch (e: any) {
					console.error(`  poll #${pollCount} error: ${e.message}`);
				}
			}
		} finally {
			pollClient.close();
		}
		console.error(
			`Timed out after ${waitSec}s. Use 'read-db' to check node status manually.`,
		);
	}
}

function sendAndWait(
	client: RealtimeLite,
	ch: string,
	action: BotAction,
	timeout: number,
): Promise<BotResponse> {
	return new Promise((res, rej) => {
		const t = setTimeout(() => {
			cleanup();
			rej(
				new Error(
					`Timeout (${timeout / 1000}s). Is Flowith open on the correct canvas?`,
				),
			);
		}, timeout);
		const cleanup = client.onBroadcast(
			ch,
			BOT_EVENTS.RESPONSE,
			(r: BotResponse) => {
				if (r.actionId !== action.actionId || r.type === "ack") return;
				clearTimeout(t);
				cleanup();
				res(r);
			},
		);
		client.broadcast(ch, BOT_EVENTS.ACTION, action);
	});
}

function printUsage() {
	console.log(`
Canvas Bot CLI — Remote Flowith canvas control (zero dependencies)

Usage:  bun .claude/skills/canvas/canvas-bot.ts --bot <identity> <command> [args]

Global:
  --bot <identity>                Set bot cursor identity (claude-code|codex|openclaw|cursor|opencode|flowithos)

Commands:
  status [--live]                 Check session (--live also probes the browser tab)
  login | connect                 Establish/reuse a session, report browser state
  whoami                          Print the logged-in userId (no side effects)
  open [convId]                   Open Flowith in browser
  ping                            Test browser connection

  create-canvas [title]           Create new canvas (auto-switches, adds [Bot] prefix)
  switch <convId>                 Set active canvas
  list                            List recent canvases
  search "query"                  Search canvases by title (case-insensitive)
  list-models [mode]              List available models (text|image|video|agent)

  set-mode <mode>                 Set generation mode (text|image|video|agent|neo)
  set-model <model-id>            Set model
  submit "text" [--image <path-or-url>]... [--ratio <r>] [--size <s>] [--wait]
                                    Submit text with optional image(s)
                                    --image: local file (auto-uploaded) or URL
                                    In image mode: used as style reference
                                    In video mode: used as start/end frame
                                    In text mode: multimodal attachment
                                    --ratio: aspect ratio — VALUES ARE MODEL-SPECIFIC.
                                             Run list-models first and copy a value from the target
                                             model's supportedAspectRatios verbatim. Formats differ:
                                               gpt-image-2 → pixel strings ("1024x1024", "3840x2160")
                                               seedream-5 / gemini / kling → ratio strings ("16:9")
                                             Passing the wrong format is now rejected up front.
                                    --size: image resolution from the model's supportedImageSizes
                                             (e.g. gemini-3-pro-image: "1k" / "2k" / "4k").
                                    --duration: video duration in seconds (e.g. 5, 10)
                                    --loop: loop video (start frame = end frame)
                                    --no-audio: disable audio generation

  read [nodeId | --all]           Read node(s) from browser memory
  delete <nodeId>                 Delete node (via browser)
  delete-many <id1> <id2> ...     Delete multiple nodes (via browser)

  recall ["query"] [flags]         Search user's memory (fast DB match + AI fallback)
                                    --type <text|image|video|webpage>  Filter by content type
                                    --conv <convId>                    Scope to a conversation
                                    --limit <n>                        Max results (default 10)
                                    Empty query with --conv lists all entries on that canvas
  recall-node <convId> <nodeId>   Get bookshelf metadata for a specific node

  read-db [nodeId] [--failed] [--full] [--conv <convId>]
                                         Read nodes from database (default: summary)
                                         nodeId: drill into one node (full content)
                                         --full: all nodes with full content
                                         --failed: only failed nodes
                                         --conv: read from a different canvas (no switch)
  clean-failed                    Find & delete all failed nodes from database

  batches [batchId]               Audit submit-batch runs (recovery after timeout/interrupt)
                                         no arg: list recent batches
                                         batchId: per-prompt status + questionNodeIds

  dream-init "theme" [--mode m]   Initialize creative journal (default: image)

First run: browser opens automatically, log in to Flowith, done.
Journal stored in ~/.flowith/creative-journal.md — edit it directly.
Session stored in ~/.flowith/bot-session.json, expires in ~1 hour.
`);
}

main().catch((e) => {
	const message = e.message || String(e);
	const code =
		e instanceof BrowserConnectionError
			? e.code
			: message.includes("Timeout")
				? "TIMEOUT"
				: "UNKNOWN_ERROR";

	// Structured JSON to stdout so the calling agent can parse it
	console.log(JSON.stringify({ type: "error", actionId: null, code, message }));
	process.exit(1);
});
