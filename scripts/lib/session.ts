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
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
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
	savedAt: string;
}

export const home = () => process.env.FLOWITH_HOME || join(homedir(), ".flowith");
const sessionFile = () => join(home(), "canvas-session.json");

export function siteUrl(): string {
	return (process.env.FLOWITH_URL || DEFAULT_SITE).replace(/\/+$/, "").replace(/\/blank$/, "");
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

export function saveSession(s: Session) {
	mkdirSync(home(), { recursive: true });
	writeFileSync(sessionFile(), JSON.stringify(s, null, 2), { mode: 0o600 });
	try {
		chmodSync(sessionFile(), 0o600);
	} catch {}
}

export function forgetSession() {
	try {
		unlinkSync(sessionFile());
	} catch {}
}

export function jwtClaims(jwt: string): { sub?: string; exp?: number; email?: string } {
	try {
		return JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8"));
	} catch {
		return {};
	}
}

const REFRESH_AHEAD_MS = 5 * 60_000;

/** The session, refreshed when it is about to expire. Throws NOT_LOGGED_IN when there is none. */
export async function activeSession(): Promise<Session> {
	const s = loadSession();
	if (!s) throw new CliError("Not logged in. Run `login` once (opens Flowith in your browser).", "NOT_LOGGED_IN");
	if (s.site !== siteUrl())
		throw new CliError(`Logged in to ${s.site}, but FLOWITH_URL is ${siteUrl()}. Run \`login\` again.`, "NOT_LOGGED_IN");
	const exp = (jwtClaims(s.accessToken).exp ?? 0) * 1000;
	if (exp - Date.now() > REFRESH_AHEAD_MS) return s;
	if (!s.refreshToken) throw new CliError("Session expired. Run `login` again.", "NOT_LOGGED_IN");
	const resp = await fetch(`${s.supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
		method: "POST",
		headers: { apikey: s.supabaseKey, "Content-Type": "application/json" },
		body: JSON.stringify({ refresh_token: s.refreshToken }),
		signal: AbortSignal.timeout(20_000),
	});
	const body = (await resp.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; error_description?: string };
	if (!resp.ok || !body.access_token) {
		delete s.refreshToken;
		saveSession(s);
		throw new CliError(
			`Session expired and could not be renewed (${body.error_description ?? resp.status}). Run \`login\` again.`,
			"NOT_LOGGED_IN",
		);
	}
	s.accessToken = body.access_token;
	if (body.refresh_token) s.refreshToken = body.refresh_token;
	s.savedAt = new Date().toISOString();
	saveSession(s);
	return s;
}

export function apiOf(s: Session, agent: string): Api {
	return { supabaseUrl: s.supabaseUrl, supabaseKey: s.supabaseKey, accessToken: s.accessToken, workerURL: s.workerURL, agent };
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
}

/** Opens Flowith, waits for the user to allow the agent, saves the session. */
export async function login(agent: string, log: (m: string) => void, opts: { open?: boolean } = {}): Promise<Session> {
	const site = siteUrl();
	const nonce = crypto.randomUUID();
	return new Promise<Session>((resolve, reject) => {
		let done = false;
		const finish = (fn: () => void) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			setTimeout(() => server.stop(true), 50);
			fn();
		};
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
					if (msg.type === "denied") {
						ws.send(JSON.stringify({ ok: true }));
						finish(() => reject(new CliError("You declined the connection in the browser.", "LOGIN_DENIED")));
						return;
					}
					if (msg.type === "not_logged_in") {
						ws.send(JSON.stringify({ ok: true }));
						finish(() => reject(new CliError("Not signed in to Flowith in that browser. Sign in, then run `login` again.", "NOT_LOGGED_IN")));
						return;
					}
					if (msg.type !== "session" || !msg.data || msg.data.nonce !== nonce) {
						ws.send(JSON.stringify({ error: "bad request" }));
						return;
					}
					const d = msg.data;
					const s: Session = {
						site,
						supabaseUrl: d.supabaseUrl,
						supabaseKey: d.supabaseKey,
						accessToken: d.accessToken,
						...(d.refreshToken ? { refreshToken: d.refreshToken } : {}),
						workerURL: (d.workerURL || "https://edge.flowith.io").replace(/\/$/, ""),
						...(d.activeConvId ? { canvas: d.activeConvId } : {}),
						savedAt: new Date().toISOString(),
					};
					saveSession(s);
					ws.send(JSON.stringify({ ok: true }));
					finish(() => resolve(s));
				},
			},
		});
		const url = `${site}/?cli_port=${server.port}&cli_nonce=${nonce}&cli_bot=${encodeURIComponent(agent)}`;
		const timer = setTimeout(
			() =>
				finish(() =>
					reject(
						new CliError(
							`No answer from the browser within 2 minutes. Open this URL in a browser on this computer (not Safari), sign in and click Allow:\n${url}`,
							"LOGIN_TIMEOUT",
						),
					),
				),
			150_000,
		);
		const opened = opts.open !== false && openBrowser(url);
		log(
			opened
				? `Opened Flowith in your browser — sign in if asked, then click Allow.\nIf nothing opened, visit: ${url}`
				: `Open this URL in a browser on this computer, sign in and click Allow:\n${url}`,
		);
	});
}
