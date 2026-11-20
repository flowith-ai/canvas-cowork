/**
 * Logging in once and staying logged in.
 *
 * `login` opens Flowith with `?cli_port&cli_nonce&cli_bot`; the signed-in page asks the user to
 * allow the agent (/connect-agent) and sends its session to this process's one-shot WebSocket on
 * 127.0.0.1. With the refresh token in it the CLI renews itself, so the browser is needed once.
 * Supabase rotates refresh tokens on use and the browser tab holds the same chain, so the CLI
 * refreshes late (only near expiry) and asks for `login` again if a refresh is refused.
 */

import { execFileSync, spawn } from "child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { type Api, CliError } from "./http";

/** Where Flowith 3.0 lives. Becomes https://flowith.io once 3.0 is the main site. */
export const DEFAULT_SITE = "https://beta.flowith.io";

export interface Session {
	site: string;
	supabaseUrl: string;
	supabaseKey: string;
	accessToken: string;
	refreshToken?: string;
	workerURL: string;
	/** The canvas commands act on unless told otherwise. */
	canvas?: string;
	/** The browser's name for this connection, and the key it gave it for canvas operations (lib/live.ts). */
	botSessionId?: string;
	agentKey?: string;
	/** When Supabase last confirmed this sign-in is still on (a Disconnect in Flowith ends it). */
	checkedAt?: number;
	savedAt: string;
}

export const home = () => process.env.FLOWITH_HOME || join(homedir(), ".flowith");
const sessionFile = () => join(home(), "canvas-session.json");

export function siteUrl(site?: string): string {
	const url = (site || process.env.FLOWITH_URL || DEFAULT_SITE).trim().replace(/\/+$/, "").replace(/\/blank$/, "");
	return /^https?:\/\//.test(url) ? url : `https://${url}`;
}

export function loadSession(): Session | null {
	const file = sessionFile();
	if (!existsSync(file)) return null;
	try {
		const s = JSON.parse(readFileSync(file, "utf8")) as Session;
		return s.accessToken && s.supabaseUrl ? s : null;
	} catch {
		return null;
	}
}

