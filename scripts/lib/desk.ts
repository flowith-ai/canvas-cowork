/**
 * Reading a canvas: its cards (public.flow_node rows) as the agent sees them — a short ref, a kind,
 * a title, where it sits and how it relates to other cards. The same reading the Creator Agent's
 * desk does (creater-agent services/creator-canvas-desk.ts), from the rows the user can read.
 *
 * Geometry: React Flow's node origin is [0.5, 0], so a stored position is the card's top centre;
 * a group member's position is relative to its group's top-left. `rect` here is absolute top-left.
 */

import { type Api, CliError, ilikePattern, rest } from "./http";
import type { CanvasRect } from "./placement";

export type CardKind = "image" | "video" | "audio" | "text" | "prompt" | "note" | "group" | "web" | "character" | "other";

export interface FlowNodeRow {
	id: string;
	conv_id: string;
	type: string;
	p_id: string | null;
	position: { x: number; y: number } | null;
	width: number | null;
	height: number | null;
	data: Record<string, any> | string | null;
	created_at: string;
	prompt?: string | null;
}

export interface Card {
	id: string;
	/** First 8 hex digits — enough to name a card on one canvas. */
	ref: string;
	kind: CardKind;
	type: string;
	title?: string;
	model?: string;
	status?: string;
	/** The image / clip / sound. */
	url?: string;
	/** A small preview of it (webp / jpg) when the canvas made one. */
	preview?: string;
	prompt?: string;
	/** A text card's text. */
	text?: string;
	ratio?: string;
	groupId?: string;
	rect: CanvasRect;
	createdAt: string;
	/** The card it follows (its parent in the canvas tree), the cards it was made from, the cards its prompt used. */
	follows?: string;
	madeFrom?: string[];
	references?: string[];
	/** Who placed it: "flo" (the in-app Creator Agent), an outside agent's name (claude-code, codex…), or "you". */
	placedBy: string;
	error?: string;
	row: FlowNodeRow;
	data: Record<string, any>;
}

export interface CanvasInfo {
	id: string;
	title: string | null;
	updated_at: string;
	metadata?: Record<string, unknown> | null;
}

const NODE_COLUMNS = "id,conv_id,type,p_id,position,width,height,data,created_at,prompt";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (s: string) => UUID.test(s);

const dataOf = (row: FlowNodeRow): Record<string, any> => {
	if (!row.data) return {};
	if (typeof row.data === "string") {
		try {
			const parsed = JSON.parse(row.data);
			return parsed && typeof parsed === "object" ? parsed : {};
		} catch {
			return {};
		}
	}
	return row.data;
};

const httpsUrl = (v: unknown) => (typeof v === "string" && /^https?:\/\/\S+$/i.test(v.trim()) ? v.trim() : undefined);
const IMAGE_PATH = /\.(png|jpe?g|webp|gif|avif|heic)(\?|$)/i;
const DEFAULT_SIZE = { width: 320, height: 320 };

function kindOf(type: string, d: Record<string, any>): { kind: CardKind; url?: string } {
	const valueUrl = httpsUrl(d.value);
	if (type === "11") return { kind: "group" };
	if (type === "13") return { kind: "video", url: httpsUrl(d.videoId) ?? valueUrl };
	if (type === "21") return { kind: "audio", url: httpsUrl(d.audioUrl) ?? valueUrl };
	if (type === "15") return { kind: "web", url: valueUrl };
	if (type === "1") return { kind: "prompt" };
	if (type === "4") return { kind: "note" };
	if (type === "7") return { kind: d.kind === "character" ? "character" : "text" };
	if (type === "2") {
		if (d.mode === "video_generation") return { kind: "video", url: valueUrl };
		if (d.isImage === true || d.mode === "image_generation" || (valueUrl && IMAGE_PATH.test(valueUrl))) return { kind: "image", url: valueUrl };
		return { kind: "text" };
	}
	return { kind: "other" };
}

const sizeOf = (v: unknown, fallback: number) => {
	const n = Number(v);
	return Number.isFinite(n) && n > 0 ? n : fallback;
};

function textOf(v: unknown): string | undefined {
	if (typeof v === "string") return v;
	if (v == null) return undefined;
	try {
		return JSON.stringify(v);
	} catch {
		return undefined;
	}
}

