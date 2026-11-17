/**
 * The real CLI run against a stand-in Flowith (fake-flowith.ts): dry runs change nothing, retry never sends a card
 * twice, a lost answer leaves the card alone, charges are tied to their own attempts, and logout ends the sign-in.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
import { CONV, fakeFlowith, ids, precharge } from "./fake-flowith";

const ref = (id: string) => id.slice(0, 8);
const fakes: Array<{ stop: () => void }> = [];
const fake = (...args: Parameters<typeof fakeFlowith>) => {
	const f = fakeFlowith(...args);
	fakes.push(f);
	return f;
};
afterAll(() => fakes.forEach((f) => f.stop()));

describe("--dry-run sends nothing that changes the canvas", () => {
	const f = fake();
	const file = join(f.home, "pic.png");
	writeFileSync(file, Buffer.from("89504e470d0a1a0a", "hex"));
	const preview: string[][] = [
		["image", "a cat"], ["edit", ref(ids.image), "red hat"], ["vary", ref(ids.finishedAgent)], ["retry", ref(ids.failed)],
		["video", "a cat walks"], ["text", "hello", "--ref", ref(ids.text)], ["speech", "hello"], ["music", "calm"],
		["upscale", ref(ids.image)], ["cutout", ref(ids.image)], ["expand", ref(ids.image), "--ratio", "16:9"],
		["add", file], ["note", "a plan"], ["delete", ref(ids.image)],
	];
	const reads: string[][] = [["whoami"], ["credits"], ["canvases"], ["look"], ["read", ref(ids.image)], ["models", "video"], ["spent"], ["wait", ref(ids.image)]];
	const refused: string[][] = [
		["login"], ["logout"], ["new", "X"], ["use", CONV], ["open"], ["shots", ref(ids.image)], ["save", ref(ids.image)],
		["write", ref(ids.text), "new words"], ["move", ref(ids.image), "--to", "10,10"], ["arrange", ref(ids.image), ref(ids.video), "--as", "row"],
		["group", ref(ids.image), ref(ids.video)], ["ungroup", ref(ids.group)], ["rename", ref(ids.image), "New"], ["link", ref(ids.image), ref(ids.video)],
		["unlink", ref(ids.image), ref(ids.video)], ["copy", ref(ids.image)], ["focus", ref(ids.image)], ["tidy"], ["do", "focusCanvasNodes", "--input", "{}"],
	];
	test.each([...preview, ...reads])("%s previews or reads, and writes nothing", async (...args) => {
		const before = f.writes().length;
		const r = await f.run(...args, "--dry-run");
		expect(r.json.error).toBeUndefined();
		expect(f.writes().slice(before).filter((w) => w.path !== "/video/price")).toEqual([]);
	});
	test.each(refused)("%s has no dry run: refused before anything is sent", async (...args) => {
		const before = f.writes().length;
		const r = await f.run(...args, "--dry-run");
		expect(r.json.error).toBe("INVALID_PARAM");
		expect(r.json.message).toContain("has no dry run");
		expect(f.writes().slice(before)).toEqual([]);
	});
	test.each([
		["seedance-2.5", "720p", "5", 1398.276],
		["seedance-2.5", "1080p", "5", 3440.151],
		["seedance-2.5-flash", "720p", "4", 733.32],
	])("%s %s %s s is priced by the worker, never under its hold", async (model, res, seconds, hold) => {
		const r = await f.run("video", "a cat walks", "--model", model, "--resolution", res, "--ratio", "16:9", "--duration", seconds, "--dry-run");
		expect(r.json.estimatedCredits).toBeGreaterThanOrEqual(hold);
		expect(r.json.estimatedCredits).toBeLessThan(hold + 0.01);
	});
	test("a price only making it can tell is unknown, with a reason to ask", async () => {
		const r = await f.run("video", "same shot, rainy", "--model", "kling-video/v4", "--ref", ref(ids.video), "--dry-run");
		expect(r.json.estimatedCredits).toBeNull();
		expect(r.json.estimateNote).toContain("Ask the user");
	});
	test("text takes a text card as its reference", async () => {
		const r = await f.run("text", "summarise", "--ref", ref(ids.text), "--dry-run");
		expect(r.json.error).toBeUndefined();
		expect(JSON.stringify(r.json.requests)).toContain("hello there");
	});
});

describe("retry never sends a card twice", () => {
	const latch = () => {
		let release!: () => void;
		const promise = new Promise<void>((resolve) => { release = resolve; });
		return { promise, release };
	};

	test("a delayed failed-card response cannot resubmit after another process releases its lock", async () => {
		const captured = latch(), resume = latch();
		let first = true;
		const f = fake({ precharge: precharge(5), afterNodeRead: async () => {
			if (first) { first = false; captured.release(); await resume.promise; }
		} });
		const slow = f.run("retry", ref(ids.failed), "--no-wait");
		await captured.promise;
		try { expect((await f.run("retry", ref(ids.failed), "--no-wait")).code).toBe(0); }
		finally { resume.release(); }
		expect((await slow).code).toBe(1);
		expect(f.writes().filter((w) => w.path.startsWith("/image_gen/async"))).toHaveLength(1);
		expect(f.usage).toHaveLength(1);
	});

	test("two machines that both read failed compete for one database claim", async () => {
		const both = latch();
		let pending = 0;
		const f = fake({ precharge: precharge(5), beforeNodePatch: async () => {
			if (++pending === 2) both.release();
			await both.promise;
		} });
		const outcomes = await Promise.all([
			f.run("retry", ref(ids.failed), "--no-wait"),
			f.runFrom(f.newHome(), "retry", ref(ids.failed), "--no-wait"),
		]);
		expect(outcomes.map((r) => r.code).sort()).toEqual([0, 1]);
		expect(outcomes.find((r) => r.code === 1)?.json.error).toBe("BUSY");
		expect(f.writes().filter((w) => w.path.startsWith("/image_gen/async"))).toHaveLength(1);
		expect(f.usage).toHaveLength(1);
	});

	test("an edit after validation is preserved and is not submitted", async () => {
		const f = fake();
		f.opts.beforeNodePatch = async () => {
			f.rows.find((r) => r.id === ids.failed)!.data.title = "Changed meanwhile";
		};
		const result = await f.run("retry", ref(ids.failed), "--no-wait");
		expect(result.json.error).toBe("BUSY");
		expect(f.rows.find((r) => r.id === ids.failed)!.data.title).toBe("Changed meanwhile");
		expect(f.writes().filter((w) => w.path.startsWith("/image_gen/async"))).toHaveLength(0);
	});

	test("a card deleted after validation cannot be claimed", async () => {
		const f = fake();
		f.opts.beforeNodePatch = async () => { Object.assign(f.rows.find((r) => r.id === ids.failed)!, { is_delete: true }); };
		expect((await f.run("retry", ref(ids.failed), "--no-wait")).json.error).toBe("NOT_FOUND");
		expect(f.writes().filter((w) => w.path.startsWith("/image_gen/async"))).toHaveLength(0);
	});

	test("a lost claim response is recovered only by reading its unique marker", async () => {
		const f = fake({ dropPatchReply: true, precharge: precharge(5) });
		expect((await f.run("retry", ref(ids.failed), "--no-wait")).code).toBe(0);
		expect(f.writes().filter((w) => w.path.startsWith("/image_gen/async"))).toHaveLength(1);
		expect(f.usage).toHaveLength(1);
	});

	test("an unreadable lost claim sends nothing and leaves a recovery record", async () => {
		const f = fake({ dropPatchReply: true });
		f.opts.beforeNodePatch = async () => { f.opts.nodeReadStatus = 503; };
		expect((await f.run("retry", ref(ids.failed), "--no-wait")).json.error).toBe("SERVER_ERROR");
		expect(f.writes().filter((w) => w.path.startsWith("/image_gen/async"))).toHaveLength(0);
		const file = join(f.home, "sent", `${ids.failed}.json`);
		const sent = JSON.parse(readFileSync(file, "utf8"));
		expect(sent.answer).toBe("claiming");
		writeFileSync(file, JSON.stringify({ ...sent, from: sent.from - 3_600_000, to: sent.to - 3_600_000 }));
		delete f.opts.beforeNodePatch;
		delete f.opts.nodeReadStatus;
		delete f.opts.dropPatchReply;
		expect((await f.run("retry", ref(ids.failed), "--no-wait")).code).toBe(0);
		expect(f.writes().filter((w) => w.path.startsWith("/image_gen/async"))).toHaveLength(1);
	});

	test("a batch is revalidated under the lock: a card that changed is left out, the rest go, no lock is left", async () => {
		const f = fake();
		const second = structuredClone(f.rows.find((r) => r.id === ids.failed)!);
		second.id = "b3000000-0000-4000-8000-000000000004";
		f.rows.push(second);
		let first = true;
		f.opts.afterNodeRead = async () => {
			if (first) { first = false; second.data.status = "running"; }
		};
		const r = await f.run("retry", ref(ids.failed), ref(second.id), "--no-wait");
		expect(r.code).toBe(0);
		expect(f.writes().filter((w) => w.path.startsWith("/image_gen/async")).map((w) => (w.body as any).nodeId)).toEqual([ids.failed]);
		expect(JSON.stringify(r.json.notRetried)).toContain(ref(second.id));
		expect(readdirSync(join(f.home, "sent")).filter((name) => name.endsWith(".retry"))).toEqual([]);
	});

	test("a refused patch releases every lock in the batch", async () => {
		const f = fake({ patchStatus: 403 });
		const second = structuredClone(f.rows.find((r) => r.id === ids.failed)!);
		second.id = "b3000000-0000-4000-8000-000000000004";
		f.rows.push(second);
		expect((await f.run("retry", ref(ids.failed), ref(second.id), "--no-wait")).json.error).toBe("FORBIDDEN");
		expect(readdirSync(join(f.home, "sent")).filter((name) => name.endsWith(".retry"))).toEqual([]);
		expect(f.writes().filter((w) => w.path.startsWith("/image_gen/async"))).toHaveLength(0);
	});

	test("a card still generating is refused", async () => {
		const f = fake();
		const r = await f.run("retry", ref(ids.running), "--no-wait");
		expect(r.json.error).toBe("BUSY");
		expect(f.writes()).toEqual([]);
	});
	test("a finished card is refused (vary makes another take)", async () => {
		const f = fake();
		const r = await f.run("retry", ref(ids.finishedAgent), "--no-wait");
		expect(r.json.error).toBe("INVALID_PARAM");
		expect(f.writes()).toEqual([]);
	});
	test("a failed card runs again", async () => {
		const f = fake();
		await f.run("retry", ref(ids.failed), "--no-wait");
		expect(f.writes().map((w) => `${w.method} ${w.path.split("?")[0]}`)).toEqual(["PATCH /rest/v1/flow_node", "POST /image_gen/async"]);
	});
});

describe("retry decides on the card as it is once it holds the card (Codex's slow-read case)", () => {
	const submits = (f: ReturnType<typeof fake>) => f.writes().filter((w) => w.path.startsWith("/image_gen"));
	const canvasRead = (method: string, url: URL) => method === "GET" && url.pathname === "/rest/v1/flow_node" && url.searchParams.has("conv_id");
	const cardRead = (method: string, url: URL) => method === "GET" && url.pathname === "/rest/v1/flow_node" && !!url.searchParams.get("id")?.startsWith("in.(");

	test("a retry whose read was slow finds the card already retried and sends nothing", async () => {
		const f = fake({ precharge: precharge(5), finish: false });
		// The slow command's read of the canvas (the card failed) is held back while another retry runs it.
		const read = f.hold(canvasRead);
		const slow = f.run("retry", ref(ids.failed), "--no-wait");
		await read.arrived;
		const fast = await f.run("retry", ref(ids.failed), "--no-wait");
		expect(fast.code).toBe(0);
		read.release();
		const late = await slow;
		expect(late.json.error).toBe("BUSY");
		// Caught by the fresh read once it held the card (the claim in Flowith would have caught it too).
		expect(late.json.message).toContain("still generating");
		expect(submits(f)).toHaveLength(1);
		expect(f.usage).toHaveLength(1);
	});
	test("on another machine (no shared lock), the card is claimed in Flowith: only one retry is taken", async () => {
		const f = fake({ precharge: precharge(5), finish: false });
		const other = f.newHome();
		// The other machine re-reads the card once it holds its own lock; that answer (still failed) arrives late.
		const read = f.hold(cardRead);
		const slow = f.runWith({ home: other }, "retry", ref(ids.failed), "--no-wait");
		await read.arrived;
		const fast = await f.run("retry", ref(ids.failed), "--no-wait");
		expect(fast.code).toBe(0);
		read.release();
		const late = await slow;
		expect(late.json.error).toBe("BUSY");
		expect(late.json.message).toContain("changed");
		expect(submits(f)).toHaveLength(1);
		expect(f.usage).toHaveLength(1);
	});
	test("a card that failed again after a retry can be retried again", async () => {
		const f = fake({ precharge: precharge(5), finish: false });
		expect((await f.run("retry", ref(ids.failed), "--no-wait")).code).toBe(0);
		const card = f.rows.find((r) => r.id === ids.failed)!;
		Object.assign(card.data, { status: "failed", error: "provider_error" });
		expect((await f.run("retry", ref(ids.failed), "--no-wait")).code).toBe(0);
		expect(submits(f)).toHaveLength(2);
	});
});

describe("retry's claim, when it can't be made", () => {
	const submits = (f: ReturnType<typeof fake>) => f.writes().filter((w) => w.path.startsWith("/image_gen"));
	/** The claim is made but its answer is lost, and reading the card back fails too: only the record can tell later. */
	const loseClaim = (f: ReturnType<typeof fake>) => {
		f.opts.claimAnswer = "drop";
		f.opts.beforeNodePatch = async () => {
			f.opts.nodeReadStatus = 503;
		};
	};
	const restore = (f: ReturnType<typeof fake>) => {
		f.opts.claimAnswer = undefined;
		f.opts.beforeNodePatch = undefined;
		f.opts.nodeReadStatus = undefined;
	};
	const sentFile = (f: ReturnType<typeof fake>, id: string) => join(f.home, "sent", `${id}.json`);

	test("a claim whose answer is lost: nothing was sent, and the next retry sends it at once (other charges meanwhile don't hold it)", async () => {
		const f = fake({ finish: false, precharge: precharge(5) });
		loseClaim(f);
		const r = await f.run("retry", ref(ids.failed), "--no-wait");
		expect(r.json.error).toBe("SERVER_ERROR");
		expect(r.json.message).toContain("nothing was sent");
		expect(submits(f)).toHaveLength(0);
		const card = f.rows.find((x) => x.id === ids.failed)!;
		expect(card.data.status).toBe("running");
		const sent = JSON.parse(readFileSync(sentFile(f, ids.failed), "utf8"));
		expect(sent).toMatchObject({ answer: "claiming", attempt: card.data.agentAttempt });
		// The same model charged on this canvas meanwhile (another card): not taken for this card's send.
		f.usage.unshift(precharge(5)("z-image-turbo"));
		restore(f);
		const again = await f.run("retry", ref(ids.failed), "--no-wait");
		expect(again.code).toBe(0);
		expect(submits(f)).toHaveLength(1);
	});
	test("a claim that took on another machine (its mark, not this one's) isn't sent from here", async () => {
		const f = fake({ finish: false });
		loseClaim(f);
		await f.run("retry", ref(ids.failed), "--no-wait");
		restore(f);
		f.rows.find((x) => x.id === ids.failed)!.data.agentAttempt = "another-machine";
		const r = await f.run("retry", ref(ids.failed), "--no-wait");
		expect(r.json.error).toBe("BUSY");
		expect(submits(f)).toHaveLength(0);
	});
	test("a login that ended before the claim went says so (not a lost send), and leaves no record", async () => {
		const f = fake();
		const read = f.hold((m, u) => m === "GET" && !!u.searchParams.get("id")?.startsWith("in.("));
		const run = f.runWith({ env: { FLOWITH_SIGNIN_CHECK_MS: "1" } }, "retry", ref(ids.failed), "--no-wait");
		await read.arrived;
		f.opts.userStatus = 403;
		read.release();
		const r = await run;
		expect(r.json.error).toBe("NOT_LOGGED_IN");
		expect(submits(f)).toHaveLength(0);
		expect(existsSync(sentFile(f, ids.failed))).toBe(false);
	});
	test("a claim with no answer that wasn't made leaves the earlier lost send to its own rule: sent once it clearly never went", async () => {
		const f = fake({ submit: "drop", finish: false });
		const card = (await f.run("image", "a cat", "--model", "z-image-turbo")).json.cards[0].id as string;
		const file = sentFile(f, card);
		const lostSend = JSON.parse(readFileSync(file, "utf8"));
		writeFileSync(file, JSON.stringify({ ...lostSend, from: lostSend.from - 3_600_000, to: lostSend.to - 3_600_000 }));
		f.opts.submit = "ok";
		f.opts.claimAnswer = "drop-unmade";
		expect((await f.run("retry", card.slice(0, 8), "--no-wait")).json.error).toBe("SERVER_ERROR");
		expect(JSON.parse(readFileSync(file, "utf8")).prev.answer).toBe("lost");
		f.opts.claimAnswer = undefined;
		const r = await f.run("retry", card.slice(0, 8), "--no-wait");
		expect(r.code).toBe(0);
		expect(submits(f)).toHaveLength(2);
	});
	test("two claims in a row without an answer (the first made, the second not): the card is still sent, once", async () => {
		const f = fake({ finish: false });
		loseClaim(f);
		await f.run("retry", ref(ids.failed), "--no-wait");
		restore(f);
		f.opts.claimAnswer = "drop-unmade";
		expect((await f.run("retry", ref(ids.failed), "--no-wait")).json.error).toBe("SERVER_ERROR");
		f.opts.claimAnswer = undefined;
		const r = await f.run("retry", ref(ids.failed), "--no-wait");
		expect(r.code).toBe(0);
		expect(submits(f)).toHaveLength(1);
	});
	test("a claim that took, then the card was run from the page: not sent again", async () => {
		const f = fake({ finish: false, precharge: precharge(5) });
		loseClaim(f);
		await f.run("retry", ref(ids.failed), "--no-wait");
		restore(f);
		// The page's retry merges into the card's data (the mark stays) and is charged.
		Object.assign(f.rows.find((x) => x.id === ids.failed)!.data, { expired: false, error: null, refund_amount: null, value: "" });
		f.usage.unshift(precharge(5)("z-image-turbo"));
		const r = await f.run("retry", ref(ids.failed), "--no-wait");
		expect(r.json.error).toBe("BUSY");
		expect(submits(f)).toHaveLength(0);
	});
	test("a claim that took, then only the page's view changed the card: sent once it clearly never ran", async () => {
		const f = fake({ finish: false });
		loseClaim(f);
		await f.run("retry", ref(ids.failed), "--no-wait");
		restore(f);
		Object.assign(f.rows.find((x) => x.id === ids.failed)!.data, { title: "Renamed in the page" });
		expect((await f.run("retry", ref(ids.failed), "--no-wait")).json.error).toBe("BUSY");
		const file = sentFile(f, ids.failed);
		const sent = JSON.parse(readFileSync(file, "utf8"));
		writeFileSync(file, JSON.stringify({ ...sent, from: sent.from - 3_600_000, to: sent.to - 3_600_000 }));
		expect((await f.run("retry", ref(ids.failed), "--no-wait")).code).toBe(0);
		expect(submits(f)).toHaveLength(1);
	});
	test("`wait` on a card claimed but never sent says to retry it, without waiting", async () => {
		const f = fake({ finish: false });
		loseClaim(f);
		await f.run("retry", ref(ids.failed), "--no-wait");
		restore(f);
		const started = Date.now();
		const r = await f.run("wait", ref(ids.failed), "--timeout", "60");
		expect(Date.now() - started).toBeLessThan(10_000);
		expect(r.code).toBe(1);
		expect(r.json.cards[0].code).toBe("NOT_SENT");
		expect(r.json.next).toContain("retry");
	});
	test("an old card whose data is a JSON string is claimed by one machine only", async () => {
		const f = fake({ finish: false });
		const row = f.rows.find((x) => x.id === ids.failed)! as any;
		row.data = JSON.stringify(row.data);
		const other = f.newHome();
		const read = f.hold((m, u) => m === "GET" && !!u.searchParams.get("id")?.startsWith("in.("));
		const slow = f.runWith({ home: other }, "retry", ref(ids.failed), "--no-wait");
		await read.arrived;
		expect((await f.run("retry", ref(ids.failed), "--no-wait")).code).toBe(0);
		read.release();
		expect((await slow).json.error).toBe("BUSY");
		expect(submits(f)).toHaveLength(1);
	});
	test("a card too large to compare whole in a URL is still claimed (by its status and retry mark)", async () => {
		const f = fake({ finish: false });
		Object.assign(f.rows.find((x) => x.id === ids.failed)!.data, { notes: "字".repeat(6000) });
		expect((await f.run("retry", ref(ids.failed), "--no-wait")).code).toBe(0);
		const patchUrl = f.writes().find((w) => w.method === "PATCH")!.path;
		expect(patchUrl).not.toContain("&data=");
		expect(patchUrl).toContain("agentAttempt");
		expect(submits(f)).toHaveLength(1);
	});
	test("a canvas the user can't edit says so (not that another retry ran it)", async () => {
		const f = fake({ readOnly: true });
		const r = await f.run("retry", ref(ids.failed), "--no-wait");
		expect(r.json.error).toBe("FORBIDDEN");
		expect(submits(f)).toHaveLength(0);
		expect(existsSync(sentFile(f, ids.failed))).toBe(false);
	});
	test("a card deleted just before the claim isn't sent (or charged)", async () => {
		const f = fake();
		const read = f.hold((m, u) => m === "GET" && !!u.searchParams.get("id")?.startsWith("in.("));
		const run = f.run("retry", ref(ids.failed), "--no-wait");
		await read.arrived;
		(f.rows.find((x) => x.id === ids.failed) as any).is_delete = true;
		read.release();
		const r = await run;
		expect(r.json.error).toBe("NOT_FOUND");
		expect(r.json.message).toContain("no longer on the canvas");
		expect(submits(f)).toHaveLength(0);
	});
	test("a refused send marks its card only while it is still its own: another machine's claim is never undone", async () => {
		const f = fake({ submit: { status: 402, body: { error: "insufficient credits", reason: "insufficient_effective_balance" } } });
		const submit = f.hold((m, u) => m === "POST" && u.pathname === "/image_gen/async");
		const run = f.run("retry", ref(ids.failed), "--no-wait");
		await submit.arrived;
		const card = f.rows.find((x) => x.id === ids.failed)!;
		card.data = { ...card.data, status: "running", agentAttempt: "other-machine" };
		submit.release();
		await run;
		expect(card.data.agentAttempt).toBe("other-machine");
		expect(card.data.status).toBe("running");
		expect(card.type).toBe("2");
	});
	test("a refused retry still turns its card into the canvas's credits card", async () => {
		const f = fake({ submit: { status: 402, body: { error: "insufficient credits", reason: "insufficient_effective_balance" } } });
		await f.run("retry", ref(ids.failed), "--no-wait");
		expect(f.rows.find((x) => x.id === ids.failed)!.type).toBe("22");
	});
	const twoFailed = (f: ReturnType<typeof fake>) => {
		const second = "a7000000-0000-4000-8000-000000000008";
		const failedRow = f.rows.find((x) => x.id === ids.failed)!;
		f.rows.push({ ...structuredClone(failedRow), id: second, position: { x: 3000, y: 0 }, data: { ...structuredClone(failedRow.data), title: "Failed 2" } });
		return second;
	};
	test("in a batch, a card claimed elsewhere between the fresh read and the claim is left out; the others go", async () => {
		const f = fake({ finish: false });
		const second = twoFailed(f);
		const read = f.hold((m, u) => m === "GET" && !!u.searchParams.get("id")?.startsWith("in.("));
		const run = f.run("retry", "--no-wait");
		await read.arrived;
		Object.assign(f.rows.find((x) => x.id === second)!.data, { status: "running", agentAttempt: "another-machine" });
		read.release();
		const r = await run;
		expect(r.code).toBe(0);
		expect(submits(f).map((w) => (w.body as any).nodeId)).toEqual([ids.failed]);
		expect(JSON.stringify(r.json.notRetried)).toContain("changed since it was read");
	});
	test("in a batch, a card the user can't edit stops the rest, and what was sent is still reported", async () => {
		const f = fake({ finish: false });
		const second = twoFailed(f);
		f.opts.readOnlyIds = [second];
		const r = await f.run("retry", "--no-wait");
		expect(submits(f).map((w) => (w.body as any).nodeId)).toEqual([ids.failed]);
		expect(r.json.cards.map((c: any) => c.id)).toEqual([ids.failed]);
		expect(r.json.stopped.error).toBe("FORBIDDEN");
		expect(r.json.next).toContain("Stopped before the rest");
		expect(r.code).toBe(1);
	});
	test("in a batch, a card that changed meanwhile is left out and the others still go", async () => {
		const f = fake({ finish: false });
		const second = "a7000000-0000-4000-8000-000000000008";
		const failedRow = f.rows.find((x) => x.id === ids.failed)!;
		f.rows.push({ ...structuredClone(failedRow), id: second, position: { x: 3000, y: 0 }, data: { ...structuredClone(failedRow.data), title: "Failed 2" } });
		const read = f.hold((m, u) => m === "GET" && u.searchParams.has("conv_id"));
		const run = f.run("retry", "--no-wait");
		await read.arrived;
		// Run elsewhere while this command's read of the canvas was on its way.
		f.rows.find((x) => x.id === second)!.data.status = "running";
		read.release();
		const r = await run;
		expect(r.code).toBe(0);
		expect(submits(f).map((w) => (w.body as any).nodeId)).toEqual([ids.failed]);
		expect(JSON.stringify(r.json.notRetried)).toContain(ref(second));
	});
});

