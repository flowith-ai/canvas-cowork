#!/usr/bin/env bun
/**
 * canvas-cowork — work on a Flowith 3.0 canvas from Claude Code, Codex or any agent with a shell.
 *
 * Every command acts on the user's canvas the way their own hands (or the in-app Creator Agent,
 * Flo) would: cards are placed where Flo places them, generations go through the canvas's own
 * routes and pricing, and an open canvas shows each card arrive live. Zero dependencies; Bun.
 *
 *   bun scripts/index.ts <command> [args] [--flags]      (`help` lists everything)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import {
	type Catalog,
	type Kind,
	AUDIO_MODELS,
	defaultModel,
	estimateCredits,
	fetchCatalog,
	modelLine,
	modelsOf,
	resolveModel,
} from "./lib/catalog";
import {
	type Card,
	canvasUrl,
	cardsFrom,
	createCanvas,
	fetchRowsById,
	findCard,
	getCanvas,
	listCanvases,
	readCanvas,
	resolveCanvas,
} from "./lib/desk";
import {
	type ImageJob,
	type Ref,
	type Result,
	type TextJob,
	type VideoJob,
	failCard,
	hasHan,
	imageCardData,
	imageRequest,
	resultOf,
	send,
	textCardData,
	textRequest,
	titleFrom,
	videoCardData,
	videoRequest,
	waitFor,
} from "./lib/generate";
import { type Api, CliError, worker } from "./lib/http";
import { download, fileFor, isUrl, mediaOf, toUrl } from "./lib/media";
import {
	type Session,
	activeSession,
	apiOf,
	forgetSession,
	jwtClaims,
	login,
	openUrl,
	saveSession,
	userIdOf,
} from "./lib/session";
import { cutout, expand, makeSound, upscaleImage, upscaleVideo } from "./lib/tools";
import {
	type Layout,
	type NewCard,
	arrangePoints,
	cardSize,
	deleteCards,
	groupCards,
	link,
	moveTo,
	nearestFree,
	obstaclesOf,
	patch,
	placeCards,
	rename,
	ungroup,
} from "./lib/write";
import { CANVAS_NODE_GAP, groupLayout, isClear, placeSingle } from "./lib/placement";

// ---------- args ----------

const BOOLEAN_FLAGS = new Set([
	"json", "quiet", "no-wait", "wait", "all", "full", "fresh", "dry-run", "no-audio", "audio", "draft",
	"transparent", "no-open", "instrumental", "remove", "help",
]);

interface Args {
	cmd: string;
	pos: string[];
	flags: Map<string, string[]>;
}

function parseArgs(argv: string[]): Args {
	const pos: string[] = [];
	const flags = new Map<string, string[]>();
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]!;
		if (a === "--") {
			pos.push(...argv.slice(i + 1));
			break;
		}
		if (a.startsWith("--")) {
			const eq = a.indexOf("=");
			const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
			let value: string;
			if (eq > 0) value = a.slice(eq + 1);
			else if (BOOLEAN_FLAGS.has(name) || i + 1 >= argv.length || argv[i + 1]!.startsWith("--")) value = "true";
			else value = argv[++i]!;
			flags.set(name, [...(flags.get(name) ?? []), value]);
		} else pos.push(a);
	}
	return { cmd: pos.shift() ?? "help", pos, flags };
}

const flag = (a: Args, name: string) => a.flags.get(name)?.at(-1);
const flags = (a: Args, name: string) => (a.flags.get(name) ?? []).flatMap((v) => v.split(",").map((s) => s.trim()).filter(Boolean));
const has = (a: Args, name: string) => a.flags.has(name) && flag(a, name) !== "false";
const num = (a: Args, name: string) => {
	const v = flag(a, name);
	if (v === undefined) return undefined;
	const n = Number(v);
	if (!Number.isFinite(n)) throw new CliError(`--${name} takes a number.`, "INVALID_PARAM");
	return n;
};

// ---------- output ----------

let quiet = false;
let jsonOut = false;
const log = (m: string) => {
	if (!quiet) process.stderr.write(`${m}\n`);
};
const out = (data: unknown) => process.stdout.write(`${JSON.stringify(data, null, jsonOut ? 0 : 2)}\n`);

/** Which agent writes: shown on the canvas's change feed and on the connect page. */
function agentName(a: Args): string {
	const named = flag(a, "as") ?? flag(a, "bot") ?? process.env.FLOWITH_AGENT;
	if (named) return named;
	const e = process.env;
	if (e.CLAUDECODE || e.CLAUDE_CODE_ENTRYPOINT) return "claude-code";
	if (e.CODEX_HOME || e.CODEX_SANDBOX || e.CODEX_MANAGED_BY_NPM || e.CODEX_CI) return "codex";
	if (e.CURSOR_AGENT || e.CURSOR_TRACE_ID) return "cursor";
	if (e.OPENCODE) return "opencode";
	if (e.OPENCLAW) return "openclaw";
	return "other";
}

// ---------- context ----------

interface Ctx {
	session: Session;
	api: Api;
	userId: string;
	site: string;
}

async function context(a: Args): Promise<Ctx> {
	const session = await activeSession();
	return { session, api: apiOf(session, agentName(a)), userId: userIdOf(session), site: session.site };
}

/** The canvas a command works on: --canvas, $FLOWITH_CANVAS, or the active one. */
async function canvasOf(ctx: Ctx, a: Args, opts: { create?: string } = {}): Promise<{ id: string; title: string | null; created?: boolean }> {
	const ref = flag(a, "canvas") ?? process.env.FLOWITH_CANVAS;
	if (ref) {
		const c = await resolveCanvas(ctx.api, ctx.userId, ref);
		return { id: c.id, title: c.title };
	}
	if (ctx.session.canvas) {
		try {
			const c = await getCanvas(ctx.api, ctx.session.canvas);
			return { id: c.id, title: c.title };
		} catch (e) {
			if (!(e instanceof CliError && e.code === "NOT_FOUND")) throw e;
		}
	}
	if (opts.create !== undefined) {
		const c = await createCanvas(ctx.api, ctx.userId, opts.create || "Untitled");
		ctx.session.canvas = c.id;
		saveSession(ctx.session);
		log(`New canvas "${c.title}": ${canvasUrl(ctx.site, c.id)}`);
		return { id: c.id, title: c.title, created: true };
	}
	throw new CliError("No canvas chosen. `use <canvas>` an existing one, or `new \"title\"` to start one.", "NO_CANVAS");
}

async function catalogOf(ctx: Ctx, fresh = false): Promise<Catalog> {
	return fetchCatalog(ctx.session.workerURL, { fresh });
}

/** --ref / --first values: a card ref on this canvas, a local file or a URL. */
async function toRef(ctx: Ctx, convId: string, cards: Card[], input: string): Promise<Ref> {
	if (!isUrl(input) && !existsSync(resolve(input))) {
		const card = findCard(cards, input);
		if (!card.url) throw new CliError(`${card.ref} (${card.kind}) has no finished media to use yet.`, "INVALID_PARAM");
		const media = card.kind === "image" || card.kind === "video" || card.kind === "audio" ? card.kind : mediaOf(card.url);
		return { url: card.url, name: card.title ?? card.ref, media, card };
	}
	const up = await toUrl(ctx.api, input, convId);
	if (!isUrl(input)) log(`Uploaded ${up.name}`);
	return up;
}

