import { describe, expect, test } from "bun:test";
import { estimateCredits, imageSizing, resolveModel, videoParams, type Catalog } from "../lib/catalog";
import { cardsFrom, findCard, readableError, type FlowNodeRow } from "../lib/desk";
import { imageRequest, nameReferences, resultOf, titleFrom, videoRequest, type Ref } from "../lib/generate";
import { imageSize } from "../lib/media";
import { klingReferenceName, seedanceReferenceName } from "../lib/reference-names";
import { operationWaitSec, printedIds, tidyScript } from "../lib/live";
import { expandFrame } from "../lib/tools";
import { arrangePoints, cardSize, nearestFree } from "../lib/write";

const catalog: Catalog = {
	"dola-seedream-5-5-261028": { media: "image", title: "Seedream 5.5", sort: -1, supportedAspectRatios: ["1:1", "16:9", "4:3"], supportedImageSizes: ["2k", "1k"], maxReferenceImages: 10, supportedImageBackgrounds: ["auto", "transparent"], estimatedPrice: 12 },
	"gpt-image-2.6-flare": {
		media: "image",
		title: "GPT Image 2.6 Flare",
		sort: 1,
		sizeMatrix: { ratios: ["1:1", "16:9"], resolutions: ["1K", "2K"], sizes: { "1:1": { "1K": "1024x1024", "2K": "2048x2048" }, "16:9": { "1K": "1280x720", "2K": "2048x1152" } } },
		supportedQualities: ["low", "high"],
	},
	"seedance-2.5-flash": { media: "video", sort: 78, supportedAspectRatios: ["adaptive", "16:9"], supportedDurations: ["-1", "4", "5"], supportedResolutions: ["480p", "720p"], supportsAudio: true, supportedKeyframe: true, referenceAssetLimits: { total: 20, image: 10, audio: 5, video: 5 }, pricePerSecond: { audioOn: 80704, audioOff: 80704 } },
	"kling-video/v4": { media: "video", sort: 75, supportedAspectRatios: ["auto", "16:9"], supportedDurations: ["5"], supportedResolutions: ["720p", "1080p"], supportedKeyframe: true, referenceAssetLimits: { total: 15, image: 10, video: 5, audio: 0 } },
	"veo-3.1-fast-image-to-video": { media: "video", sort: 90, supportedAspectRatios: ["16:9"], supportedDurations: ["8"], supportedResolutions: ["720p"], supportsAudio: true },
	"claude-opus-5-5": { media: "text", sort: 1, title: "Claude Opus 5.5" },
};

const ref = (media: Ref["media"], n: number): Ref => ({ url: `https://x/${media}${n}.${media === "image" ? "png" : media === "video" ? "mp4" : "mp3"}`, name: `${media}${n}`, media });

describe("models", () => {
	test("defaults follow the canvas (video starts on Seedance 2.5 Flash)", () => {
		expect(resolveModel(catalog, "image", undefined).id).toBe("dola-seedream-5-5-261028");
		expect(resolveModel(catalog, "video", undefined).id).toBe("seedance-2.5-flash");
	});
	test("models resolve by display name", () => {
		expect(resolveModel(catalog, "image", "Seedream 5.5").id).toBe("dola-seedream-5-5-261028");
		expect(() => resolveModel(catalog, "image", "nope")).toThrow(/not a image model/);
	});
	test("size-matrix models get a pixel size from ratio × tier", () => {
		// The canvas's defaults: 1K and the first quality (left out, GPT Image runs and bills at "max").
		expect(imageSizing("gpt-image-2.6-flare", catalog["gpt-image-2.6-flare"]!, "16:9")).toMatchObject({ aspect_ratio: "1280x720", quality: "low" });
		expect(imageSizing("gpt-image-2.6-flare", catalog["gpt-image-2.6-flare"]!, "16:9", "2K", "high")).toMatchObject({ aspect_ratio: "2048x1152", quality: "high" });
		expect(() => imageSizing("dola-seedream-5-5-261028", catalog["dola-seedream-5-5-261028"]!, "5:4")).toThrow(/Choose one of/);
	});
	test("video defaults: 16:9, 5 s, 720p when offered", () => {
		expect(videoParams("seedance-2.5-flash", catalog["seedance-2.5-flash"]!, {})).toEqual({ aspect_ratio: "16:9", duration: "5", resolution: "720p" });
	});
	test("token-billed pictures are priced by quality and area", () => {
		const m = { media: "image", estimatedPrice: 20, estimatedBreakdown: [{ quality: "low", price: 20 }, { quality: "max", price: 174 }] };
		expect(estimateCredits(m, { quality: "low", pixels: "1024x1024" })).toBe(20);
		expect(estimateCredits(m, { quality: "max", pixels: "2048x2048" })).toBe(696);
	});
	test("Seedream 5.5 is priced by tier and input pictures, with its launch discount", () => {
		const m = { media: "image", title: "Seedream 5.5", discount: 40, launchCampaignUntil: "2999-01-01T00:00:00Z" };
		expect(estimateCredits(m)).toBe(21);
		expect(estimateCredits(m, { refs: 1 })).toBe(25.8);
		expect(estimateCredits(m, { size: "1k" })).toBe(12);
		expect(estimateCredits({ ...m, launchCampaignUntil: "2000-01-01T00:00:00Z" })).toBe(35);
	});
});