describe("data writes never undo a newer state", () => {
	test("ungroup refuses while a member is still generating (its result would be undone)", async () => {
		const f = fake();
		Object.assign(f.rows.find((x) => x.id === ids.running)!.data, { group_id: ids.group });
		const r = await f.run("ungroup", ref(ids.group));
		expect(r.json.error).toBe("BUSY");
		expect(f.writes()).toEqual([]);
	});
	test("an old card whose data is stored as a JSON string can still be renamed", async () => {
		const f = fake();
		const row = f.rows.find((x) => x.id === ids.image)! as any;
		row.data = JSON.stringify(row.data);
		const r = await f.run("rename", ref(ids.image), "Old card");
		expect(r.code).toBe(0);
	});
	test("rename of a card whose result came in meanwhile says so instead of writing over it", async () => {
		const f = fake();
		const read = f.hold((m, u) => m === "GET" && u.searchParams.has("conv_id"));
		const run = f.run("rename", ref(ids.failed), "New name");
		await read.arrived;
		Object.assign(f.rows.find((x) => x.id === ids.failed)!.data, { status: "finished", value: "https://cdn.test/late.png" });
		read.release();
		const r = await run;
		expect(r.json.error).toBe("BUSY");
		expect(f.rows.find((x) => x.id === ids.failed)!.data.value).toBe("https://cdn.test/late.png");
	});
});

