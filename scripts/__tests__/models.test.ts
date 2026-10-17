import { describe, expect, test } from "bun:test";
import {
	type ModelMap,
	modelsForMode,
	requireModel,
	resolveImageSizing,
	resolveVideoParams,
	seedanceLimits,
	summarizeModel,
	usesSizeMatrix,
} from "../lib/models";
import { CliError } from "../lib/http";

// Shapes copied from the live /models catalogue.
const MODELS: ModelMap = {
	"seedance-2.5": {
		media: "video",
		tier: "t1",
		title: "Seedance 2.5",
		sort: 79,
		supportedAspectRatios: ["adaptive", "16:9", "9:16", "1:1"],
		supportedDurations: ["-1", "4", "5", "10"],
		supportedResolutions: ["480p", "720p", "1080p"],
		supportsAudio: true,
		supportedKeyframe: true,
		supportsDraft: true,
		referenceAssetLimits: { total: 50, image: 30, audio: 10, video: 10 },
		estimatedPricePer5s: 616.8,
	},
	"veo-3.1-generate": {
		media: "video",
		tier: "t1",
		title: "Veo 3.1",
		sort: 10,
		supportedAspectRatios: ["16:9", "9:16"],
		supportedDurations: ["4", "6", "8"],
		supportsAudio: true,
	},
	"gpt-image-2": {
		media: "image",
		tier: "t1",
		title: "GPT Image 2",
		sizeMatrix: {
			ratios: ["1:1", "16:9"],
			resolutions: ["1K", "2K"],
			sizes: { "1:1": { "1K": "1024x1024", "2K": "2048x2048" }, "16:9": { "1K": "1536x864", "2K": "2048x1152" } },
		},
	},
	"gemini-3-pro-image": {
		media: "image",
		tier: "t1",
		title: "Gemini 3 Pro Image",
		supportedAspectRatios: ["1:1", "16:9", "auto"],
		supportedImageSizes: ["1k", "2k", "4k"],
		maxReferenceImages: 14,
	},
	"gpt-4.1": { media: "text", tier: "t1", title: "GPT-4.1" },
};

describe("modelsForMode", () => {
	test("filters by media and sorts by sort", () => {
		expect(modelsForMode(MODELS, "video").map(([id]) => id)).toEqual(["veo-3.1-generate", "seedance-2.5"]);
		expect(modelsForMode(MODELS, "image").map(([id]) => id).sort()).toEqual(["gemini-3-pro-image", "gpt-image-2"]);
	});
	test("falls back to suitableChatModes when media is missing", () => {
		const m: ModelMap = { x: { suitableChatModes: ["9"] } };
		expect(modelsForMode(m, "video").map(([id]) => id)).toEqual(["x"]);
		expect(modelsForMode(m, "image")).toEqual([]);
	});
});

describe("requireModel", () => {
	test("rejects unknown and wrong-mode models with the available list", () => {
		expect(() => requireModel(MODELS, "nope", "video")).toThrow(CliError);
		try {
			requireModel(MODELS, "nope", "video");
		} catch (e: any) {
			expect(e.code).toBe("INVALID_MODEL");
			expect(e.data.available).toContain("seedance-2.5");
		}
		expect(() => requireModel(MODELS, "gpt-image-2", "video")).toThrow(/image model/);
	});
});

describe("resolveImageSizing", () => {
	test("plain models pass ratio + size through after validation", () => {
		const m = MODELS["gemini-3-pro-image"];
		expect(resolveImageSizing("gemini-3-pro-image", m, "16:9", "2k")).toEqual({ aspect_ratio: "16:9", image_size: "2k" });
		expect(resolveImageSizing("gemini-3-pro-image", m)).toEqual({});
		expect(() => resolveImageSizing("gemini-3-pro-image", m, "4:3")).toThrow(/Allowed: 1:1, 16:9, auto/);
		expect(() => resolveImageSizing("gemini-3-pro-image", m, "1:1", "8k")).toThrow(/--size/);
	});
	test("size-matrix models collapse ratio+size into a pixel string", () => {
		const m = MODELS["gpt-image-2"];
		expect(usesSizeMatrix("gpt-image-2", m)).toBe(true);
		expect(resolveImageSizing("gpt-image-2", m, "16:9", "2K")).toEqual({ aspect_ratio: "2048x1152" });
		expect(resolveImageSizing("gpt-image-2", m, "16:9")).toEqual({ aspect_ratio: "1536x864" });
		expect(resolveImageSizing("gpt-image-2", m, "2048x2048")).toEqual({ aspect_ratio: "2048x2048" });
		expect(resolveImageSizing("gpt-image-2", m, "auto")).toEqual({});
		expect(() => resolveImageSizing("gpt-image-2", m, "4:3")).toThrow(/Invalid --ratio/);
	});
});

describe("resolveVideoParams", () => {
	const m = MODELS["seedance-2.5"];
	test("validates against the model's lists", () => {
		expect(resolveVideoParams("seedance-2.5", m, { ratio: "16:9", duration: 5, resolution: "720p" })).toEqual({
			aspect_ratio: "16:9",
			duration: "5",
			resolution: "720p",
		});
		expect(() => resolveVideoParams("seedance-2.5", m, { duration: 7 })).toThrow(/Allowed: -1, 4, 5, 10/);
		expect(() => resolveVideoParams("seedance-2.5", m, { resolution: "4k" })).toThrow(/--resolution/);
	});
	test("draft forces 480p and needs supportsDraft", () => {
		expect(resolveVideoParams("seedance-2.5", m, { draft: true, resolution: "1080p" }).resolution).toBe("480p");
		expect(() => resolveVideoParams("veo-3.1-generate", MODELS["veo-3.1-generate"], { draft: true })).toThrow(/--draft/);
	});
	test("models without a resolution list reject --resolution", () => {
		expect(() => resolveVideoParams("veo-3.1-generate", MODELS["veo-3.1-generate"], { resolution: "720p" })).toThrow(/omit it/);
	});
});

describe("summarizeModel / seedanceLimits", () => {
	test("summary exposes the fields agents need", () => {
		const s = summarizeModel("seedance-2.5", MODELS["seedance-2.5"]);
		expect(s.supportedResolutions).toEqual(["480p", "720p", "1080p"]);
		expect(s.referenceAssetLimits).toEqual({ total: 50, image: 30, audio: 10, video: 10 });
		expect(s.estimatedCreditsPer5s).toBe(616.8);
		const g = summarizeModel("gpt-image-2", MODELS["gpt-image-2"]) as any;
		expect(g.sizeMatrix.sizes).toContain("2048x1152");
	});
	test("limits fall back to the legacy defaults", () => {
		expect(seedanceLimits(MODELS["seedance-2.5"]).total).toBe(50);
		expect(seedanceLimits({})).toEqual({ total: 15, image: 9, audio: 3, video: 3 });
	});
});
