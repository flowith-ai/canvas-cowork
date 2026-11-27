#!/usr/bin/env node
/**
 * canvas-cowork — work on a Flowith 3.0 canvas from Claude Code, Codex or any agent with a shell.
 *
 * Every command acts on the user's canvas the way their own hands (or the in-app Creator Agent,
 * Flo) would: cards are placed where Flo places them, generations go through the canvas's own
 * routes and pricing, and an open canvas shows each card arrive live. Zero dependencies; Node 22.18+ or Bun.
 *
 *   node scripts/index.ts <command> [args] [--flags]     (`help` lists everything)
 *   bun scripts/index.ts …  ·  npx -y github:flowith-ai/canvas-cowork …
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import {
	type Catalog,
	type Kind,
	AUDIO_MODELS,
	atRate,
	defaultModel,
	estimateCredits,
	fetchCatalog,
	memberRates,
	modelLine,
	modelsOf,
	resolveModel,
} from "./lib/catalog.ts";
import {
	type Card,
	canvasUrl,
	cardsFrom,
	createCanvas,
	fetchRowsById,
	findCard,
	getCanvas,
	isUuid,
	listCanvases,
	readCanvas,
	resolveCanvas,
} from "./lib/desk.ts";
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
} from "./lib/generate.ts";
import { type Api, CliError, forbidWrites, serverNow, sleep, worker } from "./lib/http.ts";
import { type Sent, SETTLE_MS, chargeOf, chargedSince, claimRetry, creditsOf, fingerprint, forgetSent, noteSent, releaseRetry, sentOf, usageOf } from "./lib/ledger.ts";
import { download, fileFor, isUrl, mediaOf, toUrl } from "./lib/media.ts";
import {
	type Session,
	activeSession,
	apiOf,
	forgetOldLogin,
	jwtClaims,
	login,
	logout,
	siteUrl,
	workerFor,
	openUrl,
	saveSession,
	userIdOf,
} from "./lib/session.ts";
import { cutout, expand, makeSound, upscaleImage, upscaleVideo } from "./lib/tools.ts";
import { videoPrice } from "./lib/video-cost.ts";
import { type CanvasResult, operationWaitSec, printedIds, runOnCanvas, SELECTION_SCRIPT, tidyScript } from "./lib/live.ts";
import {
	type Layout,
	type NewCard,
	type Placed,
	arrangePoints,
	cardSize,
	claim,
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
} from "./lib/write.ts";
import { CANVAS_NODE_GAP, groupLayout, isClear, placeSingle } from "./lib/placement.ts";

// ---------- args ----------

const BOOLEAN_FLAGS = new Set([
	"json", "quiet", "no-wait", "wait", "full", "fresh", "dry-run", "no-audio", "audio", "draft",
	"transparent", "no-open", "open", "handoff", "instrumental", "vocals", "layout", "add", "help",
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
			else if (BOOLEAN_FLAGS.has(name)) value = "true";
			else if (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--")) value = argv[++i]!;
			else if (name === "voice") value = "true"; // soundtrack also accepts --voice without a line.
			else throw new CliError(`--${name} requires a value. See \`<command> --help\`.`, "INVALID_PARAM");
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
/** --dry-run: nothing is created, uploaded, sent or charged. */
let dryRun = false;
const log = (m: string) => {
	if (!quiet) process.stderr.write(`${m}\n`);
};
const out = (data: unknown) => process.stdout.write(`${JSON.stringify(data, null, jsonOut ? 0 : 2)}\n`);

