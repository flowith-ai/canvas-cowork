import { describe, expect, test } from "bun:test";
import { NODE_TYPE, childPosition, estimateHeight, rootQuestionPosition } from "../lib/canvas";
import { ilikePattern } from "../lib/http";
import { decodeJwt, isJwtExpired, jwtExpiresAtIso, jwtExpiresInMs } from "../lib/session";
import { extOf, isUrl, mediaOf } from "../lib/upload";

const node = (type: string, x: number, y: number, data: Record<string, unknown> = {}) => ({
	id: crypto.randomUUID(),
	conv_id: "c",
	p_id: null,
	c_ids: [],
	type,
	data,
	position: { x, y },
});

describe("layout", () => {
	test("empty canvas → origin", () => {
		expect(rootQuestionPosition([])).toEqual({ x: 0, y: 0 });
	});
	test("new root goes below the lowest node at the right-most node's x", () => {
		const nodes = [
			node(NODE_TYPE.question, 0, 0),
			node(NODE_TYPE.video, 0, 130),
			node(NODE_TYPE.question, 500, 10),
		];
		const p = rootQuestionPosition(nodes);
		expect(p.x).toBe(500);
		expect(p.y).toBe(130 + estimateHeight(nodes[1]) + 50);
	});
	test("children sit below their parent by estimated height", () => {
		const q = node(NODE_TYPE.question, 10, 20);
		expect(childPosition(q)).toEqual({ x: 10, y: 20 + 80 + 50 });
		const textResp = node(NODE_TYPE.response, 0, 0, { isImage: false });
		const imgResp = node(NODE_TYPE.response, 0, 0, { isImage: true });
		expect(estimateHeight(textResp)).toBeLessThan(estimateHeight(imgResp));
	});
});

describe("jwt", () => {
	const mk = (payload: object) =>
		`h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`;
	test("decodes and reads expiry", () => {
		const exp = Math.floor(Date.now() / 1000) + 600;
		const jwt = mk({ sub: "u1", exp });
		expect(decodeJwt(jwt)?.sub).toBe("u1");
		expect(isJwtExpired(jwt)).toBe(false);
		expect(jwtExpiresInMs(jwt)).toBeGreaterThan(500_000);
		expect(jwtExpiresAtIso(jwt)).toBe(new Date(exp * 1000).toISOString());
		expect(isJwtExpired(mk({ exp: 1 }))).toBe(true);
		expect(decodeJwt("garbage")).toBeNull();
	});
});

describe("upload helpers", () => {
	test("media detection by extension / url", () => {
		expect(mediaOf("a.PNG")).toBe("image");
		expect(mediaOf("https://x/y/clip.mp4?sig=1")).toBe("video");
		expect(mediaOf("voice.wav")).toBe("audio");
		expect(mediaOf("doc.pdf")).toBe("file");
		expect(extOf("https://x/a.b/c.webp#f")).toBe("webp");
		expect(isUrl("http://a")).toBe(true);
		expect(isUrl("./a.png")).toBe(false);
	});
});

describe("ilikePattern", () => {
	test("escapes wildcards", () => {
		expect(ilikePattern("50%_off")).toBe("*50\\%\\_off*");
	});
});
