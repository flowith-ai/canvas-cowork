/**
 * Generation, the way a card's own composer does it (hypergpt-frontend image-node-prompt-composer,
 * api.ts sendImageGenAsync / sendVideoGenAsync / sendCompletionAsync): place the generating card,
 * send the request with the user's session (the canvas's credit check, price and charge), and let
 * the worker fill the card. Waiting reads the cards until they settle.
 */

import { type Catalog, type Model, imageSizing, videoParams } from "./catalog";
import type { Card } from "./desk";
import { cardsFrom, fetchRowsById } from "./desk";
import { type Api, CliError, sleep, worker } from "./http";
import type { Uploaded } from "./media";
import {
	type MediaKind,
	type MediaNamer,
	geminiOmniReferenceName,
	imageReferenceNameFor,
	klingReferenceName,
	minimaxH3ReferenceName,
	nameMediaReferences,
	seedanceReferenceName,
} from "./reference-names";

export const hasHan = (s: string) => /\p{Script=Han}/u.test(s);

/** A short card title from the prompt when none is given. */
export function titleFrom(prompt: string, max = hasHan(prompt) ? 14 : 28): string {
	const flat = prompt.replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\s+/g, " ").trim();
	const first = flat.split(/(?<=[。！？.!?])\s*/u)[0] ?? flat;
	const s = first.length <= max ? first : first.slice(0, max).replace(/[，,、\s]+\S*$/u, "") || first.slice(0, max);
	return s.replace(/[。.!！?？,，:：;；]+$/u, "") || "Untitled";
}

/** A reference: a card on this canvas, or an uploaded / linked file. */
export interface Ref extends Uploaded {
	card?: Card;
}

// ---------- reference naming ----------

/** How a video model's request names what it is sent (frontend video-model-capabilities mediaReferenceFormatFor). */
export function videoNamer(id: string, m: Model): MediaNamer | undefined {
	if (/seedance-2\.(0|5)/.test(id)) return seedanceReferenceName;
	if (id === "muse-video") return seedanceReferenceName;
	if (id.startsWith("kling-video/v4")) return klingReferenceName;
	if (!m.referenceAssetLimits) return undefined;
	if (id.startsWith("gemini-omni")) return geminiOmniReferenceName;
	if (id.startsWith("minimax-h3")) return minimaxH3ReferenceName;
	return undefined;
}

/**
 * Rewrites every spelling that can only mean a sent item (@image1, image1, @图片1, <Image_1>) to the
 * model's own name, and names the items the words leave out at the end, so every sent item is named
 * once. Refuses words that name an item not sent.
 */
export function nameReferences(
	prompt: string,
	namer: MediaNamer,
	counts: Record<MediaKind, number>,
	offset: Partial<Record<MediaKind, number>> = {},
): string {
	const shifted: MediaNamer = (kind, index) => namer(kind, index + (offset[kind] ?? 0));
	const { text, references } = nameMediaReferences(prompt, shifted);
	const unsent = references.filter((r) => r.index < 1 || r.index > counts[r.kind]);
	if (unsent.length) {
		const sent = (["image", "video", "audio"] as const).filter((k) => counts[k]).map((k) => `${counts[k]} ${k}`);
		throw new CliError(
			`The prompt names ${unsent.map((r) => `${r.kind}${r.index}`).join(", ")}, but only ${sent.join(", ") || "no references"} are sent. Number references per kind in --ref order (@image1, @video1, @audio1).`,
			"INVALID_PARAM",
		);
	}
	const named = new Set(references.map((r) => `${r.kind}${r.index}`));
	const missing: string[] = [];
	for (const kind of ["image", "video", "audio"] as const)
		for (let i = 1; i <= counts[kind]; i++) if (!named.has(`${kind}${i}`)) missing.push(shifted(kind, i));
	return [text.trim(), missing.join(" ")].filter(Boolean).join(" ");
}

// ---------- requests ----------

export interface ImageJob {
	prompt: string;
	modelId: string;
	model: Model;
	ratio?: string;
	size?: string;
	quality?: string;
	transparent?: boolean;
	refs: Ref[];
}

