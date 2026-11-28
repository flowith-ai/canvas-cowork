/**
 * A stand-in canvas folder (flo-workers /canvas-folder, creater-agent docs/futuristic-agents.md §2) for the CLI tests:
 * versions of a file tree, contents stored by sha256, commits made on a base version and merged onto the head per path.
 * Unlike the real one it merges no text: a file both sides changed is a conflict, the head's copy staying at the path
 * and the committer's kept beside it as `<stem> (<Agent>).<ext>`, as flo-workers names it.
 */
import { createHash } from "crypto";

type Ref = { hash: string; size: number };
interface Version {
	seq: number;
	parents: number[];
	files: Map<string, Ref>;
	agent: string | null;
	createdAt: string;
}
type Change = { path: string; hash: string; size: number } | { path: string; delete: true };

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
/** flo-workers paths.ts labelOf: claude-code → Claude Code; a person's own copy → copy. */
const labelOf = (agent: string | null) => (agent ? agent.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ") : "copy");

export function fakeFolder() {
	const blobs = new Map<string, Uint8Array>();
	const versions: Version[] = [];
	/** Every commit asked for, as sent. */
	const commits: Array<{ base: number | null; agent?: string; message?: string; changes: Change[] }> = [];
	const head = () => versions.at(-1);
	const at = (seq: number) => versions.find((v) => v.seq === seq);

	const conflictPath = (path: string, agent: string | null, taken: Map<string, Ref>) => {
		const slash = path.lastIndexOf("/");
		const dot = path.lastIndexOf(".");
		const [stem, ext] = dot > slash + 1 ? [path.slice(0, dot), path.slice(dot)] : [path, ""];
		for (let n = 1; ; n++) {
			const name = `${stem} (${labelOf(agent)}${n > 1 ? ` ${n}` : ""})${ext}`;
			if (!taken.has(name)) return name;
		}
	};

	function commit(input: { base: number | null; agent?: string; changes: Change[] }) {
		const current = head();
		const headFiles = current?.files ?? new Map<string, Ref>();
		const baseFiles = input.base === null ? new Map<string, Ref>() : at(input.base)!.files;
		const files = new Map(headFiles);
		const conflicts: { path: string; keptAs: string }[] = [];
		for (const change of input.changes) {
			const ours = "delete" in change ? null : { hash: change.hash, size: change.size };
			const before = baseFiles.get(change.path)?.hash ?? null;
			const theirs = headFiles.get(change.path)?.hash ?? null;
			if (theirs === before || theirs === (ours?.hash ?? null)) {
				if (ours) files.set(change.path, ours);
				else files.delete(change.path);
			} else if (ours) {
				const keptAs = conflictPath(change.path, input.agent ?? null, files);
				files.set(keptAs, ours);
				conflicts.push({ path: change.path, keptAs });
			}
		}
		const same = files.size === headFiles.size && [...files].every(([path, ref]) => headFiles.get(path)?.hash === ref.hash);
		if (same) return { seq: current?.seq ?? null, root: "root", merged: false, conflicts: [], unchanged: true };
		const merged = current !== undefined && input.base !== current.seq;
		const seq = (current?.seq ?? 0) + 1;
		versions.push({
			seq,
			parents: !current ? [] : merged && input.base !== null ? [current.seq, input.base] : [current.seq],
			files,
			agent: input.agent ?? null,
			createdAt: new Date().toISOString(),
		});
		return { seq, root: `root-${seq}`, merged, conflicts, unchanged: false };
	}

	/** Another writer (Flo, a run, the browser) changes files on the head: text by path, null deletes. */
	function write(changes: Record<string, string | null>, agent: string | null = "flo") {
		return commit({
			base: head()?.seq ?? null,
			agent: agent ?? undefined,
			changes: Object.entries(changes).map(([path, text]) => {
				if (text === null) return { path, delete: true as const };
				const bytes = new TextEncoder().encode(text);
				blobs.set(sha256(bytes), bytes);
				return { path, hash: sha256(bytes), size: bytes.byteLength };
			}),
		});
	}

	/** A file of the head as text, or undefined. */
	const text = (path: string, seq = head()?.seq) => {
		const ref = seq === undefined ? undefined : at(seq)?.files.get(path);
		return ref ? new TextDecoder().decode(blobs.get(ref.hash)) : undefined;
	};

	function handle(req: Request, url: URL, body: unknown): Response {
		const route = /^\/canvas-folder\/[^/]+(\/.*)?$/.exec(url.pathname)?.[1] ?? "";
		const version = (seq: string | null) => (seq ? at(Number(seq)) : head());
		if (req.method === "GET" && route === "") {
			const h = head();
			return Response.json({ head: h ? { seq: h.seq, parents: h.parents, agent: h.agent, createdAt: h.createdAt, changes: { counts: {} } } : null });
		}
		if (req.method === "GET" && route === "/files") {
			const v = version(url.searchParams.get("seq"));
			if (!v) return Response.json({ error: "not_found" }, { status: 404 });
			return Response.json({ seq: v.seq, files: [...v.files].map(([path, ref]) => ({ path, ...ref })), truncated: false });
		}
		if (req.method === "GET" && route === "/file") {
			const v = version(url.searchParams.get("seq"));
			const ref = v?.files.get(url.searchParams.get("path") ?? "");
			if (!v || !ref) return Response.json({ error: "not_found" }, { status: 404 });
			return new Response(blobs.get(ref.hash), { headers: { "Content-Type": "application/octet-stream", "X-Content-Sha256": ref.hash, "X-Folder-Seq": String(v.seq) } });
		}
		const blob = /^\/blobs\/([0-9a-f]{64})$/.exec(route);
		if (req.method === "PUT" && blob) {
			const bytes = body as Uint8Array;
			if (sha256(bytes) !== blob[1]) return Response.json({ error: "The content doesn't match its sha256." }, { status: 400 });
			blobs.set(blob[1]!, bytes);
			return Response.json({ hash: blob[1], size: bytes.byteLength });
		}
		if (req.method === "POST" && route === "/commit") {
			const input = body as { base: number | null; agent?: string; message?: string; changes: Change[] };
			commits.push(structuredClone(input));
			if (input.agent !== undefined && !/^[a-z0-9][a-z0-9-]{0,39}$/.test(input.agent)) return Response.json({ error: "bad agent" }, { status: 400 });
			for (const change of input.changes) if ("hash" in change && !blobs.has(change.hash)) return Response.json({ error: `Upload content ${change.hash} first.`, hash: change.hash }, { status: 400 });
			if (input.base !== null && !at(input.base)) return Response.json({ error: `Version ${input.base} isn't in this folder.` }, { status: 400 });
			return Response.json(commit(input));
		}
		return Response.json({ error: "not_found" }, { status: 404 });
	}

	return { handle, write, text, commits, versions, head, sha256 };
}
