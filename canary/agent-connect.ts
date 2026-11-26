#!/usr/bin/env node
/**
 * Agent Connect canary: the whole hosted-MCP loop a user's agent goes through, with no person, so a host, upstream or
 * deploy change is caught before a user hits it (Agent Connect v2, design rule 8).
 *
 *   node canary/agent-connect.ts [--target next-gen|flowith] [--job hourly|<name>] [--email agent-qa-…@flowith.cc]
 *                                [--image auto|always|never] [--alert] [--test]
 *
 * discovery → register (DCR) → authorize → consent (the account's own browser session reads the request and clicks
 * Allow through the same endpoints the consent page calls) → code + state + iss → token → MCP initialize, tools,
 * list_canvases, credits, the canary canvas → a free write (create_canvas_node, read back, removed again) and a relayed
 * step with no canvas open (needs_canvas with a handoffUrl) → generate_image + get_task when asked (it spends credits:
 * the charge must equal the quote) → read_canvas → open_canvas → redeem the side-tab ticket (single use) → refresh →
 * agent-sessions names the client → disconnect → the MCP refuses the token. It ends only the sessions it opened (its
 * own client's), even when a step fails, and signs its browser session out at the end: other agents may share the
 * account.
 *
 * Schedules (Agent.Space, this Mac): hourly `--image never` on agent-qa-canary (no credits spent); once a day
 * `--job daily-image --image always` on an account with starter credits. Each job keeps its own state (mute, recovery).
 *
 * The account is an internal test account (agent-qa-…@flowith.cc, a free user). Its browser session is minted the way
 * hypergpt-frontend's visual-ux-audit sign-in-as.mjs does: the Supabase secret key (env SUPABASE_SECRET_KEY, else the
 * Supabase CLI, in memory only, never printed) makes a magic link, which is exchanged for a session. No email is sent.
 *
 * --alert posts a Feishu card on failure (and once on recovery) to CANARY_FEISHU_WEBHOOK; a repeat of the same failing
 * step is muted for 6 hours. Settings can live in canary/.env (git-ignored): CANARY_FEISHU_WEBHOOK, SUPABASE_SECRET_KEY.
 * --test marks the card "[canary test, ignore]" and skips the mute and the saved state.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

export const TARGETS = {
	"next-gen": {
		site: "https://next-gen.flowith.io",
		issuer: "https://dev-edge.flowith.io",
		mcp: "https://flowith-creator-agent-preview.fly.dev/mcp",
	},
	flowith: {
		site: "https://flowith.io",
		issuer: "https://edge.flowith.io",
		mcp: "https://agent.flowith.io/mcp",
	},
} as const;
export type TargetName = keyof typeof TARGETS;

/** Flowith's Supabase project and its publishable key, as the web app (and scripts/lib/session.ts) ship them. */
const SUPABASE_URL = process.env.FLOWITH_SUPABASE_URL || "https://aibdxsebwhalbnugsqel.supabase.co";
const SUPABASE_KEY = process.env.FLOWITH_SUPABASE_KEY || "sb_publishable_qPCinc8LE8ChpdT7Pf79tQ_eryz5udr";

export const CLIENT_NAME = "Flowith Canary";
export const CANVAS_TITLE = "Agent Connect canary";
const REDIRECT = "http://127.0.0.1:53682/callback";
/** The tools the loop needs; the rest of the server's list is reported, not required. */
export const REQUIRED_TOOLS = ["get_started", "list_canvases", "create_canvas", "open_canvas", "read_canvas", "find_canvas_nodes", "create_canvas_node", "focus_canvas_nodes", "generate_image", "get_task", "credits"];
/** Credits are counted to the cent: a charge further from its quote than this is a mismatch. */
const CHARGE_TOLERANCE = 0.005;
/** How long after a generation is done the balance is read again, so a late settlement is counted. */
const SETTLE_MS = 8_000;
const MUTE_MS = 6 * 3600_000;
const IMAGE_EVERY_MS = 23 * 3600_000;

export interface Options {
	target: TargetName;
	/** Which schedule this run is: its own state file, named in the alert. */
	job: string;
	site: string;
	issuer: string;
	mcp: string;
	email: string;
	image: "auto" | "always" | "never";
	imageModel: string;
	alert: boolean;
	test: boolean;
	json: boolean;
}