/** Written whole or not at all (a temp file renamed over it), owner-only. */
export function saveSession(s: Session) {
	mkdirSync(home(), { recursive: true });
	const tmp = `${sessionFile()}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
	renameSync(tmp, sessionFile());
	try {
		chmodSync(sessionFile(), 0o600);
	} catch {}
}

export function forgetSession() {
	try {
		unlinkSync(sessionFile());
	} catch {}
}

/** The previous canvas-cowork's login (bot-session.json): a copy of the browser's own session, never renewed here. */
const oldLoginFile = () => join(home(), "bot-session.json");

/** Deletes the previous canvas-cowork's login file, if any (it shares the browser's sign-in, so it is not signed out). */
export function forgetOldLogin(): boolean {
	if (!existsSync(oldLoginFile())) return false;
	try {
		unlinkSync(oldLoginFile());
		return true;
	} catch {
		return false;
	}
}

/**
 * Ends this CLI's sign-in and forgets it here. The worker ends it (/user/agent-session/end) only if it is an agent
 * sign-in issued to this user, so a login an older page made from the browser's own session is never signed out (that
 * would sign the browser out); such a login is only forgotten here. When Flowith can't be reached, nothing is
 * forgotten: run `logout` again, or Disconnect the agent in Flowith.
 */
export async function logout(): Promise<{ ended: boolean; note?: string }> {
	if (!loadSession()) return { ended: false, note: "Not logged in here." };
	let s: Session;
	try {
		s = await activeSession();
	} catch (e) {
		// Supabase said it was ended already (Disconnect in Flowith); anything else (offline, an error) leaves it be.
		if (e instanceof CliError && (e.data as { ended?: boolean } | undefined)?.ended) {
			forgetSession();
			return { ended: true };
		}
		return { ended: false, note: "Couldn't reach Flowith to end this sign-in; nothing was forgotten. Run `logout` again, or Disconnect the agent in Flowith." };
	}
	const sessionId = jwtClaims(s.accessToken).session_id;
	const resp = await fetch(`${s.workerURL}/user/agent-session/end`, {
		method: "POST",
		headers: { Authorization: s.accessToken, "Content-Type": "application/json" },
		body: JSON.stringify({ sessionIds: [sessionId] }),
		signal: AbortSignal.timeout(15_000),
	}).catch(() => null);
	const body = resp?.ok ? ((await resp.json().catch(() => ({}))) as { ended?: string[] }) : undefined;
	if (!body) return { ended: false, note: "Couldn't reach Flowith to end this sign-in; nothing was forgotten. Run `logout` again, or Disconnect the agent in Flowith." };
	forgetSession();
	return body.ended?.includes(String(sessionId))
		? { ended: true }
		: { ended: false, note: "Flowith doesn't know this login as an agent sign-in (an older page gave the browser's own); it was only forgotten here. Signing out of Flowith in that browser ends it." };
}

/** The worker a site's pages use: production talks to edge, the beta and previews to the dev worker. */
export function workerFor(site: string): string {
	return /^https:\/\/(www\.)?flowith\.io$/.test(siteUrl(site)) ? "https://edge.flowith.io" : "https://dev-edge.flowith.io";
}

export function jwtClaims(jwt: string): { sub?: string; exp?: number; email?: string; session_id?: string } {
	try {
		return JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8"));
	} catch {
		return {};
	}
}

/** Renew when this much of the token's life is left: a video wait outlives a few minutes. */
const REFRESH_AHEAD_MS = 20 * 60_000;

/** The session, refreshed when it is about to expire (or `force`). Throws NOT_LOGGED_IN when there is none. */
export async function activeSession(opts: { force?: boolean; confirm?: boolean } = {}): Promise<Session> {
	const s = loadSession();
	if (!s) throw new CliError("Not logged in. Run `login` once (opens Flowith in your browser).", "NOT_LOGGED_IN");
	// The session belongs to the site it was allowed on; only an explicit FLOWITH_URL elsewhere asks for a new login.
	if (process.env.FLOWITH_URL && s.site !== siteUrl())
		throw new CliError(`Logged in to ${s.site}, but FLOWITH_URL is ${siteUrl()}. Run \`login\` again.`, "NOT_LOGGED_IN");
	const exp = (jwtClaims(s.accessToken).exp ?? 0) * 1000;
	if (!opts.force && exp - Date.now() > REFRESH_AHEAD_MS) return confirmed(s, opts.confirm);
	if (!s.refreshToken) {
		if (exp > Date.now()) return s;
		throw new CliError("Session expired. Run `login` again.", "NOT_LOGGED_IN");
	}
	const resp = await fetch(`${s.supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
		method: "POST",
		headers: { apikey: s.supabaseKey, "Content-Type": "application/json" },
		body: JSON.stringify({ refresh_token: s.refreshToken }),
		signal: AbortSignal.timeout(20_000),
	}).catch(() => null);
	const body = resp
		? ((await resp.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; error_description?: string; error?: string; error_code?: string; msg?: string })
		: {};
	// Supabase Auth answers {error, error_description} or, newer, {code, error_code, msg}.
	const why = [body.error_code, body.msg, body.error, body.error_description].filter(Boolean).join(": ");
	if (!resp?.ok || !body.access_token) {
		// Another command may have renewed it a moment ago: use what it saved.
		const latest = loadSession();
		if (latest && latest.accessToken !== s.accessToken && (jwtClaims(latest.accessToken).exp ?? 0) * 1000 > Date.now()) return latest;
		// Only a refused refresh token is dropped; a network or server error leaves it for the next try.
		if (resp && (resp.status === 400 || resp.status === 401) && /invalid|not valid|revoked|not.found|already.used|expired/i.test(why)) {
			delete s.refreshToken;
			saveSession(s);
			throw new CliError(`The login was ended (${why}). Run \`login\` again.`, "NOT_LOGGED_IN", { ended: true });
		}
		if (exp > Date.now()) return s;
		throw new CliError(`Couldn't renew the session (${why || resp?.status || "network error"}). Try again, or run \`login\`.`, "NOT_LOGGED_IN");
	}
	const latest = loadSession() ?? s;
	const next: Session = { ...latest, accessToken: body.access_token, ...(body.refresh_token ? { refreshToken: body.refresh_token } : {}), checkedAt: Date.now(), savedAt: new Date().toISOString() };
	saveSession(next);
	return next;
}

/**
 * How often a command asks Supabase whether the sign-in is still on, between renewals: when it starts and, in a long
 * run, as it goes. (FLOWITH_SIGNIN_CHECK_MS only shortens it for tests.)
 */
const checkEveryMs = () => Number(process.env.FLOWITH_SIGNIN_CHECK_MS) || 2 * 60_000;

/**
 * The session, once Supabase has confirmed in the last two minutes that it is still on: a Disconnect in Flowith (or
 * `logout` elsewhere) ends it at once there, while its access token would otherwise keep working until it expires.
 */