describe("a long command keeps checking the sign-in", () => {
	test("a Disconnect during `wait` stops it within the check interval", async () => {
		const f = fake();
		const started = Date.now();
		const waiting = f.runWith({ env: { FLOWITH_SIGNIN_CHECK_MS: "300" } }, "wait", ref(ids.running), "--timeout", "30");
		await Bun.sleep(1_500);
		f.opts.userStatus = 403;
		const r = await waiting;
		expect(r.json.error).toBe("NOT_LOGGED_IN");
		expect(Date.now() - started).toBeLessThan(15_000);
	}, 20_000);
	test("a login to another account made meanwhile in another terminal stops it, never carried on as that account", async () => {
		const f = fake();
		const waiting = f.runWith({ env: { FLOWITH_SIGNIN_CHECK_MS: "300" } }, "wait", ref(ids.running), "--timeout", "30");
		await Bun.sleep(1_500);
		const file = join(f.home, "canvas-session.json");
		const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
		const other = `${b64({ alg: "HS256" })}.${b64({ sub: "99999999-9999-4999-8999-999999999999", exp: Math.floor(Date.now() / 1000) + 3600, session_id: "s-2" })}.sig`;
		writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), accessToken: other, refreshToken: "r9" }));
		const r = await waiting;
		expect(r.json.error).toBe("NOT_LOGGED_IN");
		expect(r.json.message).toContain("changed while this command ran");
	}, 20_000);
});

