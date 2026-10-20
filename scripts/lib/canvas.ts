/**
 * Canvases (`conversation`) and nodes (`flow_node`) over Supabase PostgREST.
 * Everything here is what the browser's bot control-channel does for
 * list/search/create/read_nodes/poll_generation — minus the browser.
 */

import { type ApiSession, CliError, ilikePattern, rest, workerJson } from "./http";
import { getJwtUserId } from "./session";

export const NODE_TYPE = {
	question: "1",
	response: "2",
	video: "13",
	audio: "21",
	noCredits: "22",
	locked: "25",
} as const;

export interface Position {
	x: number;
	y: number;
}

export interface FlowNodeRow {
	id: string;
	conv_id: string;
	p_id: string | null;
	c_ids: string[] | null;
	type: string;
	data: Record<string, any> | null;
	position: Position | null;
	created_at?: string;
	is_delete?: boolean;
}

export interface CanvasRow {
	id: string;
	title: string | null;
	updated_at: string;
	created_at?: string;
}

function userId(s: ApiSession): string {
	const uid = getJwtUserId(s.accessToken);
	if (!uid) throw new CliError("Invalid access token (no user id).", "NOT_LOGGED_IN");
	return uid;
}

export async function listCanvases(s: ApiSession, query?: string, limit = 20): Promise<CanvasRow[]> {
	const q = [
		`conversation?select=id,title,updated_at,created_at`,
		`user_id=eq.${userId(s)}`,
		`is_delete=not.is.true`,
		...(query ? [`title=ilike.${encodeURIComponent(ilikePattern(query))}`] : []),
		`order=updated_at.desc`,
		`limit=${limit}`,
	];
	return rest<CanvasRow[]>(s, q.join("&"));
}

/** Resolve a canvas the user can read (own or shared). Throws when it doesn't exist. */
export async function getCanvas(s: ApiSession, convId: string): Promise<CanvasRow> {
	const rows = await rest<CanvasRow[]>(
		s,
		`conversation?select=id,title,updated_at&id=eq.${convId}&is_delete=not.is.true&limit=1`,
	);
	if (!rows[0]) throw new CliError(`Canvas ${convId} not found or not accessible.`, "NOT_FOUND");
	return rows[0];
}

/**
 * Create a canvas. Mirrors the browser's create_canvas: a same-titled canvas
 * created by this user within the last 5 minutes is reused (so retries don't
 * litter the sidebar).
 */
export async function createCanvas(
	s: ApiSession,
	title: string,
): Promise<{ convId: string; reused: boolean }> {
	const uid = userId(s);
	const since = new Date(Date.now() - 5 * 60 * 1000).toISOString();
	const recent = await rest<CanvasRow[]>(
		s,
		`conversation?select=id,title,updated_at&user_id=eq.${uid}&is_delete=not.is.true&title=eq.${encodeURIComponent(title)}&created_at=gte.${encodeURIComponent(since)}&order=created_at.desc&limit=1`,
	);
	if (recent[0]) return { convId: recent[0].id, reused: true };
	const id = crypto.randomUUID();
	const rows = await rest<Array<{ id: string }>>(s, "conversation", {
		json: { id, title, is_absolute_mode: true, user_id: uid },
		prefer: "return=representation",
	});
	return { convId: rows[0]?.id ?? id, reused: false };
}

export async function fetchNodes(s: ApiSession, convId: string): Promise<FlowNodeRow[]> {
	return rest<FlowNodeRow[]>(
		s,
		`flow_node?select=id,type,data,p_id,c_ids,conv_id,position,created_at&conv_id=eq.${convId}&is_delete=not.is.true&order=created_at.asc`,
	);
}

export async function fetchNode(s: ApiSession, nodeId: string): Promise<FlowNodeRow | null> {
	const rows = await rest<FlowNodeRow[]>(
		s,
		`flow_node?select=id,type,data,p_id,c_ids,conv_id,position,created_at&id=eq.${nodeId}&limit=1`,
	);
	return rows[0] ?? null;
}

/** Same shapes the browser's read_nodes action returns. */
export async function readNodes(
	s: ApiSession,
	convId: string,
	opts: { nodeId?: string; full?: boolean; failed?: boolean } = {},
): Promise<unknown> {
	if (opts.nodeId) {
		const n = await fetchNode(s, opts.nodeId);
		if (!n) throw new CliError(`Node ${opts.nodeId} not found.`, "NOT_FOUND");
		const { c_ids: _c, created_at: _t, ...row } = n;
		return row;
	}
	let nodes = await fetchNodes(s, convId);
	if (opts.failed) nodes = nodes.filter((n) => n.data?.status === "failed");
	return nodes.map((n) => {
		const { c_ids: _c, created_at: _t, ...row } = n;
		if (opts.full) return row;
		const d = n.data ?? {};
		return {
			...row,
			data: { status: d.status, mode: d.mode, model: d.model, tag: d.tag, theme: d.theme },
		};
	});
}

/** Upsert rows into flow_node (PostgREST merge-duplicates = the app's upsert). */
export async function upsertNodes(
	s: ApiSession,
	rows: Array<Omit<FlowNodeRow, "created_at" | "is_delete">>,
): Promise<void> {
	await rest(s, "flow_node", {
		json: rows,
		prefer: "resolution=merge-duplicates,return=minimal",
	});
}

