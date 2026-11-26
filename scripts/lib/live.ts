/**
 * Canvas operations that only the open canvas can carry out (its own layout engine, storyboard and
 * director tools, toolbar actions such as split, angles, relight, lip-sync): handed to the user's
 * browser window that has the canvas open, which runs them with the same executor the in-app
 * Creator Agent's operations use (hypergpt-frontend use-creator-canvas.ts). The request travels on
 * the user's Realtime control topic, sealed (both ways) with the key that browser gave this agent
 * when the user allowed it at `login`, so nothing on the public topic can be read or forged.
 */

import { isUuid } from "./desk.ts";
import { type Api, CliError, guardWrite } from "./http.ts";
import { Realtime, openWith, sealWith } from "./realtime.ts";

export interface CanvasResult {
	kind?: string;
	operationId?: string;
	ok: boolean;
	nodeIds?: string[];
	error?: string;
	[k: string]: unknown;
}

/**
 * Operations on what the user sees (focus, and the old selection read): answered or given up fast. The page keeps the
 * same list (hypergpt-frontend use-bot-control-channel.ts isViewportOperation): a command of these queued behind
 * another canvas operation is answered "busy … not run" within 15 s, anything else (layoutCanvas included) within
 * 8 minutes.
 */
export const usesLiveViewport = (operation: string) => operation === "focusCanvasNodes" || operation === "getCanvasLayout";
/**
 * Seconds to wait for an operation's answer once the canvas took it on (unacknowledged, it fails at 20 s): past the
 * page's "busy" answer, 20 s for a viewport operation and at least ten minutes for anything else.
 */
export const operationWaitSec = (operation: string, atLeastSec = 0) => (usesLiveViewport(operation) ? 20 : Math.max(600, atLeastSec));

export async function runOnCanvas(
	api: Api,
	agent: { sessionId?: string; key?: string },
	userId: string,
	convId: string,
	operation: string,
	input: Record<string, unknown>,
	opts: { timeoutMs: number; canvasUrl: string; onAccepted?: () => void },
): Promise<CanvasResult> {
	guardWrite("SEND", `canvas operation ${operation}`);
	if (!agent.sessionId || !agent.key)
		throw new CliError("This login predates canvas operations. Run `login` again (once) to let the open canvas take them.", "NOT_LOGGED_IN");
	const rt = new Realtime(api.supabaseUrl, api.supabaseKey, api.accessToken);
	const topic = `bot_ctrl:${userId}`;
	try {
		try {
			await rt.connect();
			await rt.join(topic);
		} catch (error) {
			throw new CliError(`Couldn't connect to Flowith Realtime: ${(error as Error).message}`, "REALTIME_UNAVAILABLE", { operation, canvasUrl: opts.canvasUrl });
		}
		const actionId = crypto.randomUUID();
		const operationId = crypto.randomUUID();
		const context = `${agent.sessionId}:${actionId}`;
		const sealed = await sealWith(agent.key, context, {
			at: Date.now(),
			command: { ...input, operation, operationId, conversationId: convId },
		});
		return await new Promise<CanvasResult>((resolve, reject) => {
			let acknowledged = false;
			const viewport = usesLiveViewport(operation);
			const showCanvas = `Bring ${opts.canvasUrl} to the foreground in the browser that approved the CLI. If the canvas is open in multiple tabs, keep just one copy open until you finish working together.`;
			const details = () => ({ operation, operationId, canvasUrl: opts.canvasUrl, acknowledged });
			const until = Date.now() + opts.timeoutMs;
			const finish = () => {
				clearTimeout(timer);
				off();
			};
			const fail = (message: string, code: string) => {
				finish();
				reject(new CliError(message, code, details()));
			};
			let timer = setTimeout(() => fail(
				viewport
					? `No browser acknowledged the operation. ${showCanvas}`
					: `No browser acknowledged the operation. Open ${opts.canvasUrl} in the browser that approved the CLI. Check the canvas before resending an operation that can create cards or use credits.`,
				"CANVAS_NOT_OPEN",
			), Math.min(opts.timeoutMs, 20_000));
			const off = rt.on(topic, "bot_response", async (r: { type: string; actionId: string; code?: string; sealed?: { iv: string; ct: string } }) => {
				if (r?.actionId !== actionId) return;
				// The page's rate limit answers in the clear (it can't know the key yet).
				if (r.type === "error" && r.code === "LOCKED" && !acknowledged) {
					fail("The canvas is busy (too many requests).", "RATE_LIMITED");
					return;
				}
				if (r.type === "ack" && !acknowledged) {
					acknowledged = true;
					clearTimeout(timer);
					timer = setTimeout(() => fail(
						viewport
							? `The browser acknowledged "${operation}" but no result arrived. ${showCanvas} Check the visible selection before trying again.`
							: `The browser acknowledged "${operation}" but no result arrived. It may still be running. Inspect the canvas before retrying.`,
						"TIMEOUT",
					), Math.max(0, until - Date.now()));
					opts.onAccepted?.();
					return;
				}
				if (r.type !== "result") return;
				// Only a result sealed with our key counts: the topic is public.
				const data = await openWith<CanvasResult>(agent.key!, `${context}:result`, r.sealed);
				if (!data || data.operationId !== operationId || typeof data.ok !== "boolean") return;
				finish();
				resolve(data);
			});
			rt.broadcast(topic, "bot_action", { actionId, sessionId: agent.sessionId, timestamp: new Date().toISOString(), type: "canvas_command", sealed });
		});
	} finally {
		rt.close();
	}
}

/**
 * The selection, read by a layoutCanvas script that only prints it (the page took out getCanvasLayout on 2026-11-24
 * and reads a canvas through layoutCanvas since): one id per line, packed by print() into what comes back, so a
 * couple of hundred selected cards fit in one answer. Nothing moves, so nothing is saved.
 */
export const SELECTION_SCRIPT = "print(selected().map((card) => card.id))";
/** The selected ids a selection read printed, in the order printed. */
export const printedIds = (data: unknown) => {
	const printed = (data as { printed?: unknown } | undefined)?.printed;
	return Array.isArray(printed) ? printed.flatMap((text) => String(text).split(/\s+/)).filter(isUuid) : undefined;
};
/**
 * A layoutCanvas script for `tidy`: no cards is the canvas's Organize (clears overlaps), cards alone are tidied, and
 * `--as` lays them out (the page's arrangeCanvasNodes is gone; these are the same moves in the layout API).
 */
export const TIDY_LAYOUTS: Record<string, string> = {
	row: "row(cards)",
	column: "column(cards)",
	grid: "grid(cards)",
	left: 'align(cards, "left")',
	top: 'align(cards, "top")',
	hdistribute: 'distribute(cards, "h")',
	vdistribute: 'distribute(cards, "v")',
};
export const tidyScript = (nodeIds: string[], layout?: string) => {
	if (layout && !TIDY_LAYOUTS[layout]) throw new CliError(`--as takes ${Object.keys(TIDY_LAYOUTS).join(", ")}.`, "INVALID_PARAM");
	if (layout && !nodeIds.length) throw new CliError("Name the cards to lay out with --as.", "INVALID_PARAM");
	if (!nodeIds.length) return "tidy()";
	return `const cards = ${JSON.stringify(nodeIds)}.map((id) => node({ ids: id }))\n${layout ? TIDY_LAYOUTS[layout] : "tidy(cards)"}`;
};
