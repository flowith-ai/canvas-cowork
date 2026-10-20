/**
 * Model catalogue — the public `GET {workerURL}/models` the web app loads at
 * startup. Not account-specific (the browser's list_models action filters
 * the same global list), so no auth is needed.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { CliError, DEFAULT_WORKER_URL } from "./http";

export type Mode = "text" | "image" | "video";

export interface RemoteModel {
	media?: Mode;
	tier?: string;
	title?: string;
	desc?: string;
	sort?: number;
	comingSoon?: boolean;
	suitableChatModes?: string[];
	// image
	supportedAspectRatios?: string[];
	supportedImageSizes?: string[];
	supportedQualities?: string[];
	sizeMatrix?: {
		ratios?: string[];
		resolutions?: string[];
		sizes: Record<string, Record<string, string>>;
	};
	maxReferenceImages?: number;
	// video
	supportedResolutions?: string[];
	supportedDurations?: string[];
	supportsAudio?: boolean;
	supportedKeyframe?: boolean;
	supportsDraft?: boolean;
	supportsCharacterAssets?: boolean;
	supportedInputTypes?: string[];
	supportsImageInput?: boolean;
	referenceAssetLimits?: { total: number; image: number; audio: number; video: number };
	// pricing (credits)
	consume_num?: number;
	estimatedPrice?: number;
	estimatedPricePer5s?: number;
	pricePerSecond?: { audioOff?: number; audioOn?: number };
	price?: { prompt?: number; completion?: number };
	[k: string]: unknown;
}

export type ModelMap = Record<string, RemoteModel>;

// ChatMode enum values the frontend uses in `suitableChatModes`
const CHAT_MODE_FOR: Record<Mode, string> = { text: "0", image: "2", video: "9" };

const CACHE_FILE = join(homedir(), ".flowith", "models-cache.json");
const CACHE_TTL_MS = 5 * 60 * 1000;

export async function fetchModels(
	workerURL: string = DEFAULT_WORKER_URL,
	opts: { noCache?: boolean } = {},
): Promise<ModelMap> {
	if (!opts.noCache && existsSync(CACHE_FILE)) {
		try {
			const c = JSON.parse(readFileSync(CACHE_FILE, "utf-8"));
			if (c.workerURL === workerURL && Date.now() - c.fetchedAt < CACHE_TTL_MS && c.models)
				return c.models as ModelMap;
		} catch {}
	}
	const resp = await fetch(`${workerURL.replace(/\/$/, "")}/models?logo=1&desc=1`, {
		signal: AbortSignal.timeout(20_000),
	});
	if (!resp.ok) throw new CliError(`Failed to fetch models (HTTP ${resp.status})`, "HTTP_ERROR");
	const models = (await resp.json()) as ModelMap;
	try {
		mkdirSync(join(homedir(), ".flowith"), { recursive: true });
		writeFileSync(CACHE_FILE, JSON.stringify({ workerURL, fetchedAt: Date.now(), models }));
	} catch {}
	return models;
}

/** Models usable in a mode, sorted like the app's picker. */
export function modelsForMode(models: ModelMap, mode: Mode): Array<[string, RemoteModel]> {
	const chatMode = CHAT_MODE_FOR[mode];
	return Object.entries(models)
		.filter(([, m]) =>
			m.media ? m.media === mode : (m.suitableChatModes ?? []).includes(chatMode),
		)
		.sort(([, a], [, b]) => (a.sort ?? 0) - (b.sort ?? 0));
}