/** A failure as one readable sentence: providers' errors arrive as JSON, sometimes nested in the card's value. */
export function readableError(raw: unknown): string | undefined {
	if (raw == null || raw === "") return undefined;
	let v: unknown = raw;
	for (let i = 0; i < 3 && typeof v === "string" && /^\s*\{/.test(v); i++) {
		try {
			v = JSON.parse(v);
		} catch {
			break;
		}
	}
	if (v && typeof v === "object") {
		const o = v as Record<string, unknown>;
		const nested = o.request_error && typeof o.request_error === "object" ? (o.request_error as Record<string, unknown>).message : undefined;
		const text = [o.error_message, o.message, nested, o.error, o.reason].find((x) => typeof x === "string" && x.trim());
		const kind = typeof o.error_type === "string" ? o.error_type : typeof o.value === "string" && /^[a-z_]+$/.test(o.value) ? o.value : undefined;
		const msg = typeof text === "string" ? text : kind;
		return msg ? `${kind && msg !== kind ? `${kind}: ` : ""}${msg}`.replace(/\s+/g, " ").slice(0, 300) : undefined;
	}
	return String(v).replace(/\s+/g, " ").trim().slice(0, 300) || undefined;
}

/** Rows → cards, with group members placed absolutely. */
export function cardsFrom(rows: FlowNodeRow[]): Card[] {
	const byId = new Map(rows.map((r) => [r.id, r]));
	const datas = new Map(rows.map((r) => [r.id, dataOf(r)]));
	const origins = new Map<string, { x: number; y: number }>();
	const groupOf = (r: FlowNodeRow) => {
		const g = datas.get(r.id)?.group_id;
		return typeof g === "string" && byId.has(g) && g !== r.id ? g : undefined;
	};
	const originOf = (id: string, depth = 0): { x: number; y: number } => {
		const cached = origins.get(id);
		if (cached) return cached;
		const r = byId.get(id)!;
		const pos = r.position && typeof r.position.x === "number" ? r.position : { x: 0, y: 0 };
		const g = groupOf(r);
		const parent = g && depth < 8 ? originOf(g, depth + 1) : undefined;
		const width = sizeOf(r.width ?? datas.get(id)?.width, DEFAULT_SIZE.width);
		const point = { x: (parent?.x ?? 0) + pos.x - width / 2, y: (parent?.y ?? 0) + pos.y };
		origins.set(id, point);
		return point;
	};
	return rows.map((r) => {
		const d = datas.get(r.id)!;
		const { kind, url } = kindOf(r.type, d);
		const origin = originOf(r.id);
		const groupId = groupOf(r);
		const value = textOf(d.value);
		const title = (r.type === "11" ? [d.name, d.customTitle] : [d.customTitle, d.title, d.name]).find((t) => typeof t === "string" && t.trim() && t.trim() !== "AI")?.trim();
		const onCanvas = (v: unknown) => (typeof v === "string" && v !== r.id && byId.has(v) ? v : undefined);
		const follows = r.p_id && r.p_id !== groupId ? onCanvas(r.p_id) : undefined;
		const madeFrom = [d.baseImageNodeId, d.baseVideoNodeId].map(onCanvas).filter(Boolean) as string[];
		const references = [
			...new Set(
				(Array.isArray(d.promptReferenceNodes) ? d.promptReferenceNodes : [])
					.map((p: { id?: unknown }) => onCanvas(p?.id))
					.filter((v: string | undefined): v is string => Boolean(v) && !madeFrom.includes(v!)),
			),
		] as string[];
		const prompt = typeof d.prompt === "string" ? d.prompt : typeof r.prompt === "string" ? r.prompt : undefined;
		const preview = typeof d.mediaPreview?.url === "string" ? d.mediaPreview.url : undefined;
		const error = d.status === "failed" || r.type === "22" || r.type === "25" ? readableError(d.error ?? d.errorMessage ?? d.value) : undefined;
		return {
			id: r.id,
			ref: r.id.slice(0, 8),
			kind,
			type: r.type,
			...(title ? { title } : {}),
			...(typeof d.model === "string" && d.model ? { model: d.model } : {}),
			...(typeof d.status === "string" && d.status ? { status: d.status } : {}),
			...(url ? { url } : {}),
			...(preview ? { preview } : {}),
			...(prompt ? { prompt } : {}),
			...(kind === "text" || kind === "note" || kind === "prompt" || kind === "character" ? (value ? { text: value } : {}) : {}),
			...(typeof d.aspect_ratio === "string" ? { ratio: d.aspect_ratio } : {}),
			...(groupId ? { groupId } : {}),
			rect: {
				x: Math.round(origin.x),
				y: Math.round(origin.y),
				width: sizeOf(r.width ?? d.width, DEFAULT_SIZE.width),
				height: sizeOf(r.height ?? d.height, DEFAULT_SIZE.height),
			},
			createdAt: r.created_at,
			...(follows ? { follows } : {}),
			...(madeFrom.length ? { madeFrom } : {}),
			...(references.length ? { references } : {}),
			placedBy: d.creatorMedia ? "flo" : typeof d.madeBy === "string" ? d.madeBy : "you",
			...(error ? { error } : {}),
			row: r,
			data: d,
		};
	});
}

export async function fetchRows(api: Api, convId: string): Promise<FlowNodeRow[]> {
	return rest<FlowNodeRow[]>(
		api,
		`flow_node?select=${NODE_COLUMNS}&conv_id=eq.${convId}&is_delete=not.is.true&order=created_at.asc`,
	);
}

export async function readCanvas(api: Api, convId: string): Promise<Card[]> {
	return cardsFrom(await fetchRows(api, convId));
}

export async function fetchRowsById(api: Api, ids: string[]): Promise<FlowNodeRow[]> {
	if (!ids.length) return [];
	return rest<FlowNodeRow[]>(api, `flow_node?select=${NODE_COLUMNS}&id=in.(${ids.join(",")})&is_delete=not.is.true`);
}

/**
 * A card by full id, id prefix (≥ 4 hex) or exact title. Throws NOT_FOUND / AMBIGUOUS with the
 * candidates, so the agent can pick.
 */
export function findCard(cards: Card[], ref: string, opts: { strict?: boolean } = {}): Card {
	const q = ref.trim().replace(/^#/, "");
	const lower = q.toLowerCase();
	const exact = cards.find((c) => c.id === lower);
	if (exact) return exact;
	let hits = /^[0-9a-f-]{4,}$/i.test(q) ? cards.filter((c) => c.id.startsWith(lower)) : [];
	if (!hits.length) hits = cards.filter((c) => c.title?.toLowerCase() === lower);
	// Part of a title is enough to find a card, never to delete one.
	if (!hits.length && !opts.strict) hits = cards.filter((c) => c.title?.toLowerCase().includes(lower) && lower.length >= 2);
	if (hits.length === 1) return hits[0]!;
	if (!hits.length) throw new CliError(`No card "${ref}" on this canvas. Run \`look\` for the refs.`, "NOT_FOUND");
	throw new CliError(
		`"${ref}" matches ${hits.length} cards: ${hits.slice(0, 8).map((c) => `${c.ref} ${c.kind} "${c.title ?? ""}"`).join("; ")}`,
		"AMBIGUOUS",
	);
}

// ---------- canvases ----------

export async function listCanvases(api: Api, userId: string, query?: string, limit = 20): Promise<CanvasInfo[]> {
	const q = [
		`conversation?select=id,title,updated_at`,
		`user_id=eq.${userId}`,
		`is_delete=not.is.true`,
		...(query ? [`title=ilike.${encodeURIComponent(ilikePattern(query))}`] : []),
		`order=updated_at.desc`,
		`limit=${limit}`,
	];
	return rest<CanvasInfo[]>(api, q.join("&"));
}

export async function getCanvas(api: Api, convId: string): Promise<CanvasInfo> {
	const rows = await rest<CanvasInfo[]>(
		api,
		`conversation?select=id,title,updated_at,metadata&id=eq.${convId}&is_delete=not.is.true&limit=1`,
	);
	if (!rows[0]) throw new CliError(`Canvas ${convId} not found or not yours to open.`, "NOT_FOUND");
	return rows[0];
}

/** A canvas by id, id prefix or title (newest first). */
export async function resolveCanvas(api: Api, userId: string, ref: string): Promise<CanvasInfo> {
	if (isUuid(ref)) return getCanvas(api, ref.toLowerCase());
	const recent = await listCanvases(api, userId, undefined, 200);
	const byPrefix = /^[0-9a-f-]{4,}$/i.test(ref) ? recent.filter((c) => c.id.startsWith(ref.toLowerCase())) : [];
	if (byPrefix.length === 1) return byPrefix[0]!;
	const byTitle = await listCanvases(api, userId, ref, 10);
	const exact = byTitle.filter((c) => c.title?.toLowerCase() === ref.toLowerCase());
	const pick = exact[0] ?? (byTitle.length === 1 ? byTitle[0] : undefined);
	if (pick) return pick;
	if (!byTitle.length && !byPrefix.length) throw new CliError(`No canvas matches "${ref}". Try \`canvases\`.`, "NOT_FOUND");
	const options = [...byPrefix, ...byTitle].slice(0, 8).map((c) => `${c.id.slice(0, 8)} "${c.title ?? ""}"`);
	throw new CliError(`"${ref}" matches several canvases: ${options.join("; ")}`, "AMBIGUOUS");
}

export async function createCanvas(api: Api, userId: string, title: string): Promise<CanvasInfo> {
	const id = crypto.randomUUID();
	const rows = await rest<CanvasInfo[]>(api, "conversation?select=id,title,updated_at", {
		json: { id, title, user_id: userId, type: "canvas", is_absolute_mode: true },
		prefer: "return=representation",
	});
	return rows[0] ?? { id, title, updated_at: new Date().toISOString() };
}

/**
 * The web app skips reading cards of a canvas whose metadata says `flow_node_data: false`
 * (a canvas that had none). After writing cards there, say it has them — or they vanish on reload.
 */
export async function markHasCards(api: Api, convId: string) {
	const rows = await rest<Array<{ metadata: Record<string, unknown> | null }>>(
		api,
		`conversation?select=metadata&id=eq.${convId}&limit=1`,
	);
	const metadata = rows[0]?.metadata;
	if (!metadata || metadata.flow_node_data !== false) return;
	await rest(api, `conversation?id=eq.${convId}`, {
		method: "PATCH",
		json: { metadata: { ...metadata, flow_node_data: true } },
		prefer: "return=minimal",
	});
}

export function canvasUrl(site: string, convId: string) {
	return `${site.replace(/\/$/, "")}/conv/${convId}`;
}