async function toRefs(ctx: Ctx, convId: string, cards: Card[], inputs: string[]) {
	const refs: Ref[] = [];
	for (const i of inputs) refs.push(await toRef(ctx, convId, cards, i));
	return refs;
}

const timeoutOf = (a: Args, fallbackSec: number) => (num(a, "timeout") ?? fallbackSec) * 1000;

function finish(ctx: Ctx, convId: string, results: Result[], extra: Record<string, unknown> = {}) {
	const failed = results.filter((r) => r.status === "failed");
	const running = results.filter((r) => r.status === "running");
	out({
		canvas: convId,
		url: canvasUrl(ctx.site, convId),
		...extra,
		cards: results,
		...(running.length ? { next: `Still generating: run \`wait ${running.map((r) => r.ref).join(" ")}\` later.` } : {}),
	});
	if (failed.length === results.length && results.length) process.exitCode = 1;
}

async function waitAndReport(ctx: Ctx, a: Args, convId: string, ids: string[], fallbackSec: number, extra: Record<string, unknown> = {}) {
	if (has(a, "no-wait")) {
		const rows = await fetchRowsById(ctx.api, ids);
		finish(ctx, convId, cardsFrom(rows).map(resultOf), extra);
		return;
	}
	let last = -1;
	const results = await waitFor(ctx.api, ids, {
		timeoutMs: timeoutOf(a, fallbackSec),
		onTick: (done, total) => {
			if (done !== last) log(`${done}/${total} done`);
			last = done;
		},
	});
	finish(ctx, convId, results, extra);
}

// ---------- commands: session ----------

async function cmdLogin(a: Args) {
	const s = await login(agentName(a), log, { open: !has(a, "no-open") });
	const claims = jwtClaims(s.accessToken);
	out({ loggedIn: true, email: claims.email, site: s.site, worker: s.workerURL, canvas: s.canvas ?? null });
}

async function cmdWhoami(a: Args) {
	const ctx = await context(a);
	const claims = jwtClaims(ctx.session.accessToken);
	out({
		email: claims.email,
		userId: ctx.userId,
		site: ctx.site,
		worker: ctx.session.workerURL,
		agent: ctx.api.agent,
		canvas: ctx.session.canvas ? canvasUrl(ctx.site, ctx.session.canvas) : null,
		sessionExpires: claims.exp ? new Date(claims.exp * 1000).toISOString() : null,
		renews: Boolean(ctx.session.refreshToken),
	});
}

async function cmdCredits(a: Args) {
	const ctx = await context(a);
	const rows = await worker<Array<Record<string, any>>>(ctx.api, "/user/credits");
	const live = (rows ?? []).filter((r) => !r.canceled && (!r.to_date || new Date(r.to_date) > new Date()));
	const total = live.reduce((s, r) => s + Math.max(0, Number(r.remain_quota) || 0), 0);
	out({
		credits: Math.round(total * 100) / 100,
		note: "1 credit = $0.001. Some grants only cover certain model tiers.",
		grants: live
			.filter((r) => Number(r.remain_quota) > 0)
			.map((r) => ({ kind: r.sub_type, left: r.remain_quota, until: r.to_date?.slice(0, 10), ...(r.policy_summary ? { limits: r.policy_summary } : {}) })),
	});
}

// ---------- commands: canvases ----------

async function cmdCanvases(a: Args) {
	const ctx = await context(a);
	const list = await listCanvases(ctx.api, ctx.userId, a.pos.join(" ") || undefined, num(a, "limit") ?? 20);
	if (jsonOut) return out(list.map((c) => ({ id: c.id, title: c.title, updated: c.updated_at, url: canvasUrl(ctx.site, c.id) })));
	const active = ctx.session.canvas;
	for (const c of list)
		console.log(`${c.id === active ? "*" : " "} ${c.id.slice(0, 8)}  ${c.updated_at.slice(0, 16).replace("T", " ")}  ${c.title ?? "(untitled)"}`);
	if (!list.length) console.log("No canvases.");
}

async function cmdNew(a: Args) {
	const ctx = await context(a);
	const title = a.pos.join(" ").trim() || "Untitled";
	const c = await createCanvas(ctx.api, ctx.userId, title);
	ctx.session.canvas = c.id;
	saveSession(ctx.session);
	const url = canvasUrl(ctx.site, c.id);
	if (has(a, "open")) openUrl(url);
	out({ canvas: c.id, title: c.title, url, active: true });
}

async function cmdUse(a: Args) {
	const ctx = await context(a);
	const ref = a.pos.join(" ").trim();
	if (!ref) throw new CliError("use <canvas id, prefix, title or URL>", "INVALID_PARAM");
	const id = ref.match(/\/conv\/([0-9a-f-]{36})/i)?.[1] ?? ref;
	const c = await resolveCanvas(ctx.api, ctx.userId, id);
	ctx.session.canvas = c.id;
	saveSession(ctx.session);
	out({ canvas: c.id, title: c.title, url: canvasUrl(ctx.site, c.id), active: true });
}

async function cmdOpen(a: Args) {
	const ctx = await context(a);
	const c = await canvasOf(ctx, a);
	const url = canvasUrl(ctx.site, c.id);
	openUrl(url);
	out({ opened: url });
}

// ---------- commands: seeing ----------

const STATUS_MARK: Record<string, string> = { finished: "✓", failed: "✗", running: "…", init: "…" };

function cardLine(c: Card, byId: Map<string, Card>, indent: string): string {
	const short = (id: string) => byId.get(id)?.ref ?? id.slice(0, 8);
	const bits: string[] = [`${indent}${c.kind.padEnd(6)} ${c.ref}`];
	if (c.title) bits.push(`"${c.title.length > 40 ? `${c.title.slice(0, 39)}…` : c.title}"`);
	if (c.model) bits.push(c.model);
	if (c.ratio && (c.kind === "image" || c.kind === "video")) bits.push(c.ratio);
	if (c.status && c.kind !== "group") bits.push(STATUS_MARK[c.status] ?? c.status);
	if (c.type === "22") bits.push("✗ no credits");
	if (c.type === "25") bits.push("✗ needs a higher plan");
	bits.push(`@${c.rect.x},${c.rect.y} ${c.rect.width}×${c.rect.height}`);
	const from = [...(c.madeFrom ?? []), ...(c.references ?? []), ...(c.follows ? [c.follows] : [])];
	if (from.length) bits.push(`← ${[...new Set(from)].map(short).join(",")}`);
	if (c.placedBy === "flo") bits.push("(Flo)");
	const gist = (c.kind === "image" || c.kind === "video" || c.kind === "audio" ? c.prompt : c.text)?.replace(/\s+/g, " ").trim();
	return `${bits.join("  ")}${gist ? `\n${indent}       ${gist.length > 110 ? `${gist.slice(0, 109)}…` : gist}` : ""}${c.status === "failed" && c.error ? `\n${indent}       error: ${c.error.slice(0, 160)}` : ""}`;
}