export function parseArgs(argv: string[], env: Record<string, string | undefined> = process.env): Options {
	const flags = new Map<string, string>();
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] ?? "";
		if (!arg.startsWith("--")) throw new Error(`Unknown argument "${arg}"`);
		const [key, inline] = arg.slice(2).split("=", 2) as [string, string | undefined];
		if (["alert", "test", "json"].includes(key)) flags.set(key, "1");
		else flags.set(key, inline ?? argv[++i] ?? "");
	}
	const known = ["target", "job", "site", "issuer", "mcp", "email", "image", "image-model", "alert", "test", "json"];
	for (const key of flags.keys()) if (!known.includes(key)) throw new Error(`Unknown flag --${key}`);
	const target = (flags.get("target") ?? env.CANARY_TARGET ?? "next-gen") as TargetName;
	if (!Object.hasOwn(TARGETS, target)) throw new Error(`--target must be ${Object.keys(TARGETS).join(" or ")}`);
	const email = flags.get("email") ?? env.CANARY_EMAIL ?? "agent-qa-canary@flowith.cc";
	if (!/^agent-qa-[a-z0-9-]+@flowith\.cc$/.test(email)) throw new Error(`Only agent-qa-<name>@flowith.cc test accounts; got "${email}"`);
	const job = flags.get("job") ?? env.CANARY_JOB ?? "hourly";
	if (!/^[a-z0-9-]{1,40}$/.test(job)) throw new Error(`--job must be a short lowercase name; got "${job}"`);
	const image = flags.get("image") ?? "auto";
	if (!["auto", "always", "never"].includes(image)) throw new Error("--image must be auto, always or never");
	const preset = TARGETS[target];
	const origin = (url: string) => url.replace(/\/+$/, "");
	return {
		target,
		job,
		site: origin(flags.get("site") ?? preset.site),
		issuer: origin(flags.get("issuer") ?? preset.issuer),
		mcp: flags.get("mcp") ?? preset.mcp,
		email,
		image: image as Options["image"],
		imageModel: flags.get("image-model") ?? "z-image-turbo",
		alert: flags.has("alert"),
		test: flags.has("test"),
		json: flags.has("json"),
	};
}

export interface State {
	lastImageAt?: string;
	lastOkAt?: string;
	failing?: { step: string; since: string; alertedAt?: string };
}

export const imageDue = (opts: Pick<Options, "image">, state: State, now: number) =>
	opts.image === "always" || (opts.image === "auto" && (!state.lastImageAt || now - Date.parse(state.lastImageAt) >= IMAGE_EVERY_MS));

/** What to post after a run: a failure card unless the same step already alerted in the last 6 hours, a recovery card
 * once after a failure, nothing on a normal pass. */
export function alertDecision(state: State, result: { ok: true } | { ok: false; step: string }, now: number, test = false): "failure" | "recovery" | null {
	if (result.ok) return state.failing?.alertedAt && !test ? "recovery" : null;
	if (test) return "failure";
	const last = state.failing;
	if (last?.step === result.step && last.alertedAt && now - Date.parse(last.alertedAt) < MUTE_MS) return null;
	return "failure";
}

export interface Report {
	ok: boolean;
	target: TargetName;
	job?: string;
	/** Whether this run made an image (the daily job), for the card's subtitle. */
	imageRun?: boolean;
	step?: string;
	error?: string;
	startedAt: string;
	ms: number;
	log: string[];
	creditsSpent?: number;
	/** What generate_image quoted, to compare with creditsSpent. */
	creditsQuoted?: number;
	/** The balance after the run, for sizing the cadence; never put in the alert. */
	creditsLeft?: number;
	/** Why the image step didn't make an image this run, when it was due. */
	imageSkipped?: string;
}