export function imageCardData(job: ImageJob, title: string, ratio: string) {
	const refCards = job.refs.flatMap((r) => (r.card ? [r.card.id] : []));
	return {
		value: "",
		title,
		isImage: true,
		mode: "image_generation",
		status: "running",
		model: job.modelId,
		prompt: job.prompt,
		aspect_ratio: ratio,
		...(refCards.length ? { promptReferenceNodes: refCards.map((id) => ({ id, value: "" })) } : {}),
	};
}

/** The `/image_gen/async` body: pictures go in the message as Markdown images, named 图N / image N by place. */
export function imageRequest(job: ImageJob, nodeId: string, convId: string) {
	const images = job.refs.filter((r) => r.media === "image");
	if (images.length !== job.refs.length) throw new CliError("Image models take only pictures as references.", "INVALID_PARAM");
	if (job.model.maxReferenceImages !== undefined && images.length > job.model.maxReferenceImages)
		throw new CliError(`${job.modelId} takes at most ${job.model.maxReferenceImages} reference pictures; ${images.length} given.`, "INVALID_PARAM");
	if (images.length && job.model.supportsImageInput === false)
		throw new CliError(`${job.modelId} does not take reference pictures.`, "INVALID_PARAM");
	const sizing = imageSizing(job.modelId, job.model, job.ratio, job.size, job.quality);
	const words = images.length
		? nameReferences(job.prompt, imageReferenceNameFor(hasHan(job.prompt) ? "zh" : "en"), { image: images.length, video: 0, audio: 0 })
		: job.prompt.trim();
	const content = [words, images.map((r, i) => `![${hasHan(job.prompt) ? `图${i + 1}` : `image ${i + 1}`}](${r.url})`).join("\n")]
		.filter(Boolean)
		.join("\n\n");
	if (job.transparent && !job.model.supportedImageBackgrounds?.includes("transparent"))
		throw new CliError(`${job.modelId} can't make transparent backgrounds; use dola-seedream-5-5-261028.`, "INVALID_PARAM");
	return {
		ratio: sizing.ratio,
		body: {
			target_feature: "image_generation",
			model: job.modelId,
			nodeId,
			convId,
			messages: [{ role: "user", content }],
			...(sizing.aspect_ratio ? { aspect_ratio: sizing.aspect_ratio } : {}),
			...(sizing.image_size ? { image_size: sizing.image_size } : {}),
			...(sizing.quality ? { quality: sizing.quality } : {}),
			...(job.transparent ? { background: "transparent", output_format: "png" } : {}),
		},
	};
}

export interface VideoJob {
	prompt: string;
	modelId: string;
	model: Model;
	ratio?: string;
	duration?: string;
	resolution?: string;
	audio?: boolean;
	draft?: boolean;
	first?: Ref;
	last?: Ref;
	refs: Ref[];
	/** Gemini Omni only: work on the one clip in refs instead of generating from references. */
	operation?: "edit" | "extend";
}

