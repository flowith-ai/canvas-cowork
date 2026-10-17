/**
 * Headless image / video generation.
 *
 * What the web app does on submit, minus the UI:
 *   1. insert the question node (type "1") under the canvas root or a --follow node
 *   2. insert the response node with status "init" (image: type "2", video: type "13")
 *   3. POST /image_gen/async or /video/async — the backend generates and
 *      writes the result into that node row
 *   4. poll the row until status is finished / failed
 *
 * `buildImageRequest` / `buildVideoRequest` are pure so they can be unit-tested.
 */

import { type ApiSession, CliError, workerFetch } from "./http";
import {
	type ModelMap,
	type RemoteModel,
	isSeedanceMultiMedia,
	requireModel,
	resolveImageSizing,
	resolveVideoParams,
	seedanceLimits,
} from "./models";
import {
	type FlowNodeRow,
	type Position,
	NODE_TYPE,
	childPosition,
	fetchNode,
	fetchNodes,
	nowTimestamp,
	patchNodeData,
	pollNode,
	rootQuestionPosition,
	upsertNodes,
} from "./canvas";
import type { UploadedMedia } from "./upload";

export type GenKind = "text" | "image" | "video";

export interface GenResult {
	status: "finished" | "failed" | "submitted" | "timeout";
	kind: GenKind;
	model: string;
	convId: string;
	questionNodeId: string;
	nodeId: string;
	/** image / video result */
	url?: string;
	/** text result */
	text?: string;
	reasoning?: string;
	ratio?: string;
	duration?: string;
	resolution?: string;
	elapsedMs?: number;
	error?: string;
	errorCode?: string;
	/** the node's `data` as last seen (status, refund_amount, resolution, ...) */
	data?: Record<string, unknown>;
	/** Seedance reference tokens → URLs, so the caller can explain the mapping */
	references?: Record<string, string>;
}

/** Trim a result to what an agent needs by default (`--verbose` keeps `data`). */
export function compactResult(r: GenResult): GenResult {
	const { data, ...rest } = r;
	if (r.status !== "failed" || !data) return rest;
	const keep: Record<string, unknown> = {};
	for (const k of ["error", "error_type", "error_code", "refund_amount", "request_id"])
		if (data[k] !== undefined && data[k] !== null) keep[k] = data[k];
	return Object.keys(keep).length ? { ...rest, data: keep } : rest;
}

interface FileListEntry {
	id: string;
	name: string;
	url: string;
	type?: string;
}

function fileEntry(m: UploadedMedia, type?: string): FileListEntry {
	return { id: crypto.randomUUID(), name: m.name, url: m.url, type: type ?? m.type };
}

function parseAspectRatio(r?: string): number | undefined {
	const m = r?.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
	return m ? Number(m[1]) / Number(m[2]) : undefined;
}

// ---------- image ----------

export interface ImageOpts {
	prompt: string;
	model: string;
	ratio?: string;
	size?: string;
	quality?: string;
	refs?: UploadedMedia[];
	convId: string;
	/** parent node id (follow-up); defaults to the canvas root */
	follow?: string;
}

export interface BuiltRequest {
	questionNode: Omit<FlowNodeRow, "created_at" | "is_delete">;
	responseNode: Omit<FlowNodeRow, "created_at" | "is_delete">;
	path: string;
	body: Record<string, unknown>;
}

