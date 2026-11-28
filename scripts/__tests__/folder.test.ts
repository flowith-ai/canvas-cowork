/**
 * `sync <dir>`, the canvas folder on this computer (Flowith Next): the real CLI against the stand-in folder
 * (fake-folder.ts). What changes here goes back as a version named after the agent; others' versions come down; a real
 * conflict keeps both copies; a never-synced directory is not merged blind; flowith.io is refused before anything is sent.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { type FolderState, folderAgent, folderHostAllowed, pull, push, readState, STATE_FILE, syncRound } from "../lib/folder.ts";
import { fakeFlowith } from "./fake-flowith.ts";

const fakes: Array<{ stop: () => void }> = [];
const fake = () => {
	const f = fakeFlowith();
	fakes.push(f);
	return f;
};
afterAll(() => fakes.forEach((f) => f.stop()));

const directory = () => join(mkdtempSync(join(tmpdir(), "cw-folder-")), "canvas");
const read = (dir: string, path: string) => readFileSync(join(dir, path), "utf8");
const write = (dir: string, path: string, text: string) => {
	mkdirSync(join(dir, path, ".."), { recursive: true });
	writeFileSync(join(dir, path), text);
};

describe("sync <dir>", () => {
	test("takes the folder's files, hands back what changed here as a version of its own, and takes others' versions", async () => {
		const f = fake();
		f.folder.write({ "brief.md": "Lemon soda\n", "shots/1.md": "Dawn\n" });
		const dir = directory();

		const first = await f.run("sync", dir);
		expect(first.code).toBe(0);
		expect(first.json).toMatchObject({ seq: 1, handedBack: 0, took: ["brief.md", "shots/1.md"], removed: [] });
		expect(read(dir, "shots/1.md")).toBe("Dawn\n");
		expect(readState(dir)).toMatchObject({ seq: 1, canvasId: first.json.canvas });

		// Changed, added and deleted here: one version, by this computer's agent, made on v1.
		write(dir, "brief.md", "Lemon soda, summer\n");
		write(dir, "notes/plan.md", "Three shots\n");
		unlinkSync(join(dir, "shots/1.md"));
		const second = await f.run("sync", dir);
		expect(second.json).toMatchObject({ from: 1, seq: 2, handedBack: 3, took: [], removed: [] });
		expect(f.folder.commits.at(-1)).toMatchObject({ base: 1, agent: "claude-code" });
		expect(f.folder.versions.at(-1)!.agent).toBe("claude-code");
		expect(f.folder.text("brief.md")).toBe("Lemon soda, summer\n");
		expect(f.folder.text("shots/1.md")).toBeUndefined();

		// Flo writes in the folder: the next round brings it here, and hands nothing back.
		f.folder.write({ "notes/flo.md": "From Flo\n", "notes/plan.md": "Four shots\n" });
		const third = await f.run("sync", dir);
		expect(third.json).toMatchObject({ from: 2, seq: 3, handedBack: 0 });
		expect(third.json.took.sort()).toEqual(["notes/flo.md", "notes/plan.md"]);
		expect(read(dir, "notes/plan.md")).toBe("Four shots\n");
		// Only this computer's commit came over the API.
		expect(f.folder.commits).toHaveLength(1);

		// Nothing new anywhere: nothing goes up.
		const fourth = await f.run("sync", dir);
		expect(fourth.json).toMatchObject({ seq: 3, handedBack: 0, took: [], removed: [] });
		expect(f.folder.commits).toHaveLength(1);
	});

	test("keeps both copies of a real conflict: the folder's newest at the path, this computer's beside it, both here", async () => {
		const f = fake();
		f.folder.write({ "brief.md": "Lemon soda\n" });
		const dir = directory();
		await f.run("sync", dir);
		f.folder.write({ "brief.md": "Lemon soda, by Flo\n" });
		write(dir, "brief.md", "Lemon soda, by me\n");

		const round = await f.run("sync", dir);
		expect(round.json).toMatchObject({ from: 1, seq: 3, handedBack: 1, merged: true, conflicts: [{ path: "brief.md", keptAs: "brief (Claude Code).md" }] });
		expect(round.json.next).toContain("Compare them, keep one");
		expect(read(dir, "brief.md")).toBe("Lemon soda, by Flo\n");
		expect(read(dir, "brief (Claude Code).md")).toBe("Lemon soda, by me\n");
		// What went up came back as the folder has it: nothing to hand back again.
		const again = await f.run("sync", dir);
		expect(again.json).toMatchObject({ seq: 3, handedBack: 0 });
	});

	test("hands a directory's files up as the first version of an empty folder, but never merges a never-synced one blind", async () => {
		const f = fake();
		const dir = directory();
		write(dir, "index.html", "<h1>Hi</h1>\n");
		const first = await f.run("sync", dir);
		expect(first.json).toMatchObject({ from: null, seq: 1, handedBack: 1 });
		expect(f.folder.text("index.html")).toBe("<h1>Hi</h1>\n");

		const other = directory();
		write(other, "index.html", "<h1>Other</h1>\n");
		const refused = await f.run("sync", other);
		expect(refused).toMatchObject({ code: 1, json: { error: "FOLDER_NOT_EMPTY" } });
		expect(f.folder.commits).toHaveLength(1);
	});

	test("--dry-run says what a round would hand back and take, and sends nothing", async () => {
		const f = fake();
		f.folder.write({ "a.md": "a\n" });
		const dir = directory();
		await f.run("sync", dir);
		f.folder.write({ "b.md": "b\n" });
		write(dir, "a.md", "changed\n");
		const writes = f.writes().length;
		const dry = await f.run("sync", dir, "--dry-run");
		expect(dry.json).toMatchObject({ seq: 1, head: 2, toHandBack: { changed: ["a.md"], deleted: [] }, toTake: true, agent: "claude-code", dryRun: true });
		expect(f.writes().length).toBe(writes);
		expect(read(dir, "a.md")).toBe("changed\n");
		expect(existsSync(join(dir, "b.md"))).toBe(false);
	});

	test("is refused on flowith.io before anything is sent, and a directory of one canvas never takes another's", async () => {
		const f = fake();
		const session = JSON.parse(readFileSync(join(f.home, "canvas-session.json"), "utf8"));
		const prod = f.newHome();
		writeFileSync(join(prod, "canvas-session.json"), JSON.stringify({ ...session, workerURL: "https://edge.flowith.io" }), { mode: 0o600 });
		const dir = directory();
		const before = f.requests.length;
		const refused = await f.runFrom(prod, "sync", dir);
		expect(refused).toMatchObject({ code: 1, json: { error: "NEXT_GEN_ONLY" } });
		expect(f.requests.slice(before).filter((r) => !r.path.startsWith("/auth/v1/"))).toEqual([]);
		expect(existsSync(dir)).toBe(false);

		await f.run("sync", dir);
		const state = readState(dir)!;
		writeFileSync(join(dir, STATE_FILE), JSON.stringify({ ...state, canvasId: "99999999-9999-4999-8999-999999999999" }));
		expect(await f.run("sync", dir)).toMatchObject({ code: 1, json: { error: "FOLDER_CANVAS_MISMATCH" } });
		rmSync(dir, { recursive: true });
	});
});

describe("a round", () => {
	test("a file changed here while the round took the folder's latest goes up next on the version it was changed from", async () => {
		const f = fake();
		f.folder.write({ "brief.md": "one\ntwo\n" });
		const api = { workerURL: f.origin, accessToken: "token" };
		const dir = directory();
		mkdirSync(dir, { recursive: true });
		const start: FolderState = { v: 1, workerURL: f.origin, canvasId: "22222222-2222-4222-8222-222222222222", seq: null, files: {}, syncedAt: "" };
		const { state: inStep } = await syncRound(api, dir, start, { agent: "codex" });
		expect(inStep.seq).toBe(1);

		// Flo changes it; it changes here too after this round's hand-back looked (nothing then), before the folder came down.
		f.folder.write({ "brief.md": "one\ntwo\nthree, by Flo\n" });
		write(dir, "brief.md", "ONE\ntwo\n");
		const { state: after, pulled } = await pull(api, dir, inStep, 2, inStep);
		expect(pulled.kept).toEqual(["brief.md"]);
		expect(read(dir, "brief.md")).toBe("ONE\ntwo\n");
		expect(after).toMatchObject({ seq: 2, stale: { "brief.md": 1 } });

		// Made from v1, so it goes up on v1: the folder merges it with Flo's change instead of taking it over it.
		await push(api, dir, after, { agent: "codex" });
		expect(f.folder.commits.at(-1)).toMatchObject({ base: 1, agent: "codex", changes: [{ path: "brief.md" }] });
	});

	test("names this computer's agent as the folder records authors, and knows Flowith Next's workers", () => {
		expect(folderAgent("claude-code")).toBe("claude-code");
		expect(folderAgent("My Agent")).toBe("my-agent");
		expect(folderAgent("—")).toBe("local");
		expect(folderHostAllowed("https://dev-edge.flowith.io")).toBe(true);
		expect(folderHostAllowed("https://feat-x-main-worker.dev-9b6.workers.dev")).toBe(true);
		expect(folderHostAllowed("https://edge.flowith.io")).toBe(false);
		expect(folderHostAllowed("https://main-worker.dev-9b6.workers.dev")).toBe(false);
	});
});
