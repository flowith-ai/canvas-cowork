/**
 * The canvas's model catalogue: the worker's public `GET /models`, the one list the canvas's own
 * model picker shows (and the Creator Agent reads). Limits, defaults and prices all come from here.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { CliError } from "./http";
import { home } from "./session";

export type Kind = "text" | "image" | "video" | "audio";

export interface Model {
	media?: string;
	tier?: string;
	title?: string;
	sort?: number;
	comingSoon?: boolean;
	newest?: boolean;
	suitableChatModes?: string[];
	supportedAspectRatios?: string[];
	supportedImageSizes?: string[];
	supportedQualities?: string[];
	supportedImageBackgrounds?: string[];
	supportedOutputFormats?: string[];
	sizeMatrix?: { ratios?: string[]; resolutions?: string[]; sizes: Record<string, Record<string, string>> };
	maxReferenceImages?: number;
	supportedResolutions?: string[];
	supportedDurations?: string[];
	supportsAudio?: boolean;
	supportedKeyframe?: boolean;
	supportsDraft?: boolean;
	supportsImageInput?: boolean;
	supportedInputTypes?: string[];
	referenceAssetLimits?: { total: number; image: number; audio: number; video: number };
	consume_num?: number;
	estimatedPrice?: number;
	estimatedPricePer5s?: number;
	pricePerSecond?: { audioOff?: number; audioOn?: number };
	pricePerSecondByResolution?: Record<string, { audioOff?: number; audioOn?: number }>;
	price?: { prompt?: number; completion?: number };
	audioPricing?: { credits: number; per: string };
	discount?: number;
	[k: string]: unknown;
}

export type Catalog = Record<string, Model>;

const TTL_MS = 10 * 60_000;

export async function fetchCatalog(workerURL: string, opts: { fresh?: boolean } = {}): Promise<Catalog> {
	const file = join(home(), "models-cache.json");
	if (!opts.fresh && existsSync(file)) {
		try {
			const c = JSON.parse(readFileSync(file, "utf8"));
			if (c.workerURL === workerURL && Date.now() - c.at < TTL_MS && c.models) return c.models;
		} catch {}
	}
	const resp = await fetch(`${workerURL.replace(/\/$/, "")}/models?logo=0&desc=1`, { signal: AbortSignal.timeout(20_000) });
	if (!resp.ok) throw new CliError(`Could not load the model list (HTTP ${resp.status}).`, "SERVER_ERROR");
	const models = (await resp.json()) as Catalog;
	try {
		mkdirSync(home(), { recursive: true });
		writeFileSync(file, JSON.stringify({ workerURL, at: Date.now(), models }));
	} catch {}
	return models;
}

const kindOfModel = (m: Model): Kind | undefined => {
	if (m.media === "tool") return "audio";
	if (m.media === "text" || m.media === "image" || m.media === "video") return m.media;
	return undefined;
};

/** A kind's models in the canvas picker's order. */
export function modelsOf(catalog: Catalog, kind: Kind): Array<[string, Model]> {
	return Object.entries(catalog)
		.filter(([, m]) => kindOfModel(m) === kind && !m.comingSoon)
		.sort(([, a], [, b]) => (a.sort ?? 999) - (b.sort ?? 999));
}

/** What a new card starts on when no model is named: the canvas's own default. */
export function defaultModel(catalog: Catalog, kind: Kind): string {
	// The canvas starts video on Seedance 2.5 Flash once it is offered (frontend utils/seedance-2-5.ts).
	if (kind === "video") {
		for (const id of ["seedance-2.5-flash", "seedance-2.5"]) if (catalog[id] && !catalog[id]!.comingSoon) return id;
	}
	const first = modelsOf(catalog, kind)[0]?.[0];
	if (!first) throw new CliError(`No ${kind} models are offered right now.`, "INVALID_MODEL");
	return first;
}

const norm = (s: string) => s.toLowerCase().replace(/[\s._/-]+/g, "");

/** A model by id or by the name the canvas shows ("Seedream 5.5", "nano banana 2"). */
export function resolveModel(catalog: Catalog, kind: Kind, wanted: string | undefined): { id: string; model: Model } {
	const id = wanted ?? defaultModel(catalog, kind);
	const list = modelsOf(catalog, kind);
	const hit =
		list.find(([k]) => k === id) ??
		list.find(([k, m]) => norm(k) === norm(id) || (m.title && norm(m.title) === norm(id))) ??
		(() => {
			const partial = list.filter(([k, m]) => norm(k).includes(norm(id)) || (m.title && norm(m.title).includes(norm(id))));
			return partial.length === 1 ? partial[0] : undefined;
		})();
	if (!hit) {
		throw new CliError(
			`"${id}" is not a ${kind} model on the canvas. Choose one of: ${list.map(([k]) => k).join(", ")}`,
			"INVALID_MODEL",
			{ available: list.map(([k]) => k) },
		);
	}
	return { id: hit[0], model: hit[1] };
}