export function buildImageRequest(
	opts: ImageOpts,
	model: RemoteModel,
	questionPos: Position,
): BuiltRequest {
	const refs = opts.refs ?? [];
	const nonImage = refs.filter((r) => r.media !== "image");
	if (nonImage.length)
		throw new CliError(
			`Image models only take image references (got ${nonImage.map((r) => r.name).join(", ")}).`,
			"INVALID_PARAM",
		);
	if (model.maxReferenceImages !== undefined && refs.length > model.maxReferenceImages)
		throw new CliError(
			`${opts.model} accepts at most ${model.maxReferenceImages} reference image(s); got ${refs.length}.`,
			"INVALID_PARAM",
		);
	const sizing = resolveImageSizing(opts.model, model, opts.ratio, opts.size, opts.quality);
	const ts = nowTimestamp();
	const questionId = crypto.randomUUID();
	const nodeId = crypto.randomUUID();
	const questionNode: BuiltRequest["questionNode"] = {
		id: questionId,
		conv_id: opts.convId,
		p_id: opts.follow ?? opts.convId,
		c_ids: [],
		type: NODE_TYPE.question,
		position: questionPos,
		data: {
			timestamp: ts,
			value: opts.prompt,
			...(refs.length ? { fileList: refs.map((r) => fileEntry(r)) } : {}),
		},
	};
	const responseNode: BuiltRequest["responseNode"] = {
		id: nodeId,
		conv_id: opts.convId,
		p_id: questionId,
		c_ids: [],
		type: NODE_TYPE.response,
		position: childPosition(questionNode),
		data: {
			title: "AI",
			value: "",
			mode: "image_generation",
			timestamp: ts,
			isImage: true,
			status: "init",
			model: opts.model,
			ratio: sizing.aspect_ratio,
			aspect_ratio: sizing.aspect_ratio,
			resolution: sizing.image_size,
			image_size: sizing.image_size,
			...(sizing.quality ? { quality: sizing.quality } : {}),
		},
	};
	const body: Record<string, unknown> = {
		target_feature: "image_generation",
		model: opts.model,
		nodeId,
		convId: opts.convId,
		messages: [{ role: "user", content: opts.prompt }],
		...(sizing.aspect_ratio ? { aspect_ratio: sizing.aspect_ratio } : {}),
		...(sizing.image_size ? { image_size: sizing.image_size } : {}),
		...(sizing.quality ? { quality: sizing.quality } : {}),
		...(refs.length ? { styleUrls: refs.map((r) => r.url) } : {}),
	};
	return { questionNode, responseNode, path: "/image_gen/async", body };
}

// ---------- video ----------

export interface VideoOpts {
	prompt: string;
	model: string;
	ratio?: string;
	duration?: string | number;
	resolution?: string;
	/** default: on when the model supports audio */
	audio?: boolean;
	start?: UploadedMedia;
	end?: UploadedMedia;
	/** Seedance 2.x reference media (images / video / audio) */
	refs?: UploadedMedia[];
	draft?: boolean;
	convId: string;
	follow?: string;
}

/**
 * Seedance prompt convention: references are addressed as `image1`, `video2`,
 * `audio1` (1-based per type). If the prompt doesn't already mention a
 * reference, its token is appended — exactly what the app does for attached
 * files. Returns the possibly-extended prompt and the token→URL map.
 */
export function applySeedanceReferences(
	prompt: string,
	refs: UploadedMedia[],
): { prompt: string; urls: { image_urls: string[]; video_urls: string[]; audio_urls: string[] }; tokens: Record<string, string> } {
	const urls = { image_urls: [] as string[], video_urls: [] as string[], audio_urls: [] as string[] };
	const tokens: Record<string, string> = {};
	const unmentioned: string[] = [];
	for (const r of refs) {
		if (r.media === "file") throw new CliError(`Unsupported reference type: ${r.name}`, "INVALID_PARAM");
		const list = urls[`${r.media}_urls`];
		let idx = list.indexOf(r.url);
		if (idx < 0) idx = list.push(r.url) - 1;
		const token = `${r.media}${idx + 1}`;
		tokens[token] = r.url;
		if (!new RegExp(`\\b${token}\\b`).test(prompt) && !unmentioned.includes(token)) unmentioned.push(token);
	}
	return { prompt: [prompt.trim(), ...unmentioned].join(" ").trim(), urls, tokens };
}

