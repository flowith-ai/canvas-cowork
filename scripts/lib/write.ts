/**
 * Writing cards, the way the canvas and the Creator Agent do (creater-agent
 * services/creator-canvas-delivery.ts): a generating card is a real flow_node the moment work
 * starts, at its final place; the worker fills it in place. Several results of one request form one
 * group. All writes go through PostgREST with the user's session and the `x-canvas-agent` label.
 */

import type { Card, FlowNodeRow } from "./desk";
import { cardsFrom, fetchRowsById, markHasCards } from "./desk";
import { type Api, CliError, rest, worker } from "./http";
import {
	CANVAS_DEFAULT_NODE_WIDTH,
	type CanvasRect,
	type CanvasSize,
	groupLayout,
	isClear,
	placeSingle,
} from "./placement";

export type CardKindToMake = "image" | "video" | "audio" | "text" | "note";

/** 3.0 renders text as a type-2 text card; type 7 only shows character and director-stage cards. */
export const NODE_TYPE: Record<CardKindToMake, string> = { image: "2", video: "13", audio: "21", text: "2", note: "2" };

/** The canvas's own frame sizes (creator-canvas-delivery.ts placeholderSize, text-node-frame.ts). */
export function cardSize(kind: CardKindToMake | "group", ratio?: string): CanvasSize {
	// A text card keeps a fixed frame (frontend text-node-frame.ts TEXT_NODE_FRAME_HEIGHT); longer text scrolls inside.
	if (kind === "text" || kind === "note") return { width: CANVAS_DEFAULT_NODE_WIDTH, height: 520 };
	if (kind === "audio") return { width: CANVAS_DEFAULT_NODE_WIDTH, height: 120 };
	const m = /^(\d+(?:\.\d+)?)[:x](\d+(?:\.\d+)?)$/.exec(ratio ?? "");
	const value = m && Number(m[2]) > 0 ? Number(m[1]) / Number(m[2]) : kind === "video" ? 16 / 9 : 1;
	return { width: CANVAS_DEFAULT_NODE_WIDTH, height: Math.round(CANVAS_DEFAULT_NODE_WIDTH / value) };
}

const stamps = () => ({ createdAt: new Date().toISOString(), timestamp: Math.floor(Date.now() / 1000).toString() });
const centreTop = (r: CanvasRect) => ({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y) });

/** Where to sit beside a card: its group's frame when it is in one (inside the frame there is no room to sit). */
export const anchorRect = (cards: Card[], card: Card | undefined) =>
	card ? (card.groupId ? cards.find((c) => c.id === card.groupId)?.rect : undefined) ?? card.rect : undefined;

/** Top-level boxes: ungrouped cards and whole groups (members sit inside their group). */
export const obstaclesOf = (cards: Card[], except: string[] = []) =>
	cards.filter((c) => !c.groupId && !except.includes(c.id)).map((c) => c.rect);

/** The free top-left nearest to `at` for a box of `size` (rings outward, nearest first). */
export function nearestFree(size: CanvasSize, at: { x: number; y: number }, obstacles: CanvasRect[], step = 48): { x: number; y: number } {
	const candidates: Array<{ x: number; y: number; d: number }> = [];
	for (let i = -40; i <= 40; i++)
		for (let j = -40; j <= 40; j++) candidates.push({ x: at.x + i * step, y: at.y + j * step, d: Math.hypot(i, j) });
	candidates.sort((p, q) => p.d - q.d);
	const hit = candidates.find((c) => isClear({ x: c.x, y: c.y, ...size }, obstacles));
	if (!hit) throw new CliError("No free space near there.", "NO_SPACE");
	return { x: hit.x, y: hit.y };
}

export interface NewCard {
	kind: CardKindToMake;
	/** `data` beyond what every card gets. */
	data: Record<string, unknown>;
	size: CanvasSize;
}

export interface Placement {
	/** The card the work came from: new cards sit beside it. */
	anchor?: Card;
	/** Several cards become a group with this name (a single card stays loose unless `group` is set). */
	group?: string;
	/** An existing group to add the cards to; it grows to fit. */
	into?: Card;
}

export interface Placed {
	ids: string[];
	groupId?: string;
	rows: FlowNodeRow[];
}

async function insert(api: Api, rows: Array<Record<string, unknown>>): Promise<FlowNodeRow[]> {
	return rest<FlowNodeRow[]>(api, "flow_node?select=id,conv_id,type,p_id,position,width,height,data,created_at", {
		json: rows,
		prefer: "return=representation",
	});
}

/** A card's status and retry mark (`agentAttempt`, renewed by each retry) as read, or null. */
const markOf = (data: Record<string, unknown> | undefined, key: string) => {
	const v = data?.[key];
	return v === undefined || v === null ? null : String(v);
};