describe("reference naming", () => {
	test("Seedance names its references 图片N / 视频N, unmentioned ones appended", () => {
		expect(nameReferences("the cat in @image1 dances to audio1", seedanceReferenceName, { image: 2, video: 0, audio: 1 })).toBe("the cat in 图片1 dances to 音频1 图片2");
	});
	test("Kling counts its first frame before references", () => {
		expect(nameReferences("@image1 walks in", klingReferenceName, { image: 1, video: 0, audio: 0 }, { image: 1 })).toBe("@image_2 walks in");
	});
	test("naming something not sent is refused", () => {
		expect(() => nameReferences("use image3", seedanceReferenceName, { image: 2, video: 0, audio: 0 })).toThrow(/only 2 image/);
	});
});

describe("requests", () => {
	test("image references ride in the message as numbered Markdown pictures", () => {
		const m = catalog["dola-seedream-5-5-261028"]!;
		const { body, ratio } = imageRequest({ prompt: "put @image1 on @image2", modelId: "dola-seedream-5-5-261028", model: m, ratio: "16:9", refs: [ref("image", 1), ref("image", 2)] }, "n", "c");
		expect(ratio).toBe("16:9");
		expect((body.messages[0] as { content: string }).content).toBe("put image 1 on image 2\n\n![image 1](https://x/image1.png)\n![image 2](https://x/image2.png)");
	});
	test("Chinese prompts name pictures 图N", () => {
		const m = catalog["dola-seedream-5-5-261028"]!;
		const { body } = imageRequest({ prompt: "让@image1 里的猫戴帽子", modelId: "dola-seedream-5-5-261028", model: m, refs: [ref("image", 1)] }, "n", "c");
		expect((body.messages[0] as { content: string }).content).toStartWith("让图1 里的猫戴帽子");
	});
	test("transparent needs a model that can", () => {
		expect(() => imageRequest({ prompt: "x", modelId: "gpt-image-2.6-flare", model: catalog["gpt-image-2.6-flare"]!, transparent: true, refs: [] }, "n", "c")).toThrow(/transparent/);
	});
	test("a video's first and last frames become keyFrames; refs go per kind", () => {
		const m = catalog["seedance-2.5-flash"]!;
		const framed = videoRequest({ prompt: "p", modelId: "seedance-2.5-flash", model: m, first: ref("image", 1), last: ref("image", 2), refs: [] }, "n", "c", "c", { x: 0, y: 0 });
		expect((framed.body as Record<string, unknown>).keyFrames).toEqual(["https://x/image1.png", "https://x/image2.png"]);
		const refd = videoRequest({ prompt: "@image1 sings @audio1", modelId: "seedance-2.5-flash", model: m, refs: [ref("image", 1), ref("audio", 1)] }, "n", "c", "c", { x: 0, y: 0 });
		expect(refd.body).toMatchObject({ prompt: "图片1 sings 音频1", image_urls: ["https://x/image1.png"], audio_urls: ["https://x/audio1.mp3"], audio: true });
	});
	test("frames and references don't mix except on Kling", () => {
		const m = catalog["seedance-2.5-flash"]!;
		expect(() => videoRequest({ prompt: "p", modelId: "seedance-2.5-flash", model: m, first: ref("image", 1), refs: [ref("image", 2)] }, "n", "c", "c", { x: 0, y: 0 })).toThrow(/can't be combined/);
		const k = videoRequest({ prompt: "@image1 runs", modelId: "kling-video/v4", model: catalog["kling-video/v4"]!, first: ref("image", 1), refs: [ref("image", 2)] }, "n", "c", "c", { x: 0, y: 0 });
		expect(k.body.prompt).toBe("@image_2 runs");
		expect("audio" in k.body).toBe(false);
	});
	test("a model without named references takes one picture as its first frame", () => {
		const v = videoRequest({ prompt: "p", modelId: "veo-3.1-fast-image-to-video", model: catalog["veo-3.1-fast-image-to-video"]!, refs: [ref("image", 1)] }, "n", "c", "c", { x: 0, y: 0 });
		expect((v.body as Record<string, unknown>).imageURL).toBe("https://x/image1.png");
		expect(v.body.duration).toBe("8");
	});
	test("titles come from the first sentence", () => {
		expect(titleFrom("一只橘猫趴在窗边。清晨柔光")).toBe("一只橘猫趴在窗边");
		expect(titleFrom("戴红帽的橘猫慢慢抬起头，眨了眨眼，尾巴轻轻摆动")).toBe("戴红帽的橘猫慢慢抬起头");
		expect(titleFrom("A red roadster on a coastal road at sunset, cinematic wide shot")).toBe("A red roadster on a coastal");
	});
});

describe("reading the canvas", () => {
	const row = (id: string, type: string, data: Record<string, unknown>, position = { x: 0, y: 0 }, w = 384, h = 216): FlowNodeRow => ({
		id, conv_id: "c", type, p_id: "c", position, width: w, height: h, data, created_at: "2026-11-16T00:00:00Z",
	});
	const g = "11111111-0000-0000-0000-000000000000";
	const a = "aaaaaaaa-0000-0000-0000-000000000000";
	const b = "bbbbbbbb-0000-0000-0000-000000000000";
	const cards = cardsFrom([
		row(g, "11", { name: "Shots", title: "分组 (2 个节点)" }, { x: 232, y: -120 }, 464, 560),
		row(a, "2", { isImage: true, value: "https://x/a.png", group_id: g, title: "AI", status: "finished" }, { x: 232, y: 40 }),
		row(b, "13", { videoId: "https://x/b.mp4", status: "finished", title: "Clip", promptReferenceNodes: [{ id: a }] }, { x: 600, y: 0 }),
	]);
	test("group members are placed from their group's corner; stored positions are top-centre", () => {
		const member = cards.find((c) => c.id === a)!;
		expect(member.rect).toEqual({ x: 0 + 232 - 192, y: -120 + 40, width: 384, height: 216 });
		expect(member.groupId).toBe(g);
		expect(member.title).toBeUndefined();
	});
	test("groups are named by their name, cards by their title; links come back", () => {
		expect(cards.find((c) => c.id === g)!.title).toBe("Shots");
		expect(cards.find((c) => c.id === b)!.references).toEqual([a]);
		expect(cards.find((c) => c.id === b)!.kind).toBe("video");
	});
	test("provider failures read as one sentence", () => {
		const raw = JSON.stringify({ value: "provider_error", error_type: "provider_error", error_message: "Workflow delivery failed: -1", request_error: { message: "x" } });
		expect(readableError(raw)).toBe("provider_error: Workflow delivery failed: -1");
		expect(readableError("Generation failed\n\nPlease try again.")).toBe("Generation failed Please try again.");
	});
	test("a refused card that became the canvas's credits card keeps its kind and reads as NO_CREDITS", () => {
		const [refused] = cardsFrom([
			row(a, "22", { status: "failed", errorMessage: "insufficient credits", agentRequest: { kind: "video", body: {} } }),
		]);
		expect(refused!.kind).toBe("video");
		expect(resultOf(refused!)).toMatchObject({ status: "failed", code: "NO_CREDITS", error: "insufficient credits" });
	});
	test("cards are found by ref, prefix or title", () => {
		expect(findCard(cards, "bbbb").id).toBe(b);
		expect(findCard(cards, "clip").id).toBe(b);
		expect(() => findCard(cards, "zzzz")).toThrow(/No card/);
	});
});

describe("layout helpers", () => {
	test("card sizes follow the canvas", () => {
		expect(cardSize("image", "16:9")).toEqual({ width: 384, height: 216 });
		expect(cardSize("text")).toEqual({ width: 384, height: 520 });
	});
	test("arrange lines cards up from the first one's corner", () => {
		const mk = (x: number, y: number, w: number, h: number) => ({ rect: { x, y, width: w, height: h } }) as never;
		expect(arrangePoints([mk(10, 20, 100, 50), mk(500, 500, 80, 60)], "row", 32)).toEqual([{ x: 10, y: 20 }, { x: 142, y: 20 }]);
		expect(arrangePoints([mk(0, 0, 100, 50), mk(0, 0, 100, 50), mk(0, 0, 100, 50)], "grid", 10, 2)).toEqual([{ x: 0, y: 0 }, { x: 110, y: 0 }, { x: 0, y: 60 }]);
	});
	test("nearestFree stays put when clear and steps aside when not", () => {
		expect(nearestFree({ width: 100, height: 100 }, { x: 0, y: 0 }, [])).toEqual({ x: 0, y: 0 });
		const moved = nearestFree({ width: 100, height: 100 }, { x: 0, y: 0 }, [{ x: 0, y: 0, width: 100, height: 100 }]);
		expect(moved).not.toEqual({ x: 0, y: 0 });
	});
	test("expand keeps the whole picture, centred, within the tool's limits", () => {
		const f = expandFrame({ width: 16, height: 9 }, 2048, 2048);
		expect(f.outputWidth / f.outputHeight).toBeCloseTo(16 / 9, 1);
		expect(f.sourceHeight).toBe(f.outputHeight);
		expect(f.outputWidth * f.outputHeight).toBeLessThanOrEqual(2048 * 2048);
		expect(f.offsetX).toBe(Math.floor((f.outputWidth - f.sourceWidth) / 2));
	});
	test("image headers give their size", () => {
		const png = Buffer.alloc(32);
		png.writeUInt32BE(0x89504e47, 0);
		png.writeUInt32BE(1920, 16);
		png.writeUInt32BE(1080, 20);
		expect(imageSize(png)).toEqual({ width: 1920, height: 1080 });
	});
});

describe("listed clip prices (`models`)", () => {
	const { catalog } = require("./fake-flowith") as typeof import("./fake-flowith");
	const { listPrice } = require("../lib/video-cost") as typeof import("../lib/video-cost");
	test("say the size they are quoted at; a request's own price comes from the worker", () => {
		expect(listPrice(catalog["seedance-2.5"] as never)).toEqual({ credits: 622, at: "480p" });
		expect(listPrice(catalog["kling-video/v4"] as never)).toEqual({ credits: 1021, at: "720p" });
		expect(listPrice(catalog["muse-video"] as never)).toEqual({ credits: 15 });
	});
});

describe("charges of cards only claimed for a retry", () => {
	test("a card only claimed (never sent from here) makes the charge unknown, not zero", async () => {
		const { chargeOf } = await import("../lib/ledger");
		const claiming = { card: "c1", conv: "v", model: "m", kind: "image" as const, from: 0, to: 0, answer: "claiming" as const, attempt: "x" };
		// A charge of that model at that moment (another card's) is not taken for it.
		const other = { model: "m", req_id: "r1", tokens_used: 5000, billing_unit_price: null, created_at: new Date(0).toISOString() };
		expect("unknown" in chargeOf([claiming], [other], 1)).toBe(true);
	});
	test("the fingerprint of card data ignores key order (the database reorders it)", async () => {
		const { fingerprint } = await import("../lib/ledger");
		expect(fingerprint({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } })).toBe(fingerprint({ a: { c: null, d: [1, { x: 1, y: 2 }] }, b: 1 }));
		expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: 2 }));
	});
});