export function videoRequest(job: VideoJob, nodeId: string, convId: string, parentNodeId: string, position: { x: number; y: number }) {
	const { model: m, modelId: id } = job;
	const params = videoParams(id, m, { ratio: job.ratio, duration: job.duration, resolution: job.resolution, draft: job.draft });
	for (const f of [job.first, job.last]) if (f && f.media !== "image") throw new CliError("--first / --last take pictures.", "INVALID_PARAM");
	if (job.last && !job.first) throw new CliError("--last needs --first.", "INVALID_PARAM");
	if (job.last && !m.supportedKeyframe) throw new CliError(`${id} doesn't take a last frame.`, "INVALID_PARAM");
	if (job.first && m.supportsImageInput === false) throw new CliError(`${id} is text-to-video only; drop --first.`, "INVALID_PARAM");
	const kling = id.startsWith("kling-video/v4");
	if (!kling && (job.first || job.last) && job.refs.length)
		throw new CliError("Frames (--first/--last) and --ref can't be combined on this model; use one or the other.", "INVALID_PARAM");

	const counts = { image: 0, video: 0, audio: 0 } as Record<MediaKind, number>;
	const urls = { image_urls: [] as string[], video_urls: [] as string[], audio_urls: [] as string[] };
	for (const r of job.refs) {
		if (r.media === "file") throw new CliError(`${r.name}: references are pictures, clips or sounds.`, "INVALID_PARAM");
		counts[r.media]++;
		urls[`${r.media}_urls`].push(r.url);
	}
	let prompt = job.prompt.trim();
	let imageURL: string | undefined = job.first?.url;
	const namer = videoNamer(id, m);
	if (job.refs.length) {
		const limits = m.referenceAssetLimits;
		if (!namer || !limits) {
			// Image-to-video models without named references take one picture: it is the first frame.
			if (job.refs.length > 1 || counts.image !== 1) throw new CliError(`${id} takes one reference picture (as its first frame); use --first.`, "INVALID_PARAM");
			imageURL = urls.image_urls[0];
			urls.image_urls = [];
		} else {
			if (job.refs.length > limits.total) throw new CliError(`${id} takes at most ${limits.total} references.`, "INVALID_PARAM");
			for (const k of ["image", "video", "audio"] as const)
				if (counts[k] > limits[k]) throw new CliError(`${id} takes at most ${limits[k]} ${k} references; ${counts[k]} given.`, "INVALID_PARAM");
			// Kling numbers its keyframes first, then the references of the same kind.
			const offset = kling ? { image: Number(Boolean(job.first)) + Number(Boolean(job.last)) } : {};
			prompt = nameReferences(prompt, namer, counts, offset);
		}
	}
	if (job.operation) {
		if (!id.startsWith("gemini-omni")) throw new CliError("--extend / --edit-video work with Gemini Omni models.", "INVALID_PARAM");
		if (urls.video_urls.length !== 1) throw new CliError("--extend / --edit-video take exactly one clip.", "INVALID_PARAM");
	}
	const keyFrames = job.first && job.last ? [job.first.url, job.last.url] : undefined;
	// Kling 4 always makes its own sound and refuses an audio switch.
	// Models without a sound switch get none sent (they keep their own default).
	const audio = kling ? undefined : (job.audio ?? (m.supportsAudio ? true : undefined));
	const body = {
		target_feature: "video_generation",
		nodeId,
		convId,
		parentNodeId,
		position,
		model: id,
		prompt,
		...(keyFrames ? { keyFrames } : imageURL ? { imageURL } : {}),
		...(urls.image_urls.length ? { image_urls: urls.image_urls } : {}),
		...(urls.video_urls.length ? { video_urls: urls.video_urls } : {}),
		...(urls.audio_urls.length ? { audio_urls: urls.audio_urls } : {}),
		...(params.aspect_ratio ? { aspect_ratio: params.aspect_ratio } : {}),
		...(params.duration ? { duration: params.duration } : {}),
		...(params.resolution ? { resolution: params.resolution } : {}),
		...(audio !== undefined ? { audio } : {}),
		...(job.draft ? { draft: true } : {}),
		...(job.operation ? { video_operation: job.operation } : {}),
	};
	return { body, params, audio };
}

export function videoCardData(job: VideoJob, title: string, params: { aspect_ratio?: string; duration?: string; resolution?: string }, audio?: boolean) {
	const refCards = [job.first, job.last, ...job.refs].flatMap((r) => (r?.card ? [r.card.id] : []));
	const base = job.first?.card ?? (job.operation ? job.refs[0]?.card : undefined);
	return {
		value: "",
		title,
		isImage: false,
		mode: "video_generation",
		status: "running",
		model: job.modelId,
		prompt: job.prompt,
		aspect_ratio: params.aspect_ratio && params.aspect_ratio !== "adaptive" && params.aspect_ratio !== "auto" ? params.aspect_ratio : "16:9",
		...(params.duration ? { duration: params.duration } : {}),
		...(params.resolution ? { resolution: params.resolution } : {}),
		...(audio !== undefined ? { audio } : {}),
		...(job.draft ? { draft: true } : {}),
		...(base ? { [base.kind === "video" ? "baseVideoNodeId" : "baseImageNodeId"]: base.id } : {}),
		...(refCards.length ? { promptReferenceNodes: [...new Set(refCards)].map((id) => ({ id, value: "" })) } : {}),
	};
}

export interface TextJob {
	prompt: string;
	modelId: string;
	system?: string;
	refs: Ref[];
}