/** Which agent writes: shown on the canvas's change feed and on the connect page. */
function agentName(a: Args): string {
	const named = flag(a, "agent") ?? flag(a, "bot") ?? process.env.FLOWITH_AGENT;
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
async function canvasOf(ctx: Ctx, a: Args, opts: { create?: string } = {}): Promise<{ id: string; title: string | null; created?: boolean; team?: boolean; teamId?: string }> {
	const ref = flag(a, "canvas") ?? process.env.FLOWITH_CANVAS;
	if (ref) {
		const found = await resolveCanvas(ctx.api, ctx.userId, ref, ctx.site);
		const c = found.team_id === undefined ? await getCanvas(ctx.api, found.id) : found;
		return { id: c.id, title: c.title, team: !!c.team_id, teamId: c.team_id ?? undefined };
	}
	if (ctx.session.canvas) {
		try {
			const c = await getCanvas(ctx.api, ctx.session.canvas);
			return { id: c.id, title: c.title, team: !!c.team_id, teamId: c.team_id ?? undefined };
		} catch (e) {
			if (!(e instanceof CliError && e.code === "NOT_FOUND")) throw e;
		}
	}
	if (opts.create !== undefined && dryRun) return { id: "(a new canvas)", title: opts.create, created: true };
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
async function toRef(ctx: Ctx, convId: string, cards: Card[], input: string, dry = false): Promise<Ref> {
	if (!isUrl(input) && !existsSync(resolve(input))) {
		const card = findCard(cards, input);
		// A text card is read by text models (its words go in the request); media models refuse it by name.
		if (!card.url && card.text) return { url: "", name: card.title ?? card.ref, media: "file", card };
		if (!card.url) throw new CliError(`${card.ref} (${card.kind}) has no finished media to use yet.`, "INVALID_PARAM");
		const media = card.kind === "image" || card.kind === "video" || card.kind === "audio" ? card.kind : mediaOf(card.url);
		return { url: card.url, name: card.title ?? card.ref, media, card };
	}
	// A dry run uploads nothing: the file stands in for its URL.
	if (dry && !isUrl(input)) return { url: `file://${resolve(input)}`, name: input.split("/").pop() ?? input, media: mediaOf(input) };
	const up = await toUrl(ctx.api, input, convId);
	if (!isUrl(input)) log(`Uploaded ${up.name}`);
	return up;
}

async function toRefs(ctx: Ctx, convId: string, cards: Card[], inputs: string[], dry = false) {
	const refs: Ref[] = [];
	for (const i of inputs) refs.push(await toRef(ctx, convId, cards, i, dry));
	return refs;
}

const timeoutOf = (a: Args, fallbackSec: number) => (num(a, "timeout") ?? fallbackSec) * 1000;

/**
 * Sends a placed card's generation and writes the send down (lib/ledger.ts). Refused (an answer under 500): the card
 * is marked as the canvas marks its own refusals. No answer (the connection failed, timed out or a gateway 5xx): the
 * card stays generating, since Flowith may have taken it; it is never marked failed, so nothing runs it twice.
 */
async function sendFor(
	ctx: Ctx,
	kind: Sent["kind"],
	body: Record<string, unknown>,
	card: { id: string; createdAt: string; type: string; data: Record<string, unknown> },
): Promise<Sent["answer"]> {
	const from = serverNow();
	const sent = { card: card.id, conv: String(body.convId), model: String(body.model), kind, from };
	// Written down before it goes out: if this process is stopped mid-send, the card still reads as possibly taken.
	noteSent({ ...sent, to: from, answer: "lost" });
	try {
		await send(ctx.api, kind, body);
		noteSent({ ...sent, to: serverNow(), answer: "taken" });
		return "taken";
	} catch (e) {
		// An answer under 500, or none to give at all (the sign-in was ended, a bad request caught here): not taken.
		const refused = e instanceof CliError && (e.status === undefined || e.status < 500);
		noteSent({ ...sent, to: serverNow(), answer: refused ? "refused" : "lost" });
		if (!refused) return "lost";
		await failCard(ctx.api, { id: card.id, createdAt: card.createdAt, type: card.type }, card.data, e);
		throw e;
	}
}

/** Sends every placed card's generation. A refusal marks its card (and is thrown when it was the only one); the ids
 * whose answer was lost come back. */
async function sendAll(ctx: Ctx, placed: Placed, request: (id: string) => { kind: Sent["kind"]; body: Record<string, unknown> }): Promise<string[]> {
	const lost: string[] = [];
	await Promise.all(
		placed.ids.map(async (id) => {
			const row = placed.rows.find((r) => r.id === id)!;
			const { kind, body } = request(id);
			try {
				const answer = await sendFor(ctx, kind, body, { id, createdAt: row.created_at, type: row.type, data: (row.data as Record<string, unknown>) ?? {} });
				if (answer === "lost") lost.push(id);
			} catch (e) {
				if (placed.ids.length === 1) throw e;
			}
		}),
	);
	return lost;
}

/** What these cards' sends were charged, tied to their attempts (lib/ledger.ts); null with the reason when it can't be told. */
async function chargedFor(ctx: Ctx, convId: string, cards: Result[], team = false) {
	const generated = cards.filter((c) => c.kind === "image" || c.kind === "video" || c.kind === "text");
	if (!generated.length) return {};
	if (team) return { chargedCredits: null, chargedNote: "Unknown: on a team canvas the team's payer is charged, and only they see those records." };
	// A refund of a failed run lands right after its card fails.
	await sleep(1500);
	try {
		const charge = chargeOf(sentOf(generated.map((c) => c.id)), await usageOf(ctx.api, convId), generated.length);
		return "credits" in charge ? { chargedCredits: charge.credits } : { chargedCredits: null, chargedNote: `Unknown: ${charge.unknown}.` };
	} catch {
		return { chargedCredits: null, chargedNote: "Unknown: the canvas's charges couldn't be read." };
	}
}

async function finish(ctx: Ctx, convId: string, results: Result[], extra: Record<string, unknown> = {}, opts: { charged?: boolean; team?: boolean } = {}) {
	const failed = results.filter((r) => r.status === "failed");
	const running = results.filter((r) => r.status === "running");
	const removed = results.filter((r) => r.status === "removed");
	const lost = running.filter((r) => r.code === "SENT_UNKNOWN");
	const unsent = running.filter((r) => r.code === "NOT_SENT");
	const halted = extra.stopped as { message?: string } | undefined;
	const charged = opts.charged && !running.length ? await chargedFor(ctx, convId, results, opts.team) : {};
	const stopped = failed.filter((r) => r.code === "NO_CREDITS" || r.code === "MODEL_LOCKED");
	const broken = failed.filter((r) => r.code !== "NO_CREDITS" && r.code !== "MODEL_LOCKED");
	const next = [
		...(stopped.length ? ["Stop: not enough credits, or the plan doesn't include this model. Tell the user (https://flowith.io/pricing); don't retry or switch models unasked."] : []),
		...(broken.length ? [`Failed: ${broken.map((r) => `${r.ref} (${r.error ?? r.code})`).join("; ")}. Transient failures: \`retry <ref>\`; refusals: change the prompt or model.`] : []),
		...(lost.length
			? [`No answer came back for ${lost.map((r) => r.ref).join(" ")}: Flowith may have taken it. \`wait ${lost.map((r) => r.ref).join(" ")}\` (it finishes if it was taken); \`retry\` checks the canvas's charges and only sends it again once it is clear it never arrived.`]
			: []),
		...(unsent.length ? [`Claimed for a retry but never sent: \`retry ${unsent.map((r) => r.ref).join(" ")}\` sends it.`] : []),
		...(running.length > lost.length + unsent.length ? [`Still generating: \`wait ${running.filter((r) => !lost.includes(r) && !unsent.includes(r)).map((r) => r.ref).join(" ")}\` later.`] : []),
		...(halted?.message ? [`Stopped before the rest: ${halted.message}`] : []),
		...(removed.length ? [`No longer on the canvas: ${removed.map((r) => r.ref).join(" ")}. Run \`look\` to see what is there now.`] : []),
	];
	out({
		canvas: convId,
		url: canvasUrl(ctx.site, convId),
		...extra,
		...charged,
		cards: results,
		...(next.length ? { next: next.join(" ") } : {}),
	});
	if (failed.length || lost.length || unsent.length || halted || removed.length) process.exitCode = 1;
}

/** Waits for the cards Flowith took and reports them all; a card whose send got no answer is reported, not waited on. */
async function waitAndReport(ctx: Ctx, a: Args, convId: string, ids: string[], fallbackSec: number, extra: Record<string, unknown> = {}, lostIds: string[] = [], charged = true) {
	const team = charged ? !!(await getCanvas(ctx.api, convId).catch(() => null))?.team_id : false;
	const taken = ids.filter((id) => !lostIds.includes(id));
	let last = -1;
	const waited = has(a, "no-wait") || !taken.length
		? cardsFrom(await fetchRowsById(ctx.api, taken)).map(resultOf)
		: await waitFor(ctx.api, taken, {
				timeoutMs: timeoutOf(a, fallbackSec),
				onTick: (done, total) => {
					if (done !== last) log(`${done}/${total} done`);
					last = done;
				},
			});
	const lost = lostIds.length
		? cardsFrom(await fetchRowsById(ctx.api, lostIds)).map((c) => ({ ...resultOf(c), ...(c.status === "running" ? { code: claimedNotSent(c) ? "NOT_SENT" : "SENT_UNKNOWN" } : {}) }))
		: [];
	const byId = new Map([...waited, ...lost].map((r) => [r.id, r]));
	await finish(ctx, convId, ids.map((id) => byId.get(id)).filter((r): r is Result => !!r), extra, { charged: charged && !has(a, "no-wait"), team });
}

// ---------- commands: session ----------

async function cmdLogin(a: Args) {
	const s = await login(agentName(a), (message) => process.stderr.write(`${message}\n`), { open: !has(a, "no-open"), site: flag(a, "site") });
	const claims = jwtClaims(s.accessToken);
	// The previous canvas-cowork's login (a copy of the browser's sign-in) is no longer used.
	const oldLogin = forgetOldLogin();
	out({ loggedIn: true, email: claims.email, site: s.site, worker: s.workerURL, canvas: s.canvas ?? null, ...(oldLogin ? { removedOldLogin: "~/.flowith/bot-session.json" } : {}) });
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
	const now = Date.now();
	const live = (rows ?? []).filter(
		(r) => !r.canceled && (!r.from_date || Date.parse(r.from_date) <= now) && (!r.to_date || Date.parse(r.to_date) > now),
	);
	// The balance Flowith shows: grants overdrawn by a run that cost more than they held go negative and count.
	const total = live.reduce((s, r) => s + (Number(r.remain_quota) || 0), 0);
	out({
		credits: Math.round(total * 100) / 100,
		note: "1 credit = $0.001. Some grants only cover certain model tiers; a negative grant is owed and comes off the rest.",
		grants: live
			.filter((r) => Number(r.remain_quota) !== 0)
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

function browserHandoff(url: string) {
	return { url, preferredMode: "codex-internal-browser" };
}

async function cmdNew(a: Args) {
	const ctx = await context(a);
	const title = a.pos.join(" ").trim() || "Untitled";
	const c = await createCanvas(ctx.api, ctx.userId, title);
	ctx.session.canvas = c.id;
	saveSession(ctx.session);
	const url = canvasUrl(ctx.site, c.id);
	const result = { canvas: c.id, title: c.title, url, active: true };
	if (has(a, "open")) {
		openUrl(url);
		return out(result);
	}
	out({ ...result, browserHandoff: browserHandoff(url) });
}

async function cmdUse(a: Args) {
	const ctx = await context(a);
	const ref = a.pos.join(" ").trim();
	if (!ref) throw new CliError("use <canvas id, prefix, title or URL>", "INVALID_PARAM");
	const c = await resolveCanvas(ctx.api, ctx.userId, ref, ctx.site);
	ctx.session.canvas = c.id;
	saveSession(ctx.session);
	out({ canvas: c.id, title: c.title, url: canvasUrl(ctx.site, c.id), active: true });
}

async function cmdOpen(a: Args) {
	const ctx = await context(a);
	const c = await canvasOf(ctx, a);
	const url = canvasUrl(ctx.site, c.id);
	if (has(a, "handoff")) return out({ canvas: c.id, title: c.title, url, browserHandoff: browserHandoff(url) });
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
	if (c.type === "22") bits.push("✗ no credits");
	else if (c.type === "25") bits.push("✗ needs a higher plan");
	else if (c.status && c.kind !== "group") bits.push(STATUS_MARK[c.status] ?? c.status);
	bits.push(`@${c.rect.x},${c.rect.y} ${c.rect.width}×${c.rect.height}`);
	const from = [...(c.madeFrom ?? []), ...(c.references ?? []), ...(c.follows ? [c.follows] : [])];
	if (from.length) bits.push(`← ${[...new Set(from)].map(short).join(",")}`);
	if (c.placedBy !== "you") bits.push(`(${c.placedBy === "flo" ? "Flo" : c.placedBy})`);
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
	const status = flag(a, "status");
	const by = flag(a, "by")?.toLowerCase();
	const matches = (c: Card) =>
		(!kind || c.kind === kind) &&
		(!status || (c.status === "init" ? "running" : c.status) === status) &&
		(!by || c.placedBy.toLowerCase() === by) &&
		(!words || [c.title, c.prompt, c.text, c.model, c.ref].some((v) => v?.toLowerCase().includes(words)));
	const hits = all.filter(matches);
	const hitIds = new Set(hits.map((c) => c.id));
	const parentIds = new Set(hits.map((c) => c.groupId));
	const included = all.filter((c) => hitIds.has(c.id) || parentIds.has(c.id) || (!kind && !status && !by && c.groupId && hitIds.has(c.groupId)));
	const byPosition = (a: Card, b: Card) => a.rect.y - b.rect.y || a.rect.x - b.rect.x || a.id.localeCompare(b.id);
	const groupIds = new Set(included.filter((card) => card.kind === "group").map((card) => card.id));
	const membersByGroup = new Map<string, Card[]>();
	const top = included.filter((card) => {
		if (card.kind === "group" || !card.groupId || !groupIds.has(card.groupId)) return true;
		const members = membersByGroup.get(card.groupId) ?? [];
		members.push(card);
		membersByGroup.set(card.groupId, members);
		return false;
	}).sort(byPosition);
	const cards = top.flatMap((card) => [card, ...(membersByGroup.get(card.id) ?? []).sort(byPosition)]);
	if (jsonOut) {
		return out({
			canvas: canvas.id,
			title: canvas.title,
			url: canvasUrl(ctx.site, canvas.id),
			cards: cards.map(({ row: _r, data: _d, ...c }) => ({ ...c, prompt: c.prompt?.slice(0, 400), text: c.text?.slice(0, 400) })),
		});
	}
	const byId = new Map(all.map((c) => [c.id, c]));
	const groups = cards.filter((c) => c.kind === "group");
	const counts = Object.entries(
		cards.filter((c) => c.kind !== "group").reduce<Record<string, number>>((m, c) => ((m[c.kind] = (m[c.kind] ?? 0) + 1), m), {}),
	)
		.map(([k, n]) => `${n} ${k}`)
		.join(", ");
	console.log(`Canvas "${canvas.title ?? "(untitled)"}" ${canvas.id}\n${canvasUrl(ctx.site, canvas.id)}\n${counts || "empty"}${groups.length ? `, ${groups.length} group${groups.length > 1 ? "s" : ""}` : ""}  (@x,y = top-left; ← = made from / uses)\n`);
	// What a tidy-up should fix: top-level boxes that cover each other.
	const overlaps: string[] = [];
	for (let i = 0; i < top.length; i++)
		for (let j = i + 1; j < top.length; j++) {
			const [p, q] = [top[i]!.rect, top[j]!.rect];
			if (p.x < q.x + q.width && q.x < p.x + p.width && p.y < q.y + q.height && q.y < p.y + p.height) overlaps.push(`${top[i]!.ref}×${top[j]!.ref}`);
		}
	if (overlaps.length) console.log(`Overlapping: ${overlaps.slice(0, 12).join(", ")}${overlaps.length > 12 ? " …" : ""}  (tidy, arrange or move fixes it)\n`);
	for (const c of top) {
		if (c.kind === "group") {
		const members = membersByGroup.get(c.id) ?? [];
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
	const files = await Promise.all(
		chosen.map(async (c) => {
			const src = has(a, "full") ? c.url : (c.preview ?? (c.kind === "image" ? c.url : undefined));
			if (!src) {
				return { ref: c.ref, kind: c.kind, skipped: c.kind === "video" ? "no preview frame yet; use --full for the clip" : "no media" };
			}
			const path = fileFor(dir, c.ref, c.title, src, c.kind === "video" && !has(a, "full") ? "jpg" : c.kind === "video" ? "mp4" : "png");
			try {
				await download(src, path);
				// A cut-out keeps its background colours under full transparency; most viewers draw them anyway.
				const head = readFileSync(path).subarray(0, 26);
				const alpha = head.length > 25 && head.readUInt32BE(0) === 0x89504e47 && (head[25] === 6 || head[25] === 4);
				return { ref: c.ref, kind: c.kind, title: c.title, file: path, ...(alpha ? { note: "PNG with transparency: transparent areas may still show colour in a viewer" } : {}) };
			} catch (e) {
				return { ref: c.ref, kind: c.kind, error: (e as Error).message };
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
	const [cards, catalog] = await Promise.all([canvas.created && dryRun ? ([] as Card[]) : readCanvas(ctx.api, canvas.id), catalogOf(ctx)]);
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
	// edit <card> "change A" "change B": one new picture per change, all from the same card.
	const prompts = (base ? a.pos.slice(1) : a.pos).map((p) => p.trim()).filter(Boolean);
	if (!prompts.length || !prompts[0]) throw new CliError(base ? 'edit <card> "what to change"' : 'image "prompt" ["prompt" …]', "INVALID_PARAM");
	const { ctx, canvas, cards, catalog } = await prepare(a, prompts[0]!);
	// --model a,b,c: the same prompt on several models (a comparison), one card each.
	const wanted = flags(a, "model");
	const models = (wanted.length ? wanted : [undefined]).map((w) => resolveModel(catalog, "image", w));
	const modelId = models.map((m) => m.id).join(", ");
	// Asked alongside the references: what this canvas's payer pays on each model (their member discounts).
	const rates = memberRates(ctx.api, canvas.teamId);
	const extraRefs = await toRefs(ctx, canvas.id, cards, flags(a, "ref"), dryRun);
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
	const rate = await rates;
	const estimates = jobs.map((j, i) => {
		const body = built[i]!.body as { quality?: string; aspect_ratio?: string; image_size?: string };
		const pixels = /^\d+x\d+$/.test(body.aspect_ratio ?? "") ? body.aspect_ratio : undefined;
		const list = estimateCredits(j.model, { quality: body.quality, pixels, size: body.image_size, refs: j.refs.length });
		return list === undefined ? undefined : atRate(list, rate?.[j.modelId]);
	});
	const credits = estimates.some((estimate) => estimate === undefined)
		? null
		: Math.round(estimates.reduce<number>((sum, estimate) => sum + (estimate ?? 0), 0) * 1000) / 1000;
	const pricing = {
		estimatedCredits: credits,
		...(credits === null
			? { estimateNote: "The catalogue has no price for at least one image request. Ask the user before running this batch." }
			: !rate
				? { estimateNote: "At list price: the user's member discounts couldn't be read, so the charge may be lower." }
				: {}),
	};
	if (has(a, "dry-run")) return out({ model: modelId, jobs: jobs.length, ...pricing, requests: built.map((b) => b.body) });
	const title = flag(a, "title");
	const items: NewCard[] = jobs.map((j, i) => {
		const ratio = built[i]!.ratio;
		const t = title
			? models.length > 1 ? `${title} · ${j.model.title ?? j.modelId}` : jobs.length > 1 ? `${title} ${i + 1}` : title
			: titleFrom(j.prompt);
		return {
			kind: "image",
			size: cardSize("image", ratio),
			data: {
				...imageCardData(j, t, ratio),
				...(title ? { customTitle: t } : {}),
				...(base ? { baseImageNodeId: base.source.id, baseImageUrl: base.source.url } : {}),
				agentRequest: { kind: "image", body: requestTemplate(built[i]!.body) },
			},
		};
	});
	const groupName = flag(a, "group") ?? (items.length > 1 ? title ?? titleFrom(prompts[0]!, 20) : undefined);
	const placed = await placeCards(ctx.api, canvas.id, cards, items, { anchor: anchorOf(a, cards, refs), group: groupName, into: intoOf(a, cards) });
	log(`Placed ${placed.ids.length} image card${placed.ids.length > 1 ? "s" : ""} (${modelId}, ${credits === null ? "no price estimate" : `~${credits} credits`}); generating…`);
	const lost = await sendAll(ctx, placed, (id) => ({ kind: "image", body: imageRequest(jobs[placed.ids.indexOf(id)]!, id, canvas.id).body }));
	await waitAndReport(ctx, a, canvas.id, placed.ids, 300, { model: modelId, ...pricing, ...(placed.groupId ? { group: placed.groupId.slice(0, 8) } : {}) }, lost);
}

/** Said where a clip's price can't be known before it is made. */
const UNPRICED = "Unknown until it is made (it depends on a source clip's length the CLI can't read, or on what the provider measures). Ask the user before running it.";

async function cmdVideo(a: Args) {
	let prompt = a.pos.join(" ").trim();
	const extend = flag(a, "extend");
	const editVideo = flag(a, "edit-video");
	const operation = extend ? "extend" : editVideo ? "edit" : undefined;
	if (!prompt && !operation && !flag(a, "first") && !flag(a, "from")) throw new CliError('video "prompt" [--first card|file] [--ref …]', "INVALID_PARAM");
	if (operation === "edit" && !prompt) throw new CliError('video --edit-video <clip> "what to change"', "INVALID_PARAM");
	const { ctx, canvas, cards, catalog } = await prepare(a, prompt || "Video");
	const clip = operation ? await toRef(ctx, canvas.id, cards, extend ?? editVideo!, dryRun) : undefined;
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
	const first = firstIn ? await toRef(ctx, canvas.id, cards, firstIn, dryRun) : undefined;
	const last = flag(a, "last") ? await toRef(ctx, canvas.id, cards, flag(a, "last")!, dryRun) : undefined;
	const refs = [...opRefs, ...(await toRefs(ctx, canvas.id, cards, flags(a, "ref"), dryRun))];
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
	// Source clips (references, or the clip extended / edited) and their lengths where their cards know them.
	const clips = [...(first ? [first] : []), ...(last ? [last] : []), ...refs].filter((r) => r.media === "video");
	const clipSeconds = clips.map((r) => Number(r.card?.data?.duration));
	const sources = clips.length ? { count: clips.length, seconds: clipSeconds.every((n) => n > 0) ? clipSeconds.reduce((x, y) => x + y, 0) : undefined } : undefined;
	const credits = await videoPrice(ctx.api, canvas.created ? undefined : canvas.id, preview.body, sources);
	if (has(a, "dry-run")) return out({ model: modelId, estimatedCredits: credits ?? null, ...(credits === undefined ? { estimateNote: UNPRICED } : {}), request: preview.body });
	const title = flag(a, "title") ?? (clip?.card && operation ? `${clip.card.title ?? "Clip"} · ${operation === "extend" ? "extended" : "edited"}` : titleFrom(a.pos.join(" ").trim() || "Video"));
	const ratio = preview.params.aspect_ratio && !["adaptive", "auto"].includes(preview.params.aspect_ratio) ? preview.params.aspect_ratio : "16:9";
	const placed = await placeCards(
		ctx.api,
		canvas.id,
		cards,
		// Named, or the worker names a finished clip by its prompt's first five characters.
		[{ kind: "video", size: cardSize("video", ratio), data: { ...videoCardData(job, title, preview.params, preview.audio), customTitle: title, agentRequest: { kind: "video", body: requestTemplate(preview.body) } } }],
		{ anchor, group: flag(a, "group"), into: intoOf(a, cards) },
	);
	const id = placed.ids[0]!;
	const row = placed.rows.find((r) => r.id === id)!;
	log(`Placed video card ${id.slice(0, 8)} (${modelId}, ${preview.params.duration ?? "?"} s, ~${credits ?? "?"} credits); generating…`);
	const lost = await sendAll(ctx, placed, () => ({ kind: "video", body: videoRequest(job, id, canvas.id, row.p_id ?? canvas.id, row.position ?? { x: 0, y: 0 }).body }));
	await waitAndReport(ctx, a, canvas.id, [id], 900, { model: modelId, estimatedCredits: credits ?? null, ...(credits === undefined ? { estimateNote: UNPRICED } : {}) }, lost);
}

async function cmdText(a: Args) {
	const prompt = a.pos.join(" ").trim();
	if (!prompt) throw new CliError('text "prompt" [--model a,b] [--ref card]', "INVALID_PARAM");
	const { ctx, canvas, cards, catalog } = await prepare(a, prompt);
	const wanted = flags(a, "model");
	const models = (wanted.length ? wanted : [undefined]).map((w) => resolveModel(catalog, "text", w));
	const refs = await toRefs(ctx, canvas.id, cards, flags(a, "ref"), dryRun);
	const title = flag(a, "title") ?? titleFrom(prompt);
	const jobs: TextJob[] = models.map((m) => ({ prompt, modelId: m.id, system: flag(a, "system"), refs }));
	if (has(a, "dry-run")) return out({ requests: jobs.map((j) => textRequest(j, "00000000-0000-0000-0000-000000000000", canvas.id)) });
	// Several models: each card names its model, so the comparison reads at a glance.
	const items: NewCard[] = jobs.map((j) => ({
		kind: "text",
		size: cardSize("text"),
		data: {
			...textCardData(
				j,
				models.length > 1 ? `${flag(a, "title") ?? titleFrom(prompt, 10)} · ${catalog[j.modelId]?.title ?? j.modelId}` : title,
				Boolean(flag(a, "title")) || models.length > 1,
			),
			agentRequest: { kind: "text", body: requestTemplate(textRequest(j, "x", "x")) },
		},
	}));
	const placed = await placeCards(ctx.api, canvas.id, cards, items, {
		anchor: anchorOf(a, cards, refs),
		group: flag(a, "group") ?? (items.length > 1 ? title : undefined),
		into: intoOf(a, cards),
	});
	log(`Placed ${items.length} text card${items.length > 1 ? "s" : ""} (${models.map((m) => m.id).join(", ")}); writing…`);
	const lost = await sendAll(ctx, placed, (id) => ({ kind: "text", body: textRequest(jobs[placed.ids.indexOf(id)]!, id, canvas.id) }));
	await waitAndReport(ctx, a, canvas.id, placed.ids, 600, {}, lost);
}

async function cmdSound(a: Args, tool: "gen_speech" | "gen_music") {
	const words = a.pos.join(" ").trim();
	if (!words) throw new CliError(tool === "gen_speech" ? 'speech "text to say" [--for card]' : 'music "style / mood" [--for card]', "INVALID_PARAM");
	const ctx = await context(a);
	const canvas = await canvasOf(ctx, a, { create: titleFrom(words, 24) });
	const [cards, catalog] = await Promise.all([canvas.created && dryRun ? ([] as Card[]) : readCanvas(ctx.api, canvas.id), catalogOf(ctx)]);
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
					instrumental: has(a, "instrumental") || (!flag(a, "lyrics") && !has(a, "vocals")),
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
	await finish(ctx, canvas.id, cardsFrom(rows).map(resultOf), { model: modelId, estimatedCredits: credits, source: source.ref });
}

async function cmdVary(a: Args) {
	const ctx = await context(a);
	const canvas = await canvasOf(ctx, a);
	const cards = await readCanvas(ctx.api, canvas.id);
	const src = findCard(cards, a.pos[0] ?? "");
	const req = src.data.agentRequest as { kind?: "image" | "video" | "text"; body?: Record<string, unknown> } | undefined;
	// A card this CLI made carries its exact request: the same request again, as new cards beside it.
	if (req?.kind && req.body && !flag(a, "model")) {
		const n = Math.max(1, Math.min(8, num(a, "n") ?? 1));
		if (dryRun) return out({ vary: src.ref, copies: n, request: req.body });
		const { error: _e, error_type: _t, error_code: _c, request_id: _r, group_id: _g, customTitle: _ct, ...data } = src.data;
		const kind = req.kind === "video" ? "video" : req.kind === "text" ? "text" : "image";
		const size = kind === "text" ? cardSize("text") : { width: src.rect.width, height: src.rect.height };
		const items: NewCard[] = Array.from({ length: n }, () => ({ kind, size, data: { ...data, value: "", status: "running", ...(kind === "video" ? { videoId: null } : {}) } }));
		const placed = await placeCards(ctx.api, canvas.id, cards, items, { anchor: src, group: n > 1 ? flag(a, "group") ?? `${src.title ?? "Variations"}` : undefined });
		const rowOf = (id: string) => placed.rows.find((r) => r.id === id)!;
		const lost = await sendAll(ctx, placed, (id) => ({
			kind: req.kind!,
			body: { ...req.body, nodeId: id, convId: canvas.id, ...(kind === "video" ? { parentNodeId: rowOf(id).p_id ?? canvas.id, position: rowOf(id).position ?? { x: 0, y: 0 } } : {}) },
		}));
		return waitAndReport(ctx, a, canvas.id, placed.ids, kind === "video" ? 900 : 300, placed.groupId ? { group: placed.groupId.slice(0, 8) } : {}, lost);
	}
	if (src.kind === "text" && src.prompt && src.model) {
		const next = parseArgs(["text", src.prompt, "--model", flag(a, "model") ?? src.model, "--near", src.ref]);
		for (const [k, v] of a.flags) if (k !== "model") next.flags.set(k, v);
		return cmdText(next);
	}
	if (src.kind !== "image" && src.kind !== "video") throw new CliError("vary takes a picture, clip or text card.", "INVALID_PARAM");
	if (!src.prompt || !src.model) throw new CliError(`${src.ref} has no prompt/model to run again.`, "INVALID_PARAM");
	// Frames are not references: the first / last frame card goes back as a frame.
	const frames = [src.data.baseImageNodeId, src.data.lastFrameNodeId].filter(Boolean);
	const refs = (src.data.promptReferenceNodes ?? [])
		.filter((p: { id: string }) => !frames.includes(p.id))
		.map((p: { id: string }) => cards.find((c) => c.id === p.id)?.ref)
		.filter(Boolean) as string[];
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
	if (dryRun)
		return out({
			tool,
			source: source.ref,
			kind: source.kind,
			...(tool === "expand" ? { ratio: flag(a, "ratio") ?? a.pos[1] } : {}),
			...(tool === "upscale" ? { to: flag(a, "to") ?? "next size up", quality: flag(a, "quality") ?? "fast" } : {}),
			note: "Nothing sent. The canvas prices card tools when they run; `spent` shows the charge afterwards.",
		});
	let placed;
	if (tool === "upscale") placed = source.kind === "video" ? await upscaleVideo(ctx.api, canvas.id, cards, source, flag(a, "to"), flag(a, "quality")) : await upscaleImage(ctx.api, canvas.id, cards, source, flag(a, "to"));
	else if (tool === "cutout") placed = await cutout(ctx.api, canvas.id, cards, source);
	else {
		const ratio = flag(a, "ratio") ?? a.pos[1];
		if (!ratio) throw new CliError("expand <card> --ratio 16:9", "INVALID_PARAM");
		placed = await expand(ctx.api, canvas.id, cards, source, ratio);
	}
	log(`${tool} started on ${source.ref} → ${placed.ids[0]!.slice(0, 8)}`);
	await waitAndReport(ctx, a, canvas.id, placed.ids, source.kind === "video" ? 1200 : 600, {}, [], false);
}


/**
 * What this machine's send record says about a card now. A claim for a retry whose answer was lost is read through:
 * it took and the card is untouched since (its mark, its data as the claim wrote it): "unsent", nothing went; it took
 * but the card changed since (it may have been run from the page): a send whose answer was lost, from the claim on; it
 * didn't take: what the record before it says.
 */
function sendState(card: Card, record = sentOf([card.id])[0]): Sent | "unsent" | undefined {
	let s = record;
	while (s?.answer === "claiming") {
		if (s.attempt && card.data.agentAttempt === s.attempt) return s.fingerprint === fingerprint(card.data) ? "unsent" : { ...s, answer: "lost" };
		s = s.prev;
	}
	return s;
}

/** A card this machine claimed for a retry whose request never went. */
const claimedNotSent = (card: Card) => sendState(card) === "unsent";

/** A request as stored on its card (for `retry`): without the ids and placement it gets when sent. */
function requestTemplate(body: Record<string, unknown>) {
	const { nodeId: _n, convId: _c, parentNodeId: _p, position: _pos, ...rest } = body;
	return rest;
}

/**
 * Runs failed cards again in place. A card still generating, or finished, is never sent again (it would be charged
 * twice and the results would overwrite each other). One whose send got no answer is sent again only once it is clear
 * it never arrived: no charge began while it was sent, and it has stayed generating longer than such a run takes.
 *
 * Decided twice: on the first read, and again on a fresh read once this machine holds the cards (another retry may
 * have run them while the first read was on its way). Each card is then claimed in Flowith only if it is still exactly
 * as read, so a retry from another machine or tab that got there first wins and this one sends nothing.
 */
async function cmdRetry(a: Args) {
	const ctx = await context(a);
	const canvas = await canvasOf(ctx, a);
	const cards = await readCanvas(ctx.api, canvas.id);
	const requestOf = (c: Card) => c.data.agentRequest as { kind?: "image" | "video" | "text"; body?: Record<string, unknown> } | undefined;
	// Someone (the canvas page, another agent) claimed it for a run in the last two hours and it is running: not a failed
	// card, whatever its type (a credits card becomes a picture or clip again only once the worker takes the request).
	const claimedLive = (c: Card) =>
		(c.status === "running" || c.status === "init") && serverNow() - Date.parse(String(c.data.agentAttemptAt ?? "")) < 2 * 3_600_000;
	const failed = (c: Card) => c.status === "failed" || ((c.type === "22" || c.type === "25") && !claimedLive(c));
	// Each card once, however often it is named (a ref and its title are the same card).
	const named = [...new Map(a.pos.map((r) => findCard(cards, r)).map((c) => [c.id, c])).values()];
	const candidates = named.length ? named : cards.filter(failed);
	// Checked before anything is sent: only cards carrying their own request run again.
	const chosen = candidates.filter((c) => requestOf(c)?.kind && requestOf(c)?.body);
	const skipped = candidates.filter((c) => !chosen.includes(c)).map((c) => c.ref);
	if (named.length && skipped.length)
		throw new CliError(`${skipped.join(", ")} weren't made by this CLI's generation, so their request isn't on the card. Use \`vary\` or make them again.`, "INVALID_PARAM");
	if (!chosen.length) return out({ canvas: canvas.id, note: skipped.length ? `Nothing to retry here (${skipped.join(", ")} weren't made by this CLI).` : "Nothing failed." });
	/** Why a card may not run again now, as read (its send record read now too); undefined when it may. */
	const whyNot = (card: Card, records: Awaited<ReturnType<typeof usageOf>>): CliError | undefined => {
		const req = requestOf(card);
		if (!req?.kind || !req.body) return new CliError(`${card.ref}'s request is no longer on the card.`, "INVALID_PARAM");
		if (failed(card)) return;
		if (card.status === "finished") return new CliError(`${card.ref} is finished; \`vary ${card.ref}\` makes another take beside it.`, "INVALID_PARAM");
		const sent = sendState(card);
		// Claimed by this machine and never sent: it goes now.
		if (sent === "unsent") return;
		if (sent?.answer !== "lost") return new CliError(`${card.ref} is still generating: \`wait ${card.ref}\`.`, "BUSY");
		if (canvas.team)
			return new CliError(`No answer came back for ${card.ref}, and on a team canvas the team's charges can't be read to tell whether it arrived, so it isn't sent again. \`wait ${card.ref}\`; if it never finishes, delete it and make it again.`, "BUSY");
		if (chargedSince(sent, records, serverNow()))
			return new CliError(`${card.ref} did reach Flowith (a ${sent.model} charge began on this canvas after it was sent): \`wait ${card.ref}\` for the result.`, "BUSY");
		const left = sent.to + SETTLE_MS[req.kind] - serverNow();
		if (left > 0)
			return new CliError(`No charge for ${card.ref} so far, but it may still be on its way. \`wait ${card.ref}\`; if it is still generating in ${Math.ceil(left / 60_000)} min, retry then.`, "BUSY");
	};
	const chargesFor = (list: Card[]) => (list.some((c) => !failed(c)) ? usageOf(ctx.api, canvas.id) : Promise.resolve([]));
	const first = await chargesFor(chosen);
	for (const card of chosen) {
		const why = whyNot(card, first);
		if (why) throw why;
	}
	if (dryRun) return out({ retry: chosen.map((c) => ({ ref: c.ref, kind: requestOf(c)!.kind, model: requestOf(c)!.body!.model })), ...(skipped.length ? { skipped } : {}) });
	// Two retries of one card on this machine: the second finds it held.
	const claimed: string[] = [];
	const busy = chosen.find((c) => (claimRetry(c.id) ? (claimed.push(c.id), false) : true));
	if (busy) {
		claimed.forEach(releaseRetry);
		throw new CliError(`${busy.ref} is being retried by another command: \`wait ${busy.ref}\`.`, "BUSY");
	}
	const ids: string[] = [];
	const lost: string[] = [];
	/** Cards not sent, each with why: they changed between the first read and now. */
	const notSent: CliError[] = [];
	/** What stopped the rest of the batch (a refusal, no answer to a claim, a login that ended); those sent are still reported. */
	let stopped: CliError | undefined;
	try {
		// The first read may be stale by now (another retry may have run these cards meanwhile): each card is decided
		// again on a fresh read, with its send record as it is now; one that changed is left out, the rest still go.
		const fresh = cardsFrom(await fetchRowsById(ctx.api, chosen.map((c) => c.id)));
		for (const c of chosen) if (!fresh.some((f) => f.id === c.id)) notSent.push(new CliError(`${c.ref} is no longer on the canvas.`, "NOT_FOUND"));
		const records = await chargesFor(fresh);
		for (const card of fresh) {
			const why = whyNot(card, records);
			if (why) {
				notSent.push(why);
				continue;
			}
			const req = requestOf(card)!;
			const {
				error: _e, error_type: _t, error_code: _c, request_id: _r,
				errorMessage: _m, creditFailureReason: _cr, creditFailureStage: _cs, creditFailureCode: _cc, httpCode: _h, attemptedModel: _a,
				...rest
			} = card.data;
			// A fresh retry mark: a retry elsewhere that read the card before this one can no longer claim it. With when it
			// was made (server time), so the canvas page tells this live run from a stale card and won't retry it on top.
			const data = {
				...rest, value: "", status: "running", agentAttempt: crypto.randomUUID(), agentAttemptAt: new Date(serverNow()).toISOString(),
				...(req.kind === "video" ? { videoId: null } : {}),
			};
			// A refusal may have turned it into the canvas's credits or upgrade card: back to the card it was.
			const type = card.type === "22" || card.type === "25" ? (req.kind === "video" ? "13" : "2") : card.type;
			// Written down before the claim, with its mark: if the claim's answer is lost, the next retry sees whether it
			// took (the card carries the mark, nothing sent: it goes at once) or not. Put back when it surely didn't happen.
			const before = sentOf([card.id])[0];
			const putBack = () => (before ? noteSent(before) : forgetSent(card.id));
			const at = serverNow();
			// The record before, as what it means now (a claim of its own read through), so a chain of lost claims stays short.
			const state = sendState(card, before);
			const prev = state === "unsent" ? { ...before!, prev: undefined } : state;
			noteSent({
				card: card.id, conv: canvas.id, model: String(req.body!.model), kind: req.kind!, from: at, to: at,
				answer: "claiming", attempt: data.agentAttempt, fingerprint: fingerprint(data), ...(prev ? { prev } : {}),
			});
			let outcome;
			try {
				outcome = await claim(ctx.api, card, { ...(type !== card.type ? { type } : {}), data });
			} catch (e) {
				// An answer (or none needed: the login ended before it went) means the claim surely didn't happen.
				if (e instanceof CliError && (e.status === undefined || e.status < 500)) {
					putBack();
					stopped = e;
					break;
				}
				// No answer: read the card back. Carrying this claim's mark, it took (nothing sent yet): go on. Otherwise it
				// hasn't taken (yet); the claiming record stays, so a late one is still sent once and never twice.
				const back = await fetchRowsById(ctx.api, [card.id]).then(cardsFrom).catch(() => undefined);
				if (back?.[0]?.data.agentAttempt === data.agentAttempt) outcome = "done";
				else if (back) {
					notSent.push(new CliError(`No answer came back while claiming ${card.ref}, and the claim hasn't taken; nothing was sent. \`retry ${card.ref}\` again.`, "SERVER_ERROR"));
					continue;
				} else {
					stopped = new CliError(`No answer came back while claiming ${card.ref} (${e instanceof Error ? e.message : String(e)}); nothing was sent. \`retry ${card.ref}\` again: it carries on from here.`, "SERVER_ERROR");
					break;
				}
			}
			if (outcome !== "done") {
				putBack();
				if (outcome === "forbidden") {
					stopped = new CliError(`${card.ref} couldn't be changed: it isn't yours to edit on this canvas.`, "FORBIDDEN");
					break;
				}
				notSent.push(
					outcome === "gone" ? new CliError(`${card.ref} is no longer on the canvas.`, "NOT_FOUND")
					: outcome === "unchecked" ? new CliError(`${card.ref} wasn't claimed, and reading it back to tell why failed; nothing was sent: retry it again.`, "SERVER_ERROR")
					: new CliError(`${card.ref} changed since it was read (another retry, on another machine, ran it first; or its result came in).`, "BUSY"),
				);
				continue;
			}
			const body = {
				...req.body,
				nodeId: card.id,
				convId: canvas.id,
				...(req.kind === "video" ? { parentNodeId: card.row.p_id ?? canvas.id, position: card.row.position ?? { x: 0, y: 0 }, rerun: true } : {}),
			};
			log(`Retrying ${card.ref} (${req.kind}, ${String(req.body!.model)})…`);
			try {
				if ((await sendFor(ctx, req.kind!, body, { id: card.id, createdAt: card.createdAt, type, data })) === "lost") lost.push(card.id);
				ids.push(card.id);
			} catch (e) {
				// Refused (and its card marked): the rest would most likely be refused too.
				stopped = e instanceof CliError ? e : new CliError(String(e), "SERVER_ERROR");
				break;
			}
		}
	} finally {
		claimed.forEach(releaseRetry);
	}
	if (!ids.length) {
		if (stopped) throw stopped;
		throw notSent.length === 1 ? notSent[0]! : new CliError(`Nothing was sent. ${notSent.map((e) => e.message).join(" ")}`, "BUSY");
	}
	await waitAndReport(ctx, a, canvas.id, ids, chosen.some((c) => c.kind === "video") ? 900 : 300, {
		...(notSent.length ? { notRetried: notSent.map((e) => e.message) } : {}),
		...(stopped ? { stopped: { error: stopped.code, message: stopped.message } } : {}),
	}, lost);
}

async function cmdSpent(a: Args) {
	const ctx = await context(a);
	const canvas = await canvasOf(ctx, a);
	const res = await worker<{ data?: Array<{ model: string; tokens_used: number; billing_unit_price: number | null; created_at: string }> }>(
		ctx.api,
		`/user/model-usage/group-records?groupIds=${canvas.id}`,
	);
	const sinceArg = flag(a, "since");
	const since = sinceArg ? Date.now() - (Number(sinceArg.replace(/[^0-9.]/g, "")) || 0) * (/h$/.test(sinceArg) ? 3_600_000 : /s$/.test(sinceArg) ? 1000 : 60_000) : 0;
	const rows = (res?.data ?? []).filter((r) => Date.parse(r.created_at) >= since);
	const byModel: Record<string, number> = {};
	for (const r of rows) byModel[r.model] = (byModel[r.model] ?? 0) + creditsOf(r);
	const total = Object.values(byModel).reduce((x, y) => x + y, 0);
	out({
		canvas: canvas.id,
		...(sinceArg ? { since: new Date(since).toISOString() } : {}),
		chargedCredits: Math.round(total * 100) / 100,
		byModel: Object.fromEntries(Object.entries(byModel).sort((p, q) => q[1] - p[1]).map(([k, v]) => [k, Math.round(v * 100) / 100])),
		note: "Everything charged on this canvas (by you, Flo, other tabs and agents), refunds included; 1 credit = $0.001.",
	});
}

// ---------- commands: placing & organising ----------

/** A finished text card holding given words, as the canvas marks text a person wrote (frontend user-text-node.ts): its footer names the author, not a model. */
const noteData = (text: string, title?: string) => ({
	value: text,
	isImage: false,
	mode: "text",
	tag: { text: "User Upload" },
	status: "finished",
	title: title ?? titleFrom(text),
	...(title ? { customTitle: title } : {}),
});

async function cmdAdd(a: Args) {
	if (!a.pos.length) throw new CliError("add <file|url> […]", "INVALID_PARAM");
	if (dryRun) return out({ add: a.pos, note: "Nothing uploaded or placed." });
	const ctx = await context(a);
	const canvas = await canvasOf(ctx, a, { create: "Imports" });
	const cards = await readCanvas(ctx.api, canvas.id);
	const items: NewCard[] = [];
	for (const input of a.pos) {
		const up = await toUrl(ctx.api, input, canvas.id);
		// Named like a file the user uploads in the canvas: the file name as it is.
		const title = flag(a, "title") ?? up.name;
		const common = { title, name: up.name, value: up.url, insert: true, mediaSource: "upload", uploadState: "ready", status: "finished" };
		if (up.media === "image") {
			const { remoteImageSize } = await import("./lib/media.ts");
			const size = await remoteImageSize(up.url);
			const ratio = size ? `${size.width}:${size.height}` : "1:1";
			items.push({ kind: "image", size: cardSize("image", ratio), data: { ...common, isImage: true, mode: "image", aspect_ratio: ratio } });
		} else if (up.media === "video") items.push({ kind: "video", size: cardSize("video", flag(a, "ratio") ?? "16:9"), data: { ...common, videoId: up.url, aspect_ratio: flag(a, "ratio") ?? "16:9" } });
		else if (up.media === "audio") items.push({ kind: "audio", size: cardSize("audio"), data: { ...common, audioUrl: up.url } });
		else throw new CliError(`${up.name}: add takes pictures, clips and sounds.`, "INVALID_PARAM");
		log(`Uploaded ${up.name}`);
	}
	const placed = await placeCards(ctx.api, canvas.id, cards, items, { anchor: anchorOf(a, cards, []), group: flag(a, "group"), into: intoOf(a, cards) });
	await finish(ctx, canvas.id, cardsFrom(placed.rows).filter((c) => c.kind !== "group").map(resultOf), placed.groupId ? { group: placed.groupId.slice(0, 8) } : {});
}

async function cmdNote(a: Args) {
	const text = a.pos.join(" ").trim() || (flag(a, "file") ? readFileSync(flag(a, "file")!, "utf8") : "");
	if (!text) throw new CliError('note "text" (or --file notes.md)', "INVALID_PARAM");
	if (dryRun) return out({ note: text.slice(0, 200), chars: text.length });
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
	await finish(ctx, canvas.id, cardsFrom(placed.rows).map(resultOf));
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
		// The frame keeps its corner unless its new size would cover a card; then it moves to the nearest free place.
		const others = obstaclesOf(cards, [group.id, ...members.map((m) => m.id)]);
		let corner = { x: group.rect.x, y: group.rect.y };
		if (!isClear({ ...corner, width: layout.width, height: layout.height }, others)) corner = nearestFree({ width: layout.width, height: layout.height }, corner, others);
		await Promise.all(members.map((m, i) => patch(ctx.api, m, { position: { x: Math.round(layout.members[i]!.x + m.rect.width / 2), y: Math.round(layout.members[i]!.y) } })));
		await patch(ctx.api, group, {
			position: { x: Math.round(corner.x + layout.width / 2), y: corner.y },
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
		const { rest } = await import("./lib/http.ts");
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
	const { rest } = await import("./lib/http.ts");
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
	const chosen = a.pos.map((r) => findCard(cards, r, { strict: true }));
	if (!chosen.length) throw new CliError("delete <card> […]", "INVALID_PARAM");
	if (dryRun) return out({ wouldDelete: chosen.map((c) => ({ ref: c.ref, kind: c.kind, title: c.title, ...(c.kind === "group" ? { withCards: cards.filter((m) => m.groupId === c.id).length } : {}) })) });
	// A group goes with its cards, as on the canvas.
	const ids = [...new Set(chosen.flatMap((c) => (c.kind === "group" ? [c.id, ...cards.filter((m) => m.groupId === c.id).map((m) => m.id)] : [c.id])))];
	// A group whose every card goes would stay as an empty frame: it goes too.
	const gone = new Set(ids);
	for (const g of cards) {
		const members = cards.filter((m) => m.groupId === g.id);
		if (g.kind === "group" && !gone.has(g.id) && members.length && members.every((m) => gone.has(m.id))) ids.push(g.id);
	}
	await deleteCards(ctx.api, canvas.id, ids);
	out({ deleted: ids.map((id) => id.slice(0, 8)) });
}

async function cmdWait(a: Args) {
	const ctx = await context(a);
	const canvas = await canvasOf(ctx, a);
	const cards = await readCanvas(ctx.api, canvas.id);
	const chosen = a.pos.length ? a.pos.map((r) => findCard(cards, r)) : cards.filter((c) => c.status === "running" || c.status === "init");
	if (!chosen.length) return out({ canvas: canvas.id, cards: [], note: "Nothing is generating." });
	// A card claimed for a retry whose request never went would never finish: reported, not waited on.
	await waitAndReport(ctx, a, canvas.id, [...new Set(chosen.map((c) => c.id))], 900, {}, chosen.filter(claimedNotSent).map((c) => c.id));
}

// ---------- commands: run by the open canvas ----------

/**
 * A canvas from before layoutCanvas (a release not yet on that site: flowith.io until it takes the 2026-11-24 page)
 * refuses it as an unknown operation, and still answers the old getCanvasLayout and arrangeCanvasNodes. A busy canvas
 * was answered already: asking it again the old way would only wait behind the same operation.
 */
const askOlderPage = (error: unknown) => error instanceof CliError && error.code === "CANVAS_ERROR" && !/\bis busy\b/.test(error.message);

/** Hands an operation to the browser window that has this canvas open (see lib/live.ts). */
async function browserOperation(ctx: Ctx, a: Args, convId: string, operation: string, input: Record<string, unknown>, fallbackSec: number) {
	const url = canvasUrl(ctx.site, convId);
	log(`Asking the open canvas to run ${operation}…`);
	const result = await runOnCanvas(ctx.api, { sessionId: ctx.session.botSessionId, key: ctx.session.agentKey }, ctx.userId, convId, operation, input, {
		timeoutMs: timeoutOf(a, fallbackSec),
		canvasUrl: url,
		onAccepted: () => log("The canvas took it on."),
	});
	if (!result.ok) throw new CliError(result.error || `${operation} failed on the canvas.`, "CANVAS_ERROR", { operation, operationId: result.operationId, canvasUrl: url });
	return result;
}

async function cmdSelection(a: Args) {
	const ctx = await context(a);
	const canvas = await canvasOf(ctx, a);
	// layoutCanvas is no viewport operation on the page: queued behind another canvas operation, it is answered "busy"
	// within 8 minutes, so the read waits as long as the other layout commands do.
	let result: CanvasResult;
	try {
		result = await browserOperation(ctx, a, canvas.id, "layoutCanvas", { script: SELECTION_SCRIPT }, operationWaitSec("layoutCanvas"));
	} catch (error) {
		// The old read, on a canvas that predates layoutCanvas (see askOlderPage).
		if (!askOlderPage(error)) throw error;
		result = await browserOperation(ctx, a, canvas.id, "getCanvasLayout", { selectionOnly: true }, operationWaitSec("getCanvasLayout")).catch(() => { throw error; });
	}
	const layout = result.layout as { nodes?: Array<{ id: string; selected?: boolean; hidden?: boolean }> } | undefined;
	// Older canvas versions ignore selectionOnly and still return the full layout.
	const nodeIds = printedIds(result.data) ?? result.nodeIds ?? layout?.nodes?.filter((node) => node.selected && !node.hidden).map((node) => node.id);
	if (!Array.isArray(nodeIds)) throw new CliError("The browser did not return the current selection. Bring the canvas forward and try again.", "CANVAS_ERROR");
	const selected = [...new Set(nodeIds.filter(isUuid))];
	const byId = new Map<string, Card>();
	for (let i = 0; i < selected.length; i += 100) {
		const rows = await fetchRowsById(ctx.api, selected.slice(i, i + 100));
		for (const card of cardsFrom(rows.filter((row) => row.conv_id === canvas.id))) byId.set(card.id, card);
	}
	out({
		canvas: canvas.id,
		url: canvasUrl(ctx.site, canvas.id),
		cards: selected.map((id) => {
			const card = byId.get(id);
			if (!card) return { id, ref: id.slice(0, 8), status: "unsaved" };
			const { ref, kind, title, status } = resultOf(card);
			return { id, ref, kind, title, status };
		}),
	});
}

async function onCanvas(
	a: Args,
	operation: string,
	build: (cards: Card[]) => Record<string, unknown>,
	waitSec = 0,
	older?: { operation: string; build: (cards: Card[]) => Record<string, unknown> },
) {
	const ctx = await context(a);
	const canvas = await canvasOf(ctx, a);
	const cards = await readCanvas(ctx.api, canvas.id);
	const input = build(cards);
	let res: CanvasResult;
	try {
		res = await browserOperation(ctx, a, canvas.id, operation, input, operationWaitSec(operation, waitSec));
	} catch (error) {
		// The same request in the operation an older page still has (see askOlderPage).
		if (!older || !askOlderPage(error)) throw error;
		res = await browserOperation(ctx, a, canvas.id, older.operation, older.build(cards), operationWaitSec(older.operation, waitSec)).catch(() => { throw error; });
	}
	// A layout names the cards it moved.
	const ids = (res.nodeIds ?? (res.changedNodeIds as string[] | undefined) ?? []).filter((id) => isUuid(id));
	const { kind: _k, ok: _ok, nodeIds: _n, ...extra } = res;
	if (waitSec && ids.length && !has(a, "no-wait")) {
		const rows = cardsFrom(await fetchRowsById(ctx.api, ids));
		const generating = rows.filter((c) => c.status === "running" || c.status === "init").map((c) => c.id);
		if (generating.length) return waitAndReport(ctx, a, canvas.id, ids, waitSec, { operation, ...extra }, [], false);
	}
	const rows = ids.length ? cardsFrom(await fetchRowsById(ctx.api, ids)) : [];
	const results = new Map(rows.map((card) => [card.id, resultOf(card)]));
	out({ canvas: canvas.id, url: canvasUrl(ctx.site, canvas.id), operation, ...extra, cards: ids.map((id) => results.get(id) ?? { id, ref: id.slice(0, 8) }) });
}

const idOf = (cards: Card[], ref: string | undefined, what = "card") => {
	if (!ref) throw new CliError(`Name the ${what}.`, "INVALID_PARAM");
	return findCard(cards, ref).id;
};

const ON_CANVAS: Record<string, (a: Args) => Promise<unknown>> = {
	selection: cmdSelection,
	focus: (a) => onCanvas(a, "focusCanvasNodes", (cards) => {
		if (!a.pos.length) throw new CliError("Name at least one card to focus.", "INVALID_PARAM");
		return { nodeIds: a.pos.map((r) => idOf(cards, r)) };
	}),
	tidy: (a) =>
		onCanvas(a, "layoutCanvas", (cards) => ({ script: tidyScript(a.pos.map((r) => idOf(cards, r)), flag(a, "as")) }), 0, {
			operation: "arrangeCanvasNodes",
			build: (cards) => ({
				...(a.pos.length ? { nodeIds: a.pos.map((r) => idOf(cards, r)) } : {}),
				...(flag(a, "as") ? { layout: flag(a, "as") } : {}),
			}),
		}),
	split: (a) =>
		onCanvas(a, "cardTool", (cards) => ({ nodeId: idOf(cards, a.pos[0]), tool: "split", rows: num(a, "rows") ?? 2, cols: num(a, "cols") ?? 2 }), 300),
	angles: (a) =>
		onCanvas(a, "cardTool", (cards) => ({ nodeId: idOf(cards, a.pos[0]), tool: "angles", ...(flags(a, "angles").length ? { angles: flags(a, "angles") } : {}) }), 600),
	relight: (a) => onCanvas(a, "cardTool", (cards) => ({ nodeId: idOf(cards, a.pos[0]), tool: "relight", relightPreset: flag(a, "preset") ?? "golden" }), 600),
	lipsync: (a) => onCanvas(a, "cardTool", (cards) => ({ nodeId: idOf(cards, a.pos[0], "clip"), tool: "lipsync", withNodeId: idOf(cards, flag(a, "with"), "sound card (--with)") }), 1200),
	motion: (a) =>
		onCanvas(a, "cardTool", (cards) => ({ nodeId: idOf(cards, a.pos[0], "clip"), tool: "motion-transfer", withNodeId: idOf(cards, flag(a, "with"), "character picture (--with)") }), 1200),
	soundtrack: (a) =>
		onCanvas(
			a,
			"cardTool",
			(cards) => ({
				nodeId: idOf(cards, a.pos[0], "clip"),
				tool: "soundtrack",
				soundtrack: flag(a, "voice") ? "voice" : "music",
				...(flag(a, "voice") && flag(a, "voice") !== "true" ? { text: flag(a, "voice") } : {}),
			}),
			1200,
		),
	breakdown: (a) => onCanvas(a, "breakdownVideo", (cards) => ({ nodeId: idOf(cards, a.pos[0], "clip"), layoutReference: has(a, "layout") }), 900),
	character: (a) =>
		onCanvas(a, "makeCharacter", (cards) => {
			const name = flag(a, "name");
			if (!name) throw new CliError('character <picture> --name "Mia" [--subject human|animal|anthro|creature] [--style auto|realistic|anime|cartoon3d|picturebook|mascot|pixel]', "INVALID_PARAM");
			return {
				nodeId: idOf(cards, a.pos[0], "picture"),
				name,
				description: flag(a, "description") ?? "",
				subject: flag(a, "subject") ?? "human",
				style: flag(a, "style") ?? "auto",
			};
		}, 900),
	cut: (a) =>
		onCanvas(a, "addToCut", (cards) => ({
			nodeIds: a.pos.map((r) => idOf(cards, r)),
			...(flag(a, "into") ? { cutNodeId: idOf(cards, flag(a, "into"), "cut") } : {}),
			start: num(a, "start") ?? 0,
		})),
	stage: (a) =>
		onCanvas(a, "buildDirectorStage", (cards) => {
			const idea = a.pos.join(" ").trim();
			if (!idea) throw new CliError('stage "who is where, what they do, how each shot frames and moves" [--cast <character cards>] [--into <stage>] [--add]', "INVALID_PARAM");
			return {
				idea,
				mode: has(a, "add") ? "add" : "replace",
				...(flag(a, "into") ? { nodeId: idOf(cards, flag(a, "into"), "stage") } : {}),
				...(flag(a, "title") ? { title: flag(a, "title") } : {}),
				characterNodeIds: flags(a, "cast").map((r) => idOf(cards, r)),
			};
		}, 300),
	shoot: (a) =>
		onCanvas(a, "shootDirectorShot", (cards) => ({
			nodeId: idOf(cards, a.pos[0], "stage"),
			...(flag(a, "shots") ? { shots: flag(a, "shots") === "all" ? "all" : flags(a, "shots") } : {}),
		})),
	do: (a) => {
		const operation = a.pos[0];
		if (!operation) throw new CliError("do <operation> --input '{…}'  (an operation the canvas runs for Flo; ids are full card ids)", "INVALID_PARAM");
		const raw = flag(a, "input") ?? a.pos[1] ?? "{}";
		let input: Record<string, unknown>;
		try {
			input = JSON.parse(raw);
		} catch {
			throw new CliError("--input must be a JSON object.", "INVALID_PARAM");
		}
		if (input === null || Array.isArray(input) || typeof input !== "object") throw new CliError("--input must be a JSON object.", "INVALID_PARAM");
		return onCanvas(a, operation, () => input, 900);
	},
};

// ---------- commands: models ----------

async function cmdModels(a: Args) {
	const ctx = await context(a).catch(() => null);
	// Not logged in: the worker the site's pages use (FLOWITH_URL, else the default site).
	const catalog = await fetchCatalog(ctx?.session.workerURL ?? workerFor(siteUrl()), { fresh: has(a, "fresh") });
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

  node scripts/index.ts <command> [args] [--flags]      (or bun scripts/index.ts, or npx -y github:flowith-ai/canvas-cowork)

SET UP      login [--site flowith.io] [--no-open] · whoami · credits · spent [--since 30m] · logout
CANVASES    canvases [search] · new "title" [--open] · use <canvas|url> · rename canvas "title"
            open [--handoff]              open in the default browser, or return the URL for the agent's browser
SEE         look [words] [--kind image] [--status running] [--by codex]  card refs, placement and links
            read <card…> [--full]        full prompt / text / media of cards
            shots [card…] [--full]       download previews to look at (Read the files)
            save <card…> [--out dir]     download originals / text
MAKE        image "prompt" ["prompt"…]   [--model] [--ratio 16:9] [--size 2k] [--n 4] [--ref card|file|url]… [--transparent]
            edit <card> "change" ["change2"…]  new pictures made from that one, beside it [--model] [--ratio] [--size] [--title]
            vary <card> [--n 3]           run a picture, clip or text card's prompt again, beside it
            retry [card…]                 run failed cards again in place (all failed cards when none named)
            video "prompt"               [--model] [--first card|file] [--last …] [--ref …]… [--duration 5] [--resolution 720p]
                                         [--ratio] [--no-audio] [--draft] [--extend clip] [--edit-video clip]
            text "prompt"                [--model a,b,c] [--ref card]… [--system "…"]
            speech "words"  · music "style"   [--model] [--voice id] [--for card] [--lyrics "…"] [--duration s]
TOOLS       upscale <card> [--to 4k] · cutout <card> · expand <card> --ratio 16:9
ARRANGE     add <file|url…> · note "text" · write <card> "text" · move <card> --to x,y | --right-of c | --below c
            arrange <cards…> --as row|column|grid  ·  arrange <group>  ·  group <cards…> --name "…" · ungroup <group>
            rename <card> "title" · link <from> <to> · unlink <from> <to> · copy <card> · delete <card…>
            wait [card…]
ON CANVAS   (run by the user's open canvas window, as Flo's operations are)
            selection (get refs selected in the browser) · focus <refs…> (show cards in the browser)
            tidy [refs…] [--as row|column|grid|left|top|hdistribute…] (no refs: Organize)
            split <ref> --rows 2 --cols 2 · angles <ref> [--angles low,closeUp,wide,side,back,high,overShoulder]
            relight <ref> --preset window|golden|blueHour|neon|rim|noir|studio|candle
            lipsync <clip> --with <sound> · motion <clip> --with <picture> · soundtrack <clip> [--voice "text"]
            breakdown <clip> [--layout] · character <picture> --name "Mia" [--subject animal] · cut <refs…>
            stage "scene idea" [--cast refs] · shoot <stage> [--shots all] · do <operation> --input '{…}'
MODELS      models [image|video|text|audio] · models <id>

Placement   new cards sit beside --near <card> (or the first --ref card), else in free space; several
            results form one group (--group "name"); --into <group> adds to an existing group.
Cards       a card is named by its ref (first 8 hex of its id, shown by look), a longer id prefix, or its title.
References  in prompts, name references @image1 @image2 @video1 @audio1 in --ref order; the CLI rewrites
            them to each model's own naming (Seedance 图片1, Kling @image_1, image models 图1/image 1).
Global      --canvas <ref|url>  --json  --quiet  --no-wait  --timeout <s>
            --dry-run (making commands, add, note, delete: show the request and credits; send nothing)
            --agent <claude-code|codex|…> (auto-detected)  ·  env FLOWITH_URL, FLOWITH_CANVAS, FLOWITH_HOME
`;

// ---------- main ----------

const COMMANDS: Record<string, (a: Args) => Promise<unknown>> = {
	login: cmdLogin,
	whoami: cmdWhoami,
	status: cmdWhoami,
	credits: cmdCredits,
	logout: async () => {
		const { ended, note } = await logout();
		const oldLogin = forgetOldLogin();
		out({ signInEnded: ended, ...(note ? { note } : {}), ...(oldLogin ? { removedOldLogin: "~/.flowith/bot-session.json" } : {}) });
		if (!ended && note?.startsWith("Couldn't")) process.exitCode = 1;
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
	retry: cmdRetry,
	spent: cmdSpent,
	models: cmdModels,
	...ON_CANVAS,
};

const GLOBAL_FLAGS = new Set(["canvas", "agent", "bot", "json", "quiet", "help", "dry-run", "wait", "no-wait", "timeout"]);
const PLACEMENT = "title near group into";
const IMAGE_FLAGS = `model ratio size quality n ref transparent ${PLACEMENT}`;
const COMMAND_FLAGS: Record<string, string> = {
	login: "site no-open", canvases: "limit", list: "limit", new: "open", open: "handoff", look: "kind status by", read: "full", shots: "last full out", save: "out",
	image: IMAGE_FLAGS, edit: IMAGE_FLAGS, vary: `${IMAGE_FLAGS} system duration resolution audio no-audio draft first from last extend edit-video`,
	video: `model ratio duration resolution ref first from last audio no-audio draft extend edit-video ${PLACEMENT}`,
	text: `model ref system ${PLACEMENT}`, speech: "model voice language for", music: "model lyrics duration for instrumental vocals",
	upscale: "to quality", expand: "ratio", add: `ratio ${PLACEMENT}`, note: "file title near into", write: "file",
	move: "to gap right-of left-of below above", arrange: "as cols gap", group: "name", spent: "since", models: "fresh",
	tidy: "as", split: "rows cols", angles: "angles", relight: "preset", lipsync: "with", motion: "with", soundtrack: "voice",
	breakdown: "layout", character: "name subject style description", cut: "into start", stage: "add into title cast", shoot: "shots", do: "input",
};

function validateArgs(a: Args) {
	const localFlags = (COMMAND_FLAGS[a.cmd] ?? "").split(" ");
	for (const [name, values] of a.flags) {
		if (!GLOBAL_FLAGS.has(name) && !localFlags.includes(name))
			throw new CliError(`\`${a.cmd}\` does not accept --${name}. See \`${a.cmd} --help\`.`, "INVALID_PARAM");
		if (BOOLEAN_FLAGS.has(name) && values.some((value) => value !== "true" && value !== "false"))
			throw new CliError(`--${name} is a boolean flag.`, "INVALID_PARAM");
	}
	const seconds = num(a, "timeout");
	if (seconds !== undefined && (seconds <= 0 || seconds * 1000 > 2_147_483_647))
		throw new CliError("--timeout must be a positive number of seconds within the system timer limit.", "INVALID_PARAM");
	if (a.cmd === "speech" && flag(a, "voice") === "true") throw new CliError("--voice requires a voice id for speech.", "INVALID_PARAM");
}

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

/** Commands whose --dry-run shows what they would do (requests, cards, credits) without doing it. */
const PREVIEWS = new Set(["image", "edit", "vary", "retry", "video", "text", "speech", "music", "upscale", "cutout", "expand", "add", "note", "delete"]);
/** Commands that only read Flowith: --dry-run leaves them as they are. */
const READS = new Set(["whoami", "status", "credits", "canvases", "list", "look", "read", "models", "spent", "wait"]);

async function main() {
	const a = parseArgs(process.argv.slice(2));
	jsonOut = has(a, "json");
	quiet = has(a, "quiet") || jsonOut;
	dryRun = has(a, "dry-run");
	if (dryRun && COMMANDS[a.cmd]) {
		if (!PREVIEWS.has(a.cmd) && !READS.has(a.cmd))
			throw new CliError(`\`${a.cmd}\` has no dry run: it changes things when it runs. Leave out --dry-run (\`look\` shows the canvas as it is).`, "INVALID_PARAM");
		// Whatever a preview misses, nothing that would change the canvas or spend credits leaves the machine.
		forbidWrites();
	}
	if (a.cmd === "help") return void process.stdout.write(HELP);
	if (has(a, "help")) {
		// The help lines that name this command, with the shared notes.
		const lines = HELP.split("\n").filter((l) => new RegExp(`(^|[\\s·(])${a.cmd}\\b`).test(l));
		return void process.stdout.write(`${lines.join("\n") || HELP}\n\n${HELP.slice(HELP.indexOf("Placement"))}`);
	}
	const run = COMMANDS[a.cmd];
	if (!run) {
		const moved = RENAMED[a.cmd];
		throw new CliError(moved ? `\`${a.cmd}\` is now: ${moved}. See \`help\`.` : `Unknown command "${a.cmd}". See \`help\`.`, "INVALID_PARAM");
	}
	validateArgs(a);
	await run(a);
}

main().catch((e: unknown) => {
	const err = e instanceof CliError ? e : new CliError(e instanceof Error ? e.message : String(e), "ERROR");
	process.stdout.write(`${JSON.stringify({ error: err.code, message: err.message, ...(err.data && typeof err.data === "object" && !Array.isArray(err.data) && Object.keys(err.data).length < 8 ? { data: err.data } : {}) })}\n`);
	process.exit(1);
});

