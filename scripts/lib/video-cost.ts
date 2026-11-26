/**
 * What a clip will be charged, in credits: the worker's own price for this very request (POST /video/price, the
 * price /video/async holds, at the user's member rate), so it never drifts from what the canvas charges. Undefined
 * where only making it can tell (a source clip the worker measures, a draft's later render), or when the worker
 * can't be asked: the caller says "unknown" and asks the user, never guesses.
 */
import type { Model } from "./catalog.ts";
import { type Api, worker } from "./http.ts";

/** What /video/price reads of a /video/async body. */
const PRICED = ["prompt", "imageURL", "keyFrames", "image_urls", "video_urls", "audio_urls", "aspect_ratio", "duration", "audio", "resolution", "draft"];

export interface ClipSources {
	count: number;
	/** Their total seconds, when every one's length is known. */
	seconds?: number;
}

export async function videoPrice(api: Api, convId: string | undefined, body: Record<string, unknown>, sources?: ClipSources): Promise<number | undefined> {
	const input = Object.fromEntries(PRICED.filter((k) => body[k] !== undefined).map((k) => [k, k === "duration" ? Number(body[k]) : body[k]]));
	let credits: number;
	try {
		const answer = await worker<{ credits?: number }>(api, "/video/price", {
			json: { kind: "video", model: body.model, input, ...(convId && /^[0-9a-f-]{36}$/i.test(convId) ? { conversationId: convId } : {}) },
			read: true,
			timeoutMs: 20_000,
		});
		if (typeof answer?.credits !== "number") return undefined;
		credits = answer.credits;
	} catch {
		return undefined;
	}
	// Seedance holds the output's tokens; settling also counts a source clip's own seconds at that rate.
	if (sources?.count && /^seedance-2\./.test(String(body.model))) {
		const out = Number(body.duration);
		if (sources.seconds === undefined || !(out > 0)) return undefined;
		credits *= (out + sources.seconds) / out;
	}
	return Math.ceil(credits * 100) / 100;
}

/** A model's price for 5 s as the catalogue lists it, for `models` (the size it is quoted at, when it has one). */
export function listPrice(m: Model): { credits: number; at?: string } | undefined {
	if (m.estimatedPricePer5s) return { credits: Math.ceil(m.estimatedPricePer5s), at: "480p" };
	const res = m.supportedResolutions?.includes("720p") ? "720p" : m.supportedResolutions?.[0];
	const rate = (res && m.pricePerSecondByResolution?.[res]) || m.pricePerSecond;
	const perSecond = rate?.audioOn ?? rate?.audioOff;
	return perSecond ? { credits: Math.ceil((perSecond * 5) / 1000), at: res && m.pricePerSecondByResolution?.[res] ? res : undefined } : undefined;
}