export function buildVideoRequest(
	opts: VideoOpts,
	model: RemoteModel,
	questionPos: Position,
): BuiltRequest & { references?: Record<string, string> } {
	const params = resolveVideoParams(opts.model, model, {
		ratio: opts.ratio,
		duration: opts.duration,
		resolution: opts.resolution,
		draft: opts.draft,
	});
	const refs = opts.refs ?? [];
	const frames = [opts.start, opts.end].filter(Boolean) as UploadedMedia[];
	for (const f of frames)
		if (f.media !== "image") throw new CliError(`--start/--end must be images (got ${f.name}).`, "INVALID_PARAM");
	if (opts.end && !opts.start) throw new CliError("--end requires --start.", "INVALID_PARAM");
	if (opts.end && !model.supportedKeyframe)
		throw new CliError(`${opts.model} does not support start+end keyframes.`, "INVALID_PARAM");
	if (frames.length && refs.length)
		throw new CliError("Start/end frames can't be combined with --ref references (app rule).", "INVALID_PARAM");

	const multimodal = isSeedanceMultiMedia(opts.model);
	let prompt = opts.prompt;
	let imageURL: string | undefined = opts.start?.url;
	let mediaUrls: { image_urls: string[]; video_urls: string[]; audio_urls: string[] } | undefined;
	let references: Record<string, string> | undefined;
	if (refs.length) {
		if (!multimodal) {
			const nonImage = refs.filter((r) => r.media !== "image");
			if (nonImage.length)
				throw new CliError(
					`${opts.model} only takes image references (video/audio refs need Seedance 2.x).`,
					"INVALID_PARAM",
				);
			if (refs.length > 1)
				throw new CliError(`${opts.model} takes a single reference image; pass it as --start.`, "INVALID_PARAM");
			imageURL = refs[0].url;
		} else {
			const limits = seedanceLimits(model);
			const count = { image: 0, video: 0, audio: 0 };
			for (const r of refs) if (r.media !== "file") count[r.media]++;
			if (refs.length > limits.total)
				throw new CliError(`Too many references (${refs.length} > ${limits.total}).`, "INVALID_PARAM");
			for (const k of ["image", "video", "audio"] as const)
				if (count[k] > limits[k])
					throw new CliError(`Too many ${k} references (${count[k]} > ${limits[k]}).`, "INVALID_PARAM");
			const applied = applySeedanceReferences(prompt, refs);
			prompt = applied.prompt;
			mediaUrls = applied.urls;
			references = applied.tokens;
		}
	}
	const keyFrames = opts.start && opts.end ? [opts.start.url, opts.end.url] : undefined;
	const audio = opts.audio ?? model.supportsAudio === true;

	const ts = nowTimestamp();
	const questionId = crypto.randomUUID();
	const nodeId = crypto.randomUUID();
	const fileList: FileListEntry[] = [
		...(opts.start ? [fileEntry(opts.start, "video-start-frame")] : []),
		...(opts.end ? [fileEntry(opts.end, "video-end-frame")] : []),
		...refs.map((r) => fileEntry(r)),
	];
	const questionNode: BuiltRequest["questionNode"] = {
		id: questionId,
		conv_id: opts.convId,
		p_id: opts.follow ?? opts.convId,
		c_ids: [],
		type: NODE_TYPE.question,
		position: questionPos,
		data: {
			timestamp: ts,
			value: opts.prompt,
			...(fileList.length ? { fileList } : {}),
		},
	};
	const position = childPosition(questionNode);
	const responseNode: BuiltRequest["responseNode"] = {
		id: nodeId,
		conv_id: opts.convId,
		p_id: questionId,
		c_ids: [],
		type: NODE_TYPE.video,
		position,
		data: {
			title: "AI",
			value: "",
			timestamp: ts,
			model: opts.model,
			mode: "image_generation",
			status: "init",
			draft: Boolean(opts.draft),
			duration: params.duration,
			audio,
			fileList: fileList.filter((f) => f.type === "video-start-frame" || f.type === "video-end-frame"),
			ratio: params.aspect_ratio,
			resolution: params.resolution,
			aspect_ratio: params.aspect_ratio,
			aspectRatio: parseAspectRatio(params.aspect_ratio),
		},
	};
	const body: Record<string, unknown> = {
		target_feature: "video_generation",
		nodeId,
		convId: opts.convId,
		parentNodeId: questionId,
		position,
		model: opts.model,
		prompt,
		...(imageURL ? { imageURL } : {}),
		...(keyFrames ? { keyFrames } : {}),
		...(params.aspect_ratio ? { aspect_ratio: params.aspect_ratio } : {}),
		...(params.duration ? { duration: params.duration } : {}),
		audio,
		...(params.resolution ? { resolution: params.resolution } : {}),
		...(mediaUrls ? mediaUrls : {}),
		...(opts.draft ? { draft: true } : {}),
	};
	return { questionNode, responseNode, path: "/video/async", body, references };
}

// ---------- text ----------

export interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

export interface TextOpts {
	prompt: string;
	model: string;
	system?: string;
	convId: string;
	follow?: string;
}

/**
 * Conversation history for a follow-up: walk `p_id` from the follow node up
 * to the canvas root, questions → user, responses → assistant (image nodes
 * become "[image: url]"), oldest first, capped at `maxTurns` messages. This
 * is the text-only core of the app's getHistoryMessageList.
 */
export function buildHistoryMessages(
	nodes: Array<Pick<FlowNodeRow, "id" | "p_id" | "type" | "data">>,
	followId: string | undefined,
	maxTurns = 20,
): ChatMessage[] {
	if (!followId) return [];
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const out: ChatMessage[] = [];
	const seen = new Set<string>();
	let cur = byId.get(followId);
	while (cur && !seen.has(cur.id) && out.length < maxTurns) {
		seen.add(cur.id);
		const d = cur.data ?? {};
		if (cur.type === NODE_TYPE.question) {
			const v = typeof d.value === "string" ? d.value : "";
			if (v) out.push({ role: "user", content: v });
		} else if (cur.type === NODE_TYPE.response || cur.type === NODE_TYPE.video) {
			const v = typeof d.value === "string" ? d.value : "";
			if (v) {
				const isMedia = d.isImage === true || cur.type === NODE_TYPE.video || /^https?:\/\/\S+$/.test(v);
				out.push({ role: "assistant", content: isMedia ? `[${cur.type === NODE_TYPE.video ? "video" : "image"}: ${v}]` : v });
			}
		}
		cur = cur.p_id ? byId.get(cur.p_id) : undefined;
	}
	return out.reverse();
}