async function cmdLook(a: Args) {
	const ctx = await context(a);
	const canvas = await canvasOf(ctx, a);
	const all = await readCanvas(ctx.api, canvas.id);
	// look [words] [--kind image]: only the matching cards (and the groups holding them).
	const words = a.pos.join(" ").trim().toLowerCase();
	const kind = flag(a, "kind");
	const matches = (c: Card) =>
		(!kind || c.kind === kind) &&
		(!words || [c.title, c.prompt, c.text, c.model, c.ref].some((v) => v?.toLowerCase().includes(words)));
	const hits = all.filter((c) => c.kind !== "group" && matches(c));
	const cards = words || kind ? all.filter((c) => hits.includes(c) || (c.kind === "group" && hits.some((h) => h.groupId === c.id))) : all;
	if (jsonOut) {
		return out({
			canvas: canvas.id,
			title: canvas.title,
			url: canvasUrl(ctx.site, canvas.id),
			cards: cards.map(({ row: _r, data: _d, ...c }) => ({ ...c, prompt: c.prompt?.slice(0, 400), text: c.text?.slice(0, 400) })),
		});
	}
	const byId = new Map(cards.map((c) => [c.id, c]));
	const groups = cards.filter((c) => c.kind === "group");
	const loose = cards.filter((c) => c.kind !== "group" && !c.groupId);
	const counts = Object.entries(
		cards.filter((c) => c.kind !== "group").reduce<Record<string, number>>((m, c) => ((m[c.kind] = (m[c.kind] ?? 0) + 1), m), {}),
	)
		.map(([k, n]) => `${n} ${k}`)
		.join(", ");
	console.log(`Canvas "${canvas.title ?? "(untitled)"}" ${canvas.id}\n${canvasUrl(ctx.site, canvas.id)}\n${counts || "empty"}${groups.length ? `, ${groups.length} group${groups.length > 1 ? "s" : ""}` : ""}  (@x,y = top-left; ← = made from / uses)\n`);
	const top = [...groups, ...loose].sort((p, q) => p.rect.y - q.rect.y || p.rect.x - q.rect.x);
	for (const c of top) {
		if (c.kind === "group") {
			const members = cards.filter((m) => m.groupId === c.id).sort((p, q) => p.rect.y - q.rect.y || p.rect.x - q.rect.x);
			const total = all.filter((m) => m.groupId === c.id).length;
			console.log(`group  ${c.ref}  "${c.title ?? ""}"  ${total} cards  @${c.rect.x},${c.rect.y} ${c.rect.width}×${c.rect.height}`);
			for (const m of members) console.log(cardLine(m, byId, "  "));
		} else console.log(cardLine(c, byId, ""));
	}
}

async function cmdRead(a: Args) {
	const ctx = await context(a);
	const canvas = await canvasOf(ctx, a);
	const cards = await readCanvas(ctx.api, canvas.id);
	if (!a.pos.length) throw new CliError("read <card> [card…]", "INVALID_PARAM");
	out(
		a.pos.map((r) => {
			const c = findCard(cards, r);
			const { row, data, ...rest } = c;
			return has(a, "full") ? { ...rest, data } : rest;
		}),
	);
}

/** Downloads previews (or originals with --full) so the agent can look at them. */
async function cmdShots(a: Args) {
	const ctx = await context(a);
	const canvas = await canvasOf(ctx, a);
	const cards = await readCanvas(ctx.api, canvas.id);
	const chosen = a.pos.length
		? a.pos.map((r) => findCard(cards, r))
		: cards.filter((c) => (c.kind === "image" || c.kind === "video") && c.url).slice(-(num(a, "last") ?? 12));
	const dir = flag(a, "out") ?? join(tmpdir(), "flowith-shots", canvas.id.slice(0, 8));
	mkdirSync(dir, { recursive: true });
	const files: Array<Record<string, unknown>> = [];
	await Promise.all(
		chosen.map(async (c) => {
			const src = has(a, "full") ? c.url : (c.preview ?? (c.kind === "image" ? c.url : undefined));
			if (!src) {
				files.push({ ref: c.ref, kind: c.kind, skipped: c.kind === "video" ? "no preview frame yet; use --full for the clip" : "no media" });
				return;
			}
			const path = fileFor(dir, c.ref, c.title, src, c.kind === "video" && !has(a, "full") ? "jpg" : c.kind === "video" ? "mp4" : "png");
			try {
				await download(src, path);
				// A cut-out keeps its background colours under full transparency; most viewers draw them anyway.
				const head = readFileSync(path).subarray(0, 26);
				const alpha = head.length > 25 && head.readUInt32BE(0) === 0x89504e47 && (head[25] === 6 || head[25] === 4);
				files.push({ ref: c.ref, kind: c.kind, title: c.title, file: path, ...(alpha ? { note: "PNG with transparency: transparent areas may still show colour in a viewer" } : {}) });
			} catch (e) {
				files.push({ ref: c.ref, kind: c.kind, error: (e as Error).message });
			}
		}),
	);
	out({ dir, files, hint: "Open each file to see it (your Read tool shows images)." });
}

async function cmdSave(a: Args) {
	const ctx = await context(a);
	const canvas = await canvasOf(ctx, a);
	const cards = await readCanvas(ctx.api, canvas.id);
	if (!a.pos.length) throw new CliError("save <card…> [--out dir]", "INVALID_PARAM");
	const dir = flag(a, "out") ?? ".";
	const saved: Array<Record<string, unknown>> = [];
	for (const r of a.pos) {
		const c = findCard(cards, r);
		if (c.text && !c.url) {
			const path = fileFor(dir, c.ref, c.title, "x.md", "md");
			mkdirSync(dir, { recursive: true });
			writeFileSync(path, c.text);
			saved.push({ ref: c.ref, file: path });
		} else if (c.url) {
			const path = fileFor(dir, c.ref, c.title, c.url, c.kind === "video" ? "mp4" : c.kind === "audio" ? "mp3" : "png");
			saved.push({ ref: c.ref, ...(await download(c.url, path)) });
		} else saved.push({ ref: c.ref, skipped: "nothing to save yet" });
	}
	out({ saved });
}

// ---------- commands: making ----------

async function prepare(a: Args, firstPrompt: string) {
	const ctx = await context(a);
	const canvas = await canvasOf(ctx, a, { create: titleFrom(firstPrompt, 24) });
	const [cards, catalog] = await Promise.all([readCanvas(ctx.api, canvas.id), catalogOf(ctx)]);
	return { ctx, canvas, cards, catalog };
}

/** Where new cards go: beside --near/--from, else beside the first card reference. */
function anchorOf(a: Args, cards: Card[], refs: Ref[]): Card | undefined {
	const near = flag(a, "near");
	if (near) return findCard(cards, near);
	return refs.find((r) => r.card)?.card;
}

function intoOf(a: Args, cards: Card[]) {
	const into = flag(a, "into");
	return into ? findCard(cards, into) : undefined;
}