/** A named card keeps its name (`customTitle`); otherwise the worker titles it from the answer. */
export function textCardData(job: TextJob, title: string, named = false) {
	const refCards = job.refs.flatMap((r) => (r.card ? [r.card.id] : []));
	return {
		value: "",
		title,
		...(named ? { customTitle: title } : {}),
		isImage: false,
		mode: "General",
		status: "running",
		model: job.modelId,
		prompt: job.prompt,
		slot: false,
		...(refCards.length ? { promptReferenceNodes: refCards.map((id) => ({ id, value: "" })) } : {}),
	};
}

/** The `/completion/async` body; text cards it reads go first, pictures as Markdown images. */
export function textRequest(job: TextJob, nodeId: string, convId: string) {
	const images = job.refs.filter((r) => r.media === "image" && !r.card?.text).length;
	const prompt = images ? nameReferences(job.prompt, imageReferenceNameFor(hasHan(job.prompt) ? "zh" : "en"), { image: images, video: 0, audio: 0 }) : job.prompt;
	const blocks = job.refs.map((r) => {
		const c = r.card;
		if (c && c.text) return `### ${c.title ?? c.ref}\n${c.text}`;
		if (r.media === "image") return `![${c?.title ?? r.name}](${r.url})`;
		return `${c?.title ?? r.name}: ${r.url}`;
	});
	let n = 0;
	const named = blocks.map((b, i) => (job.refs[i]!.media === "image" && !job.refs[i]!.card?.text ? b.replace(/^!\[[^\]]*\]/, `![${hasHan(job.prompt) ? `图${++n}` : `image ${++n}`}]`) : b));
	const content = [...named, prompt].join("\n\n");
	return {
		target_feature: "text_completion",
		model: job.modelId,
		nodeId,
		convId,
		stream: true,
		messages: [...(job.system ? [{ role: "system", content: job.system }] : []), { role: "user", content }],
	};
}

// ---------- sending and waiting ----------

const PATH = { image: "/image_gen/async", video: "/video/async", text: "/completion/async?mode=general" } as const;

export async function send(api: Api, kind: keyof typeof PATH, body: Record<string, unknown>) {
	await worker(api, PATH[kind], { json: body, timeoutMs: 180_000 });
}

export interface Result {
	ref: string;
	id: string;
	kind: string;
	status: "finished" | "failed" | "running" | "removed";
	title?: string;
	model?: string;
	url?: string;
	preview?: string;
	text?: string;
	error?: string;
	code?: string;
	ratio?: string;
	groupId?: string;
}

export function resultOf(card: Card): Result {
	const d = card.data;
	let status: Result["status"] = card.kind === "group" || card.status === "finished" ? "finished" : card.status === "failed" ? "failed" : "running";
	let code: string | undefined;
	let error = card.error;
	if (card.type === "22") {
		status = "failed";
		code = "NO_CREDITS";
		error = d.errorMessage || d.creditFailureReason || "Not enough credits";
	} else if (card.type === "25") {
		status = "failed";
		code = "MODEL_LOCKED";
		error = d.errorMessage || "This model needs a higher plan";
	} else if (status === "failed") {
		// The worker's own failure type when it gave one (content_policy, invalid_input, provider_unavailable…).
		const type = typeof d.error_type === "string" && d.error_type ? d.error_type.toUpperCase().replace(/[^A-Z0-9]+/g, "_") : undefined;
		code = ["NO_CREDITS", "MODEL_LOCKED", "RATE_LIMITED", "FORBIDDEN"].includes(String(d.error_code))
			? String(d.error_code)
			: type === "CONTENT_POLICY" || type === "INVALID_INPUT" ? type : "GENERATION_FAILED";
	}

	if (status === "finished" && (card.kind === "image" || card.kind === "video" || card.kind === "audio") && !card.url) status = "running";
	return {
		ref: card.ref,
		id: card.id,
		kind: card.kind,
		status,
		...(card.title ? { title: card.title } : {}),
		...(card.model ? { model: card.model } : {}),
		...(card.url ? { url: card.url } : {}),
		...(card.preview ? { preview: card.preview } : {}),
		...(card.text && status === "finished" ? { text: card.text } : {}),
		...(error && status === "failed" ? { error } : {}),
		...(code ? { code } : {}),
		...(card.ratio ? { ratio: card.ratio } : {}),
		...(card.groupId ? { groupId: card.groupId.slice(0, 8) } : {}),
	};
}

