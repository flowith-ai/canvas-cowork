/**
 * Canvas operations that only the open canvas can carry out (its own layout engine, storyboard and
 * director tools, toolbar actions such as split, angles, relight, lip-sync): handed to the user's
 * browser window that has the canvas open, which runs them with the same executor the in-app
 * Creator Agent's operations use (hypergpt-frontend use-creator-canvas.ts). The request travels on
 * the user's Realtime control topic, sealed (both ways) with the key that browser gave this agent
 * when the user allowed it at `login`, so nothing on the public topic can be read or forged.
 */

import { type Api, CliError, guardWrite } from "./http";
import { Realtime, openWith, sealWith } from "./realtime";

export interface CanvasResult {
	kind?: string;
	operationId?: string;
	ok: boolean;
	nodeIds?: string[];
	error?: string;
	[k: string]: unknown;
}

export const usesLiveViewport = (operation: string) => operation === "focusCanvasNodes" || operation === "getCanvasLayout";

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