async function cmdImage(a: Args, base?: { source: Card }) {
	const prompts = base ? [a.pos.slice(1).join(" ").trim()] : a.pos;
	if (!prompts.length || !prompts[0]) throw new CliError(base ? 'edit <card> "what to change"' : 'image "prompt" ["prompt" …]', "INVALID_PARAM");
	const { ctx, canvas, cards, catalog } = await prepare(a, prompts[0]!);
	// --model a,b,c: the same prompt on several models (a comparison), one card each.
	const wanted = flags(a, "model");
	const models = (wanted.length ? wanted : [undefined]).map((w) => resolveModel(catalog, "image", w));
	const modelId = models.map((m) => m.id).join(", ");
	const extraRefs = await toRefs(ctx, canvas.id, cards, flags(a, "ref"));
	const sourceRef: Ref[] = base ? [{ url: base.source.url!, name: base.source.title ?? base.source.ref, media: "image", card: base.source }] : [];
	const refs = [...sourceRef, ...extraRefs];
	const n = Math.max(1, Math.min(8, num(a, "n") ?? 1));
	const jobs: ImageJob[] = prompts.flatMap((p) =>
		models.flatMap(({ id, model }) => Array.from({ length: n }, () => ({
			prompt: p,
			modelId: id,
			model,
			ratio: flag(a, "ratio") ?? (base ? base.source.ratio : undefined),
			size: flag(a, "size"),
			quality: flag(a, "quality"),
			transparent: has(a, "transparent"),
			refs,
		}))),
	);
	const built = jobs.map((j) => imageRequest(j, "00000000-0000-0000-0000-000000000000", canvas.id));
	const credits = Math.round(jobs.reduce((sum, j) => sum + (estimateCredits(j.model) ?? 0), 0));
	if (has(a, "dry-run")) return out({ model: modelId, jobs: jobs.length, estimatedCredits: credits, requests: built.map((b) => b.body) });
	const title = flag(a, "title");
	const items: NewCard[] = jobs.map((j, i) => {
		const ratio = built[i]!.ratio;
		const t = title
			? models.length > 1 ? `${title} · ${j.model.title ?? j.modelId}` : jobs.length > 1 ? `${title} ${i + 1}` : title
			: titleFrom(j.prompt);
		return {
			kind: "image",
			size: cardSize("image", ratio),
			data: { ...imageCardData(j, t, ratio), ...(title ? { customTitle: t } : {}), ...(base ? { baseImageNodeId: base.source.id, baseImageUrl: base.source.url } : {}) },
		};
	});
	const groupName = flag(a, "group") ?? (items.length > 1 ? title ?? titleFrom(prompts[0]!, 20) : undefined);
	const placed = await placeCards(ctx.api, canvas.id, cards, items, { anchor: base?.source ?? anchorOf(a, cards, refs), group: groupName, into: intoOf(a, cards) });
	log(`Placed ${placed.ids.length} image card${placed.ids.length > 1 ? "s" : ""} (${modelId}, ~${credits} credits); generating…`);
	const rows = new Map(placed.rows.map((r) => [r.id, r]));
	await Promise.all(
		jobs.map(async (j, i) => {
			const id = placed.ids[i]!;
			try {
				await send(ctx.api, "image", imageRequest(j, id, canvas.id).body);
			} catch (e) {
				const row = rows.get(id);
				if (row) await failCard(ctx.api, { id, createdAt: row.created_at }, (row.data as Record<string, unknown>) ?? {}, (e as Error).message);
				if (jobs.length === 1) throw e;
			}
		}),
	);
	await waitAndReport(ctx, a, canvas.id, placed.ids, 300, { model: modelId, estimatedCredits: credits, ...(placed.groupId ? { group: placed.groupId.slice(0, 8) } : {}) });
}

async function cmdVideo(a: Args) {
	let prompt = a.pos.join(" ").trim();
	const extend = flag(a, "extend");
	const editVideo = flag(a, "edit-video");
	const operation = extend ? "extend" : editVideo ? "edit" : undefined;
	if (!prompt && !operation && !flag(a, "first") && !flag(a, "from")) throw new CliError('video "prompt" [--first card|file] [--ref …]', "INVALID_PARAM");
	if (operation === "edit" && !prompt) throw new CliError('video --edit-video <clip> "what to change"', "INVALID_PARAM");
	const { ctx, canvas, cards, catalog } = await prepare(a, prompt || "Video");
	const clip = operation ? await toRef(ctx, canvas.id, cards, extend ?? editVideo!) : undefined;
	if (clip && clip.media !== "video") throw new CliError("--extend / --edit-video take a clip.", "INVALID_PARAM");
	// Extending or editing a clip: Seedance (the canvas's choice) or Gemini Omni, keeping the clip's own model when it is one.
	const own = clip?.card?.model && /^(seedance-2\.|gemini-omni)/.test(clip.card.model) ? clip.card.model : undefined;
	const { id: modelId, model } = resolveModel(catalog, "video", flag(a, "model") ?? own);
	let opRefs: Ref[] = [];
	let omniOperation: VideoJob["operation"];
	if (operation && clip) {
		if (modelId.startsWith("gemini-omni")) {
			omniOperation = operation;
			opRefs = [clip];
			if (!prompt) prompt = "Continue the shot naturally: same subject, light, camera and sound.";
		} else if (/^seedance-2\./.test(modelId)) {
			// The canvas's own Seedance extend / edit wording (frontend omni-video-operations.ts seedanceOperationPrompt).
			const zh = hasHan(prompt) || !prompt;
			const seconds = flag(a, "duration") ?? "5";
			const sound = zh ? "声音：现场同期收音，纪录片质感，只有画面里人物的说话声和这个地方的自然声，不要背景音乐。" : "Sound design: raw location recording, documentary style — only the voices of the people on screen and the natural sounds of the place; the scene is otherwise silent.";
			prompt = operation === "extend"
				? zh
					? `把@video1作为同一个连续镜头延长 ${seconds} 秒，从它的最后一帧直接接着拍，主体、光线和机位都不变。${prompt || "动作自然地继续下去。"}\n${sound}`
					: `Extend @video1 as the same continuous shot for ${seconds} seconds, continuing straight from its last frame with the same subject, light and camera. ${prompt}\n${sound}`
				: zh
					? `修改@video1：${prompt.replace(/[。.！!？?\s]+$/u, "")}。@video1里其他的一切保持不变。`
					: `Edit @video1: ${prompt}. Keep everything else in @video1 the same.`;
			opRefs = [clip];
		} else throw new CliError("Extending or editing a clip works with Seedance 2.x or Gemini Omni models.", "INVALID_PARAM");
	}
	const firstIn = flag(a, "first") ?? flag(a, "from");
	const first = firstIn ? await toRef(ctx, canvas.id, cards, firstIn) : undefined;
	const last = flag(a, "last") ? await toRef(ctx, canvas.id, cards, flag(a, "last")!) : undefined;
	const refs = [...opRefs, ...(await toRefs(ctx, canvas.id, cards, flags(a, "ref")))];
	const job: VideoJob = {
		prompt,
		modelId,
		model,
		ratio: flag(a, "ratio") ?? (clip?.card?.ratio && model.supportedAspectRatios?.includes(clip.card.ratio) ? clip.card.ratio : undefined),
		duration: flag(a, "duration"),
		resolution: flag(a, "resolution"),
		audio: has(a, "no-audio") ? false : has(a, "audio") ? true : undefined,
		draft: has(a, "draft"),
		first,
		last,
		refs,
		operation: omniOperation,
	};
	const anchor = anchorOf(a, cards, [...(first ? [first] : []), ...refs]);
	const preview = videoRequest(job, "00000000-0000-0000-0000-000000000000", canvas.id, canvas.id, { x: 0, y: 0 });
	const credits = estimateCredits(model, { duration: preview.params.duration, resolution: preview.params.resolution, audio: preview.audio });
	if (has(a, "dry-run")) return out({ model: modelId, estimatedCredits: credits, request: preview.body });
	const title = flag(a, "title") ?? (clip?.card && operation ? `${clip.card.title ?? "Clip"} · ${operation === "extend" ? "extended" : "edited"}` : titleFrom(a.pos.join(" ").trim() || "Video"));
	const ratio = preview.params.aspect_ratio && !["adaptive", "auto"].includes(preview.params.aspect_ratio) ? preview.params.aspect_ratio : "16:9";
	const placed = await placeCards(
		ctx.api,
		canvas.id,
		cards,
		// Named, or the worker names a finished clip by its prompt's first five characters.
		[{ kind: "video", size: cardSize("video", ratio), data: { ...videoCardData(job, title, preview.params, preview.audio), customTitle: title } }],
		{ anchor, group: flag(a, "group"), into: intoOf(a, cards) },
	);
	const id = placed.ids[0]!;
	const row = placed.rows.find((r) => r.id === id)!;
	log(`Placed video card ${id.slice(0, 8)} (${modelId}, ${preview.params.duration ?? "?"} s, ~${credits ?? "?"} credits); generating…`);
	try {
		const { body } = videoRequest(job, id, canvas.id, row.p_id ?? canvas.id, row.position ?? { x: 0, y: 0 });
		await send(ctx.api, "video", body);
	} catch (e) {
		await failCard(ctx.api, { id, createdAt: row.created_at }, (row.data as Record<string, unknown>) ?? {}, (e as Error).message);
		throw e;
	}
	await waitAndReport(ctx, a, canvas.id, [id], 900, { model: modelId, estimatedCredits: credits });
}