/** A Feishu interactive card in the shape flo-workers' alerts use (model-attempt-monitor.ts). */
export function buildCard(report: Report, opts: Pick<Options, "site" | "issuer" | "mcp" | "test">, kind: "failure" | "recovery") {
	const prefix = opts.test ? "[canary test, ignore] " : "";
	const failed = kind === "failure";
	const lines = failed
		? [
				`**Step:** ${report.step}`,
				`**Error:** ${report.error}`,
				`**Started:** ${report.startedAt} (${Math.round(report.ms / 1000)} s)`,
				`**Site / issuer / MCP:** ${opts.site} · ${opts.issuer} · ${opts.mcp}`,
				"**Last steps:**",
				...report.log.slice(-8).map((line) => `- ${line}`),
				"Rerun: `node canary/agent-connect.ts --target " + report.target + "` in canvas-cowork.",
			]
		: [`The whole loop passed again at ${report.startedAt} (${Math.round(report.ms / 1000)} s).`];
	return {
		schema: "2.0",
		config: { update_multi: true, wide_screen_mode: true },
		header: {
			title: { tag: "plain_text", content: `${prefix}Agent Connect canary ${failed ? "failed" : "recovered"} · ${report.target}${report.job && report.job !== "hourly" ? ` · ${report.job}` : ""}` },
			subtitle: { tag: "plain_text", content: `${loopName(report)}${failed ? `: ${report.step}` : ""}` },
			template: failed ? "red" : "green",
		},
		body: { direction: "vertical", padding: "10px 12px 12px 12px", elements: [{ tag: "markdown", content: lines.join("\n") }] },
	};
}

const loopName = (report: Pick<Report, "imageRun">) =>
	`register → consent → token → MCP read/write${report.imageRun ? " → image (charge = quote)" : ""} → side tab → disconnect`;

/** The agent sessions this run opened, out of the account's: its own client's (the OAuth session and the side tabs it
 * minted). The account may be shared, so nothing else is ended. */
export const sessionsToEnd = (sessions: { sessionId: string; clientId?: string | null }[], clientId: string | undefined) =>
	clientId ? sessions.filter((s) => s.clientId === clientId).map((s) => s.sessionId) : [];

/** Whether a generation cost what it was quoted, to the cent. */
export const chargeMatchesQuote = (spent: number, quoted: number) => Math.abs(spent - quoted) < CHARGE_TOLERANCE;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The canary's own note goes again the way the app deletes a card (flow_node is_delete, by its owner's session): the
 * MCP gives a card's 8-hex ref, the start of its id. Answers how many cards it removed. */
async function removeNote(accessToken: string, note: { ref: string; canvasId: string }): Promise<number | string> {
	const headers = { apikey: SUPABASE_KEY, authorization: `Bearer ${accessToken}` };
	const rows = await http(`${SUPABASE_URL}/rest/v1/flow_node?conv_id=eq.${note.canvasId}&is_delete=eq.false&select=id`, { headers });
	if (rows.status !== 200 || !Array.isArray(rows.data)) return `flow_node read ${rows.status}`;
	const ids = rows.data.map((r: { id: string }) => r.id).filter((id: string) => id.startsWith(`${note.ref}-`));
	let removed = 0;
	for (const id of ids) {
		const r = await http(`${SUPABASE_URL}/rest/v1/flow_node?id=eq.${id}&conv_id=eq.${note.canvasId}`, { method: "PATCH", headers: { ...headers, prefer: "return=representation" }, json: { is_delete: true } });
		if (r.status === 200 && Array.isArray(r.data)) removed += r.data.length;
	}
	return removed;
}

// ---------------------------------------------------------------------------------------------------------------------

class StepError extends Error {
	readonly step: string;
	constructor(step: string, message: string) {
		super(message);
		this.step = step;
	}
}

const b64u = (bytes: Buffer) => bytes.toString("base64url");
const jwtClaims = (token: string): Record<string, unknown> => JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString() || "{}");
const short = (value: unknown, n = 240) => (typeof value === "string" ? value : JSON.stringify(value)).slice(0, n);

