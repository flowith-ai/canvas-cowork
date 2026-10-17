import { describe, expect, test } from "bun:test";
import { applySeedanceReferences, buildImageRequest, buildVideoRequest } from "../lib/generate";
import type { RemoteModel } from "../lib/models";
import type { UploadedMedia } from "../lib/upload";
import { NODE_TYPE } from "../lib/canvas";

const seedance: RemoteModel = {
	media: "video",
	supportedAspectRatios: ["adaptive", "16:9", "9:16"],
	supportedDurations: ["-1", "5", "10"],
	supportedResolutions: ["480p", "720p", "1080p"],
	supportsAudio: true,
	supportedKeyframe: true,
	supportsDraft: true,
	referenceAssetLimits: { total: 4, image: 2, audio: 1, video: 1 },
};
const kling: RemoteModel = {
	media: "video",
	supportedAspectRatios: ["16:9"],
	supportedDurations: ["5", "10"],
	supportsAudio: true,
	supportedKeyframe: true,
};
const gemini: RemoteModel = {
	media: "image",
	supportedAspectRatios: ["1:1", "16:9"],
	supportedImageSizes: ["1k", "2k"],
	maxReferenceImages: 2,
};

const img = (n: string): UploadedMedia => ({ url: `https://r2/${n}.png`, name: `${n}.png`, type: "image/png", media: "image" });
const wav = (n: string): UploadedMedia => ({ url: `https://r2/${n}.wav`, name: `${n}.wav`, type: "audio/wav", media: "audio" });
const mp4 = (n: string): UploadedMedia => ({ url: `https://r2/${n}.mp4`, name: `${n}.mp4`, type: "video/mp4", media: "video" });

const CONV = "11111111-1111-4111-8111-111111111111";
const POS = { x: 100, y: 200 };

describe("buildImageRequest", () => {
	test("builds question + init response node and the async body", () => {
		const r = buildImageRequest(
			{ prompt: "a cat", model: "gemini-3-pro-image", ratio: "16:9", size: "2k", refs: [img("ref")], convId: CONV },
			gemini,
			POS,
		);
		expect(r.path).toBe("/image_gen/async");
		expect(r.questionNode.type).toBe(NODE_TYPE.question);
		expect(r.questionNode.p_id).toBe(CONV);
		expect(r.questionNode.position).toEqual(POS);
		expect(r.questionNode.data?.value).toBe("a cat");
		expect(r.questionNode.data?.fileList[0].url).toBe("https://r2/ref.png");
		expect(r.responseNode.type).toBe(NODE_TYPE.response);
		expect(r.responseNode.p_id).toBe(r.questionNode.id);
		expect(r.responseNode.position!.y).toBeGreaterThan(POS.y);
		expect(r.responseNode.data).toMatchObject({
			mode: "image_generation",
			isImage: true,
			status: "init",
			model: "gemini-3-pro-image",
			aspect_ratio: "16:9",
			image_size: "2k",
		});
		expect(r.body).toEqual({
			target_feature: "image_generation",
			model: "gemini-3-pro-image",
			nodeId: r.responseNode.id,
			convId: CONV,
			messages: [{ role: "user", content: "a cat" }],
			aspect_ratio: "16:9",
			image_size: "2k",
			styleUrls: ["https://r2/ref.png"],
		});
	});
	test("--follow parents the question to that node", () => {
		const r = buildImageRequest({ prompt: "p", model: "m", convId: CONV, follow: "22222222-2222-4222-8222-222222222222" }, gemini, POS);
		expect(r.questionNode.p_id).toBe("22222222-2222-4222-8222-222222222222");
	});
	test("rejects non-image refs and too many refs", () => {
		expect(() => buildImageRequest({ prompt: "p", model: "m", convId: CONV, refs: [wav("a")] }, gemini, POS)).toThrow(/image references/);
		expect(() => buildImageRequest({ prompt: "p", model: "m", convId: CONV, refs: [img("a"), img("b"), img("c")] }, gemini, POS)).toThrow(/at most 2/);
	});
});

describe("applySeedanceReferences", () => {
	test("numbers references per type and appends unmentioned tokens", () => {
		const r = applySeedanceReferences("dance to audio1", [img("a"), wav("s"), img("b")]);
		expect(r.urls).toEqual({ image_urls: ["https://r2/a.png", "https://r2/b.png"], video_urls: [], audio_urls: ["https://r2/s.wav"] });
		expect(r.tokens).toEqual({ image1: "https://r2/a.png", audio1: "https://r2/s.wav", image2: "https://r2/b.png" });
		expect(r.prompt).toBe("dance to audio1 image1 image2");
	});
	test("dedupes the same url", () => {
		const r = applySeedanceReferences("x", [img("a"), img("a")]);
		expect(r.urls.image_urls).toEqual(["https://r2/a.png"]);
	});
});