function pick(flag: string, value: string | undefined, allowed: string[] | undefined): string | undefined {
	if (value === undefined) return undefined;
	if (!allowed?.length) throw new CliError(`This model takes no --${flag}; leave it out.`, "INVALID_PARAM");
	const hit = allowed.find((a) => a.toLowerCase() === value.toLowerCase());
	if (!hit) throw new CliError(`--${flag} "${value}" is not offered. Choose one of: ${allowed.join(", ")}`, "INVALID_PARAM", { allowed });
	return hit;
}

const usesSizeMatrix = (m: Model) => Boolean(m.sizeMatrix?.sizes && Object.keys(m.sizeMatrix.sizes).length);

/**
 * Image sizing as the canvas sends it (frontend resolveImageGenSubmitSizing): size-matrix models
 * (GPT Image) take a pixel size chosen from ratio × tier; the rest take a ratio and a size.
 */
export function imageSizing(
	id: string,
	m: Model,
	ratio?: string,
	size?: string,
	quality?: string,
): { aspect_ratio?: string; image_size?: string; quality?: string; ratio: string } {
	const out: { aspect_ratio?: string; image_size?: string; quality?: string; ratio: string } = { ratio: ratio ?? "1:1" };
	if (usesSizeMatrix(m)) {
		const sizes = m.sizeMatrix!.sizes;
		const ratios = m.sizeMatrix!.ratios?.length ? m.sizeMatrix!.ratios! : Object.keys(sizes);
		const tiers = m.sizeMatrix!.resolutions?.length ? m.sizeMatrix!.resolutions! : Object.keys(sizes[ratios[0]!] ?? {});
		if (ratio && ratio.toLowerCase() !== "auto") {
			const pixel = Object.values(sizes).flatMap((row) => Object.values(row)).find((px) => px.toLowerCase() === ratio.toLowerCase());
			if (pixel) {
				out.aspect_ratio = pixel;
				const [w, h] = pixel.split("x").map(Number);
				if (w && h) out.ratio = `${w}:${h}`;
			} else {
				const key = ratios.find((x) => x.toLowerCase() === ratio.toLowerCase());
				if (!key) throw new CliError(`--ratio "${ratio}" is not offered by ${id}. Choose one of: ${ratios.join(", ")}`, "INVALID_PARAM");
				const tier = pick("size", size, tiers) ?? tiers.find((t) => /2k/i.test(t)) ?? tiers[0]!;
				out.aspect_ratio = sizes[key]![tier] ?? Object.values(sizes[key]!)[0];
			}
		} else if (size) {
			throw new CliError(`--size needs a --ratio on ${id} (sizes: ${tiers.join(", ")}).`, "INVALID_PARAM");
		}
	} else {
		out.aspect_ratio = pick("ratio", ratio, m.supportedAspectRatios);
		out.image_size = pick("size", size, m.supportedImageSizes);
	}
	if (quality !== undefined) out.quality = pick("quality", quality, m.supportedQualities);
	return out;
}

export function videoParams(
	id: string,
	m: Model,
	p: { ratio?: string; duration?: string; resolution?: string; draft?: boolean },
): { aspect_ratio?: string; duration?: string; resolution?: string } {
	const has = (list: string[] | undefined, v: string) => list?.some((x) => x.toLowerCase() === v) ?? false;
	const ratio = p.ratio ?? (has(m.supportedAspectRatios, "16:9") ? "16:9" : undefined);
	// 5 s when offered, else the shortest the model makes (auto, -1, only when asked).
	const offered = (m.supportedDurations ?? []).filter((d) => d !== "-1").sort((x, y) => Number(x) - Number(y));
	const duration = p.duration ?? (has(m.supportedDurations, "5") ? "5" : offered[0]);
	let resolution = p.resolution;
	if (p.draft) {
		if (!m.supportsDraft) throw new CliError(`${id} has no draft mode.`, "INVALID_PARAM");
		resolution = "480p";
	} else if (!resolution && has(m.supportedResolutions, "720p")) resolution = "720p";
	return {
		aspect_ratio: pick("ratio", ratio, m.supportedAspectRatios),
		duration: pick("duration", duration, m.supportedDurations),
		resolution: pick("resolution", resolution, m.supportedResolutions),
	};
}