async function cmdText(a: Args) {
	const prompt = a.pos.join(" ").trim();
	if (!prompt) throw new CliError('text "prompt" [--model a,b] [--ref card]', "INVALID_PARAM");
	const { ctx, canvas, cards, catalog } = await prepare(a, prompt);
	const wanted = flags(a, "model");
	const models = (wanted.length ? wanted : [undefined]).map((w) => resolveModel(catalog, "text", w));
	const refs = await toRefs(ctx, canvas.id, cards, flags(a, "ref"));
	const title = flag(a, "title") ?? titleFrom(prompt);
	const jobs: TextJob[] = models.map((m) => ({ prompt, modelId: m.id, system: flag(a, "system"), refs }));
	if (has(a, "dry-run")) return out({ requests: jobs.map((j) => textRequest(j, "00000000-0000-0000-0000-000000000000", canvas.id)) });
	const items: NewCard[] = jobs.map((j) => ({
		kind: "text",
		size: cardSize("text"),
		data: textCardData(j, models.length > 1 && flag(a, "title") ? `${title} · ${catalog[j.modelId]?.title ?? j.modelId}` : title, Boolean(flag(a, "title"))),
	}));
	const placed = await placeCards(ctx.api, canvas.id, cards, items, {
		anchor: anchorOf(a, cards, refs),
		group: flag(a, "group") ?? (items.length > 1 ? title : undefined),
		into: intoOf(a, cards),
	});
	log(`Placed ${items.length} text card${items.length > 1 ? "s" : ""} (${models.map((m) => m.id).join(", ")}); writing…`);
	const rows = new Map(placed.rows.map((r) => [r.id, r]));
	await Promise.all(
		jobs.map(async (j, i) => {
			const id = placed.ids[i]!;
			try {
				await send(ctx.api, "text", textRequest(j, id, canvas.id));
			} catch (e) {
				const row = rows.get(id);
				if (row) await failCard(ctx.api, { id, createdAt: row.created_at }, (row.data as Record<string, unknown>) ?? {}, (e as Error).message);
				if (jobs.length === 1) throw e;
			}
		}),
	);
	await waitAndReport(ctx, a, canvas.id, placed.ids, 600);
}

async function cmdSound(a: Args, tool: "gen_speech" | "gen_music") {
	const words = a.pos.join(" ").trim();
	if (!words) throw new CliError(tool === "gen_speech" ? 'speech "text to say" [--for card]' : 'music "style / mood" [--for card]', "INVALID_PARAM");
	const ctx = await context(a);
	const canvas = await canvasOf(ctx, a, { create: titleFrom(words, 24) });
	const [cards, catalog] = await Promise.all([readCanvas(ctx.api, canvas.id), catalogOf(ctx)]);
	const wanted = flag(a, "model") ?? (tool === "gen_speech" ? "elevenlabs-v3" : "suno-chirp-v6");
	const { id: modelId, model } = resolveModel(catalog, "audio", wanted);
	const spec = AUDIO_MODELS[modelId];
	if (!spec || spec.tool !== tool) throw new CliError(`${modelId} is not a ${tool === "gen_speech" ? "speech" : "music"} model.`, "INVALID_MODEL");
	const args: Record<string, unknown> =
		tool === "gen_speech"
			? { text: words, model: spec.id, ...(flag(a, "voice") ? { voice: flag(a, "voice") } : {}), ...(flag(a, "language") ? { language_code: flag(a, "language") } : {}) }
			: {
					prompt: words,
					model: spec.id,
					instrumental: !flag(a, "lyrics") && !has(a, "vocals"),
					...(flag(a, "lyrics") ? { lyrics_prompt: flag(a, "lyrics") } : {}),
					...(num(a, "duration") ? { duration: num(a, "duration") } : {}),
				};
	const credits = estimateCredits(model, { chars: words.length });
	if (has(a, "dry-run")) return out({ model: modelId, estimatedCredits: credits, action: { name: tool, args } });
	// The sound hangs off a card: --for (the clip it scores), else a note holding its words.
	let source = flag(a, "for") ? findCard(cards, flag(a, "for")!) : undefined;
	if (!source) {
		const placed = await placeCards(ctx.api, canvas.id, cards, [
			{ kind: "note", size: cardSize("note"), data: noteData(words, tool === "gen_speech" ? "Script" : "Music brief") },
		]);
		source = cardsFrom(placed.rows)[0]!;
		cards.push(source);
	}
	log(`Making ${tool === "gen_speech" ? "speech" : "music"} with ${modelId} (~${credits ?? "?"} credits)…`);
	const made = await makeSound(ctx.api, canvas.id, cards, source, { name: tool, args }, { timeoutMs: timeoutOf(a, 600), onTick: () => {} });
	const rows = await fetchRowsById(ctx.api, made.ids);
	finish(ctx, canvas.id, cardsFrom(rows).map(resultOf), { model: modelId, estimatedCredits: credits, source: source.ref });
}

