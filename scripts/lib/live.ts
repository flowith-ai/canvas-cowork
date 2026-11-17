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
	await rt.connect();
	const topic = `bot_ctrl:${userId}`;
	try {
		await rt.join(topic);
		const actionId = crypto.randomUUID();
		const result = new Promise<CanvasResult>((resolve, reject) => {
			let accepted = false;
			const notOpen = setTimeout(() => {
				if (!accepted)
					reject(
						new CliError(
							`No open Flowith window took it. Open this canvas (\`open\`, or ${opts.canvasUrl}) in the browser where you ran \`login\`, then run the command again.`,
							"CANVAS_NOT_OPEN",
						),
					);
			}, 20_000);
			const deadline = setTimeout(
				() => reject(new CliError(`The canvas took on "${operation}" but hasn't finished after ${Math.round(opts.timeoutMs / 1000)} s; check the canvas.`, "TIMEOUT")),
				opts.timeoutMs,
			);
			const context = `${agent.sessionId}:${actionId}`;
			rt.on(topic, "bot_response", async (r: { type: string; actionId: string; code?: string; sealed?: { iv: string; ct: string } }) => {
				if (r.actionId !== actionId) return;
				// The page's rate limit answers in the clear (it can't know the key yet).
				if (r.type === "error" && r.code === "LOCKED" && !accepted) {
					clearTimeout(notOpen);
					clearTimeout(deadline);
					reject(new CliError("The canvas is busy (too many requests). Wait a few seconds and run it again.", "RATE_LIMITED"));
					return;
				}
				if (r.type === "ack") {
					accepted = true;
					clearTimeout(notOpen);
					opts.onAccepted?.();
					return;
				}
				if (r.type !== "result") return;
				// Only a result sealed with our key counts: the topic is public.
				const data = await openWith<CanvasResult>(agent.key!, `${context}:result`, r.sealed);
				if (!data) return;
				clearTimeout(notOpen);
				clearTimeout(deadline);
				resolve(data);
			});
			void sealWith(agent.key!, context, {
				at: Date.now(),
				command: { operation, operationId: crypto.randomUUID(), conversationId: convId, ...input },
			}).then((sealed) =>
				rt.broadcast(topic, "bot_action", { actionId, sessionId: agent.sessionId, timestamp: new Date().toISOString(), type: "canvas_command", sealed }),
			);
		});
		return await result;
	} finally {
		rt.close();
	}
}