/** Credits a run is expected to cost, from the catalogue (1 credit = $0.001). */
export function estimateCredits(m: Model, p: { duration?: string; resolution?: string; audio?: boolean; chars?: number } = {}): number | undefined {
	if (m.media === "image") return m.estimatedPrice ?? (m.price?.completion ? m.price.completion / 1000 : undefined);
	if (m.media === "video") {
		const seconds = Number(p.duration);
		const perSec = (p.resolution && m.pricePerSecondByResolution?.[p.resolution]) || m.pricePerSecond;
		const rate = perSec ? (p.audio === false ? perSec.audioOff : perSec.audioOn) ?? perSec.audioOn : undefined;
		if (rate && seconds > 0) return Math.round((rate / 1000) * seconds);
		return m.estimatedPricePer5s ? Math.round(m.estimatedPricePer5s) : undefined;
	}
	if (m.media === "tool" && m.audioPricing) {
		if (m.audioPricing.per === "1k_chars" && p.chars) return Math.ceil((m.audioPricing.credits * p.chars) / 1000);
		return m.audioPricing.credits;
	}
	return undefined;
}

/** One line per model for `models`. */
export function modelLine(id: string, m: Model): string {
	const cols: string[] = [id.padEnd(30), (m.title ?? "").padEnd(24)];
	const flags: string[] = [];
	if (m.media === "image") {
		const ratios = usesSizeMatrix(m) ? m.sizeMatrix!.ratios ?? Object.keys(m.sizeMatrix!.sizes) : m.supportedAspectRatios ?? [];
		const sizes = usesSizeMatrix(m) ? m.sizeMatrix!.resolutions ?? [] : m.supportedImageSizes ?? [];
		cols.push(`ratios ${ratios.join(",") || "-"}`, `sizes ${sizes.join(",") || "-"}`);
		if (m.maxReferenceImages) flags.push(`≤${m.maxReferenceImages} refs`);
		if (m.supportedImageBackgrounds?.includes("transparent")) flags.push("transparent");
		if (m.supportedQualities?.length) flags.push(`quality ${m.supportedQualities.join("/")}`);
		const c = estimateCredits(m);
		if (c !== undefined) flags.push(`~${Math.round(c)} cr`);
	} else if (m.media === "video") {
		const d = m.supportedDurations?.filter((x) => x !== "-1") ?? [];
		cols.push(`ratios ${(m.supportedAspectRatios ?? []).join(",") || "-"}`, `${d.length ? `${d[0]}–${d[d.length - 1]}s` : "-"}`, `${(m.supportedResolutions ?? []).join(",") || "-"}`);
		if (m.supportsAudio) flags.push("sound");
		if (m.supportedKeyframe) flags.push("first+last frame");
		const l = m.referenceAssetLimits;
		if (l) flags.push(`refs ${l.image} img/${l.video} video/${l.audio} audio`);
		if (m.supportsDraft) flags.push("draft");
		const c = estimateCredits(m, { duration: "5", resolution: "720p" });
		if (c !== undefined) flags.push(`~${c} cr/5s`);
	} else if (m.media === "tool") {
		if (m.audioPricing) flags.push(`${m.audioPricing.credits} cr/${m.audioPricing.per === "1k_chars" ? "1k chars" : "song"}`);
	} else {
		if (m.supportsImageInput) flags.push("reads images");
		if (m.price?.prompt !== undefined) flags.push(`$${m.price.prompt}/$${m.price.completion} per M tokens`);
	}
	if (m.tier === "t1") flags.push("advanced");
	if (m.newest) flags.push("new");
	return [...cols, flags.join(" · ")].join("  ");
}

/** Audio models (catalogue "tool" media) → the worker tool and its model id. */
export const AUDIO_MODELS: Record<string, { tool: "gen_speech" | "gen_music"; id: string }> = {
	"elevenlabs-v3": { tool: "gen_speech", id: "elevenlabs/v3/text-to-speech" },
	"minimax-speech-2.8-hd": { tool: "gen_speech", id: "minimax/speech-2.8-hd" },
	"qwen-audio-3.1-tts-plus": { tool: "gen_speech", id: "alibaba/qwen-audio-3.1-tts-plus/text-to-speech" },
	"gemini-3.1-flash-tts": { tool: "gen_speech", id: "google/gemini-3.1-flash-tts" },
	"suno-chirp-v6": { tool: "gen_music", id: "suno/chirp-v6" },
	"minimax-music-3.0": { tool: "gen_music", id: "minimax/music-3.0" },
};
