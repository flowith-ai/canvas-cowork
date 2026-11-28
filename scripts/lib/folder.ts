/**
 * The canvas folder on this computer: a directory kept in step with the shared folder of a canvas (Flowith Next only,
 * creater-agent docs/futuristic-agents.md §2), so an agent here works on the canvas's files directly and what it changes
 * goes back as a version of the folder. Flo, the canvas's Claude Code / Codex cards and other agents read and write the
 * same folder; flo-workers merges edits made at the same time and keeps both copies of a real conflict.
 *
 * One round: what changed here since the last round goes up as one commit made on the version this directory was last
 * in step with (`base`), so the folder merges it with whatever changed there meanwhile; then the directory takes the
 * folder's latest version. A file changed here during the round is never overwritten: it goes up in the next one.
 * The directory's own record (`.flowith-folder.json`) says which canvas and version it is in step with, and each file's
 * hash as of then.
 */
import { createHash } from "crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join, relative, sep } from "path";
import { CliError, type Api, worker, workerResponse } from "./http.ts";

export const STATE_FILE = ".flowith-folder.json";

/** What a hand-back leaves out, as runs' deliveries do (flo-workers src/helpers/canvas-folder/paths.ts). */
const SKIP_DIRS = new Set(["node_modules", ".venv", ".git", "__pycache__", ".cache"]);
const SKIP_FILES = new Set([".DS_Store", STATE_FILE]);
/** The folder's limits (flo-workers paths.ts) and the most changes one commit takes (its router). */
export const FILES_MAX = 5_000;
export const BYTES_MAX = 500_000_000;
const COMMIT_CHANGES_MAX = 1_000;
const PATH_MAX = 1_024;

/** A file as the folder lists it, and as this directory last saw it (its modification time spares re-reading it). */
export interface Known {
	hash: string;
	size: number;
	mtimeMs?: number;
}

export interface FolderState {
	v: 1;
	/** The Flowith it belongs to: the session's worker (a directory of next-gen is never handed to another). */
	workerURL: string;
	canvasId: string;
	/** The version this directory is in step with; null while the folder had none. */
	seq: number | null;
	files: Record<string, Known>;
	/**
	 * Files changed here while a round took the folder's latest, by the version they were changed from: they go up on
	 * that version, so the folder merges them with what changed since instead of taking them over it. Their entry in
	 * `files` is the file as of that version (none: it wasn't there).
	 */
	stale?: Record<string, number | null>;
	syncedAt: string;
}

interface Version {
	seq: number;
	agent: string | null;
	changes?: { counts?: Record<string, number> };
	createdAt: string;
}

export interface Pushed {
	seq: number | null;
	/** Changes handed back: added, changed or deleted files. */
	changed: number;
	merged: boolean;
	/** Real conflicts: the folder kept the newest at `path` and this one beside it as `keptAs`. */
	conflicts: { path: string; keptAs: string }[];
	unchanged: boolean;
}

export interface Pulled {
	written: string[];
	removed: string[];
	/** Files changed here while the folder changed them too: kept as they are here, handed back next round. */
	kept: string[];
}

export interface Round {
	base: number | null;
	seq: number | null;
	pushed: Pushed | null;
	pulled: Pulled;
}

/**
 * Whether a worker serves the canvas folder: Flowith Next and test hosts only (flo-workers src/common/next-gen.ts
 * `isNextGenRequest`). flowith.io's worker answers 404 anyway; this says so before anything is sent.
 */
export function folderHostAllowed(workerURL: string): boolean {
	let url: URL;
	try {
		url = new URL(workerURL);
	} catch {
		return false;
	}
	const host = url.hostname.toLowerCase();
	if (host === "dev-edge.flowith.io" || host === "dev-edge.flowith.net" || host === "localhost" || host === "127.0.0.1") return true;
	return url.protocol === "https:" && host.endsWith(".workers.dev") && host !== "main-worker.dev-9b6.workers.dev";
}