async function cmdVary(a: Args) {
	const ctx = await context(a);
	const canvas = await canvasOf(ctx, a);
	const cards = await readCanvas(ctx.api, canvas.id);
	const src = findCard(cards, a.pos[0] ?? "");
	if (src.kind !== "image" && src.kind !== "video") throw new CliError("vary takes a picture or clip card.", "INVALID_PARAM");
	if (!src.prompt || !src.model) throw new CliError(`${src.ref} has no prompt/model to run again.`, "INVALID_PARAM");
	const refs = (src.data.promptReferenceNodes ?? []).map((p: { id: string }) => cards.find((c) => c.id === p.id)?.ref).filter(Boolean) as string[];
	const next = parseArgs([src.kind, src.prompt, "--model", flag(a, "model") ?? src.model, "--near", src.ref, ...refs.flatMap((r) => ["--ref", r])]);
	for (const [k, v] of a.flags) if (k !== "model") next.flags.set(k, v);
	if (src.ratio && !flag(a, "ratio") && src.kind === "image") next.flags.set("ratio", [src.ratio]);
	if (src.kind === "image") {
		if (!next.flags.has("n")) next.flags.set("n", ["1"]);
		return cmdImage(next);
	}
	if (src.data.baseImageNodeId) next.flags.set("first", [String(src.data.baseImageNodeId)]);
	return cmdVideo(next);
}

async function cmdEdit(a: Args) {
	const ctx = await context(a);
	const canvas = await canvasOf(ctx, a);
	const cards = await readCanvas(ctx.api, canvas.id);
	const source = findCard(cards, a.pos[0] ?? "");
	if (source.kind !== "image" || !source.url) throw new CliError(`${source.ref} is not a finished picture. (For clips: video --edit-video ${source.ref} "…".)`, "INVALID_PARAM");
	return cmdImage(a, { source });
}

async function cmdTool(a: Args, tool: "upscale" | "cutout" | "expand") {
	const ctx = await context(a);
	const canvas = await canvasOf(ctx, a);
	const cards = await readCanvas(ctx.api, canvas.id);
	const source = findCard(cards, a.pos[0] ?? "");
	let placed;
	if (tool === "upscale") placed = source.kind === "video" ? await upscaleVideo(ctx.api, canvas.id, cards, source, flag(a, "to"), flag(a, "quality")) : await upscaleImage(ctx.api, canvas.id, cards, source, flag(a, "to"));
	else if (tool === "cutout") placed = await cutout(ctx.api, canvas.id, cards, source);
	else {
		const ratio = flag(a, "ratio") ?? a.pos[1];
		if (!ratio) throw new CliError("expand <card> --ratio 16:9", "INVALID_PARAM");
		placed = await expand(ctx.api, canvas.id, cards, source, ratio);
	}
	log(`${tool} started on ${source.ref} → ${placed.ids[0]!.slice(0, 8)}`);
	await waitAndReport(ctx, a, canvas.id, placed.ids, source.kind === "video" ? 1200 : 600);
}

// ---------- commands: placing & organising ----------

/** A finished text card holding given words (no model ran). */
const noteData = (text: string, title?: string) => ({
	value: text,
	isImage: false,
	mode: "General",
	status: "finished",
	title: title ?? titleFrom(text),
	...(title ? { customTitle: title } : {}),
});

async function cmdAdd(a: Args) {
	if (!a.pos.length) throw new CliError("add <file|url> […]", "INVALID_PARAM");
	const ctx = await context(a);
	const canvas = await canvasOf(ctx, a, { create: "Imports" });
	const cards = await readCanvas(ctx.api, canvas.id);
	const items: NewCard[] = [];
	for (const input of a.pos) {
		const up = await toUrl(ctx.api, input, canvas.id);
		const title = flag(a, "title") ?? up.name.replace(/\.[^.]+$/, "");
		const common = { title, name: up.name, value: up.url, insert: true, mediaSource: "upload", uploadState: "ready", status: "finished" };
		if (up.media === "image") {
			const { remoteImageSize } = await import("./lib/media");
			const size = await remoteImageSize(up.url);
			const ratio = size ? `${size.width}:${size.height}` : "1:1";
			items.push({ kind: "image", size: cardSize("image", ratio), data: { ...common, isImage: true, mode: "image_generation", aspect_ratio: ratio } });
		} else if (up.media === "video") items.push({ kind: "video", size: cardSize("video", flag(a, "ratio") ?? "16:9"), data: { ...common, videoId: up.url, aspect_ratio: flag(a, "ratio") ?? "16:9" } });
		else if (up.media === "audio") items.push({ kind: "audio", size: cardSize("audio"), data: { ...common, audioUrl: up.url } });
		else throw new CliError(`${up.name}: add takes pictures, clips and sounds.`, "INVALID_PARAM");
		log(`Uploaded ${up.name}`);
	}
	const placed = await placeCards(ctx.api, canvas.id, cards, items, { anchor: anchorOf(a, cards, []), group: flag(a, "group"), into: intoOf(a, cards) });
	finish(ctx, canvas.id, cardsFrom(placed.rows).filter((c) => c.kind !== "group").map(resultOf), placed.groupId ? { group: placed.groupId.slice(0, 8) } : {});
}

async function cmdNote(a: Args) {
	const text = a.pos.join(" ").trim() || (flag(a, "file") ? readFileSync(flag(a, "file")!, "utf8") : "");
	if (!text) throw new CliError('note "text" (or --file notes.md)', "INVALID_PARAM");
	const ctx = await context(a);
	const canvas = await canvasOf(ctx, a, { create: titleFrom(text, 24) });
	const cards = await readCanvas(ctx.api, canvas.id);
	const placed = await placeCards(
		ctx.api,
		canvas.id,
		cards,
		[{ kind: "note", size: cardSize("note"), data: noteData(text, flag(a, "title")) }],
		{ anchor: anchorOf(a, cards, []), into: intoOf(a, cards) },
	);
	finish(ctx, canvas.id, cardsFrom(placed.rows).map(resultOf));
}

async function cmdWrite(a: Args) {
	const ctx = await context(a);
	const canvas = await canvasOf(ctx, a);
	const cards = await readCanvas(ctx.api, canvas.id);
	const card = findCard(cards, a.pos[0] ?? "");
	const text = a.pos.slice(1).join(" ").trim() || (flag(a, "file") ? readFileSync(flag(a, "file")!, "utf8") : "");
	if (!text) throw new CliError('write <text card> "new text" (or --file)', "INVALID_PARAM");
	if (card.kind !== "text" || card.status === "running") throw new CliError(`${card.ref} is not a finished text card.`, "INVALID_PARAM");
	await patch(ctx.api, card, { data: { ...card.data, value: text } });
	out({ written: card.ref, chars: text.length });
}

async function cmdMove(a: Args) {
	const ctx = await context(a);
	const canvas = await canvasOf(ctx, a);
	const cards = await readCanvas(ctx.api, canvas.id);
	const card = findCard(cards, a.pos[0] ?? "");
	const to = flag(a, "to");
	const gap = num(a, "gap") ?? CANVAS_NODE_GAP;
	let x: number;
	let y: number;
	if (to) {
		const m = /^(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)$/.exec(to);
		if (!m) throw new CliError("--to x,y (top-left, canvas units)", "INVALID_PARAM");
		x = Number(m[1]);
		y = Number(m[2]);
	} else {
		const rel = (["right-of", "left-of", "below", "above"] as const).find((k) => flag(a, k));
		if (!rel) throw new CliError("move <card> --to x,y | --right-of c | --left-of c | --below c | --above c", "INVALID_PARAM");
		const t = findCard(cards, flag(a, rel)!).rect;
		x = rel === "right-of" ? t.x + t.width + gap : rel === "left-of" ? t.x - card.rect.width - gap : t.x;
		y = rel === "below" ? t.y + t.height + gap : rel === "above" ? t.y - card.rect.height - gap : t.y;
	}
	await moveTo(ctx.api, [{ card, x: Math.round(x), y: Math.round(y) }]);
	out({ moved: card.ref, to: { x: Math.round(x), y: Math.round(y) } });
}

