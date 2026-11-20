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

describe("a multi-stage canvas workflow", () => {
	test("starts on an empty canvas and preserves references through notes, frames, edits and clips", async () => {
		const f = fake({ team: true });
		f.rows.length = 0;
		const created = await f.run("new", "Rainy Café");
		const url = created.json.url;
		expect(created.json.title).toBe("Rainy Café");
		expect((await f.run("look", "--canvas", url)).json.cards).toEqual([]);
		const note = (await f.run("note", "A yellow cup. Blue-hour rain. Three shots.", "--title", "Creative brief", "--canvas", url)).json.cards[0];
		const plan = (await f.run("text", "Write a shot list", "--ref", note.ref, "--title", "Shot list", "--timeout", "1")).json.cards[0];
		expect(plan.text).toBe("an answer");
		const hero = (await f.run("image", "Yellow cup on a rainy window ledge", "--title", "Hero", "--timeout", "1")).json.cards[0];
		const frames = (await f.run("image", "Wide shot of @image1", "Close-up of @image1", "--ref", hero.ref, "--group", "Storyboard", "--timeout", "1")).json;
		expect(frames.cards.map((card: { status: string }) => card.status)).toEqual(["finished", "finished"]);
		const edit = (await f.run("edit", frames.cards[1].ref, "Keep the cup; soften the reflections", "--timeout", "1")).json.cards[0];
		const video = (await f.run("video", "Slow push-in", "--first", edit.ref, "--timeout", "1")).json.cards[0];
		expect(video.status).toBe("finished");
		const all = (await f.run("look")).json.cards;
		const byId = new Map<string, { references?: string[]; madeFrom?: string[]; title?: string }>(all.map((card: { id: string }) => [card.id, card]));
		expect(byId.get(plan.id)?.references).toEqual([note.id]);
		expect(byId.get(frames.cards[0].id)?.references).toEqual([hero.id]);
		expect(byId.get(edit.id)?.madeFrom).toEqual([frames.cards[1].id]);
		expect(byId.get(video.id)?.madeFrom).toEqual([edit.id]);
		expect((await f.run("look", "Storyboard")).json.cards.map((card: { ref: string }) => card.ref)).toEqual([frames.group, ...frames.cards.map((card: { ref: string }) => card.ref)]);
		expect((await f.run("look", "--kind", "group")).json.cards.map((card: { ref: string }) => card.ref)).toEqual([frames.group]);
		expect((await f.run("look", "--kind", "group", "--by", "claude-code")).json.cards.map((card: { ref: string }) => card.ref)).toEqual([frames.group]);
	}, 10_000);

	test("finds cards beyond the first page", async () => {
		const f = fake();
		const sample = f.rows[0]!;
		for (let i = 0; i < 510; i++) f.rows.push({ ...sample, id: crypto.randomUUID(), data: { name: `Board ${i}` } });
		const result = await f.run("look", "Board 509", "--kind", "group");
		expect(result.json.cards.map((card: { title: string }) => card.title)).toEqual(["Board 509"]);
	});

	test("rejects a link to a different environment and unsupported flags before writes", async () => {
		const f = fake();
		const wrongSite = `https://beta.flowith.io/conv/${CONV}`;
		expect((await f.run("note", "planned note", "--canvas", wrongSite)).json.error).toBe("CANVAS_SITE_MISMATCH");
		expect((await f.run("image", "cup", "--ration", "16:9")).json.message).toContain("does not accept --ration");
		expect((await f.run("video", "cup", "--duration")).json.message).toContain("--duration requires a value");
		expect(f.writes()).toEqual([]);
	});

	test("reports a deleted card while waiting, including when no cards remain", async () => {
		const f = fake({ afterNodeRead: async () => { Object.assign(f.rows.find((row) => row.id === ids.running)!, { is_delete: true }); } });
		const result = await f.run("wait", ref(ids.running), "--timeout", "1");
		expect(result.code).toBe(1);
		expect(result.json.cards[0]).toMatchObject({ id: ids.running, status: "removed" });
	});
});