async function confirmed(s: Session, now = false): Promise<Session> {
	// A command starting skips the check when another one made it lately; a long command's own check (`now`) never does.
	if (!s.refreshToken || (!now && Date.now() - (s.checkedAt ?? 0) < checkEveryMs())) return s;
	const resp = await fetch(`${s.supabaseUrl}/auth/v1/user`, {
		headers: { apikey: s.supabaseKey, Authorization: `Bearer ${s.accessToken}` },
		signal: AbortSignal.timeout(10_000),
	}).catch(() => null);
	// Only a definite "no such session" ends it here; a network blip is checked again next time.
	if (resp && (resp.status === 401 || resp.status === 403)) {
		// Unless another command logged in again meanwhile.
		if (loadSession()?.accessToken === s.accessToken) forgetSession();
		throw new CliError("This sign-in was ended (Disconnected in Flowith, or `logout`). Run `login` again.", "NOT_LOGGED_IN", { ended: true });
	}
	if (!resp?.ok) return s;
	// Saved over what is on disk only if no other command renewed it meanwhile (its newer tokens must not be lost).
	const latest = loadSession();
	if (latest && latest.accessToken !== s.accessToken) return latest;
	const next = { ...s, checkedAt: Date.now() };
	saveSession(next);
	return next;
}

export function apiOf(s: Session, agent: string): Api {
	const api: Api = { supabaseUrl: s.supabaseUrl, supabaseKey: s.supabaseKey, accessToken: s.accessToken, workerURL: s.workerURL, agent };
	// The login this command began with: if another terminal meanwhile logged in to another account or site, this command
	// stops rather than carry on (and spend) as someone else.
	const who = jwtClaims(s.accessToken).sub;
	const same = (next: Session) => {
		if (jwtClaims(next.accessToken).sub !== who || next.site !== s.site)
			throw new CliError("The login here changed while this command ran (another terminal logged in to another account or site). Run the command again.", "NOT_LOGGED_IN");
		return next;
	};
	api.renew = async () => {
		api.accessToken = same(await activeSession({ force: true })).accessToken;
	};
	// A long command (a clip's wait) asks Flowith again as it goes: a Disconnect stops it within the interval, not only
	// the next command.
	let asked = Date.now();
	api.recheck = async () => {
		if (Date.now() - asked < checkEveryMs()) return;
		asked = Date.now();
		api.accessToken = same(await activeSession({ confirm: true })).accessToken;
	};
	return api;
}

export function userIdOf(s: Pick<Session, "accessToken">): string {
	const sub = jwtClaims(s.accessToken).sub;
	if (!sub) throw new CliError("The session has no user. Run `login` again.", "NOT_LOGGED_IN");
	return sub;
}

// ---------- login ----------

/** The macOS default browser's bundle id, or null. */
function macDefaultBrowser(): string | null {
	try {
		const out = execFileSync(
			"defaults",
			["read", join(homedir(), "Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure"), "LSHandlers"],
			{ encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
		);
		const m = out.match(/LSHandlerRoleAll = "([^"]+)";\s*LSHandlerURLScheme = https;/);
		return m?.[1]?.toLowerCase() ?? null;
	} catch {
		return null;
	}
}

/**
 * Opens the URL. Safari refuses a page's connection to ws://127.0.0.1, so on a Mac whose default is
 * Safari another installed browser is used when there is one.
 */
function openBrowser(url: string): boolean {
	try {
		if (process.platform === "darwin") {
			const def = macDefaultBrowser();
			if (!def || def.includes("safari")) {
				for (const app of ["Google Chrome", "Arc", "Microsoft Edge", "Brave Browser", "Chromium", "Firefox"]) {
					if (existsSync(`/Applications/${app}.app`)) {
						spawn("open", ["-a", app, url], { stdio: "ignore", detached: true }).unref();
						return true;
					}
				}
			}
			spawn("open", [url], { stdio: "ignore", detached: true }).unref();
			return true;
		}
		if (process.platform === "win32") {
			spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true }).unref();
			return true;
		}
		spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();
		return true;
	} catch {
		return false;
	}
}

export function openUrl(url: string) {
	return openBrowser(url);
}

interface HandshakeSession {
	nonce: string;
	supabaseUrl: string;
	supabaseKey: string;
	accessToken: string;
	refreshToken?: string;
	workerURL?: string;
	activeConvId?: string;
	sessionId?: string;
	agentKey?: string;
}

/** Flowith's Supabase project and its public (publishable) key, as the web app ships them. */
const SUPABASE_URL = process.env.FLOWITH_SUPABASE_URL || "https://aibdxsebwhalbnugsqel.supabase.co";
const SUPABASE_KEY = process.env.FLOWITH_SUPABASE_KEY || "sb_publishable_qPCinc8LE8ChpdT7Pf79tQ_eryz5udr";

/**
 * Opens Flowith, waits for the user to allow the agent, saves the session.
 *
 * The page hands the session back sealed to this process's one-time key over the Realtime topic
 * `cli-login:<code>` (works in every browser: nothing touches the computer's own network). Pages
 * from before that also find a WebSocket on 127.0.0.1 here.
 */