describe("a send whose answer is lost", () => {
	test.each(["drop", "reset"] as const)("(%s) leaves the card generating (never marked failed) and says so", async (submit) => {
		const f = fake({ submit, precharge: precharge(5) });
		const r = await f.run("image", "a cat", "--model", "z-image-turbo");
		expect(r.code).toBe(1);
		expect(f.writes().filter((w) => w.method === "PATCH")).toEqual([]);
		expect(r.json.cards[0].code).toBe("SENT_UNKNOWN");
		expect(r.json.next).toContain("may have taken it");
	});
	test("retry won't send it again: a charge shows it arrived", async () => {
		const f = fake({ submit: "drop", precharge: precharge(5) });
		const card = (await f.run("image", "a cat", "--model", "z-image-turbo")).json.cards[0].ref as string;
		const r = await f.run("retry", card, "--no-wait");
		expect(r.json.error).toBe("BUSY");
		expect(r.json.message).toContain("did reach Flowith");
		expect(f.writes().filter((w) => w.path.startsWith("/image_gen")).length).toBe(1);
	});
	test("retry won't send it again when the charge only shows up after the send gave up", async () => {
		const f = fake({ submit: "drop" });
		const card = (await f.run("video", "a cat walks", "--model", "seedance-2.5-flash")).json.cards[0].ref as string;
		// The provider took the job after the CLI stopped waiting: the worker charged it then.
		await Bun.sleep(4_000);
		f.usage.unshift(precharge(915)("seedance-2.5-flash"));
		const r = await f.run("retry", card, "--no-wait");
		expect(r.json.error).toBe("BUSY");
		expect(r.json.message).toContain("did reach Flowith");
		expect(f.writes().filter((w) => w.path.startsWith("/video/async")).length).toBe(1);
	});
	test("two retries of one card at once send it once", async () => {
		const f = fake();
		await Promise.all([f.run("retry", ref(ids.failed), "--no-wait"), f.run("retry", ref(ids.failed), "--no-wait")]);
		expect(f.writes().filter((w) => w.path.startsWith("/image_gen")).length).toBe(1);
	});
	test("retry sends a card named twice only once", async () => {
		const f = fake();
		await f.run("retry", ref(ids.failed), ids.failed, "--no-wait");
		expect(f.writes().filter((w) => w.path.startsWith("/image_gen")).length).toBe(1);
	});
	test("on a team canvas (charges out of sight) a lost send is never sent again", async () => {
		const f = fake({ submit: "drop", team: true });
		const card = (await f.run("image", "a cat", "--model", "z-image-turbo")).json.cards[0].id as string;
		const file = join(f.home, "sent", `${card}.json`);
		const sent = JSON.parse(readFileSync(file, "utf8"));
		writeFileSync(file, JSON.stringify({ ...sent, from: sent.from - 3_600_000, to: sent.to - 3_600_000 }));
		f.opts.submit = "ok";
		const r = await f.run("retry", card.slice(0, 8), "--no-wait");
		expect(r.json.message).toContain("team canvas");
		expect(f.writes().filter((w) => w.path.startsWith("/image_gen")).length).toBe(1);
	});
	test("retry waits while it may still be on its way", async () => {
		const f = fake({ submit: "drop" });
		const card = (await f.run("image", "a cat", "--model", "z-image-turbo")).json.cards[0].ref as string;
		const r = await f.run("retry", card, "--no-wait");
		expect(r.json.error).toBe("BUSY");
		expect(r.json.message).toContain("may still be on its way");
		expect(f.writes().filter((w) => w.path.startsWith("/image_gen")).length).toBe(1);
	});
	test("retry sends it again once it clearly never arrived", async () => {
		const f = fake({ submit: "drop" });
		const card = (await f.run("image", "a cat", "--model", "z-image-turbo")).json.cards[0].id as string;
		// Long past the time such a run takes, with no charge and the card still generating.
		const file = join(f.home, "sent", `${card}.json`);
		const sent = JSON.parse(readFileSync(file, "utf8"));
		writeFileSync(file, JSON.stringify({ ...sent, from: sent.from - 3_600_000, to: sent.to - 3_600_000 }));
		f.opts.submit = "ok";
		await f.run("retry", card.slice(0, 8), "--no-wait");
		expect(f.writes().filter((w) => w.path.startsWith("/image_gen")).length).toBe(2);
	});
});