describe("working with the open canvas", () => {
	test("login opens the canvas app and keeps consent instructions visible in JSON mode", async () => {
		const f = fake();
		const proc = Bun.spawn(["bun", join(import.meta.dir, "..", "index.ts"), "login", "--site", f.origin, "--no-open", "--json", "--quiet"], {
			env: { ...process.env, FLOWITH_HOME: f.home, FLOWITH_SUPABASE_URL: f.origin, FLOWITH_SUPABASE_KEY: "k" },
			stdout: "pipe", stderr: "pipe",
		});
		try {
			const reader = proc.stderr.pipeThrough(new TextDecoderStream()).getReader();
			let instructions = "";
			let link: string | undefined;
			while (!link) {
				const next = await reader.read();
				if (next.done) throw new Error("Login exited before showing consent instructions.");
				instructions += next.value;
				link = instructions.split("\n").slice(0, -1).find((line) => line.startsWith(`${f.origin}/`));
			}
			const url = new URL(link);
			expect(url.pathname).toBe("/blank");
			expect(instructions).toContain("type this code");
			// Exercise the login receipt without creating a live account session.
			const socket = new WebSocket(`ws://127.0.0.1:${url.searchParams.get("cli_port")}`);
			const session = JSON.parse(readFileSync(join(f.home, "canvas-session.json"), "utf8"));
			await new Promise<void>((resolve, reject) => {
				socket.onerror = () => reject(new Error("The local test login socket failed."));
				socket.onopen = () => socket.send(JSON.stringify({ type: "session", data: { ...session, nonce: url.searchParams.get("cli_nonce") } }));
				socket.onmessage = () => { socket.close(); resolve(); };
			});
			expect(JSON.parse(await new Response(proc.stdout).text())).toMatchObject({ loggedIn: true, site: f.origin });
			expect(await proc.exited).toBe(0);
		} finally {
			if (proc.exitCode === null) proc.kill();
		}
	});

	test("reads the user's selection and focuses the same cards by ref", async () => {
		const received: Record<string, unknown>[] = [];
		const f = fake({ browser: (command) => {
			received.push(command);
			return { ack: true, result: command.operation === "getCanvasLayout"
				? { ok: true, layout: { nodes: [{ id: ids.image, selected: true }, { id: ids.text, selected: false }, { id: ids.video, selected: true, hidden: true }] } }
				: { ok: true, nodeIds: command.nodeIds } };
		} });
		const selected = (await f.run("selection")).json.cards;
		expect(selected).toEqual([{ id: ids.image, ref: ref(ids.image), title: "Cat", kind: "image", status: "finished" }]);
		const focused = (await f.run("focus", selected[0].ref)).json;
		expect(focused.cards[0]).toMatchObject({ ref: ref(ids.image), status: "finished" });
		expect(received[1]).toMatchObject({ operation: "focusCanvasNodes", conversationId: CONV, nodeIds: [ids.image] });
		expect(f.writes()).toEqual([]);
	});

	test("distinguishes an unanswered operation from one the browser acknowledged", async () => {
		const closed = await fake().run("focus", ref(ids.image), "--timeout", "0.2");
		const open = await fake({ browser: () => ({ ack: true }) }).run("focus", ref(ids.image), "--timeout", "0.2");
		expect(closed.json).toMatchObject({ error: "CANVAS_NOT_OPEN", data: { acknowledged: false } });
		expect(open.json).toMatchObject({ error: "TIMEOUT", data: { acknowledged: true, operation: "focusCanvasNodes" } });
	});

	test("preserves the command scope when passing a raw operation payload", async () => {
		const f = fake({ browser: (command) => ({ result: { ok: true, observed: command.conversationId } }) });
		const result = await f.run("do", "getCanvasLayout", "--input", '{"conversationId":"another-canvas","operationId":"another-operation"}');
		expect(result.json.observed).toBe(CONV);
		expect(result.json.operationId).not.toBe("another-operation");
	});
});

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
		expect((await f.run("retry", ref(ids.failed), "--no-wait")).json.error).toBe("BUSY");
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
		expect((await f.run("retry", ref(ids.failed), "--no-wait")).json.error).toBe("SENT_UNKNOWN");
		expect(f.writes().filter((w) => w.path.startsWith("/image_gen/async"))).toHaveLength(0);
		const file = join(f.home, "sent", `${ids.failed}.json`);
		const sent = JSON.parse(readFileSync(file, "utf8"));
		expect(sent.answer).toBe("lost");
		writeFileSync(file, JSON.stringify({ ...sent, from: sent.from - 3_600_000, to: sent.to - 3_600_000 }));
		delete f.opts.beforeNodePatch;
		delete f.opts.nodeReadStatus;
		delete f.opts.dropPatchReply;
		expect((await f.run("retry", ref(ids.failed), "--no-wait")).code).toBe(0);
		expect(f.writes().filter((w) => w.path.startsWith("/image_gen/async"))).toHaveLength(1);
	});

	test("a batch is revalidated before any card is submitted", async () => {
		const f = fake();
		const second = structuredClone(f.rows.find((r) => r.id === ids.failed)!);
		second.id = "b3000000-0000-4000-8000-000000000004";
		f.rows.push(second);
		let first = true;
		f.opts.afterNodeRead = async () => {
			if (first) { first = false; second.data.status = "running"; }
		};
		expect((await f.run("retry", ref(ids.failed), ref(second.id), "--no-wait")).json.error).toBe("BUSY");
		expect(f.writes()).toHaveLength(0);
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