async function cmdArrange(a: Args) {
	const ctx = await context(a);
	const canvas = await canvasOf(ctx, a);
	const cards = await readCanvas(ctx.api, canvas.id);
	const chosen = a.pos.map((r) => findCard(cards, r));
	if (chosen.length === 1 && chosen[0]!.kind === "group") {
		// Lay a group's cards out again on its grid (as Flo's groups are), in reading order.
		const group = chosen[0]!;
		const members = cards.filter((c) => c.groupId === group.id).sort((p, q) => p.rect.y - q.rect.y || p.rect.x - q.rect.x);
		const layout = groupLayout(members.map((m) => ({ width: m.rect.width, height: m.rect.height })));
		await Promise.all(members.map((m, i) => patch(ctx.api, m, { position: { x: Math.round(layout.members[i]!.x + m.rect.width / 2), y: Math.round(layout.members[i]!.y) } })));
		await patch(ctx.api, group, {
			position: { x: Math.round(group.rect.x + layout.width / 2), y: group.rect.y },
			width: layout.width,
			height: layout.height,
			data: { ...group.data, width: layout.width, height: layout.height },
		});
		return out({ arranged: group.ref, cards: members.map((m) => m.ref), size: `${layout.width}×${layout.height}` });
	}
	if (chosen.length < 2) throw new CliError("arrange <card> <card> … --as row|column|grid  (or arrange <group>)", "INVALID_PARAM");
	const layout = (flag(a, "as") ?? "row") as Layout;
	if (!["row", "column", "grid"].includes(layout)) throw new CliError("--as row | column | grid", "INVALID_PARAM");
	let points = arrangePoints(chosen, layout, num(a, "gap") ?? CANVAS_NODE_GAP, num(a, "cols"));
	// The lined-up block keeps clear of everything else: if it would cover a card, it moves as a whole to the nearest free place.
	const box = {
		x: Math.min(...points.map((p) => p.x)),
		y: Math.min(...points.map((p) => p.y)),
		width: Math.max(...points.map((p, i) => p.x + chosen[i]!.rect.width)) - Math.min(...points.map((p) => p.x)),
		height: Math.max(...points.map((p, i) => p.y + chosen[i]!.rect.height)) - Math.min(...points.map((p) => p.y)),
	};
	const others = obstaclesOf(cards, chosen.map((c) => c.id));
	if (!isClear(box, others)) {
		const free = nearestFree({ width: box.width, height: box.height }, box, others);
		points = points.map((p) => ({ x: p.x + free.x - box.x, y: p.y + free.y - box.y }));
	}
	await moveTo(ctx.api, chosen.map((card, i) => ({ card, ...points[i]! })));
	out({ arranged: chosen.map((c) => c.ref), as: layout, at: { x: points[0]!.x, y: points[0]!.y } });
}

async function cmdGroup(a: Args) {
	const ctx = await context(a);
	const canvas = await canvasOf(ctx, a);
	const cards = await readCanvas(ctx.api, canvas.id);
	const members = a.pos.map((r) => findCard(cards, r));
	if (members.length < 1) throw new CliError('group <card> <card> … --name "name"', "INVALID_PARAM");
	const id = await groupCards(ctx.api, canvas.id, cards, members, flag(a, "name") ?? "Group");
	out({ group: id.slice(0, 8), cards: members.map((m) => m.ref) });
}

async function cmdUngroup(a: Args) {
	const ctx = await context(a);
	const canvas = await canvasOf(ctx, a);
	const cards = await readCanvas(ctx.api, canvas.id);
	const freed = await ungroup(ctx.api, canvas.id, cards, findCard(cards, a.pos[0] ?? ""));
	out({ ungrouped: freed.map((id) => id.slice(0, 8)) });
}

async function cmdRename(a: Args) {
	const ctx = await context(a);
	const canvas = await canvasOf(ctx, a);
	const title = a.pos.slice(1).join(" ").trim();
	if (!a.pos[0] || !title) throw new CliError('rename <card|canvas> "new title"', "INVALID_PARAM");
	if (a.pos[0] === "canvas") {
		const { rest } = await import("./lib/http");
		await rest(ctx.api, `conversation?id=eq.${canvas.id}`, { method: "PATCH", json: { title }, prefer: "return=minimal" });
		return out({ canvas: canvas.id, title });
	}
	const cards = await readCanvas(ctx.api, canvas.id);
	const card = findCard(cards, a.pos[0]);
	await rename(ctx.api, card, title);
	out({ renamed: card.ref, title });
}

async function cmdLink(a: Args, remove: boolean) {
	const ctx = await context(a);
	const canvas = await canvasOf(ctx, a);
	const cards = await readCanvas(ctx.api, canvas.id);
	const [from, to] = [findCard(cards, a.pos[0] ?? ""), findCard(cards, a.pos[1] ?? "")];
	await link(ctx.api, to, from, remove);
	out({ [remove ? "unlinked" : "linked"]: `${from.ref} → ${to.ref}` });
}

async function cmdCopy(a: Args) {
	const ctx = await context(a);
	const canvas = await canvasOf(ctx, a);
	const cards = await readCanvas(ctx.api, canvas.id);
	const src = findCard(cards, a.pos[0] ?? "");
	if (src.kind === "group") throw new CliError("copy takes a card, not a group.", "INVALID_PARAM");
	const { group_id: _g, creatorMedia: _c, ...data } = src.data;
	const rect = placeSingle({ width: src.rect.width, height: src.rect.height }, { obstacles: obstaclesOf(cards), anchor: src.groupId ? cards.find((c) => c.id === src.groupId)?.rect : src.rect });
	const { rest } = await import("./lib/http");
	const id = crypto.randomUUID();
	await rest(ctx.api, "flow_node", {
		json: [{ id, conv_id: canvas.id, type: src.type, p_id: canvas.id, c_ids: [], position: { x: Math.round(rect.x + rect.width / 2), y: rect.y }, width: src.rect.width, height: src.rect.height, data: { ...data, timestamp: Math.floor(Date.now() / 1000).toString() } }],
		prefer: "return=minimal",
	});
	out({ copied: src.ref, card: id.slice(0, 8), id });
}

async function cmdDelete(a: Args) {
	const ctx = await context(a);
	const canvas = await canvasOf(ctx, a);
	const cards = await readCanvas(ctx.api, canvas.id);
	const chosen = a.pos.map((r) => findCard(cards, r));
	if (!chosen.length) throw new CliError("delete <card> […]", "INVALID_PARAM");
	// A group goes with its cards, as on the canvas.
	const ids = [...new Set(chosen.flatMap((c) => (c.kind === "group" ? [c.id, ...cards.filter((m) => m.groupId === c.id).map((m) => m.id)] : [c.id])))];
	await deleteCards(ctx.api, canvas.id, ids);
	out({ deleted: ids.map((id) => id.slice(0, 8)) });
}