describe("chargedCredits is this run's own charge, or unknown", () => {
	test("another model charged on the canvas meanwhile isn't counted", async () => {
		const f = fake({ precharge: precharge(5) });
		f.usage.push({ model: "muse-video", req_id: crypto.randomUUID(), tokens_used: 100_000, billing_unit_price: null, created_at: new Date().toISOString(), conv_id: CONV });
		const r = await f.run("image", "a cat", "--model", "z-image-turbo");
		expect(r.json.chargedCredits).toBe(5);
	});
	test("a refund under the same attempt is included", async () => {
		const f = fake({
			precharge: (model) => {
				const p = precharge(5)(model);
				f.usage.unshift({ ...p, tokens_used: -5000, reason: "refund" });
				return p;
			},
		});
		const r = await f.run("image", "a cat", "--model", "z-image-turbo");
		expect(r.json.chargedCredits).toBe(0);
	});
	test("two charges of the same model at that moment: unknown, not guessed", async () => {
		const f = fake({
			precharge: (model) => {
				f.usage.unshift(precharge(7)(model));
				return precharge(5)(model);
			},
		});
		const r = await f.run("image", "a cat", "--model", "z-image-turbo");
		expect(r.json.chargedCredits).toBeNull();
		expect(r.json.chargedNote).toContain("Unknown");
	});
	test("on a team canvas the charge is unknown (the payer is charged)", async () => {
		const f = fake({ team: true, precharge: precharge(5) });
		const r = await f.run("image", "a cat", "--model", "z-image-turbo");
		expect(r.json.chargedCredits).toBeNull();
		expect(r.json.chargedNote).toContain("team");
	});
	test("a batch is tied to its own charges", async () => {
		const f = fake({ precharge: precharge(5) });
		const r = await f.run("image", "a cat", "a dog", "a fox", "--model", "z-image-turbo");
		expect(r.json.chargedCredits).toBe(15);
	});
	test("`wait` in a later run reports the charge made when the card was sent", async () => {
		const f = fake({ precharge: precharge(5) });
		const sent = await f.run("image", "a cat", "--model", "z-image-turbo", "--no-wait");
		const r = await f.run("wait", sent.json.cards[0].ref);
		expect(r.json.chargedCredits).toBe(5);
	});
});

