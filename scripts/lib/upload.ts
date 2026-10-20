/**
 * File uploads via the worker's `/file/store` — the same endpoint the app's
 * composer uses. Accepts images, video, audio and documents; returns an R2 URL.
 */

import { readFileSync, statSync } from "fs";
import { basename, extname } from "path";
import { type ApiSession, CliError, workerFetch } from "./http";

export type Media = "image" | "video" | "audio" | "file";

const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "webp", "gif", "svg", "bmp", "avif", "heic", "heif"]);
const VIDEO_EXTS = new Set(["mp4", "mov", "avi", "mkv", "webm", "m4v"]);
const AUDIO_EXTS = new Set(["mp3", "wav", "flac", "aac", "m4a", "ogg", "wma"]);

const MIME: Record<string, string> = {
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	png: "image/png",
	webp: "image/webp",
	gif: "image/gif",
	svg: "image/svg+xml",
	bmp: "image/bmp",
	avif: "image/avif",
	heic: "image/heic",
	heif: "image/heif",
	mp4: "video/mp4",
	mov: "video/quicktime",
	webm: "video/webm",
	mkv: "video/x-matroska",
	avi: "video/x-msvideo",
	m4v: "video/x-m4v",
	mp3: "audio/mpeg",
	wav: "audio/wav",
	flac: "audio/flac",
	aac: "audio/aac",
	m4a: "audio/mp4",
	ogg: "audio/ogg",
	pdf: "application/pdf",
};

// Client-side limits the app enforces (video 100 MB, others 30 MB).
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
const MAX_OTHER_BYTES = 30 * 1024 * 1024;

export function isUrl(s: string): boolean {
	return /^https?:\/\//i.test(s);
}

export function extOf(nameOrUrl: string): string {
	const path = isUrl(nameOrUrl) ? nameOrUrl.split(/[?#]/)[0] : nameOrUrl;
	return extname(path).slice(1).toLowerCase();
}

export function mediaOf(nameOrUrl: string, mime?: string): Media {
	const ext = extOf(nameOrUrl);
	if (IMAGE_EXTS.has(ext) || mime?.startsWith("image/")) return "image";
	if (VIDEO_EXTS.has(ext) || mime?.startsWith("video/")) return "video";
	if (AUDIO_EXTS.has(ext) || mime?.startsWith("audio/")) return "audio";
	return "file";
}

export interface UploadedMedia {
	url: string;
	name: string;
	/** mime type (or application/octet-stream) */
	type: string;
	media: Media;
}

export async function uploadFile(
	s: ApiSession,
	filePath: string,
	opts: { convId?: string; quiet?: boolean } = {},
): Promise<UploadedMedia> {
	let size: number;
	try {
		size = statSync(filePath).size;
	} catch {
		throw new CliError(`File not found: ${filePath}`, "INVALID_PARAM");
	}
	const name = basename(filePath);
	const ext = extOf(name);
	const media = mediaOf(name);
	const limit = media === "video" ? MAX_VIDEO_BYTES : MAX_OTHER_BYTES;
	if (size > limit)
		throw new CliError(
			`File too large: ${(size / 1024 / 1024).toFixed(1)}MB (max ${limit / 1024 / 1024}MB for ${media})`,
			"INVALID_PARAM",
		);
	const mime = MIME[ext] || "application/octet-stream";
	const form = new FormData();
	form.append("file", new Blob([readFileSync(filePath)], { type: mime }), name);
	// The app sends "image" for images and the bare extension for everything else.
	form.append("type", media === "image" ? "image" : ext || "file");
	if (opts.convId) form.append("conv_id", opts.convId);
	if (!opts.quiet) console.error(`Uploading ${name} (${(size / 1024).toFixed(0)}KB)...`);
	const resp = await workerFetch(s, "/file/store", { body: form, timeoutMs: 180_000 });
	const { url } = (await resp.json()) as { url?: string };
	if (!url) throw new CliError("Upload returned no URL", "HTTP_ERROR");
	if (!opts.quiet) console.error(`Uploaded → ${url}`);
	return { url, name, type: mime, media };
}

/** Local paths get uploaded; URLs pass through (typed by their extension). */
export async function resolveMedia(
	s: ApiSession,
	inputs: string[],
	opts: { convId?: string; quiet?: boolean } = {},
): Promise<UploadedMedia[]> {
	const out: UploadedMedia[] = [];
	for (const p of inputs) {
		if (isUrl(p)) {
			const name = p.split("/").pop()?.split(/[?#]/)[0] || "file";
			const ext = extOf(name);
			out.push({ url: p, name, type: MIME[ext] || "application/octet-stream", media: mediaOf(name) });
		} else {
			out.push(await uploadFile(s, p, opts));
		}
	}
	return out;
}
