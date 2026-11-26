/**
 * The two backends the Flowith web app talks to, with the user's own session:
 *
 *   - the edge worker (`workerURL`): generation, uploads, card tools, credits. Auth is the raw
 *     Supabase access token in `Authorization` (what the web app sends).
 *   - Supabase PostgREST (`supabaseUrl`): canvases and their cards (`conversation`, `flow_node`),
 *     under the user's row-level security.
 *
 * Every write is labelled `x-canvas-agent: <agent>`: the database announces it on the canvas's
 * change feed as an agent's write, so an open canvas shows the card at once and brings it into view
 * (the same path the in-app Creator Agent's writes take).
 */

export interface Api {
	supabaseUrl: string;
	supabaseKey: string;
	accessToken: string;
	workerURL: string;
	/** Who writes: claude-code, codex, cursor… shown to the canvas's change feed. */
	agent: string;
	/** Renews the access token (a long wait can outlive it); updates this object. */
	renew?: () => Promise<void>;
	/** Asks Flowith now and then whether the sign-in is still on, so a long command stops on a Disconnect too. */
	recheck?: () => Promise<void>;
}

export class CliError extends Error {
	code: string;
	data?: unknown;
	status?: number;

	constructor(message: string, code = "ERROR", data?: unknown, status?: number) {
		super(message);
		this.name = "CliError";
		this.code = code;
		this.data = data;
		this.status = status;
	}
}

async function parseBody(resp: Response): Promise<unknown> {
	const text = await resp.text().catch(() => "");
	if (!text) return undefined;
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

function describe(body: unknown): string {
	if (body == null) return "";
	if (typeof body === "string") return body.slice(0, 500);
	const b = body as Record<string, unknown>;
	const parts = [b.error, b.reason, b.message, b.detail, b.msg].filter((v) => typeof v === "string");
	return (parts.join(" — ") || JSON.stringify(body)).slice(0, 500);
}

/** An HTTP failure in the CLI's error vocabulary (NO_CREDITS, NOT_LOGGED_IN, …). */
export async function httpFailure(resp: Response, what: string): Promise<CliError> {
	const body = await parseBody(resp);
	const detail = describe(body);
	const st = resp.status;
	if (st === 401) return new CliError(`${what}: not logged in or session expired — run \`login\`.`, "NOT_LOGGED_IN", body, st);
	if (st === 402)
		return new CliError(
			`${what}: not enough credits or the plan doesn't include this model (${detail || "payment required"}). Top up: https://flowith.io/pricing`,
			"NO_CREDITS",
			body,
			st,
		);
	if (st === 403) return new CliError(`${what}: forbidden${detail ? ` (${detail})` : ""}`, "FORBIDDEN", body, st);
	if (st === 404) return new CliError(`${what}: not found${detail ? ` (${detail})` : ""}`, "NOT_FOUND", body, st);
	if (st === 429) return new CliError(`${what}: rate limited${detail ? ` (${detail})` : ""}`, "RATE_LIMITED", body, st);
	const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
	const typed = [b.error_code, b.error_type].find((v) => typeof v === "string" && v) as string | undefined;
	return new CliError(
		`${what}: HTTP ${st}${detail ? ` — ${detail}` : ""}`,
		typed ? typed.toUpperCase().replace(/[^A-Z0-9]+/g, "_") : st >= 500 ? "SERVER_ERROR" : "BAD_REQUEST",
		body,
		st,
	);
}

// ---------- dry runs ----------

let dryRun = false;

/** --dry-run: from here on any request that would change something throws instead of being sent. */
export function forbidWrites() {
	dryRun = true;
}

/** Every write passes here first (requests, and canvas operations sent to the open canvas): in a dry run it never leaves the machine. */
export function guardWrite(method: string, what: string) {
	if (dryRun && method !== "GET") throw new CliError(`Dry run: ${method} ${what} would change the canvas and was not sent.`, "DRY_RUN");
}

/** Server time minus this machine's, from the last answer's Date header (usage records carry server time). */
let serverOffsetMs = 0;
export const serverNow = () => Date.now() + serverOffsetMs;
function noteServerTime(resp: Response) {
	const date = Date.parse(resp.headers.get("date") ?? "");
	if (Number.isFinite(date)) serverOffsetMs = date + 500 - Date.now();
}

export interface WorkerInit {
	method?: string;
	json?: unknown;
	body?: FormData | string;
	timeoutMs?: number;
	/** A POST that only asks (a price): allowed in a dry run. */
	read?: boolean;
}

export async function worker<T = unknown>(api: Api, path: string, init: WorkerInit = {}): Promise<T> {
	const method = init.method ?? (init.json !== undefined || init.body ? "POST" : "GET");
	if (!init.read) guardWrite(method, path.split("?")[0]!);
	await api.recheck?.();
	const send = () =>
		fetch(`${api.workerURL.replace(/\/$/, "")}${path}`, {
			method,
			headers: {
				Authorization: api.accessToken,
				...(init.json !== undefined ? { "Content-Type": "application/json" } : {}),
			},
			body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
			signal: AbortSignal.timeout(init.timeoutMs ?? 60_000),
		});
	let resp = await send();
	// The token ran out during a long run: renew it once and ask again (FormData bodies can't be resent).
	if (resp.status === 401 && api.renew && !(init.body instanceof FormData)) {
		await api.renew();
		resp = await send();
	}
	noteServerTime(resp);
	if (!resp.ok) throw await httpFailure(resp, `${method} ${path.split("?")[0]}`);
	return (await parseBody(resp)) as T;
}

export interface RestInit {
	method?: "GET" | "POST" | "PATCH" | "DELETE";
	json?: unknown;
	prefer?: string;
	timeoutMs?: number;
}

/** PostgREST: `query` is what follows /rest/v1/, e.g. `flow_node?id=eq.<uuid>&select=id,data`. */
export async function rest<T = unknown>(api: Api, query: string, init: RestInit = {}): Promise<T> {
	const method = init.method ?? (init.json !== undefined ? "POST" : "GET");
	guardWrite(method, query.split("?")[0]!);
	await api.recheck?.();
	const send = () =>
		fetch(`${api.supabaseUrl.replace(/\/$/, "")}/rest/v1/${query}`, {
			method,
			headers: {
				apikey: api.supabaseKey,
				Authorization: `Bearer ${api.accessToken}`,
				...(method !== "GET" ? { "x-canvas-agent": api.agent } : {}),
				...(init.json !== undefined ? { "Content-Type": "application/json" } : {}),
				...(init.prefer ? { Prefer: init.prefer } : {}),
			},
			body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
			signal: AbortSignal.timeout(init.timeoutMs ?? 30_000),
		});
	let resp = await send();
	if (resp.status === 401 && api.renew) {
		await api.renew();
		resp = await send();
	}
	noteServerTime(resp);
	if (!resp.ok) throw await httpFailure(resp, `${method} ${query.split("?")[0]}`);
	return (await parseBody(resp)) as T;
}

/** A PostgREST `ilike.*…*` pattern for free text. */
export function ilikePattern(q: string): string {
	return `*${q.replace(/[%_\\]/g, (c) => `\\${c}`).replace(/[,.()]/g, " ")}*`;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