function loadDotEnv(file: string) {
	if (!existsSync(file)) return;
	for (const line of readFileSync(file, "utf8").split("\n")) {
		const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
		if (match && match[1] && process.env[match[1]] === undefined) process.env[match[1]] = match[2]?.replace(/^["']|["']$/g, "");
	}
}

/** The project's secret key: SUPABASE_SECRET_KEY, else the Supabase CLI (signed in to the flowith org), in memory. */
function secretKey(): string {
	if (process.env.SUPABASE_SECRET_KEY) return process.env.SUPABASE_SECRET_KEY;
	const ref = new URL(SUPABASE_URL).hostname.split(".")[0] ?? "";
	let keys: { type?: string; api_key?: string }[];
	try {
		keys = JSON.parse(execFileSync("supabase", ["projects", "api-keys", "--project-ref", ref, "--reveal", "-o", "json"], { cwd: tmpdir(), stdio: ["ignore", "pipe", "ignore"] }).toString());
	} catch {
		throw new Error(`could not read ${ref}'s keys: set SUPABASE_SECRET_KEY or sign the Supabase CLI in`);
	}
	const key = keys.find((k) => k.type === "secret" && /^sb_secret_[\w-]+$/.test(k.api_key ?? ""))?.api_key;
	if (!key) throw new Error(`the Supabase CLI returned no secret key for ${ref}`);
	return key;
}

async function http(url: string, init: RequestInit & { json?: unknown; form?: Record<string, string> } = {}) {
	const headers = new Headers(init.headers);
	let body = init.body;
	if (init.json !== undefined) {
		headers.set("content-type", "application/json");
		body = JSON.stringify(init.json);
	} else if (init.form) {
		headers.set("content-type", "application/x-www-form-urlencoded");
		body = new URLSearchParams(init.form).toString();
	}
	const res = await fetch(url, { ...init, headers, body, signal: AbortSignal.timeout(60_000) });
	const text = await res.text();
	let data: any = null;
	try {
		data = text ? JSON.parse(text) : null;
	} catch {
		data = { text };
	}
	return { status: res.status, headers: res.headers, data, text };
}

export async function run(opts: Options, state: State): Promise<Report> {
	const started = Date.now();
	const log: string[] = [];
	const say = (line: string) => {
		log.push(line);
		if (!opts.json) console.log(`${new Date().toISOString().slice(11, 19)} ${line}`);
	};
	let current = "start";
	const step = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
		current = name;
		try {
			return await fn();
		} catch (e) {
			throw e instanceof StepError ? e : new StepError(name, (e as Error).message);
		}
	};
	const must = (ok: unknown, message: string) => {
		if (!ok) throw new StepError(current, message);
	};

	let browser: { access_token: string } | null = null;
	let clientId: string | undefined;
	let note: { ref: string; canvasId: string } | undefined;
	const imageRun = imageDue(opts, state, started);
	const report: Report = { ok: false, target: opts.target, job: opts.job, imageRun, startedAt: new Date(started).toISOString(), ms: 0, log };
	const asBrowser = () => ({ authorization: `Bearer ${browser?.access_token}` });

	try {
		// Discovery: the 401 a host sees first, the documents it reads next.
		const resourceMeta = await step("discovery", async () => {
			const r = await http(opts.mcp, { method: "POST", headers: { accept: "application/json, text/event-stream" }, json: { jsonrpc: "2.0", id: 0, method: "initialize", params: {} } });
			must(r.status === 401, `MCP without a token answered ${r.status}, not 401`);
			const meta = r.headers.get("www-authenticate")?.match(/resource_metadata="([^"]+)"/)?.[1];
			must(meta, `no resource_metadata in WWW-Authenticate: ${r.headers.get("www-authenticate")}`);
			const prm = await http(meta!);
			must(prm.status === 200 && prm.data?.resource === opts.mcp, `protected resource metadata: ${prm.status} ${short(prm.data)}`);
			must(prm.data.authorization_servers?.includes(opts.issuer), `authorization_servers ${short(prm.data.authorization_servers)} lacks ${opts.issuer}`);
			const as = await http(`${opts.issuer}/.well-known/oauth-authorization-server`);
			must(as.status === 200 && as.data?.issuer === opts.issuer, `authorization server metadata: ${as.status} ${short(as.data)}`);
			must(as.data.code_challenge_methods_supported?.includes("S256"), "S256 not supported");
			say(`discovery ok: ${opts.mcp} → ${opts.issuer}`);
			return as.data as { authorization_endpoint: string; token_endpoint: string; registration_endpoint: string };
		});

		// The test account's own browser session: what a signed-in user has on flowith.io.
		browser = await step("browser session", async () => {
			const secret = secretKey();
			const link = await http(`${SUPABASE_URL}/auth/v1/admin/generate_link`, { method: "POST", headers: { apikey: secret, authorization: `Bearer ${secret}` }, json: { type: "magiclink", email: opts.email } });
			must(link.status === 200 && link.data?.hashed_token, `generate_link ${link.status}: ${short(link.data?.msg ?? link.data?.error_description ?? link.data)}`);
			const verified = await http(`${SUPABASE_URL}/auth/v1/verify`, { method: "POST", headers: { apikey: SUPABASE_KEY }, json: { type: link.data.verification_type ?? "magiclink", token_hash: link.data.hashed_token } });
			must(verified.status === 200 && verified.data?.access_token, `verify ${verified.status}: ${short(verified.data?.msg ?? verified.data)}`);
			say(`signed in as ${opts.email}${link.data.verification_type === "signup" ? " (new account)" : ""}`);
			return { access_token: verified.data.access_token as string };
		});

		const client = await step("register", async () => {
			const r = await http(resourceMeta.registration_endpoint, { method: "POST", json: { client_name: CLIENT_NAME, redirect_uris: [REDIRECT], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" } });
			must(r.status === 201 || r.status === 200, `register ${r.status}: ${short(r.data)}`);
			must(r.data?.client_id, "no client_id");
			say(`registered ${r.data.client_id}`);
			clientId = r.data.client_id as string;
			return clientId;
		});

		const verifier = b64u(randomBytes(32));
		const oauthState = b64u(randomBytes(12));
		const requestId = await step("authorize", async () => {
			const challenge = b64u(createHash("sha256").update(verifier).digest());
			const url = `${resourceMeta.authorization_endpoint}?${new URLSearchParams({ response_type: "code", client_id: client, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: oauthState, resource: opts.mcp, scope: "canvas" })}`;
			const r = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
			const location = r.headers.get("location") ?? "";
			must(r.status === 302 && location.startsWith(`${opts.site}/connect-agent?`), `authorize ${r.status} → ${location || (await r.text()).slice(0, 200)}`);
			const id = new URL(location).searchParams.get("oauth_request");
			must(id && /^[A-Za-z0-9_-]{20,200}$/.test(id), `oauth_request id "${id}"`);
			const page = await http(location);
			must(page.status === 200 && page.text.includes('id="root"'), `consent page ${page.status}`);
			say(`authorize → consent page ${new URL(location).pathname}`);
			return id!;
		});

		const code = await step("consent", async () => {
			const req = await http(`${opts.issuer}/oauth/requests/${requestId}`, { headers: asBrowser() });
			must(req.status === 200 && req.data?.clientName === CLIENT_NAME && typeof req.data?.redirectHost === "string", `consent request ${req.status}: ${short(req.data)}`);
			const decision = await http(`${opts.issuer}/oauth/requests/${requestId}/decision`, { method: "POST", headers: asBrowser(), json: { allow: true } });
			must(decision.status === 200 && decision.data?.redirectTo, `decision ${decision.status}: ${short(decision.data)}`);
			const cb = new URL(decision.data.redirectTo);
			must(`${cb.origin}${cb.pathname}` === REDIRECT, `redirected to ${cb.origin}${cb.pathname}`);
			must(cb.searchParams.get("state") === oauthState, "state did not come back");
			must(cb.searchParams.get("iss") === opts.issuer, `iss "${cb.searchParams.get("iss")}"`);
			must(cb.searchParams.get("code"), `no code: ${cb.search}`);
			say(`consent "${req.data.clientName}" → Allow → callback with code, state, iss`);
			return cb.searchParams.get("code")!;
		});

		let tokens = await step("token", async () => {
			const r = await http(resourceMeta.token_endpoint, { method: "POST", form: { grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: client, code_verifier: verifier, resource: opts.mcp } });
			must(r.status === 200 && r.data?.token_type === "Bearer" && r.data.access_token && r.data.refresh_token, `token ${r.status}: ${short(r.data)}`);
			say(`token ok, expires in ${r.data.expires_in} s`);
			return r.data as { access_token: string; refresh_token: string };
		});

		let rpcId = 0;
		const rpc = async (method: string, params: unknown, token = tokens.access_token) => {
			const r = await http(opts.mcp, {
				method: "POST",
				headers: { accept: "application/json, text/event-stream", authorization: `Bearer ${token}`, "mcp-protocol-version": "2025-06-18", "x-flowith-mcp-client": "canary", "x-flowith-plugin-version": "canary", "x-flowith-install-source": "canary" },
				json: { jsonrpc: "2.0", id: ++rpcId, method, params },
			});
			if (r.status !== 200) throw new StepError(current, `${method} answered HTTP ${r.status}: ${short(r.text)}`);
			const line = r.text.split("\n").find((l) => l.startsWith("data:"));
			const body = line ? JSON.parse(line.slice(5)) : r.data;
			if (body?.error) throw new StepError(current, `${method}: ${short(body.error)}`);
			return body.result;
		};
		const call = async (name: string, args: Record<string, unknown>) => {
			const res = await rpc("tools/call", { name, arguments: args });
			const text = res?.content?.find((c: { type: string }) => c.type === "text")?.text ?? "";
			let data: any;
			try {
				data = res?.structuredContent ?? JSON.parse(text);
			} catch {
				data = { text };
			}
			if (res?.isError) throw new StepError(current, `${name} isError: ${short(data)}`);
			return data;
		};

		await step("mcp initialize", async () => {
			const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "flowith-canary", version: "1" } });
			const chars = (init?.instructions ?? "").length;
			must(init?.serverInfo?.name, "no serverInfo");
			must(chars > 0 && chars <= 4096, `instructions are ${chars} characters (want 1–4096)`);
			const tools: string[] = (await rpc("tools/list", {}))?.tools?.map((t: { name: string }) => t.name) ?? [];
			const missing = REQUIRED_TOOLS.filter((t) => !tools.includes(t));
			must(missing.length === 0, `tools missing: ${missing.join(", ")}`);
			say(`initialize ${init.serverInfo.name} ${init.serverInfo.version ?? ""}, ${tools.length} tools`);
		});

		const canvasId = await step("canvas", async () => {
			const found = await call("list_canvases", { query: CANVAS_TITLE, limit: 10 });
			must(Array.isArray(found?.canvases), `list_canvases: ${short(found)}`);
			const mine = found.canvases.find((c: { title: string }) => c.title === CANVAS_TITLE);
			if (mine) {
				say(`list_canvases found "${CANVAS_TITLE}" ${mine.canvasId}`);
				return mine.canvasId as string;
			}
			const made = await call("create_canvas", { title: CANVAS_TITLE });
			must(made?.canvasId && String(made.url).startsWith(`${opts.site}/conv/`), `create_canvas: ${short(made)}`);
			say(`create_canvas ${made.canvasId}`);
			return made.canvasId as string;
		});


		const balance = async () => {
			const c = await call("credits", {});
			must(typeof c?.credits === "number" && typeof c?.topUpUrl === "string", `credits: ${short(c)}`);
			return c.credits as number;
		};
		const before = await step("credits", balance);
		report.creditsLeft = before;
		say("credits answers");

		await step("write", async () => {
			const value = `Canary write ${new Date(started).toISOString()}`;
			const made = await call("create_canvas_node", { canvasId, type: "4", value });
			must(made?.status === "done" && typeof made.card === "string", `create_canvas_node: ${short(made)}`);
			const read = await call("read_canvas", { canvasId, refs: [made.card] });
			note = { ref: made.card, canvasId };
			const node = (read?.nodes ?? []).find((n: { ref?: string }) => n.ref === made.card);
			must(node?.text === value, `read_canvas doesn't give the new note back as written: ${short(read)}`);
			// A relayed step (it runs in the user's open canvas): with none open it must answer needs_canvas with the link.
			const focus = await call("focus_canvas_nodes", { canvasId, nodeIds: [made.card] });
			must(focus?.status === "needs_canvas" && String(focus.handoffUrl ?? "").startsWith(`${opts.site}/connect-agent/open?`), `focus_canvas_nodes with no canvas open: ${short(focus)}`);
			const removed = await removeNote(browser!.access_token, note);
			must(removed === 1, `couldn't remove the canary's note again (${removed})`);
			note = undefined;
			say(`create_canvas_node ${made.card} read back, removed; a relayed step with no canvas open → needs_canvas`);
		});

		if (imageRun) {
			await step("generate_image", async () => {
				const title = `Canary ${new Date(started).toISOString().slice(0, 16).replace("T", " ")}`;
				const gen = await call("generate_image", { canvasId, title, prompt: "A small green check mark centred on a plain white background, flat icon", ...(opts.imageModel === "default" ? {} : { model: opts.imageModel }), aspectRatio: "1:1" });
				if (gen?.status === "not_started" && before === 0) {
					// No credits on the canary account: the out-of-credits answer is what we can check (nothing placed, a
					// top-up link, no balance in the words). Grant the account credits to check generation itself.
					must(typeof gen.message === "string" && gen.topUpUrl === `${opts.site}/pricing`, `not_started without its message or top-up link: ${short(gen, 400)}`);
					const placed = await call("find_canvas_nodes", { canvasId, text: title });
					must(!short(placed, 4000).includes(title), `a not_started generation placed a card: ${short(placed)}`);
					report.imageSkipped = "no credits: checked the out-of-credits answer instead";
					say("generate_image with 0 credits → not_started, top-up link, nothing placed");
					return;
				}
				must(gen?.status === "generating" && gen.taskId && gen.card, `generate_image ${short(gen, 900)}`);
				must(typeof gen.credits === "number", `generate_image gave no price: ${short(gen, 400)}`);
				report.creditsQuoted = gen.credits as number;
				let task = gen;
				const t0 = Date.now();
				while (task.status === "generating" && Date.now() - t0 < 300_000) task = await call("get_task", { taskId: gen.taskId, waitSeconds: 50 });
				must(task.status === "done", `get_task ${task.status} after ${Math.round((Date.now() - t0) / 1000)} s: ${short(task.message ?? task)}`);
				const url = task.results?.[0]?.url;
				must(url, `done without a result url: ${short(task)}`);
				const img = await fetch(url, { signal: AbortSignal.timeout(30_000) });
				must(img.ok && (img.headers.get("content-type") ?? "").startsWith("image/"), `result ${img.status} ${img.headers.get("content-type")}`);
				await img.arrayBuffer();
				state.lastImageAt = new Date().toISOString();
				await sleep(SETTLE_MS);
				report.creditsLeft = await balance();
				report.creditsSpent = Math.round((before - report.creditsLeft) * 100) / 100;
				say(`generate_image ${opts.imageModel} → card ${gen.card} done in ${Math.round((Date.now() - t0) / 1000)} s, charged ${report.creditsSpent}, quoted ${report.creditsQuoted}`);
				must(chargeMatchesQuote(report.creditsSpent, report.creditsQuoted!), `charged ${report.creditsSpent} credits, quoted ${report.creditsQuoted}`);
			});
		}

		await step("read_canvas", async () => {
			const look = await call("read_canvas", { canvasId });
			must(look && short(look).length > 2, `read_canvas: ${short(look)}`);
			say(`read_canvas: ${short(look.text ?? look, 100)}`);
		});

		await step("side tab", async () => {
			const opened = await call("open_canvas", { canvasId });
			must(String(opened?.url).startsWith(`${opts.site}/conv/${canvasId}`), `open_canvas url ${short(opened)}`);
			must(opened.handoffUrl, `open_canvas gave no handoffUrl: ${short(opened)}`);
			const handoff = new URL(opened.handoffUrl);
			must(`${handoff.origin}${handoff.pathname}` === `${opts.site}/connect-agent/open`, `handoffUrl ${handoff.origin}${handoff.pathname}`);
			const ticket = handoff.searchParams.get("ticket") ?? "";
			const page = await http(opened.handoffUrl);
			must(page.status === 200 && page.text.includes('id="root"'), `side-tab page ${page.status}`);
			const redeemed = await http(`${opts.issuer}/user/agent-handoff/redeem`, { method: "POST", json: { ticket } });
			must(redeemed.status === 200 && redeemed.data?.access_token, `redeem ${redeemed.status}: ${short(redeemed.data)}`);
			must(redeemed.data.to === `/conv/${canvasId}?ade=1`, `redeemed to "${redeemed.data.to}"`);
			const sid = jwtClaims(redeemed.data.access_token).session_id;
			const ended = await http(`${opts.issuer}/user/agent-session/end`, { method: "POST", headers: { authorization: `Bearer ${redeemed.data.access_token}` }, json: { sessionIds: [sid] } });
			must(ended.status === 200 && ended.data?.ended?.includes(sid), `side tab ending itself ${ended.status}: ${short(ended.data)}`);
			const again = await http(`${opts.issuer}/user/agent-handoff/redeem`, { method: "POST", json: { ticket } });
			must(again.status === 404, `a used ticket answered ${again.status}, not 404`);
			say(`open_canvas → side tab redeemed to ${redeemed.data.to}, ended itself, ticket single use`);
		});

		const refreshed = await step("refresh", async () => {
			const r = await http(resourceMeta.token_endpoint, { method: "POST", form: { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client } });
			must(r.status === 200 && r.data?.access_token, `refresh ${r.status}: ${short(r.data)}`);
			tokens = r.data;
			await rpc("tools/list", {});
			say("refresh ok, MCP takes the new token");
			return r.data as { access_token: string };
		});

		await step("disconnect", async () => {
			const listed = await http(`${opts.issuer}/user/agent-sessions`, { headers: { authorization: `Bearer ${refreshed.access_token}` } });
			const current = listed.data?.sessions?.find((s: { current: boolean }) => s.current);
			must(current?.clientName === CLIENT_NAME && current.via === "oauth", `agent-sessions current ${short(current ?? listed.data)}`);
			const ended = await http(`${opts.issuer}/user/agent-session/end`, { method: "POST", headers: asBrowser(), json: { sessionIds: [current.sessionId] } });
			must(ended.status === 200 && ended.data?.ended?.includes(current.sessionId), `Disconnect ${ended.status}: ${short(ended.data)}`);
			const after = await http(opts.mcp, { method: "POST", headers: { accept: "application/json, text/event-stream", authorization: `Bearer ${refreshed.access_token}` }, json: { jsonrpc: "2.0", id: 99, method: "tools/list" } });
			must(after.status === 401, `MCP after Disconnect answered ${after.status}, not 401`);
			say(`agent-sessions names "${current.clientName}"; Disconnect → MCP 401`);
		});

		report.ok = true;
	} catch (e) {
		report.step = e instanceof StepError ? e.step : current;
		report.error = (e as Error).message;
		say(`FAILED at ${report.step}: ${report.error}`);
	} finally {
		if (browser) {
			if (note) say(`cleanup removed the canary's note: ${await removeNote(browser.access_token, note).catch((e) => (e as Error).message)}`);
			// Only this run's own sessions (its client's): the account may be shared with other agents.
			const left = await http(`${opts.issuer}/user/agent-sessions`, { headers: asBrowser() }).catch(() => null);
			const ids = sessionsToEnd(left?.data?.sessions ?? [], clientId);
			if (ids.length) {
				await http(`${opts.issuer}/user/agent-session/end`, { method: "POST", headers: asBrowser(), json: { sessionIds: ids.slice(0, 20) } }).catch(() => null);
				say(`cleanup ended ${ids.length} session(s) this run had left open`);
			}
			await http(`${SUPABASE_URL}/auth/v1/logout?scope=local`, { method: "POST", headers: { apikey: SUPABASE_KEY, ...asBrowser() } }).catch(() => null);
		}
		report.ms = Date.now() - started;
	}
	return report;
}