async function cmdWait(a: Args) {
	const ctx = await context(a);
	const canvas = await canvasOf(ctx, a);
	const cards = await readCanvas(ctx.api, canvas.id);
	const chosen = a.pos.length ? a.pos.map((r) => findCard(cards, r)) : cards.filter((c) => c.status === "running");
	if (!chosen.length) return out({ canvas: canvas.id, cards: [], note: "Nothing is generating." });
	await waitAndReport(ctx, a, canvas.id, chosen.map((c) => c.id), 900);
}

// ---------- commands: models ----------

async function cmdModels(a: Args) {
	const ctx = await context(a).catch(() => null);
	const catalog = await fetchCatalog(ctx?.session.workerURL ?? "https://dev-edge.flowith.io", { fresh: has(a, "fresh") });
	const kinds = (a.pos[0] && ["image", "video", "text", "audio"].includes(a.pos[0]) ? [a.pos[0]] : ["image", "video", "text", "audio"]) as Kind[];
	const id = a.pos.find((p) => !["image", "video", "text", "audio"].includes(p));
	if (id) {
		const m = catalog[id] ?? Object.entries(catalog).find(([, v]) => v.title?.toLowerCase() === id.toLowerCase())?.[1];
		if (!m) throw new CliError(`No model "${id}".`, "INVALID_MODEL");
		const { logo: _l, icon: _i, descI18n: _d, titleI18n: _t, ...rest } = m as Record<string, unknown>;
		return out({ id, ...rest });
	}
	if (jsonOut) return out(Object.fromEntries(kinds.map((k) => [k, modelsOf(catalog, k).map(([mid]) => mid)])));
	for (const k of kinds) {
		console.log(`\n${k.toUpperCase()}  (default: ${defaultModel(catalog, k === "audio" ? "audio" : k)})`);
		for (const [mid, m] of modelsOf(catalog, k)) console.log(`  ${modelLine(mid, m)}`);
	}
	console.log("\n`models <id>` for one model's full limits. 1 credit = $0.001.");
}

// ---------- help ----------

const HELP = `canvas-cowork — work on a Flowith 3.0 canvas. Every card you make shows up live on the user's canvas.

  bun scripts/index.ts <command> [args] [--flags]

SET UP      login · whoami · credits · logout
CANVASES    canvases [search] · new "title" · use <canvas|url> · open · rename canvas "title"
SEE         look [words] [--kind image]  every card: ref, kind, title, model, status, place, links
            read <card…> [--full]        full prompt / text / media of cards
            shots [card…] [--full]       download previews to look at (Read the files)
            save <card…> [--out dir]     download originals / text
MAKE        image "prompt" ["prompt"…]   [--model] [--ratio 16:9] [--size 2k] [--n 4] [--ref card|file|url]… [--transparent]
            edit <card> "change"          a new picture made from that one, beside it
            vary <card> [--n 3]           run a card's prompt again
            video "prompt"               [--model] [--first card|file] [--last …] [--ref …]… [--duration 5] [--resolution 720p]
                                         [--ratio] [--no-audio] [--draft] [--extend clip] [--edit-video clip]
            text "prompt"                [--model a,b,c] [--ref card]… [--system "…"]
            speech "words"  · music "style"   [--model] [--voice id] [--for card] [--lyrics "…"] [--duration s]
TOOLS       upscale <card> [--to 4k] · cutout <card> · expand <card> --ratio 16:9
ARRANGE     add <file|url…> · note "text" · write <card> "text" · move <card> --to x,y | --right-of c | --below c
            arrange <cards…> --as row|column|grid  ·  arrange <group>  ·  group <cards…> --name "…" · ungroup <group>
            rename <card> "title" · link <from> <to> · unlink <from> <to> · copy <card> · delete <card…>
            wait [card…]
MODELS      models [image|video|text|audio] · models <id>

Placement   new cards sit beside --near <card> (or the first --ref card), else in free space; several
            results form one group (--group "name"); --into <group> adds to an existing group.
Cards       a card is named by its ref (first 8 hex of its id, shown by look), a longer id prefix, or its title.
References  in prompts, name references @image1 @image2 @video1 @audio1 in --ref order; the CLI rewrites
            them to each model's own naming (Seedance 图片1, Kling @image_1, image models 图1/image 1).
Global      --canvas <ref>  --json  --quiet  --no-wait  --timeout <s>  --dry-run (show request + credits)
            --as <claude-code|codex|…> (auto-detected)  ·  env FLOWITH_URL, FLOWITH_CANVAS, FLOWITH_HOME
`;

// ---------- main ----------

const COMMANDS: Record<string, (a: Args) => Promise<unknown>> = {
	login: cmdLogin,
	whoami: cmdWhoami,
	status: cmdWhoami,
	credits: cmdCredits,
	logout: async () => {
		forgetSession();
		out({ loggedOut: true });
	},
	canvases: cmdCanvases,
	list: cmdCanvases,
	new: cmdNew,
	use: cmdUse,
	switch: cmdUse,
	open: cmdOpen,
	look: cmdLook,
	read: cmdRead,
	shots: cmdShots,
	save: cmdSave,
	image: (a) => cmdImage(a),
	edit: cmdEdit,
	vary: cmdVary,
	video: cmdVideo,
	text: cmdText,
	speech: (a) => cmdSound(a, "gen_speech"),
	music: (a) => cmdSound(a, "gen_music"),
	upscale: (a) => cmdTool(a, "upscale"),
	cutout: (a) => cmdTool(a, "cutout"),
	expand: (a) => cmdTool(a, "expand"),
	add: cmdAdd,
	note: cmdNote,
	write: cmdWrite,
	move: cmdMove,
	arrange: cmdArrange,
	group: cmdGroup,
	ungroup: cmdUngroup,
	rename: cmdRename,
	link: (a) => cmdLink(a, false),
	unlink: (a) => cmdLink(a, true),
	copy: cmdCopy,
	delete: cmdDelete,
	wait: cmdWait,
	models: cmdModels,
};

/** Commands of the previous canvas-cowork and what replaced them. */
const RENAMED: Record<string, string> = {
	"create-canvas": "new",
	gen: "image / video / text",
	submit: "image / video / text",
	"submit-batch": 'image "p1" "p2" … (one call, one group)',
	"read-db": "look / read",
	"list-models": "models",
	upload: "add (puts it on the canvas) or --ref <file>",
	"delete-many": "delete",
	"clean-failed": "delete <card…>",
	recall: "canvases <search> + look",
};

async function main() {
	const a = parseArgs(process.argv.slice(2));
	jsonOut = has(a, "json");
	quiet = has(a, "quiet") || jsonOut;
	if (a.cmd === "help" || has(a, "help")) return void process.stdout.write(HELP);
	const run = COMMANDS[a.cmd];
	if (!run) {
		const moved = RENAMED[a.cmd];
		throw new CliError(moved ? `\`${a.cmd}\` is now: ${moved}. See \`help\`.` : `Unknown command "${a.cmd}". See \`help\`.`, "INVALID_PARAM");
	}
	await run(a);
}

main().catch((e: unknown) => {
	const err = e instanceof CliError ? e : new CliError(e instanceof Error ? e.message : String(e), "ERROR");
	process.stdout.write(`${JSON.stringify({ error: err.code, message: err.message, ...(err.data && typeof err.data === "object" && !Array.isArray(err.data) && Object.keys(err.data).length < 8 ? { data: err.data } : {}) })}\n`);
	process.exit(1);
});

