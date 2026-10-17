/**
 * Direct HTTP access to Flowith — the same two backends the web app talks to:
 *
 *   - the edge worker (`workerURL`, default https://edge.flowith.io): generation,
 *     uploads, memory, credits. Auth is the raw Supabase access token in the
 *     `Authorization` header (no "Bearer" prefix — that's what the frontend sends).
 *   - Supabase PostgREST (`supabaseUrl`): canvas + node rows, under RLS.
 *     Auth is `apikey: <publishable key>` + `Authorization: Bearer <jwt>`.
 *
 * Native fetch only. No npm packages.
 */

export interface ApiSession {
	supabaseUrl: string;
	supabaseKey: string;
	accessToken: string;
	workerURL?: string;
}

export const DEFAULT_WORKER_URL = "https://edge.flowith.io";

export function workerUrl(s: ApiSession): string {
	return (s.workerURL || DEFAULT_WORKER_URL).replace(/\/$/, "");
}

/**
 * Structured error that the CLI prints as
 * `{"type":"error","code":...,"message":...,"data":...}` and exits 1 on.
 * Codes mirror the ones the browser path already produces so agents can
 * branch on them the same way (NO_CREDITS, NOT_LOGGED_IN, RATE_LIMITED, ...).
 */
export class CliError extends Error {
	constructor(
		message: string,
		public code: string = "UNKNOWN_ERROR",
		public data?: unknown,
		/** HTTP status when the error came from a response */
		public status?: number,
	) {
		super(message);
		this.name = "CliError";
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
	if (typeof body === "string") return body;
	const b = body as Record<string, unknown>;
	const parts = [b.error, b.reason, b.message, b.detail]
		.filter((v) => typeof v === "string")
		.join(" — ");
	return parts || JSON.stringify(body);
}

/** Map an HTTP failure onto the CLI's error vocabulary (same as the browser path). */
export async function httpFailure(resp: Response, what: string): Promise<CliError> {
	const body = await parseBody(resp);
	const detail = describe(body);
	const st = resp.status;
	switch (st) {
		case 401:
			return new CliError(
				`${what}: not logged in or token expired. Run 'login' again.`,
				"NOT_LOGGED_IN",
				body,
				st,
			);
		case 402:
			return new CliError(
				`${what}: no credits (${detail || "payment required"}). Top up at https://flowith.io/pricing`,
				"NO_CREDITS",
				body,
				st,
			);
		case 403:
			return new CliError(`${what}: forbidden${detail ? ` (${detail})` : ""}`, "FORBIDDEN", body, st);
		case 404:
			return new CliError(`${what}: not found${detail ? ` (${detail})` : ""}`, "NOT_FOUND", body, st);
		case 429:
			return new CliError(`${what}: rate limited${detail ? ` (${detail})` : ""}`, "RATE_LIMITED", body, st);
		default: {
			// The worker reports input/policy rejections as 500 with a typed body
			// ({error_type:"content_policy", error_code:"invalid_input"}); surface
			// that code instead of a generic SERVER_ERROR so agents can react.
			const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
			const typed = [b.error_code, b.error_type].find((v) => typeof v === "string" && v) as string | undefined;
			return new CliError(
				`${what}: HTTP ${st}${detail ? ` — ${detail}` : ""}`,
				typed ? typed.toUpperCase().replace(/[^A-Z0-9]+/g, "_") : st >= 500 ? "SERVER_ERROR" : "HTTP_ERROR",
				body,
				st,
			);
		}
	}
}

export interface WorkerInit {
	method?: string;
	json?: unknown;
	body?: BodyInit;
	headers?: Record<string, string>;
	timeoutMs?: number;
}

/** Call the edge worker. Throws CliError on any non-2xx. */
export async function workerFetch(
	s: ApiSession,
	path: string,
	init: WorkerInit = {},
): Promise<Response> {
	const headers: Record<string, string> = {
		Authorization: s.accessToken,
		...(init.json !== undefined ? { "Content-Type": "application/json" } : {}),
		...(init.headers ?? {}),
	};
	const resp = await fetch(`${workerUrl(s)}${path}`, {
		method: init.method ?? (init.json !== undefined || init.body ? "POST" : "GET"),
		headers,
		body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
		signal: AbortSignal.timeout(init.timeoutMs ?? 60_000),
	});
	if (!resp.ok) throw await httpFailure(resp, `${init.method ?? "POST"} ${path}`);
	return resp;
}

export async function workerJson<T = unknown>(
	s: ApiSession,
	path: string,
	init: WorkerInit = {},
): Promise<T> {
	const resp = await workerFetch(s, path, init);
	return (await parseBody(resp)) as T;
}

export interface RestInit {
	method?: "GET" | "POST" | "PATCH" | "DELETE";
	json?: unknown;
	/** PostgREST `Prefer` header, e.g. "return=representation" */
	prefer?: string;
	timeoutMs?: number;
}

/**
 * Supabase PostgREST call. `query` is the part after /rest/v1/, e.g.
 * `flow_node?id=eq.<uuid>&select=id,data`. Returns the parsed JSON body
 * (an array for selects; whatever `Prefer` asks for on writes).
 */
export async function rest<T = unknown>(
	s: ApiSession,
	query: string,
	init: RestInit = {},
): Promise<T> {
	const method = init.method ?? (init.json !== undefined ? "POST" : "GET");
	const resp = await fetch(`${s.supabaseUrl.replace(/\/$/, "")}/rest/v1/${query}`, {
		method,
		headers: {
			apikey: s.supabaseKey,
			Authorization: `Bearer ${s.accessToken}`,
			...(init.json !== undefined ? { "Content-Type": "application/json" } : {}),
			...(init.prefer ? { Prefer: init.prefer } : {}),
		},
		body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
		signal: AbortSignal.timeout(init.timeoutMs ?? 30_000),
	});
	if (!resp.ok) throw await httpFailure(resp, `${method} ${query.split("?")[0]}`);
	return (await parseBody(resp)) as T;
}

/** Escape a value for a PostgREST `ilike.*...*` pattern. */
export function ilikePattern(q: string): string {
	return `*${q.replace(/[%_\\]/g, (c) => `\\${c}`).replace(/[,.()]/g, " ")}*`;
}
