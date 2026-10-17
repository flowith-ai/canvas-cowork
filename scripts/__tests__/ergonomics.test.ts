import { describe, expect, test } from "bun:test";
import { NODE_TYPE } from "../lib/canvas";
import { outputPathFor } from "../lib/download";
import {
	type GenResult,
	applyVideoDefaults,
	buildHistoryMessages,
	buildTextRequest,
	compactResult,
} from "../lib/generate";
import { DEFAULT_ALIAS, MODEL_ALIASES, type ModelMap, resolveModel } from "../lib/models";

const CONV = "11111111-1111-4111-8111-111111111111";

describe("buildHistoryMessages", () => {
	const nodes = [
		{ id: "q1", p_id: CONV, type: NODE_TYPE.question, data: { value: "What is X?" } },
		{ id: "a1", p_id: "q1", type: NODE_TYPE.response, data: { value: "X is a thing.", isImage: false } },
		{ id: "q2", p_id: "a1", type: NODE_TYPE.question, data: { value: "Draw it" } },
		{ id: "a2", p_id: "q2", type: NODE_TYPE.response, data: { value: "https://r2/x.png", isImage: true } },
		{ id: "q3", p_id: "a2", type: NODE_TYPE.question, data: { value: "Animate it" } },
		{ id: "v3", p_id: "q3", type: NODE_TYPE.video, data: { value: "https://vg/x.mp4" } },
	];
	test("walks the chain to the root, oldest first, mapping roles", () => {
		expect(buildHistoryMessages(nodes, "v3")).toEqual([
			{ role: "user", content: "What is X?" },
			{ role: "assistant", content: "X is a thing." },
			{ role: "user", content: "Draw it" },
			{ role: "assistant", content: "[image: https://r2/x.png]" },
			{ role: "user", content: "Animate it" },
			{ role: "assistant", content: "[video: https://vg/x.mp4]" },
		]);
	});
	test("no follow → no history; cap respected; cycles don't loop", () => {
		expect(buildHistoryMessages(nodes, undefined)).toEqual([]);
		expect(buildHistoryMessages(nodes, "v3", 2)).toHaveLength(2);
		const loop = [
			{ id: "a", p_id: "b", type: NODE_TYPE.question, data: { value: "a" } },
			{ id: "b", p_id: "a", type: NODE_TYPE.response, data: { value: "b" } },
		];
		expect(buildHistoryMessages(loop, "a")).toHaveLength(2);
	});
});

describe("buildTextRequest", () => {
	test("system + history + prompt, General response node", () => {
		const r = buildTextRequest(
			{ prompt: "and then?", model: "claude-opus-5-5", system: "Be brief.", convId: CONV, follow: "a1" },
			{ x: 0, y: 0 },
			[{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }],
		);
		expect(r.path).toBe("/completion/async?mode=general");
		expect(r.body.messages).toEqual([
			{ role: "system", content: "Be brief." },
			{ role: "user", content: "hi" },
			{ role: "assistant", content: "hello" },
			{ role: "user", content: "and then?" },
		]);
		expect(r.body.target_feature).toBe("text_completion");
		expect(r.questionNode.p_id).toBe("a1");
		expect(r.responseNode.data).toMatchObject({ mode: "General", isImage: false, status: "init", model: "claude-opus-5-5" });
	});
});

describe("resolveModel", () => {
	const models: ModelMap = {
		"seedance-2.5": { media: "video", sort: 2 },
		"seedance-2.0-fast": { media: "video", sort: 1 },
		"gpt-image-2.5-flare": { media: "image" },
		"claude-opus-5-5": { media: "text" },
	};
	test("aliases and defaults", () => {
		expect(resolveModel(models, "video", undefined)).toEqual({ id: "seedance-2.0-fast", alias: "fast" });
		expect(resolveModel(models, "video", "best")).toEqual({ id: "seedance-2.5", alias: "best" });
		expect(resolveModel(models, "image", undefined)).toEqual({ id: "gpt-image-2.5-flare", alias: "best" });
		expect(DEFAULT_ALIAS.video).toBe("fast");
		expect(MODEL_ALIASES.text.best).toBe("claude-opus-5-5");
	});
	test("explicit ids pass through; overrides apply; missing alias target falls back", () => {
		expect(resolveModel(models, "video", "seedance-2.5")).toEqual({ id: "seedance-2.5" });
		const table = { ...MODEL_ALIASES, video: { best: "seedance-2.0-fast", fast: "gone-model" } };
		expect(resolveModel(models, "video", "best", table).id).toBe("seedance-2.0-fast");
		const fb = resolveModel(models, "video", "fast", table);
		expect(fb.id).toBe("seedance-2.0-fast");
		expect(fb.note).toMatch(/not in the catalogue/);
	});
});

describe("applyVideoDefaults", () => {
	const m = { supportedAspectRatios: ["adaptive", "16:9"], supportedDurations: ["4", "5", "10"], supportedResolutions: ["480p", "720p", "1080p"] };
	test("fills 16:9 / 5 / 720p when offered, keeps explicit values, respects draft", () => {
		const base = { prompt: "p", model: "m", convId: CONV };
		expect(applyVideoDefaults(base, m)).toMatchObject({ ratio: "16:9", duration: "5", resolution: "720p" });
		expect(applyVideoDefaults({ ...base, ratio: "9:16", duration: "10", resolution: "1080p" }, m)).toMatchObject({ ratio: "9:16", duration: "10", resolution: "1080p" });
		expect(applyVideoDefaults({ ...base, draft: true }, m).resolution).toBeUndefined();
		expect(applyVideoDefaults(base, { supportedAspectRatios: ["1:1"] })).toMatchObject({ ratio: undefined, duration: undefined, resolution: undefined });
	});
});

describe("compactResult", () => {
	const base: GenResult = { status: "finished", kind: "video", model: "m", convId: CONV, questionNodeId: "q", nodeId: "n", url: "u", data: { a: 1, b: 2 } };
	test("drops data on success, keeps error fields on failure", () => {
		expect(compactResult(base).data).toBeUndefined();
		const failed = compactResult({ ...base, status: "failed", data: { error: "x", error_code: "invalid_input", refund_amount: 3, junk: 1 } });
		expect(failed.data).toEqual({ error: "x", error_code: "invalid_input", refund_amount: 3 });
	});
});

describe("outputPathFor", () => {
	test("single file vs batch directory naming", () => {
		expect(outputPathFor("/tmp/x/out.mp4", { nodeId: "abcdef12-x", kind: "video", batch: false })).toBe("/tmp/x/out.mp4");
		expect(outputPathFor("/tmp/x/", { nodeId: "abcdef12-x", index: 0, url: "https://h/a.mp4?s=1", kind: "video", batch: true })).toBe("/tmp/x/01-abcdef12.mp4");
		expect(outputPathFor("/tmp/x", { nodeId: "abcdef12-x", index: 9, kind: "text", batch: true })).toBe("/tmp/x/10-abcdef12.md");
	});
});