/**
 * Update one node's `data` in place. flow_node is partitioned by created_at,
 * so a second upsert of the same id lands as a duplicate row — always PATCH
 * rows that already exist.
 */
export async function patchNodeData(
	s: ApiSession,
	nodeId: string,
	data: Record<string, unknown>,
): Promise<void> {
	await rest(s, `flow_node?id=eq.${nodeId}`, {
		method: "PATCH",
		json: { data },
		prefer: "return=minimal",
	});
}

export async function deleteNodes(
	s: ApiSession,
	convId: string,
	ids: string[],
): Promise<unknown> {
	if (!ids.length) return { success: true, message: "No ids to delete" };
	return workerJson(s, "/user/d-nodes", { json: { ids, conv_id: convId } });
}

/** Failed nodes + question parents whose children all failed (mirrors cleanFailedNodes). */
export async function cleanFailed(
	s: ApiSession,
	convId: string,
): Promise<{ deleted: string[]; totalDeleted: number; message?: string }> {
	const nodes = await fetchNodes(s, convId);
	const failed = nodes.filter((n) => n.data?.status === "failed");
	if (!failed.length) return { deleted: [], totalDeleted: 0, message: "No failed nodes" };
	const toDelete = new Set(failed.map((n) => n.id));
	const byId = new Map(nodes.map((n) => [n.id, n]));
	for (const pid of new Set(failed.map((n) => n.p_id).filter(Boolean) as string[])) {
		const parent = byId.get(pid);
		if (!parent || parent.type !== NODE_TYPE.question) continue;
		const children = nodes.filter((n) => n.p_id === pid).map((n) => n.id);
		if (children.length === 0 || children.every((c) => toDelete.has(c))) toDelete.add(pid);
	}
	const deleted = [...toDelete];
	await deleteNodes(s, convId, deleted);
	return { deleted, totalDeleted: deleted.length };
}

// ---------- layout ----------

// The app measures real node heights; we don't have a DOM, so estimate.
const EST_HEIGHT: Record<string, number> = {
	[NODE_TYPE.question]: 80,
	[NODE_TYPE.response]: 420,
	[NODE_TYPE.video]: 420,
};
const DEFAULT_HEIGHT = 200;
const GAP = 50;

export function estimateHeight(n: Pick<FlowNodeRow, "type" | "data">): number {
	if (n.type === NODE_TYPE.response && !n.data?.isImage) return DEFAULT_HEIGHT;
	return EST_HEIGHT[n.type] ?? DEFAULT_HEIGHT;
}

/**
 * Where a new root question goes: under the lowest node, at the x of the
 * right-most node — the same rule as the app's calcNewSubNodePosition when
 * the source is the (virtual) start node.
 */
export function rootQuestionPosition(nodes: FlowNodeRow[]): Position {
	let rightX = Number.NEGATIVE_INFINITY;
	let rightNodeX = 0;
	let bottomY = Number.NEGATIVE_INFINITY;
	let found = false;
	for (const n of nodes) {
		if (!n.position) continue;
		found = true;
		const right = n.position.x + 384;
		if (right > rightX) {
			rightX = right;
			rightNodeX = n.position.x;
		}
		const bottom = n.position.y + estimateHeight(n);
		if (bottom > bottomY) bottomY = bottom;
	}
	return found ? { x: rightNodeX, y: bottomY + GAP } : { x: 0, y: 0 };
}

export function childPosition(parent: Pick<FlowNodeRow, "type" | "data" | "position">): Position {
	const p = parent.position ?? { x: 0, y: 0 };
	return { x: p.x, y: p.y + estimateHeight(parent) + GAP };
}

export function nowTimestamp(): string {
	return String(Math.floor(Date.now() / 1000));
}

// ---------- polling ----------

export interface PollResult {
	status: "finished" | "failed" | "timeout";
	node: FlowNodeRow | null;
	isNoCredits?: boolean;
	isLocked?: boolean;
}

/**
 * Wait for a generation node to settle. Unlike the browser's poll_generation
 * this also recognises the no-credits (22) and advanced-model-locked (25)
 * retypes, which otherwise look like "nothing happened".
 */
export async function pollNode(
	s: ApiSession,
	nodeId: string,
	opts: { timeoutMs: number; intervalMs?: number; onTick?: (n: FlowNodeRow | null, i: number) => void },
): Promise<PollResult> {
	const deadline = Date.now() + opts.timeoutMs;
	let i = 0;
	let delay = opts.intervalMs ?? 3000;
	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, delay));
		i++;
		let node: FlowNodeRow | null = null;
		try {
			node = await fetchNode(s, nodeId);
		} catch (e) {
			if (e instanceof CliError && e.code === "NOT_LOGGED_IN") throw e;
			// transient — keep polling
		}
		opts.onTick?.(node, i);
		if (node) {
			if (node.type === NODE_TYPE.noCredits) return { status: "failed", node, isNoCredits: true };
			if (node.type === NODE_TYPE.locked) return { status: "failed", node, isLocked: true };
			const st = node.data?.status;
			if (st === "finished") return { status: "finished", node };
			if (st === "failed") return { status: "failed", node };
		}
		delay = Math.min(delay + 500, 8000);
	}
	return { status: "timeout", node: await fetchNode(s, nodeId).catch(() => null) };
}
