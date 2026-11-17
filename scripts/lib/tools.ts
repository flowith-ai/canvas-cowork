/**
 * A card's toolbar actions that run on the worker with the user's session: upscale, background
 * removal and expand for pictures; upscale and background removal for clips; and the canvas's
 * speech / music tools. Each result is a new card beside its source, linked to it, as the toolbar
 * makes it (hypergpt-frontend use-image-background-removal.ts, multi-size-expand.ts, audio-generation.ts).
 */

import type { Card } from "./desk";
import { type Api, CliError, sleep, worker } from "./http";
import { failCard } from "./generate";
import { remoteImageSize } from "./media";
import { type Placed, cardSize, placeCards } from "./write";
import { placeSingle } from "./placement";
import { anchorRect, obstaclesOf } from "./write";

const finishedMedia = (card: Card, kind: "image" | "video") => {
	if (card.kind !== kind || !card.url || card.status === "running")
		throw new CliError(`${card.ref} is not a finished ${kind === "image" ? "picture" : "clip"} card.`, "INVALID_PARAM");
	return card.url;
};

async function resultCard(api: Api, convId: string, cards: Card[], source: Card, kind: "image" | "video", ratio: string, data: Record<string, unknown>): Promise<Placed> {
	return placeCards(api, convId, cards, [{ kind, size: cardSize(kind, ratio), data: { value: "", status: "running", ...data } }], { anchor: source });
}

/** Sends a tool's request for its placed card; a refusal marks the card failed instead of leaving it spinning. */
async function submit(api: Api, placed: Placed, path: string, json: Record<string, unknown>) {
	try {
		await worker(api, path, { json, timeoutMs: 120_000 });
	} catch (e) {
		const row = placed.rows.find((r) => r.id === placed.ids[0]);
		if (row) await failCard(api, { id: row.id, createdAt: row.created_at, type: row.type }, (row.data as Record<string, unknown>) ?? {}, e);
		throw e;
	}
}

// ---------- pictures ----------

const UPSCALE_LONG_EDGE = { "2k": 2048, "4k": 4096, "8k": 8192 } as const;

export async function upscaleImage(api: Api, convId: string, cards: Card[], source: Card, to?: string) {
	const url = finishedMedia(source, "image");
	const size = await remoteImageSize(url);
	if (!size) throw new CliError("Couldn't read the picture's size.", "SERVER_ERROR");
	const long = Math.max(size.width, size.height);
	const tier = (to?.toLowerCase() ?? (long < 2048 ? "2k" : long < 4096 ? "4k" : "8k")) as keyof typeof UPSCALE_LONG_EDGE;
	if (!(tier in UPSCALE_LONG_EDGE)) throw new CliError("--to takes 2k, 4k or 8k for pictures.", "INVALID_PARAM");
	if (UPSCALE_LONG_EDGE[tier] <= long) throw new CliError(`The picture is already ${size.width}×${size.height}; choose a larger --to.`, "INVALID_PARAM");
	const ratio = `${size.width}:${size.height}`;
	const placed = await resultCard(api, convId, cards, source, "image", ratio, {
		title: `${source.title ?? "Picture"} · ${tier.toUpperCase()}`,
		isImage: true,
		mode: "image_generation",
		model: "seedvr2-upscale",
		aspect_ratio: ratio,
		baseImageNodeId: source.id,
		baseImageUrl: url,
		targetFeature: "image_upscale",
	});
	await submit(api, placed, "/image_edit/submit", { operation: "upscale", convId, nodeId: placed.ids[0], imageUrl: url, source_width: size.width, source_height: size.height, upscale_tier: tier });
	return placed;
}

const CUTOUT_PROMPT = "Remove the background and preserve the foreground subject with clean edges.";