describe("buildVideoRequest", () => {
	test("plain text-to-video on Seedance with resolution and audio default", () => {
		const r = buildVideoRequest(
			{ prompt: "a dog", model: "seedance-2.5", ratio: "16:9", duration: 5, resolution: "720p", convId: CONV },
			seedance,
			POS,
		);
		expect(r.path).toBe("/video/async");
		expect(r.responseNode.type).toBe(NODE_TYPE.video);
		expect(r.responseNode.data).toMatchObject({
			mode: "image_generation",
			status: "init",
			duration: "5",
			audio: true,
			resolution: "720p",
			aspect_ratio: "16:9",
			aspectRatio: 16 / 9,
			draft: false,
		});
		expect(r.body).toEqual({
			target_feature: "video_generation",
			nodeId: r.responseNode.id,
			convId: CONV,
			parentNodeId: r.questionNode.id,
			position: r.responseNode.position,
			model: "seedance-2.5",
			prompt: "a dog",
			aspect_ratio: "16:9",
			duration: "5",
			audio: true,
			resolution: "720p",
		});
	});
	test("--no-audio and --draft", () => {
		const r = buildVideoRequest({ prompt: "p", model: "seedance-2.5", audio: false, draft: true, resolution: "1080p", convId: CONV }, seedance, POS);
		expect(r.body.audio).toBe(false);
		expect(r.body.draft).toBe(true);
		expect(r.body.resolution).toBe("480p");
	});
	test("start/end frames → imageURL + keyFrames + typed fileList", () => {
		const r = buildVideoRequest({ prompt: "p", model: "kling", start: img("s"), end: img("e"), convId: CONV }, kling, POS);
		expect(r.body.imageURL).toBe("https://r2/s.png");
		expect(r.body.keyFrames).toEqual(["https://r2/s.png", "https://r2/e.png"]);
		expect(r.questionNode.data?.fileList.map((f: any) => f.type)).toEqual(["video-start-frame", "video-end-frame"]);
		expect(r.responseNode.data?.fileList).toHaveLength(2);
		expect(() => buildVideoRequest({ prompt: "p", model: "kling", end: img("e"), convId: CONV }, kling, POS)).toThrow(/--end requires --start/);
		expect(() => buildVideoRequest({ prompt: "p", model: "kling", start: wav("a"), convId: CONV }, kling, POS)).toThrow(/must be images/);
	});
	test("Seedance refs become image_urls/audio_urls with tokens; frames + refs are exclusive", () => {
		const r = buildVideoRequest({ prompt: "sing audio1", model: "seedance-2.5", refs: [img("a"), wav("v")], convId: CONV }, seedance, POS);
		expect(r.body.image_urls).toEqual(["https://r2/a.png"]);
		expect(r.body.audio_urls).toEqual(["https://r2/v.wav"]);
		expect(r.body.video_urls).toEqual([]);
		expect(r.body.prompt).toBe("sing audio1 image1");
		expect(r.body.imageURL).toBeUndefined();
		expect(r.references).toEqual({ image1: "https://r2/a.png", audio1: "https://r2/v.wav" });
		expect(() => buildVideoRequest({ prompt: "p", model: "seedance-2.5", start: img("s"), refs: [img("a")], convId: CONV }, seedance, POS)).toThrow(/can't be combined/);
	});
	test("Seedance reference limits are enforced", () => {
		expect(() => buildVideoRequest({ prompt: "p", model: "seedance-2.5", refs: [wav("a"), wav("b")], convId: CONV }, seedance, POS)).toThrow(/audio references/);
		expect(() => buildVideoRequest({ prompt: "p", model: "seedance-2.5", refs: [img("a"), img("b"), wav("c"), mp4("d"), img("e")], convId: CONV }, seedance, POS)).toThrow(/Too many/);
	});
	test("non-Seedance models: a single image ref becomes imageURL; audio/video refs rejected", () => {
		const r = buildVideoRequest({ prompt: "p", model: "kling", refs: [img("a")], convId: CONV }, kling, POS);
		expect(r.body.imageURL).toBe("https://r2/a.png");
		expect(r.body.image_urls).toBeUndefined();
		expect(() => buildVideoRequest({ prompt: "p", model: "kling", refs: [mp4("a")], convId: CONV }, kling, POS)).toThrow(/Seedance 2.x/);
		expect(() => buildVideoRequest({ prompt: "p", model: "kling", refs: [img("a"), img("b")], convId: CONV }, kling, POS)).toThrow(/single reference/);
	});
});
