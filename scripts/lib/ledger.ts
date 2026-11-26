/**
 * What a generation this CLI sent was charged, and whether one whose answer was lost ever reached Flowith.
 *
 * The worker charges a picture or clip the moment it takes the request, before it answers, as a usage record under
 * the attempt's own id (model_usage.req_id); refunds and settlement land later under that same id. A record names the
 * canvas and the model, not the card. So each send is written down here (card, model, when it went out and when it
 * came back, on the server's clock), and tied to its attempt by the one record of its model on its canvas that began
 * in that span. Anything else (none, or several: the user made the same model on the same canvas at that moment) is
 * unknown, never guessed. Text is charged when its answer finishes, so it is never tied here.
 */
import { createHash } from "crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { type Api, worker } from "./http.ts";
import { home } from "./session.ts";

export interface Sent {
	card: string;
	conv: string;
	model: string;
	kind: "image" | "video" | "text";
	/** Server time the request went out, and its answer came back (or the connection failed). */
	from: number;
	to: number;
	/**
	 * "lost": no answer came back, so whether Flowith took it is unknown. "claiming": a retry was claiming the card under
	 * the mark `attempt` and nothing has been sent yet (if the claim took, the card carries that mark).
	 */
	answer: "taken" | "refused" | "lost" | "claiming";
	attempt?: string;
	/** "claiming": the card's data as the claim wrote it (`fingerprint`), and the send before the claim. */
	fingerprint?: string;
	prev?: Sent;
}

/** Card data in a form that survives the database (jsonb reorders keys): the same data gives the same string. */
export function fingerprint(data: unknown): string {
	const canon = (v: unknown): unknown =>
		Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])])) : v;
	return createHash("sha256").update(JSON.stringify(canon(data))).digest("base64url").slice(0, 22);
}

export interface UsageRecord {
	model: string;
	req_id: string;
	tokens_used: number;
	billing_unit_price: number | null;
	created_at: string;
}

/** Slack around a send for clock reading (the Date header has whole seconds) and the worker writing its record. */
const SLACK_MS = 2_000;
const KEEP_MS = 14 * 24 * 3_600_000;
/** One file per card, written whole (temp file renamed over it): CLI processes running at once never lose another's. */
const dir = () => join(home(), "sent");
const fileOf = (card: string) => join(dir(), `${card.replace(/[^0-9a-f-]/gi, "")}.json`);