/** The compact, agent-facing view of a model (what `list-models` prints). */
export function summarizeModel(id: string, m: RemoteModel): Record<string, unknown> {
	const out: Record<string, unknown> = { id, title: m.title ?? id, tier: m.tier };
	if (m.comingSoon) out.comingSoon = true;
	for (const k of [
		"supportedAspectRatios",
		"supportedImageSizes",
		"supportedQualities",
		"supportedResolutions",
		"supportedDurations",
		"supportsAudio",
		"supportedKeyframe",
		"supportsDraft",
		"supportsCharacterAssets",
		"supportsImageInput",
		"supportedInputTypes",
		"maxReferenceImages",
		"referenceAssetLimits",
	] as const) {
		if (m[k] !== undefined) out[k] = m[k];
	}
	if (m.sizeMatrix?.sizes) {
		out.sizeMatrix = {
			ratios: m.sizeMatrix.ratios ?? Object.keys(m.sizeMatrix.sizes),
			resolutions: m.sizeMatrix.resolutions,
			// flat list of accepted --ratio values for size-matrix models
			sizes: Object.values(m.sizeMatrix.sizes).flatMap((row) => Object.values(row)),
		};
	}
	if (m.media === "video") {
		if (m.estimatedPricePer5s !== undefined) out.estimatedCreditsPer5s = m.estimatedPricePer5s;
		if (m.pricePerSecond) out.pricePerSecond = m.pricePerSecond;
	} else if (m.estimatedPrice !== undefined) {
		out.estimatedCredits = m.estimatedPrice;
	}
	return out;
}

export function requireModel(models: ModelMap, id: string, mode: Mode): RemoteModel {
	const m = models[id];
	if (!m) {
		const known = modelsForMode(models, mode).map(([k]) => k);
		throw new CliError(
			`Unknown ${mode} model "${id}". Available: ${known.join(", ")}`,
			"INVALID_MODEL",
			{ available: known },
		);
	}
	const okMode = m.media ? m.media === mode : (m.suitableChatModes ?? []).includes(CHAT_MODE_FOR[mode]);
	if (!okMode) {
		throw new CliError(`Model "${id}" is a ${m.media ?? "non-" + mode} model, not usable for ${mode}.`, "INVALID_MODEL");
	}
	return m;
}

function pick(
	label: string,
	value: string | undefined,
	allowed: string[] | undefined,
	fallbackToFirst: boolean,
): string | undefined {
	if (!allowed || allowed.length === 0) {
		if (value !== undefined)
			throw new CliError(`This model does not take --${label}; omit it.`, "INVALID_PARAM", { allowed: [] });
		return undefined;
	}
	if (value === undefined) return fallbackToFirst ? allowed[0] : undefined;
	const hit = allowed.find((a) => a.toLowerCase() === value.toLowerCase());
	if (!hit)
		throw new CliError(
			`Invalid --${label} "${value}". Allowed: ${allowed.join(", ")}`,
			"INVALID_PARAM",
			{ allowed },
		);
	return hit;
}

export const GPT_IMAGE_2_MODEL_ID = "gpt-image-2";

export function usesSizeMatrix(id: string, m: RemoteModel): boolean {
	return id === GPT_IMAGE_2_MODEL_ID || Boolean(m.sizeMatrix?.sizes && Object.keys(m.sizeMatrix.sizes).length);
}

/**
 * Port of the frontend's `resolveImageGenSubmitSizing`:
 *  - size-matrix models (gpt-image-2 family): `aspect_ratio` is the pixel
 *    string, chosen from (ratio, size tier); `image_size` is not sent.
 *  - everything else: `aspect_ratio` from supportedAspectRatios and
 *    `image_size` from supportedImageSizes (first entry when omitted,
 *    matching what the app does for a fresh composer).
 */