export type PatchOutcome = "done" | "changed" | "gone" | "forbidden";

/**
 * Patches a card. flow_node is partitioned by created_at, so rows are addressed by id + created_at. `data` replaces the
 * whole object, so a write of data applies only while the card's status and retry mark are as read (`asRead`, by
 * default the card's own data): one UPDATE … WHERE, so a result, a retry or another command that came in meanwhile is
 * never undone. With `type`, the card's type must be as read too. Says what happened: done, or why not.
 */
export async function tryPatch(
	api: Api,
	card: Pick<Card, "id" | "createdAt"> & { type?: string; data?: Record<string, unknown> },
	fields: Record<string, unknown>,
	opts: { asRead?: Record<string, unknown>; type?: boolean } = {},
): Promise<PatchOutcome> {
	const q = new URLSearchParams({ id: `eq.${card.id}`, created_at: `eq.${card.createdAt}`, is_delete: "not.is.true", select: "id" });
	const read = opts.asRead ?? ("data" in fields ? card.data : undefined);
	for (const key of read ? ["status", "agentAttempt"] : []) {
		const v = markOf(read, key);
		q.append(`data->>${key}`, v === null ? "is.null" : `eq.${v}`);
	}
	if (opts.type && card.type) q.set("type", `eq.${card.type}`);
	const rows = await rest<Array<{ id: string }>>(api, `flow_node?${q}`, { method: "PATCH", json: fields, prefer: "return=representation" });
	if (rows?.length) return "done";
	// Nothing was changed: why, from the card as it is now.
	const now = cardsFrom(await fetchRowsById(api, [card.id]))[0];
	if (!now) return "gone";
	if (read && (markOf(now.data, "status") !== markOf(read, "status") || markOf(now.data, "agentAttempt") !== markOf(read, "agentAttempt"))) return "changed";
	if (opts.type && card.type && now.type !== card.type) return "changed";
	return "forbidden";
}

export async function patch(
	api: Api,
	card: Pick<Card, "id" | "createdAt"> & { type?: string; data?: Record<string, unknown> },
	fields: Record<string, unknown>,
	opts: { asRead?: Record<string, unknown> } = {},
) {
	const outcome = await tryPatch(api, card, fields, opts);
	const ref = card.id.slice(0, 8);
	if (outcome === "gone") throw new CliError(`Card ${ref} is no longer on the canvas.`, "NOT_FOUND");
	if (outcome === "changed") throw new CliError(`Card ${ref} changed while this ran (its result came in, or another command changed it): \`look\` and try again.`, "BUSY");
	if (outcome === "forbidden") throw new CliError(`Card ${ref} couldn't be changed (not yours to edit).`, "FORBIDDEN");
}

/**
 * Claims a card for a retry: changed only if its type, status and retry mark are still as read (the claim writes a new
 * mark). When two clients (other machines) claim the same card at once, the database lets only one change it.
 */
export const claim = (api: Api, card: Card, fields: Record<string, unknown>) => tryPatch(api, card, fields, { type: true });

/** A card still generating gets its result written by the worker; changing its data now could undo that. */
export function settled(card: Card, what: string) {
	if (card.status === "running" || card.status === "init")
		throw new CliError(`${card.ref} is still generating; ${what} it once it's done (\`wait ${card.ref}\`).`, "BUSY");
}

/** Places new cards on the canvas, as generating placeholders unless their data says otherwise. */
export async function placeCards(api: Api, convId: string, cards: Card[], items: NewCard[], where: Placement = {}): Promise<Placed> {
	if (!items.length) throw new CliError("Nothing to place.", "INVALID_PARAM");
	const ids = items.map(() => crypto.randomUUID());
	for (const item of items) item.data = { madeBy: api.agent, ...item.data };
	const base = (item: NewCard, i: number) => ({
		id: ids[i],
		conv_id: convId,
		type: NODE_TYPE[item.kind],
		c_ids: [],
		width: item.size.width,
		height: item.size.height,
	});

	if (where.into) return addToGroup(api, convId, cards, where.into, items, ids, base);

	if (items.length === 1 && !where.group) {
		const rect = placeSingle(items[0]!.size, { obstacles: obstaclesOf(cards), anchor: anchorRect(cards, where.anchor) });
		const rows = await insert(api, [{ ...base(items[0]!, 0), p_id: convId, position: centreTop(rect), data: { ...stamps(), ...items[0]!.data } }]);
		await markHasCards(api, convId).catch(() => {});
		await settle(api, convId, rows[0]!, rect);
		return { ids, rows };
	}

	const layout = groupLayout(items.map((i) => i.size));
	const frame = placeSingle({ width: layout.width, height: layout.height }, { obstacles: obstaclesOf(cards), anchor: anchorRect(cards, where.anchor) });
	const groupId = crypto.randomUUID();
	const group = {
		id: groupId,
		conv_id: convId,
		type: "11",
		p_id: convId,
		c_ids: [],
		position: centreTop(frame),
		width: layout.width,
		height: layout.height,
		data: {
			...stamps(),
			value: "",
			name: where.group || "Group",
			width: layout.width,
			height: layout.height,
			title: `分组 (${items.length} 个节点)`,
			channelGroupInnerNodes: ids,
			layoutMode: "free",
		},
	};
	const members = items.map((item, i) => {
		const m = layout.members[i]!;
		return {
			...base(item, i),
			p_id: groupId,
			position: { x: Math.round(m.x + m.width / 2), y: Math.round(m.y) },
			data: { ...stamps(), ...item.data, group_id: groupId },
		};
	});
	const rows = await insert(api, [group, ...members]);
	await markHasCards(api, convId).catch(() => {});
	const groupRow = rows.find((r) => r.id === groupId);
	if (groupRow) await settle(api, convId, groupRow, frame);
	return { ids, groupId, rows };
}