export async function cutout(api: Api, convId: string, cards: Card[], source: Card) {
	if (source.kind === "video") {
		const url = finishedMedia(source, "video");
		const placed = await resultCard(api, convId, cards, source, "video", source.ratio ?? "16:9", {
			title: `${source.title ?? "Clip"} · cut out`,
			isImage: false,
			mode: "video_generation",
			model: "video-background-removal",
			baseVideoNodeId: source.id,
		});
		await submit(api, placed, "/video_edit/remove-background/submit", { convId, nodeId: placed.ids[0], sourceNodeId: source.id, video_url: url });
		return placed;
	}
	const url = finishedMedia(source, "image");
	const placed = await resultCard(api, convId, cards, source, "image", source.ratio ?? "1:1", {
		title: `${source.title ?? "Picture"} · cut out`,
		isImage: true,
		mode: "image_generation",
		model: "image-edit-background-removal",
		prompt: CUTOUT_PROMPT,
		baseImageNodeId: source.id,
		baseImageUrl: url,
		targetFeature: "image_background_removal",
	});
	await submit(api, placed, "/image_edit/submit", { operation: "edit", convId, nodeId: placed.ids[0], imageUrl: url, prompt: CUTOUT_PROMPT, target_feature: "image_background_removal" });
	return placed;
}

/** The expand frame: the smallest box of the ratio holding the whole picture, centred (frontend multiSizeFrame). */
export function expandFrame(ratio: { width: number; height: number }, w: number, h: number) {
	const target = ratio.width / ratio.height;
	const wider = w / h > target;
	const boxW = wider ? w : h * target;
	const boxH = wider ? w / target : h;
	const fit = Math.min(1, 2560 / boxW, 2560 / boxH, Math.sqrt((2048 * 2048) / (boxW * boxH)));
	const scale = Math.max(fit, 64 / Math.min(boxW, boxH));
	const sourceWidth = Math.max(1, Math.floor(w * scale));
	const sourceHeight = Math.max(1, Math.floor(h * scale));
	const outputWidth = Math.max(64, sourceWidth, Math.floor(boxW * scale));
	const outputHeight = Math.max(64, sourceHeight, Math.floor(boxH * scale));
	return { outputWidth, outputHeight, sourceWidth, sourceHeight, offsetX: Math.floor((outputWidth - sourceWidth) / 2), offsetY: Math.floor((outputHeight - sourceHeight) / 2) };
}

export async function expand(api: Api, convId: string, cards: Card[], source: Card, ratioText: string) {
	const url = finishedMedia(source, "image");
	const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(ratioText);
	if (!m) throw new CliError("--ratio takes a ratio such as 16:9, 9:16, 4:5 or 1:1.", "INVALID_PARAM");
	const size = await remoteImageSize(url);
	if (!size) throw new CliError("Couldn't read the picture's size.", "SERVER_ERROR");
	const ratio = { width: Number(m[1]), height: Number(m[2]) };
	if (Math.abs(Math.log(ratio.width / ratio.height / (size.width / size.height))) < 0.04)
		throw new CliError(`The picture is already about ${ratioText}; nothing to expand.`, "INVALID_PARAM");
	const f = expandFrame(ratio, size.width, size.height);
	const prompt = [
		`Extend this image to ${f.outputWidth}x${f.outputHeight} pixels (from ${f.sourceWidth}x${f.sourceHeight}).`,
		"Keep the original content unchanged and centered; generate only the new area around it, continuing the scene, lighting, perspective and texture so the result reads as one photograph.",
		"Do not add borders, letterboxing or duplicated subjects.",
	].join(" ");
	const aspect = `${f.outputWidth}:${f.outputHeight}`;
	const placed = await resultCard(api, convId, cards, source, "image", aspect, {
		title: `${source.title ?? "Picture"} · ${ratioText}`,
		isImage: true,
		mode: "image_generation",
		model: "flux-2",
		prompt,
		aspect_ratio: aspect,
		ratio: aspect,
		baseImageNodeId: source.id,
		baseImageUrl: url,
		expandMode: "free",
		expandOriginalWidth: size.width,
		expandOriginalHeight: size.height,
		expandOutputWidth: f.outputWidth,
		expandOutputHeight: f.outputHeight,
		expandReferenceWidth: f.sourceWidth,
		expandReferenceHeight: f.sourceHeight,
		expandReferenceOffsetX: f.offsetX,
		expandReferenceOffsetY: f.offsetY,
		targetFeature: "image_expand",
	});
	await submit(api, placed, "/image_edit/submit", {
			operation: "outpaint",
			convId,
			nodeId: placed.ids[0],
			imageUrl: url,
			prompt,
			width: f.outputWidth,
			height: f.outputHeight,
			reference_width: f.sourceWidth,
			reference_height: f.sourceHeight,
			reference_offset_x: f.offsetX,
			reference_offset_y: f.offsetY,
			target_feature: "image_expand",
		});
	return placed;
}