export async function login(agent: string, log: (m: string) => void, opts: { open?: boolean; site?: string } = {}): Promise<Session> {
	const { Realtime, loginKeys, openSealed, ackProof, loginCode, verificationCode } = await import("./realtime");
	const site = siteUrl(opts.site);
	const nonce = crypto.randomUUID();
	const code = loginCode();
	const keys = await loginKeys();
	const topic = `cli-login:${code}`;
	const relay = new Realtime(SUPABASE_URL, SUPABASE_KEY);
	let relayReady = false;
	try {
		await relay.connect();
		await relay.join(topic);
		relayReady = true;
	} catch (e) {
		log(`(Couldn't reach Flowith's realtime service: ${(e as Error).message}; using the local connection only.)`);
	}

	return new Promise<Session>((resolve, reject) => {
		let done = false;
		const finish = (fn: () => void) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			setTimeout(() => {
				server.stop(true);
				relay.close();
			}, 300);
			fn();
		};
		const accept = (d: HandshakeSession) => {
			if (!d || d.nonce !== nonce || !d.accessToken) return false;
			const s: Session = {
				site,
				supabaseUrl: d.supabaseUrl,
				supabaseKey: d.supabaseKey,
				accessToken: d.accessToken,
				...(d.refreshToken ? { refreshToken: d.refreshToken } : {}),
				workerURL: (d.workerURL || "https://edge.flowith.io").replace(/\/$/, ""),
				...(d.activeConvId ? { canvas: d.activeConvId } : {}),
				...(d.sessionId && d.agentKey ? { botSessionId: d.sessionId, agentKey: d.agentKey } : {}),
				savedAt: new Date().toISOString(),
			};
			saveSession(s);
			finish(() => resolve(s));
			return true;
		};
		const refuse = (type: string) => {
			if (type === "denied") finish(() => reject(new CliError("You declined the connection in the browser.", "LOGIN_DENIED")));
			if (type === "not_logged_in")
				finish(() => reject(new CliError("Not signed in to Flowith in that browser. Sign in, then run `login` again.", "NOT_LOGGED_IN")));
		};

		if (relayReady) {
			relay.on(topic, "cli_login", async (payload: { type?: string; epk?: string; iv?: string; ct?: string }) => {
				if (payload?.type === "sealed" && payload.epk && payload.iv && payload.ct) {
					try {
						const opened = await openSealed(keys.privateKey, code, payload as { epk: string; iv: string; ct: string });
						const message = opened.message as { type?: string; data?: HandshakeSession };
						if (message.type === "session" && message.data && accept(message.data))
							relay.broadcast(topic, "cli_login_ack", await ackProof(opened.key, code, nonce));
					} catch {
						// Not sealed to our key: ignore.
					}
				} else if (payload?.type === "denied" || payload?.type === "not_logged_in") {
					relay.broadcast(topic, "cli_login_ack", { ok: true });
					refuse(payload.type);
				}
			});
		}

		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch(req, srv) {
				if (srv.upgrade(req)) return undefined;
				return new Response("canvas-cowork login", { status: 200 });
			},
			websocket: {
				message(ws, raw) {
					let msg: { type?: string; data?: HandshakeSession };
					try {
						msg = JSON.parse(String(raw));
					} catch {
						return;
					}
					if (msg.type === "denied" || msg.type === "not_logged_in") {
						ws.send(JSON.stringify({ ok: true }));
						refuse(msg.type);
						return;
					}
					if (msg.type === "session" && msg.data && accept(msg.data)) ws.send(JSON.stringify({ ok: true }));
					else ws.send(JSON.stringify({ error: "bad request" }));
				},
			},
		});
		const params = new URLSearchParams({ cli_nonce: nonce, cli_bot: agent, cli_port: String(server.port), ...(relayReady ? { cli_code: code, cli_key: keys.publicKey } : {}) });
		const url = `${site}/?${params}`;
		const timer = setTimeout(
			() =>
				finish(() =>
					reject(new CliError(`No answer from the browser within 2.5 minutes. Run \`login\` again and click Allow on the Flowith page.`, "LOGIN_TIMEOUT")),
				),
			150_000,
		);
		const opened = opts.open !== false && openBrowser(url);
		log(
			[
				opened ? "Opened Flowith in your browser — sign in if asked, then click Allow." : "Open this link in a browser, sign in and click Allow:",
				relayReady ? `When the page asks, type this code: ${verificationCode(code)}` : "",
				"(If the browser asks whether the page may connect to apps on this device, allow it.)",
				opened ? `If nothing opened, visit: ${url}` : url,
			]
				.filter(Boolean)
				.join("\n"),
		);
	});
}
