/** `--out`: save a generation result to disk. */

import { mkdirSync, writeFileSync } from "fs";
import { dirname, extname, join, resolve } from "path";
import { CliError } from "./http";

/** Derive the file path for one result: `--out dir/` → `dir/<index>-<nodeId>.<ext>`. */
export function outputPathFor(
	out: string,
	opts: { nodeId: string; index?: number; url?: string; kind: "text" | "image" | "video"; batch: boolean },
): string {
	const isDir = out.endsWith("/") || opts.batch;
	if (!isDir) return resolve(out);
	const ext =
		(opts.url && extname(opts.url.split(/[?#]/)[0])) ||
		(opts.kind === "text" ? ".md" : opts.kind === "video" ? ".mp4" : ".png");
	const prefix = opts.index !== undefined ? `${String(opts.index + 1).padStart(2, "0")}-` : "";
	return resolve(join(out, `${prefix}${opts.nodeId.slice(0, 8)}${ext}`));
}

export async function saveResult(
	path: string,
	content: { url?: string; text?: string },
): Promise<{ file: string; bytes: number }> {
	mkdirSync(dirname(path), { recursive: true });
	if (content.text !== undefined) {
		writeFileSync(path, content.text);
		return { file: path, bytes: Buffer.byteLength(content.text) };
	}
	if (!content.url) throw new CliError("Nothing to save (no url or text).", "INVALID_PARAM");
	const resp = await fetch(content.url, { signal: AbortSignal.timeout(300_000) });
	if (!resp.ok) throw new CliError(`Download failed (HTTP ${resp.status}) for ${content.url}`, "HTTP_ERROR");
	const buf = Buffer.from(await resp.arrayBuffer());
	writeFileSync(path, buf);
	return { file: path, bytes: buf.length };
}