describe("signing out", () => {
	test("logout ends the CLI's own sign-in through the worker and forgets it", async () => {
		const f = fake();
		writeFileSync(join(f.home, "bot-session.json"), "{}");
		const r = await f.run("logout");
		expect(r.json.signInEnded).toBe(true);
		expect(r.json.removedOldLogin).toBeTruthy();
		expect(f.requests.some((q) => q.method === "POST" && q.path === "/user/agent-session/end")).toBe(true);
		expect(existsSync(join(f.home, "canvas-session.json"))).toBe(false);
	});
	test("a login the worker doesn't know as an agent's is only forgotten (never the browser signed out)", async () => {
		const f = fake({ agentSession: false });
		const r = await f.run("logout");
		expect(r.json.signInEnded).toBe(false);
		expect(r.json.note).toContain("only forgotten");
		expect(f.requests.some((q) => q.path.startsWith("/auth/v1/logout"))).toBe(false);
	});
	test("when Flowith can't be reached, nothing is forgotten and it says so", async () => {
		const f = fake();
		f.stop();
		const r = await f.run("logout");
		expect(r.json.signInEnded).toBe(false);
		expect(r.code).toBe(1);
		expect(existsSync(join(f.home, "canvas-session.json"))).toBe(true);
	});
	test("a sign-in ended in Flowith (Disconnect) stops the next command", async () => {
		const f = fake({ userStatus: 403 });
		const r = await f.run("look");
		expect(r.json.error).toBe("NOT_LOGGED_IN");
		expect(f.requests.some((q) => q.path.startsWith("/rest/v1/flow_node"))).toBe(false);
	});
});
