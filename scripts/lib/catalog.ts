/**
 * The canvas's model catalogue: the worker's public `GET /models`, the one list the canvas's own
 * model picker shows (and the Creator Agent reads). Limits, defaults and prices all come from here.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { type Api, CliError, worker } from "./http.ts";
import { home } from "./session.ts";

export type Kind = "text" | "image" | "video" | "audio";

import { listPrice } from "./video-cost.ts";

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
	/**
	 * A picture's list price at each size it offers, as its route charges it (flo-workers resolveImageBillingBasePrice),
	 * `default` for a request that names none.
	 */
	estimatedPriceBySize?: Record<string, number>;
	/** What 1, 2, … reference pictures add to one picture, in credits (each entry the whole addition). */
	estimatedReferencePrices?: number[];
	/** Token-billed pictures: the price of one 1024×1024 picture at each quality. */
	estimatedBreakdown?: Array<{ quality: string; price: number }>;
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
	// Text cards default to a fast, current model every plan's credits cover; name a flagship when it matters.
	if (kind === "text" && catalog["gemini-3.8-flash"] && !catalog["gemini-3.8-flash"]!.comingSoon) return "gemini-3.8-flash";
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
				const tier = pick("size", size, tiers) ?? tiers.find((t) => /^1k$/i.test(t)) ?? tiers[0]!;
				out.aspect_ratio = sizes[key]![tier] ?? Object.values(sizes[key]!)[0];
			}
		} else if (size) {
			throw new CliError(`--size needs a --ratio on ${id} (sizes: ${tiers.join(", ")}).`, "INVALID_PARAM");
		}
	} else {
		out.aspect_ratio = pick("ratio", ratio, m.supportedAspectRatios);
		out.image_size = pick("size", size, m.supportedImageSizes);
	}
	// The canvas sends a quality whenever the model has them, its first one unless chosen: left out, GPT Image
	// runs (and bills) at "max".
	if (quality !== undefined) out.quality = pick("quality", quality, m.supportedQualities);
	else if (m.supportedQualities?.length) out.quality = m.supportedQualities[0];
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

/**
 * A picture's list price as its route charges this request, where the catalogue publishes it per size and reference
 * picture (Seedream 5.5's launch price included): the size named when the model makes it, else its default, plus what
 * the pictures add. Undefined for a model without that table (token-billed GPT Image, priced per quality).
 */
function pictureAtRequest(m: Model, size: string | undefined, refs = 0): number | undefined {
	const table = m.estimatedPriceBySize;
	if (!table) return undefined;
	const named = size ? Object.keys(table).find((k) => k !== "default" && k.toLowerCase() === size.toLowerCase()) : undefined;
	const base = table[named ?? "default"];
	if (typeof base !== "number" || !Number.isFinite(base)) return undefined;
	const added = m.estimatedReferencePrices;
	return base + (refs > 0 && added?.length ? (added[Math.min(refs, added.length) - 1] ?? 0) : 0);
}

/** Credits a run is expected to cost at list price, from the catalogue (1 credit = $0.001); memberRates gives the user's rate. */
export function estimateCredits(
	m: Model,
	p: { duration?: string; resolution?: string; audio?: boolean; chars?: number; quality?: string; pixels?: string; size?: string; refs?: number } = {},
): number | undefined {
	if (m.media === "image") {
		const exact = pictureAtRequest(m, p.size, p.refs);
		if (exact !== undefined) return exact;
		// Token-billed pictures (GPT Image): the quality's 1024² price, scaled by the picture's area.
		const byQuality = p.quality ? m.estimatedBreakdown?.find((b) => b.quality === p.quality)?.price : undefined;
		if (byQuality !== undefined) {
			const [w, h] = (p.pixels ?? "1024x1024").split("x").map(Number);
			return Math.round(byQuality * (w && h ? (w * h) / (1024 * 1024) : 1));
		}
		return m.estimatedPrice ?? (m.price?.completion ? m.price.completion / 1000 : undefined);
	}
	// Clips: estimateVideoCredits (lib/video-cost.ts), which needs the request's own settings.
	if (m.media === "tool" && m.audioPricing) {
		if (m.audioPricing.per === "1k_chars" && p.chars) return Math.ceil((m.audioPricing.credits * p.chars) / 1000);
		return m.audioPricing.credits;
	}
	return undefined;
}

/** A model's share of its list price, keyed by model id as /models lists it; a model absent pays the list price. */
export type MemberRates = Record<string, number>;

/**
 * What the user pays on each discounted model on this canvas, as the worker charges it: their own rates on their
 * canvas (GET /user/paid-member `modelRates`: member prices and their plan's model discounts, Nano Banana 2, GPT 6 …),
 * on a team's canvas the team's (GET /team `model_rates`, while its Studio plan is open; otherwise the list price).
 * Undefined when the worker can't say: the caller then quotes the list price and says so.
 */
export async function memberRates(api: Api, teamId?: string): Promise<MemberRates | undefined> {
	try {
		const rates = teamId
			? (await worker<{ teams?: Array<{ id?: string; model_rates?: unknown }> }>(api, "/team")).teams?.find((t) => t.id === teamId)?.model_rates ?? {}
			: (await worker<{ modelRates?: unknown }>(api, "/user/paid-member")).modelRates;
		if (!rates || typeof rates !== "object") return undefined;
		return Object.fromEntries(Object.entries(rates).filter((e): e is [string, number] => typeof e[1] === "number" && e[1] > 0 && e[1] < 1));
	} catch {
		return undefined;
	}
}

/** A list price at `rate`, rounded to the thousandth of a credit the charge is kept in (flo-workers applyPlanMemberPriceRate). */
export function atRate(credits: number, rate = 1): number {
	return rate === 1 ? credits : Math.max(0.001, Math.round(credits * 1000 * rate) / 1000);
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
		// The listed price (the size it is quoted at); `video … --dry-run` asks the worker for a request's own.
		const p = listPrice(m);
		if (p) flags.push(`~${p.credits} cr/5s${p.at ? ` ${p.at}` : ""}`);
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