/**
 * Two agents (or two commands) placing at once can pick the same free spot. After writing, look again: if something
 * written meanwhile now covers this box, move it to the nearest free place.
 */
async function settle(api: Api, convId: string, row: FlowNodeRow, rect: CanvasRect) {
	try {
		const { readCanvas } = await import("./desk");
		const now = await readCanvas(api, convId);
		const others = obstaclesOf(now, [row.id]);
		if (isClear(rect, others)) return;
		const free = nearestFree({ width: rect.width, height: rect.height }, rect, others);
		const position = centreTop({ ...free, width: rect.width, height: rect.height });
		await patch(api, { id: row.id, createdAt: row.created_at }, { position });
		rect.x = free.x;
		rect.y = free.y;
		row.position = position;
	} catch {
		// Placement already holds; a later look shows any overlap.
	}
}

/** New cards join a group: the group is laid out again with them last and grows (or moves, if it would cover something). */
async function addToGroup(
	api: Api,
	convId: string,
	cards: Card[],
	group: Card,
	items: NewCard[],
	ids: string[],
	base: (item: NewCard, i: number) => Record<string, unknown>,
): Promise<Placed> {
	if (group.kind !== "group") throw new CliError(`${group.ref} is not a group.`, "INVALID_PARAM");
	const members = cards
		.filter((c) => c.groupId === group.id)
		.sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
	const sizes = [...members.map((m) => ({ width: m.rect.width, height: m.rect.height })), ...items.map((i) => i.size)];
	const layout = groupLayout(sizes);
	let frame: CanvasRect = { x: group.rect.x, y: group.rect.y, width: layout.width, height: layout.height };
	const keep = [group.id, ...members.map((m) => m.id)];
	const others = obstaclesOf(cards, keep);
	if (!isClear(frame, others)) frame = placeSingle({ width: layout.width, height: layout.height }, { obstacles: others, anchor: group.rect });
	const memberIds = [...members.map((m) => m.id), ...ids];
	const at = (i: number) => {
		const m = layout.members[i]!;
		return { x: Math.round(m.x + m.width / 2), y: Math.round(m.y) };
	};
	const rows = await insert(
		api,
		items.map((item, i) => ({ ...base(item, i), p_id: group.id, position: at(members.length + i), data: { ...stamps(), ...item.data, group_id: group.id } })),
	);
	await patch(api, group, {
		position: centreTop(frame),
		width: layout.width,
		height: layout.height,
		data: { ...group.data, width: layout.width, height: layout.height, channelGroupInnerNodes: memberIds, title: `分组 (${memberIds.length} 个节点)` },
	});
	await Promise.all(members.map((m, i) => patch(api, m, { position: at(i) })));
	return { ids, groupId: group.id, rows };
}

// ---------- editing ----------

/** Moves top-level cards (or whole groups) so their top-left lands on the given points. */
export async function moveTo(api: Api, moves: Array<{ card: Card; x: number; y: number }>) {
	for (const { card } of moves) if (card.groupId) throw new CliError(`${card.ref} is inside a group; move the group or ungroup it first.`, "INVALID_PARAM");
	await Promise.all(moves.map(({ card, x, y }) => patch(api, card, { position: centreTop({ x, y, width: card.rect.width, height: card.rect.height }) })));
}

export type Layout = "row" | "column" | "grid";