export function buildTextRequest(
	opts: TextOpts,
	questionPos: Position,
	history: ChatMessage[],
): BuiltRequest {
	const ts = nowTimestamp();
	const questionId = crypto.randomUUID();
	const nodeId = crypto.randomUUID();
	const questionNode: BuiltRequest["questionNode"] = {
		id: questionId,
		conv_id: opts.convId,
		p_id: opts.follow ?? opts.convId,
		c_ids: [],
		type: NODE_TYPE.question,
		position: questionPos,
		data: { timestamp: ts, value: opts.prompt },
	};
	const responseNode: BuiltRequest["responseNode"] = {
		id: nodeId,
		conv_id: opts.convId,
		p_id: questionId,
		c_ids: [],
		type: NODE_TYPE.response,
		position: childPosition(questionNode),
		data: {
			title: "AI",
			value: "",
			mode: "General",
			timestamp: ts,
			isImage: false,
			status: "init",
			model: opts.model,
		},
	};
	const messages: ChatMessage[] = [
		...(opts.system ? [{ role: "system" as const, content: opts.system }] : []),
		...history,
		{ role: "user", content: opts.prompt },
	];
	const body: Record<string, unknown> = {
		target_feature: "text_completion",
		model: opts.model,
		messages,
		nodeId,
		convId: opts.convId,
	};
	return { questionNode, responseNode, path: "/completion/async?mode=general", body };
}

// ---------- run ----------

export interface RunOpts {
	wait: boolean;
	timeoutMs: number;
	onProgress?: (msg: string) => void;
	/** Pre-computed question position (batch runs plan these up front so nodes don't overlap). */
	questionPos?: Position;
}

/** Vertical space one question+response pair takes; batch jobs are stacked by this. */
export const BATCH_ROW_HEIGHT = 650;

export async function questionPositionFor(s: ApiSession, convId: string, follow?: string): Promise<Position> {
	if (follow) {
		const parent = await fetchNode(s, follow);
		if (!parent || parent.conv_id !== convId)
			throw new CliError(`--follow node ${follow} not found on canvas ${convId}.`, "NOT_FOUND");
		return childPosition(parent);
	}
	return rootQuestionPosition(await fetchNodes(s, convId));
}

function failureInfo(node: FlowNodeRow | null): { error: string; code: string } {
	const d = node?.data ?? {};
	if (node?.type === NODE_TYPE.noCredits)
		return { error: d.errorMessage || d.creditFailureReason || "No credits", code: "NO_CREDITS" };
	if (node?.type === NODE_TYPE.locked)
		return { error: d.errorMessage || "Model locked for this account (upgrade required)", code: "MODEL_LOCKED" };
	let msg: string = d.error || "";
	if (!msg && typeof d.value === "string" && d.value) {
		try {
			const parsed = JSON.parse(d.value);
			msg = parsed.error || parsed.value || parsed.error_type || d.value;
		} catch {
			msg = d.value;
		}
	}
	return { error: msg || "Generation failed", code: "GENERATION_FAILED" };
}