export function resolveImageSizing(
	id: string,
	m: RemoteModel,
	ratio?: string,
	size?: string,
	quality?: string,
): { aspect_ratio?: string; image_size?: string; quality?: string } {
	const out: { aspect_ratio?: string; image_size?: string; quality?: string } = {};
	if (usesSizeMatrix(id, m) && m.sizeMatrix?.sizes) {
		const sizes = m.sizeMatrix.sizes;
		const ratios = m.sizeMatrix.ratios?.length ? m.sizeMatrix.ratios : Object.keys(sizes);
		const tiers = m.sizeMatrix.resolutions?.length
			? m.sizeMatrix.resolutions
			: Object.keys(sizes[ratios[0]] ?? {});
		if (ratio === undefined || ratio.toLowerCase() === "auto") {
			// "auto" → let the backend decide (frontend omits aspect_ratio)
		} else {
			const r = ratio.toLowerCase();
			// Accept either a ratio ("16:9") or a pixel string ("2048x1152") verbatim.
			const pixel = Object.values(sizes)
				.flatMap((row) => Object.values(row))
				.find((px) => px.toLowerCase() === r);
			if (pixel) {
				out.aspect_ratio = pixel;
			} else {
				const row = sizes[ratios.find((x) => x.toLowerCase() === r) ?? ""];
				if (!row)
					throw new CliError(
						`Invalid --ratio "${ratio}" for ${id}. Use a ratio (${ratios.join(", ")}) or a pixel size (${Object.values(sizes).flatMap((x) => Object.values(x)).join(", ")}).`,
						"INVALID_PARAM",
					);
				const tier = pick("size", size, tiers, true)!;
				out.aspect_ratio = row[tier] ?? row[Object.keys(row)[0]];
			}
		}
		if (size !== undefined && out.aspect_ratio === undefined) {
			throw new CliError(`--size needs a --ratio on ${id} (sizes: ${tiers.join(", ")}).`, "INVALID_PARAM");
		}
	} else {
		out.aspect_ratio = pick("ratio", ratio, m.supportedAspectRatios, false);
		out.image_size = pick("size", size, m.supportedImageSizes, false);
	}
	if (m.supportedQualities?.length || quality !== undefined) {
		out.quality = pick("quality", quality, m.supportedQualities, false);
	}
	return out;
}

export function resolveVideoParams(
	id: string,
	m: RemoteModel,
	p: { ratio?: string; duration?: string | number; resolution?: string; draft?: boolean },
): { aspect_ratio?: string; duration?: string; resolution?: string } {
	const out: { aspect_ratio?: string; duration?: string; resolution?: string } = {};
	out.aspect_ratio = pick("ratio", p.ratio, m.supportedAspectRatios, false);
	const dur = p.duration === undefined ? undefined : String(p.duration);
	out.duration = pick("duration", dur, m.supportedDurations, false);
	if (p.draft) {
		if (!m.supportsDraft) throw new CliError(`${id} does not support --draft.`, "INVALID_PARAM");
		out.resolution = "480p"; // the app forces 480p for drafts
	} else {
		out.resolution = pick("resolution", p.resolution, m.supportedResolutions, false);
	}
	return out;
}

// ---------- aliases & defaults ----------

export type Alias = "best" | "fast";

/**
 * Curated picks so an agent can say `--model best` without reading the
 * catalogue. Override per machine in ~/.flowith/defaults.json:
 *   {"video":{"best":"seedance-2.5","fast":"seedance-2.0-fast"}, ...}
 */
export const MODEL_ALIASES: Record<Mode, Record<Alias, string>> = {
	text: { best: "claude-opus-5-5", fast: "gemini-3.8-flash" },
	image: { best: "gpt-image-2.5-flare", fast: "gemini-3.1-flash-image" },
	video: { best: "seedance-2.5", fast: "seedance-2.0-fast" },
};

/** What `gen` uses when --model is omitted. Video defaults to the cheaper tier. */
export const DEFAULT_ALIAS: Record<Mode, Alias> = { text: "best", image: "best", video: "fast" };

const DEFAULTS_FILE = join(homedir(), ".flowith", "defaults.json");

export function loadAliasTable(): Record<Mode, Record<Alias, string>> {
	const table: Record<Mode, Record<Alias, string>> = {
		text: { ...MODEL_ALIASES.text },
		image: { ...MODEL_ALIASES.image },
		video: { ...MODEL_ALIASES.video },
	};
	if (existsSync(DEFAULTS_FILE)) {
		try {
			const o = JSON.parse(readFileSync(DEFAULTS_FILE, "utf-8"));
			for (const mode of ["text", "image", "video"] as Mode[])
				for (const alias of ["best", "fast"] as Alias[])
					if (typeof o?.[mode]?.[alias] === "string") table[mode][alias] = o[mode][alias];
		} catch {}
	}
	return table;
}

