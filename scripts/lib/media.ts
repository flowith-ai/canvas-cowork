/**
 * Files in and out: uploads through the worker's `/file/store` (what the composer uses), downloads
 * of results and previews, and an image's pixel size read from its header (no dependencies).
 */

import { mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { basename, dirname, extname, join, resolve } from "path";
import { type Api, CliError, worker } from "./http";

export type Media = "image" | "video" | "audio" | "file";

const EXT: Record<string, { mime: string; media: Media }> = {
	jpg: { mime: "image/jpeg", media: "image" },
	jpeg: { mime: "image/jpeg", media: "image" },
	png: { mime: "image/png", media: "image" },
	webp: { mime: "image/webp", media: "image" },
	gif: { mime: "image/gif", media: "image" },
	avif: { mime: "image/avif", media: "image" },
	heic: { mime: "image/heic", media: "image" },
	bmp: { mime: "image/bmp", media: "image" },
	mp4: { mime: "video/mp4", media: "video" },
	mov: { mime: "video/quicktime", media: "video" },
	webm: { mime: "video/webm", media: "video" },
	m4v: { mime: "video/x-m4v", media: "video" },
	mp3: { mime: "audio/mpeg", media: "audio" },
	wav: { mime: "audio/wav", media: "audio" },
	m4a: { mime: "audio/mp4", media: "audio" },
	aac: { mime: "audio/aac", media: "audio" },
	flac: { mime: "audio/flac", media: "audio" },
	ogg: { mime: "audio/ogg", media: "audio" },
	pdf: { mime: "application/pdf", media: "file" },
};

export const isUrl = (s: string) => /^https?:\/\//i.test(s);
const extOf = (s: string) => extname((isUrl(s) ? s.split(/[?#]/)[0] : s) ?? "").slice(1).toLowerCase();
export const mediaOf = (s: string): Media => EXT[extOf(s)]?.media ?? "file";

export interface Uploaded {
	url: string;
	name: string;
	media: Media;
}

const MAX_BYTES: Record<Media, number> = { video: 100 << 20, image: 30 << 20, audio: 30 << 20, file: 30 << 20 };

export async function upload(api: Api, path: string, convId?: string): Promise<Uploaded> {
	let size: number;
	try {
		size = statSync(path).size;
	} catch {
		throw new CliError(`No such file: ${path}`, "INVALID_PARAM");
	}
	const name = basename(path);
	const info = EXT[extOf(name)] ?? { mime: "application/octet-stream", media: "file" as Media };
	if (size > MAX_BYTES[info.media])
		throw new CliError(`${name} is ${(size / 2 ** 20).toFixed(1)} MB; the limit for ${info.media} is ${MAX_BYTES[info.media] / 2 ** 20} MB.`, "INVALID_PARAM");
	const form = new FormData();
	form.append("file", new Blob([readFileSync(path)], { type: info.mime }), name);
	form.append("type", info.media === "image" ? "image" : extOf(name) || "file");
	if (convId) form.append("conv_id", convId);
	const out = await worker<{ url?: string }>(api, "/file/store", { body: form, timeoutMs: 300_000 });
	if (!out?.url) throw new CliError(`Upload of ${name} returned no URL.`, "SERVER_ERROR");
	return { url: out.url, name, media: info.media };
}

/** Local files are uploaded; URLs pass through, typed by extension (or by `hint`). */
export async function toUrl(api: Api, input: string, convId?: string, hint?: Media): Promise<Uploaded> {
	if (isUrl(input)) {
		const name = input.split("/").pop()?.split(/[?#]/)[0] || "file";
		const media = mediaOf(name);
		return { url: input, name, media: media === "file" && hint ? hint : media };
	}
	return upload(api, resolve(input), convId);
}

export async function download(url: string, path: string): Promise<{ file: string; bytes: number }> {
	const resp = await fetch(url, { signal: AbortSignal.timeout(300_000) });
	if (!resp.ok) throw new CliError(`Download failed (HTTP ${resp.status}): ${url}`, "SERVER_ERROR");
	const buf = Buffer.from(await resp.arrayBuffer());
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, buf);
	return { file: path, bytes: buf.length };
}

/** `dir/<ref>-<slug>.<ext>` for a card's file. */
export function fileFor(dir: string, ref: string, title: string | undefined, url: string, fallbackExt: string) {
	const ext = extOf(url) || fallbackExt;
	const slug = (title ?? "")
		.normalize("NFKC")
		.replace(/[^\p{L}\p{N}]+/gu, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	return join(resolve(dir), `${ref}${slug ? `-${slug}` : ""}.${ext}`);
}

/** Width × height from the first bytes of a PNG, JPEG, GIF or WebP. */
export function imageSize(buf: Uint8Array): { width: number; height: number } | undefined {
	const b = Buffer.from(buf);
	if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
	if (b.length > 10 && b.toString("ascii", 0, 3) === "GIF") return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
	if (b.length > 30 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") {
		const chunk = b.toString("ascii", 12, 16);
		if (chunk === "VP8X") return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
		if (chunk === "VP8 ") return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
		if (chunk === "VP8L") {
			const bits = b.readUInt32LE(21);
			return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
		}
	}
	if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
		let i = 2;
		while (i + 9 < b.length) {
			if (b[i] !== 0xff) {
				i++;
				continue;
			}
			const marker = b[i + 1]!;
			const len = b.readUInt16BE(i + 2);
			if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
				return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
			i += 2 + len;
		}
	}
	return undefined;
}

/** An image's pixel size, reading as little of it as needed. */
export async function remoteImageSize(url: string): Promise<{ width: number; height: number } | undefined> {
	for (const range of ["bytes=0-65535", undefined]) {
		try {
			const resp = await fetch(url, { headers: range ? { Range: range } : {}, signal: AbortSignal.timeout(60_000) });
			if (!resp.ok && resp.status !== 206) continue;
			const size = imageSize(new Uint8Array(await resp.arrayBuffer()));
			if (size) return size;
		} catch {}
	}
	return undefined;
}