export function assertFolderHost(workerURL: string) {
	if (!folderHostAllowed(workerURL))
		throw new CliError(
			"The canvas folder is on Flowith Next only for now. Log in there first: `login --site next-gen.flowith.io` (use FLOWITH_HOME to keep that session apart).",
			"NEXT_GEN_ONLY",
		);
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** A folder path from a path under the directory: `/`-separated, checked as the folder checks it. */
function folderPath(dir: string, file: string): string | undefined {
	const path = relative(dir, file).split(sep).join("/");
	if (!path || path.length > PATH_MAX || path.includes("\u0000") || path.split("/").some((part) => !part || part === "." || part === "..")) return undefined;
	return path;
}

/** The directory's record, when it was synced before. */
export function readState(dir: string): FolderState | undefined {
	const file = join(dir, STATE_FILE);
	if (!existsSync(file)) return undefined;
	try {
		const state = JSON.parse(readFileSync(file, "utf8")) as FolderState;
		return state?.v === 1 && typeof state.canvasId === "string" ? state : undefined;
	} catch {
		throw new CliError(`${file} isn't a canvas folder record. Move it away to start this directory afresh.`, "FOLDER_STATE_INVALID");
	}
}

/** Written whole (a temp file renamed over it), so an interrupted round never leaves half a record. */
export function writeState(dir: string, state: FolderState) {
	const file = join(dir, STATE_FILE);
	const temp = `${file}.${process.pid}.tmp`;
	writeFileSync(temp, `${JSON.stringify(state, null, 1)}\n`);
	renameSync(temp, file);
}

/**
 * Every file of the directory with its hash, reading only files whose size or modification time moved since the
 * record (`known`). Leaves out what a hand-back leaves out, and refuses past the folder's limits.
 */
export function scanDirectory(dir: string, known: Record<string, Known> = {}): Map<string, Known> {
	const found = new Map<string, Known>();
	let bytes = 0;
	const walk = (at: string) => {
		for (const entry of readdirSync(at, { withFileTypes: true })) {
			const full = join(at, entry.name);
			if (entry.isDirectory()) {
				if (!SKIP_DIRS.has(entry.name)) walk(full);
				continue;
			}
			if (!entry.isFile() || SKIP_FILES.has(entry.name) || entry.name.endsWith(".flowith-tmp")) continue;
			const path = folderPath(dir, full);
			if (!path) continue;
			const stat = statSync(full);
			const before = known[path];
			const hash = before && before.size === stat.size && before.mtimeMs === stat.mtimeMs ? before.hash : sha256(readFileSync(full));
			found.set(path, { hash, size: stat.size, mtimeMs: stat.mtimeMs });
			bytes += stat.size;
			if (found.size > FILES_MAX || bytes > BYTES_MAX)
				throw new CliError(`The canvas folder holds at most ${FILES_MAX.toLocaleString("en")} files and ${BYTES_MAX / 1e6} MB; ${dir} has more.`, "TOO_LARGE");
		}
	};
	walk(dir);
	return found;
}

/** What changed in the directory since the record: added or changed files, and files deleted. */
export function localChanges(state: FolderState, scanned: Map<string, Known>) {
	const changed: { path: string; hash: string; size: number }[] = [];
	const deleted: string[] = [];
	for (const [path, file] of scanned) if (state.files[path]?.hash !== file.hash) changed.push({ path, hash: file.hash, size: file.size });
	for (const path of Object.keys(state.files)) if (!scanned.has(path)) deleted.push(path);
	return { changed, deleted };
}

const base = (canvasId: string) => `/canvas-folder/${encodeURIComponent(canvasId)}`;

export async function folderHead(api: Api, canvasId: string): Promise<Version | null> {
	return (await worker<{ head: Version | null }>(api, base(canvasId))).head;
}

async function folderFiles(api: Api, canvasId: string, seq: number) {
	const listing = await worker<{ seq: number; files: { path: string; size: number; hash: string }[]; truncated: boolean }>(api, `${base(canvasId)}/files?seq=${seq}`);
	if (listing.truncated) throw new CliError(`Version ${seq} of the canvas folder has more files than this computer can take in one listing.`, "TOO_LARGE");
	return listing.files;
}

async function folderFile(api: Api, canvasId: string, seq: number, path: string): Promise<Uint8Array> {
	const resp = await workerResponse(api, `${base(canvasId)}/file?seq=${seq}&path=${encodeURIComponent(path)}`, { timeoutMs: 300_000 });
	return new Uint8Array(await resp.arrayBuffer());
}

/** Writes a file whole, its directories made first: a reader never sees half of it. */
function writeWhole(file: string, bytes: Uint8Array) {
	mkdirSync(dirname(file), { recursive: true });
	const temp = `${file}.flowith-tmp`;
	writeFileSync(temp, bytes);
	renameSync(temp, file);
}

/**
 * Brings the directory to version `seq` (null: the folder is empty). A file left as the record has it takes the
 * version's; one changed here as well is kept as it is here (it goes up next round, merged there); one the version
 * deleted goes unless changed here.
 */
export async function pull(api: Api, dir: string, state: FolderState, seq: number | null, start: FolderState = state): Promise<{ state: FolderState; pulled: Pulled }> {
	const pulled: Pulled = { written: [], removed: [], kept: [] };
	const remote = seq === null ? [] : await folderFiles(api, state.canvasId, seq);
	const local = scanDirectory(dir, state.files);
	const files: Record<string, Known> = {};
	const stale: Record<string, number | null> = { ...state.stale };
	const unchangedHere = (path: string) => local.get(path)?.hash === state.files[path]?.hash && !(path in stale);
	/** Kept as it is here: it goes up next round on the version it was changed from (the round's start, or earlier). */
	const keep = (path: string) => {
		pulled.kept.push(path);
		if (!(path in stale)) stale[path] = start.stale?.[path] ?? start.seq;
		const before = start.files[path];
		if (before) files[path] = before;
		else delete files[path];
	};
	for (const file of remote) {
		files[file.path] = { hash: file.hash, size: file.size };
		const here = local.get(file.path);
		if (here?.hash === file.hash) {
			files[file.path] = here;
			continue;
		}
		// Changed here since the last round (or made here under a path the folder now has too): not overwritten.
		if (here && !unchangedHere(file.path)) {
			keep(file.path);
			continue;
		}
		const bytes = await folderFile(api, state.canvasId, seq!, file.path);
		if (sha256(bytes) !== file.hash) throw new CliError(`${file.path} arrived damaged; nothing was overwritten. Try again.`, "FOLDER_DOWNLOAD_DAMAGED");
		const full = join(dir, ...file.path.split("/"));
		writeWhole(full, bytes);
		files[file.path] = { hash: file.hash, size: file.size, mtimeMs: statSync(full).mtimeMs };
		delete stale[file.path];
		pulled.written.push(file.path);
	}
	const inVersion = new Set(remote.map((file) => file.path));
	for (const path of new Set([...Object.keys(state.files), ...Object.keys(stale)])) {
		if (inVersion.has(path) || !local.has(path)) continue;
		if (!unchangedHere(path)) {
			keep(path);
			continue;
		}
		unlinkSync(join(dir, ...path.split("/")));
		delete stale[path];
		pulled.removed.push(path);
	}
	for (const path of Object.keys(stale)) if (!local.has(path) && !(path in files)) delete stale[path];
	const next: FolderState = { ...state, seq, files, syncedAt: new Date().toISOString() };
	if (Object.keys(stale).length) next.stale = stale;
	else delete next.stale;
	return { state: next, pulled };
}

/**
 * Hands what changed here back as one version made on the record's version (several commits of at most a thousand
 * changes for a very large change, each on the one before). Returns null when nothing changed here.
 */
export async function push(
	api: Api,
	dir: string,
	state: FolderState,
	opts: { agent: string; message?: string },
): Promise<{ pushed: Pushed; sent: Record<string, Known | null> } | null> {
	const scanned = scanDirectory(dir, state.files);
	const { changed, deleted } = localChanges(state, scanned);
	if (!changed.length && !deleted.length) return null;
	const sent: Record<string, Known | null> = {};
	for (const file of changed) {
		const full = join(dir, ...file.path.split("/"));
		const bytes = readFileSync(full);
		// Read again: a file being written now goes up as it is when sent, and is checked again next round.
		const hash = sha256(bytes);
		file.hash = hash;
		file.size = bytes.byteLength;
		await worker(api, `${base(state.canvasId)}/blobs/${hash}`, { method: "PUT", body: new Uint8Array(bytes), timeoutMs: 300_000 });
		sent[file.path] = { hash, size: bytes.byteLength };
	}
	for (const path of deleted) sent[path] = null;
	type Change = { path: string; hash: string; size: number } | { path: string; delete: true };
	// Each change goes up on the version it was made from: the record's, or an older one for a file kept last round.
	const byBase = new Map<number | null, Change[]>();
	const add = (path: string, change: Change) => {
		const from = state.stale && path in state.stale ? state.stale[path]! : state.seq;
		byBase.set(from, [...(byBase.get(from) ?? []), change]);
	};
	for (const { path, hash, size } of changed) add(path, { path, hash, size });
	for (const path of deleted) add(path, { path, delete: true });
	const pushed: Pushed = { seq: state.seq, changed: changed.length + deleted.length, merged: false, conflicts: [], unchanged: true };
	for (const [from, changes] of [...byBase].sort(([a], [b]) => (a ?? 0) - (b ?? 0))) {
		// A very large change goes as several commits, each made on the version the one before it made.
		let on = from;
		for (let at = 0; at < changes.length; at += COMMIT_CHANGES_MAX) {
			const answer = await worker<{ seq: number | null; merged: boolean; conflicts: { path: string; keptAs: string }[]; unchanged?: boolean }>(
				api,
				`${base(state.canvasId)}/commit`,
				{ json: { base: on, agent: opts.agent, ...(opts.message ? { message: opts.message.slice(0, 2_000) } : {}), changes: changes.slice(at, at + COMMIT_CHANGES_MAX) }, timeoutMs: 120_000 },
			);
			on = answer.seq ?? on;
			pushed.seq = answer.seq ?? pushed.seq;
			pushed.merged ||= answer.merged;
			pushed.conflicts.push(...answer.conflicts);
			pushed.unchanged &&= Boolean(answer.unchanged);
		}
	}
	return { pushed, sent };
}

/** The agent name the folder takes (`^[a-z0-9][a-z0-9-]{0,39}$`): what this computer's agent is called, made to fit. */
export function folderAgent(name: string): string {
	const fitted = name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
	return /^[a-z0-9]/.test(fitted) ? fitted : "local";
}

/** A new record for a directory not yet in step with any version of this canvas's folder. */
export function freshState(workerURL: string, canvasId: string): FolderState {
	return { v: 1, workerURL, canvasId, seq: null, files: {}, syncedAt: new Date().toISOString() };
}

/** Whether a directory has nothing that would be handed back (missing, empty, or only what a hand-back leaves out). */
export function isEmptyDirectory(dir: string): boolean {
	if (!existsSync(dir)) return true;
	return scanDirectory(dir).size === 0;
}

/** One round: hand back what changed here, then take the folder's latest. */
export async function syncRound(api: Api, dir: string, state: FolderState, opts: { agent: string; message?: string }): Promise<{ state: FolderState; round: Round }> {
	const handed = await push(api, dir, state, opts);
	// What went up is what this directory now holds as of the folder: the folder's version of it (merged, or the newest
	// beside a conflict copy) replaces it below, unless it changes here again meanwhile.
	let after = state;
	if (handed) {
		const files = { ...state.files };
		for (const [path, known] of Object.entries(handed.sent)) {
			if (known) files[path] = known;
			else delete files[path];
		}
		after = { ...state, files };
		delete after.stale;
	}
	const head = await folderHead(api, state.canvasId);
	const target = head?.seq ?? handed?.pushed.seq ?? null;
	const next = await pull(api, dir, after, target, state);
	writeState(dir, next.state);
	return { state: next.state, round: { base: state.seq, seq: next.state.seq, pushed: handed?.pushed ?? null, pulled: next.pulled } };
}