/**
 * Turn `best` / `fast` / a model id / nothing into a concrete model id.
 * Alias targets that vanished from the catalogue fall back to the first
 * model for the mode (and say so via `note`).
 */
export function resolveModel(
	models: ModelMap,
	mode: Mode,
	requested: string | undefined,
	table: Record<Mode, Record<Alias, string>> = loadAliasTable(),
): { id: string; alias?: Alias; note?: string } {
	const alias = (requested ?? DEFAULT_ALIAS[mode]) as Alias;
	if (requested !== undefined && !(requested in table[mode])) return { id: requested };
	const target = table[mode][alias];
	if (models[target]) return { id: target, alias };
	const first = modelsForMode(models, mode)[0]?.[0];
	if (!first) throw new CliError(`No ${mode} models available.`, "INVALID_MODEL");
	return { id: first, alias, note: `alias "${alias}" → "${target}" is not in the catalogue; using "${first}"` };
}

/** One line per model for the default `models` listing. */
export function compactModelLine(id: string, m: RemoteModel): string {
	const flags: string[] = [];
	if (m.supportsAudio) flags.push("audio");
	if (m.supportedKeyframe) flags.push("keyframe");
	if (m.referenceAssetLimits) {
		const l = m.referenceAssetLimits;
		flags.push(`refs:${l.image}i/${l.video}v/${l.audio}a`);
	} else if (m.maxReferenceImages) flags.push(`refs:${m.maxReferenceImages}i`);
	if (m.supportsDraft) flags.push("draft");
	if (m.supportsImageInput && m.media === "text") flags.push("vision");
	if (m.comingSoon) flags.push("coming-soon");
	const cols: string[] = [id];
	if (m.media === "video") {
		cols.push(`ratios=${(m.supportedAspectRatios ?? []).join(",") || "-"}`);
		const d = m.supportedDurations ?? [];
		cols.push(`dur=${d.length ? `${d[0]}..${d[d.length - 1]}s` : "-"}`);
		cols.push(`res=${(m.supportedResolutions ?? []).join(",") || "-"}`);
		cols.push(flags.join(" ") || "-");
		if (m.estimatedPricePer5s !== undefined) cols.push(`~${Math.round(m.estimatedPricePer5s)}cr/5s`);
	} else if (m.media === "image") {
		if (m.sizeMatrix?.sizes) {
			cols.push(`ratios=${(m.sizeMatrix.ratios ?? Object.keys(m.sizeMatrix.sizes)).join(",")}`);
			cols.push(`sizes=${(m.sizeMatrix.resolutions ?? []).join(",") || "px"}`);
		} else {
			cols.push(`ratios=${(m.supportedAspectRatios ?? []).join(",") || "-"}`);
			cols.push(`sizes=${(m.supportedImageSizes ?? []).join(",") || "-"}`);
		}
		cols.push(flags.join(" ") || "-");
		if (m.estimatedPrice !== undefined) cols.push(`~${m.estimatedPrice}cr`);
	} else {
		cols.push(m.title ?? "");
		cols.push(flags.join(" ") || "-");
		if (m.consume_num !== undefined) cols.push(`~${m.consume_num}cr`);
	}
	return cols.join("  ");
}

/** Seedance 2.x accepts image/video/audio references in the prompt (`image1`, `audio1`, ...). */
export function isSeedanceMultiMedia(id: string): boolean {
	return id.includes("seedance-2.0") || id.includes("seedance-2.5");
}

export function seedanceLimits(m: RemoteModel): { total: number; image: number; audio: number; video: number } {
	const l = m.referenceAssetLimits;
	if (l && [l.total, l.image, l.audio, l.video].every((n) => Number.isInteger(n) && n > 0)) return l;
	return { total: 15, image: 9, audio: 3, video: 3 };
}