/** Writes down a send (the latest per card); older ones are cleared away now and then. */
export function noteSent(sent: Sent) {
	mkdirSync(dir(), { recursive: true });
	const tmp = `${fileOf(sent.card)}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(sent), { mode: 0o600 });
	renameSync(tmp, fileOf(sent.card));
	if (Math.random() < 0.05) {
		for (const name of readdirSync(dir())) {
			const path = join(dir(), name);
			try {
				if (Date.now() - statSync(path).mtimeMs > KEEP_MS) unlinkSync(path);
			} catch {}
		}
	}
}

/**
 * Claims a card for one retry (a lock file created only if absent; a claim older than a few minutes is stale). False
 * when another command holds it.
 */
export function claimRetry(card: string): boolean {
	mkdirSync(dir(), { recursive: true });
	const lock = fileOf(card).replace(/\.json$/, ".retry");
	try {
		if (Date.now() - statSync(lock).mtimeMs < 5 * 60_000) return false;
		unlinkSync(lock);
	} catch {}
	try {
		writeFileSync(lock, String(process.pid), { flag: "wx" });
		return true;
	} catch {
		return false;
	}
}

/** Gives up a retry claim once its send is done. */
export function releaseRetry(card: string) {
	try {
		unlinkSync(fileOf(card).replace(/\.json$/, ".retry"));
	} catch {}
}

/** Forgets a card's send record (a send written down ahead that never went). */
export function forgetSent(card: string) {
	try {
		unlinkSync(fileOf(card));
	} catch {}
}

export function sentOf(cards: string[]): Sent[] {
	return cards.flatMap((card) => {
		try {
			return [JSON.parse(readFileSync(fileOf(card), "utf8")) as Sent];
		} catch {
			return [];
		}
	});
}

export const creditsOf = (r: { tokens_used: number; billing_unit_price: number | null }) =>
	r.billing_unit_price != null ? (r.tokens_used * r.billing_unit_price) / 1000 : r.tokens_used / 1000;

export async function usageOf(api: Api, conv: string): Promise<UsageRecord[]> {
	const res = await worker<{ data?: UsageRecord[] }>(api, `/user/model-usage/group-records?groupIds=${conv}`);
	return res?.data ?? [];
}

/** Each attempt on the canvas: its id, model and when it was first charged. */
function attemptsOf(records: UsageRecord[]) {
	const first = new Map<string, { model: string; at: number }>();
	for (const r of records) {
		const at = Date.parse(r.created_at);
		const known = first.get(r.req_id);
		if (!known || at < known.at) first.set(r.req_id, { model: r.model, at });
	}
	return [...first].map(([id, a]) => ({ id, ...a }));
}

/** The attempts of `model` that began between `from` and `to` (server time), with slack for the clock. */
function attemptsBetween(records: UsageRecord[], model: string, from: number, to: number) {
	return attemptsOf(records).filter((a) => a.model === model && a.at >= from - SLACK_MS && a.at <= to + SLACK_MS);
}

/**
 * Whether a send whose answer was lost reached Flowith: a charge of its model began on its canvas after it went out.
 * Up to now, not just while it was sent: a clip is charged once the provider has its job, which can be after the CLI
 * gave up waiting for the answer. Any such charge counts (it may be someone else's: then the card is left alone,
 * never sent twice).
 */
export function chargedSince(s: Sent, records: UsageRecord[], now: number) {
	return attemptsBetween(records, s.model, s.from, now).length > 0;
}

export type Charge = { credits: number } | { unknown: string };

/**
 * What these sends cost together (refunds and settlement included), or why that can't be told. Sends of one model
 * are matched together (a batch goes out at once): exactly as many charges of that model began on the canvas while
 * they were being sent as were taken, or it is unknown.
 */
export function chargeOf(all: Sent[], records: UsageRecord[], expected: number): Charge {
	// A card only claimed for a retry was never sent from here.
	const sends = all.filter((s) => s.answer !== "claiming");
	if (sends.length < expected)
		return { unknown: "the CLI ties charges only to pictures and clips it sent from this machine (not card tools, or cards made elsewhere); `spent` shows the canvas's charges" };
	if (sends.some((s) => s.kind === "text")) return { unknown: "text is charged by its tokens when the answer finishes, not tied to a request; `spent` shows the canvas's charges" };
	// A lost answer's charge may land after the send (a clip is charged once the provider has its job), so another
	// charge of that model in the window could pass for it.
	const lost = sends.find((s) => s.answer === "lost");
	if (lost) return { unknown: `no answer came back for ${lost.card.slice(0, 8)}, so its charge can't be told apart` };
	const claimed = new Set<string>();
	const taken = sends.filter((s) => s.answer !== "refused");
	for (const model of new Set(taken.map((s) => s.model))) {
		const batch = taken.filter((s) => s.model === model);
		const from = Math.min(...batch.map((s) => s.from));
		const to = Math.max(...batch.map((s) => s.to));
		const during = attemptsBetween(records, model, from, to);
		if (during.length !== batch.length) {
			return {
				unknown: during.length > batch.length
					? `${during.length} ${model} charges began on this canvas while ${batch.length} were sent (something else ran it at the same moment)`
					: `${batch.length - during.length} of the ${model} charges haven't shown up yet`,
			};
		}
		for (const a of during) claimed.add(a.id);
	}
	const credits = records.filter((r) => claimed.has(r.req_id)).reduce((sum, r) => sum + creditsOf(r), 0);
	return { credits: Math.round(credits * 100) / 100 };
}

/** How long a lost send is given to show up as a charge or a result before it counts as never arrived. */
export const SETTLE_MS = { image: 10 * 60_000, text: 30 * 60_000, video: 30 * 60_000 } as const;