/** Reads the cards until each is finished or failed (or the time is up). */
export async function waitFor(
	api: Api,
	ids: string[],
	opts: { timeoutMs: number; onTick?: (done: number, total: number) => void },
): Promise<Result[]> {
	const deadline = Date.now() + opts.timeoutMs;
	let delay = 2500;
	let latest = new Map<string, Result>();
	for (;;) {
		try {
			const rows = await fetchRowsById(api, ids);
			latest = new Map(cardsFrom(rows).map((c) => [c.id, resultOf(c)]));
			for (const id of ids) {
				if (!latest.has(id)) latest.set(id, { ref: id.slice(0, 8), id, kind: "?", status: "removed" });
			}
		} catch (e) {
			if (e instanceof CliError && e.code === "NOT_LOGGED_IN") throw e;
		}
		const results = ids.map(
			(id): Result => latest.get(id) ?? { ref: id.slice(0, 8), id, kind: "?", status: "running" },
		);
		const settled = results.filter((r) => r.status !== "running").length;
		opts.onTick?.(settled, ids.length);
		const timeLeft = deadline - Date.now();
		if (settled === ids.length || timeLeft <= 0) return results;
		await sleep(Math.min(delay, timeLeft));
		delay = Math.min(delay + 500, 6000);
	}
}

/** The canvas's failure kinds (frontend ErrorType), which its cards know how to explain. */
function errorTypeOf(code: string | undefined): string {
	if (code === "CONTENT_POLICY") return "content_policy";
	if (code === "RATE_LIMITED") return "provider_rate_limit";
	if (code === "TIMEOUT") return "provider_timeout";
	if (code === "INVALID_PARAM" || code === "INVALID_INPUT" || code === "INVALID_MODEL" || code === "BAD_REQUEST") return "invalid_request";
	return code ? "provider_error" : "provider_network";
}

/**
 * Marks a card whose request was refused before the worker took it, the way the canvas marks its own: out of credits
 * becomes the canvas's credits card, a model the plan doesn't include its upgrade card, anything else an error the
 * card shows (an image card reads it from its value, as the worker writes it).
 */
export async function failCard(
	api: Api,
	card: Pick<Card, "id" | "createdAt" | "type">,
	data: Record<string, unknown>,
	failure: unknown,
) {
	const { patch } = await import("./write");
	const error = failure instanceof Error ? failure.message : String(failure);
	const code = failure instanceof CliError ? failure.code : undefined;
	const body = (failure instanceof CliError && failure.data && typeof failure.data === "object" ? failure.data : {}) as Record<string, unknown>;
	const text = (v: unknown) => (typeof v === "string" && v ? v : undefined);
	let fields: Record<string, unknown>;
	if (code === "NO_CREDITS" && body.reason === "is_free_user" && body.modelTier === "t1") {
		fields = { type: "25", data: { ...data, status: "failed", attemptedModel: text(body.model) ?? data.model, httpCode: 402, errorMessage: text(body.error) } };
	} else if (code === "NO_CREDITS") {
		fields = {
			type: "22",
			data: {
				...data,
				status: "failed",
				...(text(body.model) ? { model: body.model, attemptedModel: body.model } : {}),
				...(text(body.modelTier) ? { modelTier: body.modelTier } : {}),
				...(text(body.target_feature) ? { targetFeature: body.target_feature } : {}),
				...(text(body.reason) ? { creditFailureReason: body.reason } : {}),
				...(text(body.stage) ? { creditFailureStage: body.stage } : {}),
				...(text(body.code) ? { creditFailureCode: body.code } : {}),
				errorMessage: text(body.error) ?? error,
			},
		};
	} else {
		const errorType = errorTypeOf(code);
		const image = card.type === "2" && data.isImage === true;
		fields = {
			data: {
				...data,
				status: "failed",
				error,
				error_type: errorType,
				...(code ? { error_code: code } : {}),
				...(image ? { value: JSON.stringify({ value: errorType, error_type: errorType, error }) } : {}),
			},
		};
	}
	await patch(api, card, fields).catch(() => {});
}

export type { Catalog };