async function postFeishu(card: unknown) {
	const url = process.env.CANARY_FEISHU_WEBHOOK;
	if (!url) throw new Error("CANARY_FEISHU_WEBHOOK is not set (canary/.env)");
	const r = await http(url, { method: "POST", json: { msg_type: "interactive", card } });
	if (r.status !== 200 || (r.data?.code && r.data.code !== 0)) throw new Error(`Feishu answered ${r.status}: ${short(r.data)}`);
}

async function main() {
	loadDotEnv(join(HERE, ".env"));
	const opts = parseArgs(process.argv.slice(2));
	const stateFile = join(HERE, ".state", `${opts.target}-${opts.job}.json`);
	const state: State = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : {};
	const report = await run(opts, state);
	const now = Date.now();
	const kind = alertDecision(state, report.ok ? { ok: true } : { ok: false, step: report.step ?? "?" }, now, opts.test);
	let alerted = false;
	if (opts.alert && kind) {
		try {
			await postFeishu(buildCard(report, opts, kind));
			alerted = true;
		} catch (e) {
			console.error(`alert not sent: ${(e as Error).message}`);
		}
	}
	if (!opts.test) {
		if (report.ok) {
			state.lastOkAt = new Date(now).toISOString();
			delete state.failing;
		} else {
			const same = state.failing?.step === report.step;
			state.failing = { step: report.step ?? "?", since: same ? state.failing!.since : new Date(now).toISOString(), alertedAt: alerted ? new Date(now).toISOString() : same ? state.failing?.alertedAt : undefined };
		}
		mkdirSync(dirname(stateFile), { recursive: true });
		writeFileSync(stateFile, JSON.stringify(state, null, 2), { mode: 0o600 });
	}
	const summary = report.ok
		? `canary ${opts.target} ${opts.job} ok in ${Math.round(report.ms / 1000)} s${report.creditsSpent !== undefined ? `, image charged ${report.creditsSpent} = quoted ${report.creditsQuoted}` : report.imageSkipped ? `, image skipped (${report.imageSkipped})` : ", no image this run"}, ${report.creditsLeft} credits left`
		: `canary ${opts.target} ${opts.job} FAILED at ${report.step}: ${report.error}${alerted ? " (alerted)" : kind ? "" : " (alert muted)"}`;
	if (opts.json) console.log(JSON.stringify({ ...report, alerted }));
	console.log(summary);
	process.exitCode = report.ok ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