async function run(
	s: ApiSession,
	kind: GenKind,
	built: BuiltRequest & { references?: Record<string, string> },
	runOpts: RunOpts,
): Promise<GenResult> {
	const started = Date.now();
	const rd = built.responseNode.data ?? {};
	const base: Omit<GenResult, "status"> = {
		kind,
		model: built.body.model as string,
		convId: built.questionNode.conv_id,
		questionNodeId: built.questionNode.id,
		nodeId: built.responseNode.id,
		...(rd.aspect_ratio ? { ratio: rd.aspect_ratio as string } : {}),
		...(kind === "video" && rd.duration ? { duration: String(rd.duration) } : {}),
		...(kind === "video" && rd.resolution ? { resolution: rd.resolution as string } : {}),
		...(built.references ? { references: built.references } : {}),
	};
	await upsertNodes(s, [built.questionNode, built.responseNode]);
	runOpts.onProgress?.(`Submitting ${kind} to ${base.model}...`);
	try {
		await workerFetch(s, built.path, { json: built.body, timeoutMs: 120_000 });
	} catch (e) {
		// The backend usually marks the node failed itself (with error_type /
		// refund info); only fill it in when it didn't, so the canvas shows what
		// happened without a duplicate row.
		if (e instanceof CliError) {
			const current = await fetchNode(s, base.nodeId).catch(() => null);
			if (current && current.data?.status !== "failed") {
				await patchNodeData(s, base.nodeId, {
					...current.data,
					status: "failed",
					error: e.message,
				}).catch(() => {});
			}
		}
		throw e;
	}
	if (!runOpts.wait) return { ...base, status: "submitted", elapsedMs: Date.now() - started };

	runOpts.onProgress?.(`Waiting for generation (timeout ${Math.round(runOpts.timeoutMs / 1000)}s)...`);
	const res = await pollNode(s, base.nodeId, {
		timeoutMs: runOpts.timeoutMs,
		onTick: (n, i) => {
			if (i === 1 || i % 5 === 0) runOpts.onProgress?.(`  poll #${i}: status: ${n?.data?.status ?? "pending"}`);
		},
	});
	const data = res.node?.data ?? undefined;
	const elapsedMs = Date.now() - started;
	if (res.status === "finished") {
		if (kind === "text") {
			const text = typeof data?.value === "string" ? data.value : "";
			const reasoning = typeof data?.reasoning === "string" && data.reasoning ? data.reasoning : undefined;
			return { ...base, status: "finished", text, ...(reasoning ? { reasoning } : {}), elapsedMs, data };
		}
		const url = (data?.videoId as string) || (data?.value as string) || undefined;
		return {
			...base,
			status: "finished",
			url,
			...(data?.resolution ? { resolution: data.resolution as string } : {}),
			elapsedMs,
			data,
		};
	}
	if (res.status === "timeout") {
		return {
			...base,
			status: "timeout",
			error: `Timed out after ${Math.round(runOpts.timeoutMs / 1000)}s; check later with: read-db ${base.nodeId}`,
			elapsedMs,
			data,
		};
	}
	const { error, code } = failureInfo(res.node);
	return { ...base, status: "failed", error, errorCode: code, elapsedMs, data };
}

async function positionFor(s: ApiSession, convId: string, follow: string | undefined, runOpts: RunOpts) {
	return runOpts.questionPos ?? (await questionPositionFor(s, convId, follow));
}

export async function genImage(
	s: ApiSession,
	models: ModelMap,
	opts: ImageOpts,
	runOpts: RunOpts,
): Promise<GenResult> {
	const model = requireModel(models, opts.model, "image");
	const pos = await positionFor(s, opts.convId, opts.follow, runOpts);
	return run(s, "image", buildImageRequest(opts, model, pos), runOpts);
}

/** Defaults an agent would otherwise have to look up: 16:9, 5 s, 720p when the model offers them. */
export function applyVideoDefaults(opts: VideoOpts, model: RemoteModel): VideoOpts {
	const has = (list: string[] | undefined, v: string) => list?.some((x) => x.toLowerCase() === v) ?? false;
	return {
		...opts,
		ratio: opts.ratio ?? (has(model.supportedAspectRatios, "16:9") ? "16:9" : undefined),
		duration: opts.duration ?? (has(model.supportedDurations, "5") ? "5" : undefined),
		resolution:
			opts.resolution ?? (opts.draft ? undefined : has(model.supportedResolutions, "720p") ? "720p" : undefined),
	};
}

export async function genVideo(
	s: ApiSession,
	models: ModelMap,
	opts: VideoOpts,
	runOpts: RunOpts,
): Promise<GenResult> {
	const model = requireModel(models, opts.model, "video");
	const pos = await positionFor(s, opts.convId, opts.follow, runOpts);
	return run(s, "video", buildVideoRequest(applyVideoDefaults(opts, model), model, pos), runOpts);
}

export async function genText(
	s: ApiSession,
	models: ModelMap,
	opts: TextOpts,
	runOpts: RunOpts,
): Promise<GenResult> {
	requireModel(models, opts.model, "text");
	const nodes = opts.follow ? await fetchNodes(s, opts.convId) : [];
	if (opts.follow && !nodes.some((n) => n.id === opts.follow))
		throw new CliError(`--follow node ${opts.follow} not found on canvas ${opts.convId}.`, "NOT_FOUND");
	const history = buildHistoryMessages(nodes, opts.follow);
	const pos =
		runOpts.questionPos ??
		(opts.follow ? childPosition(nodes.find((n) => n.id === opts.follow)!) : rootQuestionPosition(nodes.length ? nodes : await fetchNodes(s, opts.convId)));
	return run(s, "text", buildTextRequest(opts, pos, history), runOpts);
}