/** Top-left points for cards lined up from the first card's corner. */
export function arrangePoints(cards: Card[], layout: Layout, gap = 32, columns?: number): Array<{ x: number; y: number }> {
	const start = { x: cards[0]!.rect.x, y: cards[0]!.rect.y };
	if (layout === "row") {
		let x = start.x;
		return cards.map((c) => {
			const p = { x, y: start.y };
			x += c.rect.width + gap;
			return p;
		});
	}
	if (layout === "column") {
		let y = start.y;
		return cards.map((c) => {
			const p = { x: start.x, y };
			y += c.rect.height + gap;
			return p;
		});
	}
	const cols = columns ?? Math.ceil(Math.sqrt(cards.length));
	const colWidth = Array.from({ length: cols }, (_, k) => Math.max(...cards.filter((_, i) => i % cols === k).map((c) => c.rect.width), 0));
	const rows = Math.ceil(cards.length / cols);
	const rowHeight = Array.from({ length: rows }, (_, r) => Math.max(...cards.slice(r * cols, r * cols + cols).map((c) => c.rect.height)));
	const offset = (lengths: number[], i: number) => lengths.slice(0, i).reduce((s, l) => s + l + gap, 0);
	return cards.map((_, i) => ({ x: start.x + offset(colWidth, i % cols), y: start.y + offset(rowHeight, Math.floor(i / cols)) }));
}

/** Groups loose cards into a new group frame laid out around the first of them. */
export async function groupCards(api: Api, convId: string, all: Card[], members: Card[], name: string): Promise<string> {
	for (const c of members) {
		settled(c, "group");
		if (c.kind === "group") throw new CliError(`${c.ref} is a group; groups can't be nested.`, "INVALID_PARAM");
		if (c.groupId) throw new CliError(`${c.ref} is already in group ${c.groupId.slice(0, 8)}; ungroup it first.`, "INVALID_PARAM");
	}
	const ordered = [...members].sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
	const layout = groupLayout(ordered.map((c) => ({ width: c.rect.width, height: c.rect.height })));
	const first = ordered[0]!;
	let frame: CanvasRect = { x: first.rect.x - layout.members[0]!.x, y: first.rect.y - layout.members[0]!.y, width: layout.width, height: layout.height };
	const others = obstaclesOf(all, ordered.map((c) => c.id));
	if (!isClear(frame, others)) frame = placeSingle({ width: layout.width, height: layout.height }, { obstacles: others, anchor: first.rect });
	const groupId = crypto.randomUUID();
	await insert(api, [
		{
			id: groupId,
			conv_id: convId,
			type: "11",
			p_id: convId,
			c_ids: [],
			position: centreTop(frame),
			width: layout.width,
			height: layout.height,
			data: {
				...stamps(),
				value: "",
				name,
				width: layout.width,
				height: layout.height,
				title: `分组 (${ordered.length} 个节点)`,
				channelGroupInnerNodes: ordered.map((c) => c.id),
				layoutMode: "free",
				madeOnCanvas: true,
			},
		},
	]);
	await Promise.all(
		ordered.map((c, i) => {
			const m = layout.members[i]!;
			return patch(api, c, { position: { x: Math.round(m.x + m.width / 2), y: Math.round(m.y) }, data: { ...c.data, group_id: groupId } });
		}),
	);
	return groupId;
}

/** Dissolves a group: its cards stay where they are, loose on the canvas. */
export async function ungroup(api: Api, convId: string, all: Card[], group: Card) {
	if (group.kind !== "group") throw new CliError(`${group.ref} is not a group.`, "INVALID_PARAM");
	const members = all.filter((c) => c.groupId === group.id);
	await Promise.all(
		members.map((c) => {
			const { group_id: _g, ...data } = c.data;
			return patch(api, c, {
				position: centreTop(c.rect),
				data,
				...(c.row.p_id === group.id ? { p_id: convId } : {}),
			});
		}),
	);
	await deleteCards(api, convId, [group.id]);
	return members.map((m) => m.id);
}

export async function deleteCards(api: Api, convId: string, ids: string[]) {
	if (!ids.length) return;
	await worker(api, "/user/d-nodes", { json: { ids, conv_id: convId } });
}

/** Draws the line from `from` into `to` (a reference the receiving card uses), or removes it. */
export async function link(api: Api, to: Card, from: Card, remove = false) {
	settled(to, "link");
	const list: Array<{ id: string; value?: string }> = Array.isArray(to.data.promptReferenceNodes) ? to.data.promptReferenceNodes : [];
	const next = remove ? list.filter((p) => p.id !== from.id) : list.some((p) => p.id === from.id) ? list : [...list, { id: from.id, value: "" }];
	await patch(api, to, { data: { ...to.data, promptReferenceNodes: next } });
}

export async function rename(api: Api, card: Card, title: string) {
	settled(card, "rename");
	const data = card.kind === "group" ? { ...card.data, name: title } : { ...card.data, customTitle: title, title };
	await patch(api, card, { data });
}