// ---------- clips ----------

export const VIDEO_UPSCALERS = { fast: "bytedance-video-upscale", best: "topaz-starlight-video-upscale", seedvr2: "seedvr2-video-upscale" } as const;

export async function upscaleVideo(api: Api, convId: string, cards: Card[], source: Card, to?: string, quality?: string) {
	const url = finishedMedia(source, "video");
	const target = !to || /^(2k|1440p?)$/i.test(to) ? "1440p" : /^(4k|2160p?)$/i.test(to) ? "2160p" : undefined;
	if (!target) throw new CliError("--to takes 2k (1440p) or 4k (2160p) for clips.", "INVALID_PARAM");
	const model = VIDEO_UPSCALERS[(quality ?? "fast") as keyof typeof VIDEO_UPSCALERS];
	if (!model) throw new CliError("--quality takes fast (ByteDance) or best (Topaz Starlight).", "INVALID_PARAM");
	const placed = await resultCard(api, convId, cards, source, "video", source.ratio ?? "16:9", {
		title: `${source.title ?? "Clip"} · ${target === "2160p" ? "4K" : "2K"}`,
		isImage: false,
		mode: "video_generation",
		model,
		baseVideoNodeId: source.id,
	});
	await submit(api, placed, "/video_edit/submit", { convId, nodeId: placed.ids[0], sourceNodeId: source.id, target_resolution: target, video_url: url, model });
	return placed;
}

// ---------- sound (the canvas's speech / music tools) ----------

export interface AudioAction {
	name: "gen_speech" | "gen_music";
	args: Record<string, unknown>;
}

/**
 * Runs the canvas's speech or music tool for a source card; the worker makes the sound card beside
 * it (linked to it). Resolves with the created cards' ids once the task is done.
 */
export async function makeSound(
	api: Api,
	convId: string,
	cards: Card[],
	source: Card,
	action: AudioAction,
	opts: { timeoutMs: number; onTick?: (status: string) => void },
): Promise<{ ids: string[]; taskId: string }> {
	const size = cardSize("audio");
	const rect = placeSingle({ width: 320, height: 104 }, { obstacles: obstaclesOf(cards), anchor: anchorRect(cards, source) });
	const position = { x: Math.round(rect.x + size.width / 2), y: Math.round(rect.y) };
	const id = crypto.randomUUID();
	let submitted = false;
	const deadline = Date.now() + opts.timeoutMs;
	for (;;) {
		let task: { status: string; response?: { status: number; body: any } };
		try {
			// Asking again with the same id never runs it twice: the server picks up the task it has.
			task = submitted
				? await worker(api, `/canvas-agent/tasks/${id}`)
				: await worker(api, "/canvas-agent/tasks", { json: { id, kind: "tool", input: { convId, sourceId: source.id, action, position } } });
		} catch (e) {
			if (e instanceof CliError && ["NOT_LOGGED_IN", "NO_CREDITS", "FORBIDDEN", "BAD_REQUEST"].includes(e.code)) throw e;
			if (Date.now() > deadline) throw e;
			await sleep(3000);
			continue;
		}
		submitted = true;
		opts.onTick?.(task.status);
		if (task.response) {
			const body = task.response.body ?? {};
			if (task.response.status >= 400 || body.error) {
				const code = typeof body.error === "string" ? body.error : typeof body.code === "string" ? body.code : "canvasToolFailed";
				throw new CliError(
					code === "insufficientCredits" ? "Not enough credits for this sound." : `The ${action.name === "gen_music" ? "music" : "speech"} tool failed: ${code}`,
					code === "insufficientCredits" ? "NO_CREDITS" : "GENERATION_FAILED",
					body,
				);
			}
			const nodes: Array<{ id: string }> = body.result?.nodes ?? [];
			if (!nodes.length) throw new CliError("The sound tool finished without a card.", "GENERATION_FAILED", body);
			return { ids: nodes.map((n) => n.id), taskId: id };
		}
		if (task.status === "failed" || task.status === "cancelled") throw new CliError(`The sound task ${task.status}.`, "GENERATION_FAILED");
		if (Date.now() > deadline) throw new CliError(`Still making the sound after ${Math.round(opts.timeoutMs / 1000)} s; it lands on the canvas when done.`, "TIMEOUT", { taskId: id });
		await sleep(3000);
	}
}