describe("canvas reads and layouts through layoutCanvas scripts", () => {
	const a = "11111111-1111-4111-8111-111111111111";
	const b = "22222222-2222-4222-8222-222222222222";
	test("printed selection ids come back in order, whatever print() packed together", () => {
		expect(printedIds({ printed: [`${a}\n${b}`, a] })).toEqual([a, b, a]);
		expect(printedIds({ printed: ["Nothing moved", ""] })).toEqual([]);
		expect(printedIds({})).toBeUndefined();
	});
	test("tidy without cards is Organize; with --as each layout is one of the API's moves", () => {
		expect(tidyScript([])).toBe("tidy()");
		expect(tidyScript([a, b])).toBe(`const cards = ${JSON.stringify([a, b])}.map((id) => node({ ids: id }))\ntidy(cards)`);
		expect(tidyScript([a, b], "hdistribute")).toContain('distribute(cards, "h")');
		expect(() => tidyScript([a, b], "spiral")).toThrow("--as takes");
		expect(() => tidyScript([], "row")).toThrow("Name the cards");
	});
	test("every wait outlasts the page's busy answer: 15 s for focus, 8 minutes for anything else, layoutCanvas included", () => {
		expect(operationWaitSec("focusCanvasNodes") * 1000).toBeGreaterThan(15_000);
		expect(operationWaitSec("getCanvasLayout") * 1000).toBeGreaterThan(15_000);
		expect(operationWaitSec("layoutCanvas") * 1000).toBeGreaterThan(8 * 60_000);
		expect(operationWaitSec("cardTool", 1200)).toBe(1200);
	});
});
