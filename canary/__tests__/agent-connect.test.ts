/** The canary's own rules: targets, when it spends credits, when it alerts, what the card says. The loop itself runs
 * against next-gen (`node canary/agent-connect.ts`); it can't be faked here without faking what it is there to catch. */
import { describe, expect, test } from "bun:test";
import { TARGETS, alertDecision, buildCard, chargeMatchesQuote, imageDue, parseArgs, sessionsToEnd, type Report } from "../agent-connect.ts";

const hour = 3600_000;
const now = Date.parse("2026-11-26T12:00:00Z");
const ago = (h: number) => new Date(now - h * hour).toISOString();

describe("options", () => {
	test("next-gen by default, flowith.io by name, origins overridable", () => {
		expect(parseArgs([], {})).toMatchObject({ target: "next-gen", ...TARGETS["next-gen"], image: "auto", alert: false });
		expect(parseArgs(["--target", "flowith"], {})).toMatchObject({ site: "https://flowith.io", issuer: "https://edge.flowith.io", mcp: "https://agent.flowith.io/mcp" });
		expect(parseArgs(["--mcp=https://x.test/mcp", "--issuer", "https://as.test/", "--alert"], {})).toMatchObject({ mcp: "https://x.test/mcp", issuer: "https://as.test", alert: true });
	});

	test("only internal agent-qa test accounts, only known flags", () => {
		expect(() => parseArgs(["--email", "someone@gmail.com"], {})).toThrow("agent-qa");
		expect(() => parseArgs(["--email", "agent-qa-x@flowith.cc.evil.com"], {})).toThrow("agent-qa");
		expect(parseArgs(["--email", "agent-qa-canary-2@flowith.cc"], {}).email).toBe("agent-qa-canary-2@flowith.cc");
		expect(() => parseArgs(["--target", "prod"], {})).toThrow("--target");
		expect(() => parseArgs(["--imagee", "always"], {})).toThrow("Unknown flag");
	});

	test("each schedule is a job of its own (hourly by default)", () => {
		expect(parseArgs([], {}).job).toBe("hourly");
		expect(parseArgs(["--job", "daily-image", "--image", "always", "--email", "agent-qa-g-s1@flowith.cc"], {})).toMatchObject({ job: "daily-image", image: "always", email: "agent-qa-g-s1@flowith.cc" });
		expect(() => parseArgs(["--job", "../x"], {})).toThrow("--job");
	});
});

describe("what a run may end and spend", () => {
	test("only the sessions its own client opened: the account may be shared", () => {
		const sessions = [
			{ sessionId: "a", clientId: "flc_mine" },
			{ sessionId: "b", clientId: "flc_other" },
			{ sessionId: "c", clientId: "https://claude.ai/oauth/claude-code-client-metadata" },
			{ sessionId: "d", clientId: "flc_mine" },
			{ sessionId: "e", clientId: null },
		];
		expect(sessionsToEnd(sessions, "flc_mine")).toEqual(["a", "d"]);
		expect(sessionsToEnd(sessions, undefined)).toEqual([]);
	});

	test("a generation must cost what it was quoted, to the cent", () => {
		expect(chargeMatchesQuote(21, 21)).toBe(true);
		expect(chargeMatchesQuote(21.004, 21)).toBe(true);
		expect(chargeMatchesQuote(21.39, 21)).toBe(false);
		expect(chargeMatchesQuote(0, 21)).toBe(false);
	});
});

describe("image cadence", () => {
	test("auto makes an image about once a day; always and never mean it", () => {
		expect(imageDue({ image: "auto" }, {}, now)).toBe(true);
		expect(imageDue({ image: "auto" }, { lastImageAt: ago(2) }, now)).toBe(false);
		expect(imageDue({ image: "auto" }, { lastImageAt: ago(23) }, now)).toBe(true);
		expect(imageDue({ image: "always" }, { lastImageAt: ago(0) }, now)).toBe(true);
		expect(imageDue({ image: "never" }, {}, now)).toBe(false);
	});
});

describe("alerts", () => {
	const fail = { ok: false as const, step: "consent" };
	test("a new failure alerts; the same step again within 6 hours doesn't; another step or later does", () => {
		expect(alertDecision({}, fail, now)).toBe("failure");
		expect(alertDecision({ failing: { step: "consent", since: ago(1), alertedAt: ago(1) } }, fail, now)).toBe(null);
		expect(alertDecision({ failing: { step: "token", since: ago(1), alertedAt: ago(1) } }, fail, now)).toBe("failure");
		expect(alertDecision({ failing: { step: "consent", since: ago(7), alertedAt: ago(7) } }, fail, now)).toBe("failure");
	});

	test("recovery is said once, only after an alert; a test run always alerts and never says recovered", () => {
		expect(alertDecision({ failing: { step: "consent", since: ago(1), alertedAt: ago(1) } }, { ok: true }, now)).toBe("recovery");
		expect(alertDecision({ failing: { step: "consent", since: ago(1) } }, { ok: true }, now)).toBe(null);
		expect(alertDecision({}, { ok: true }, now)).toBe(null);
		expect(alertDecision({ failing: { step: "consent", since: ago(1), alertedAt: ago(1) } }, fail, now, true)).toBe("failure");
		expect(alertDecision({ failing: { step: "consent", since: ago(1), alertedAt: ago(1) } }, { ok: true }, now, true)).toBe(null);
	});

	test("the card is flo-workers' shape, names the step and never carries the balance", () => {
		const report: Report = { ok: false, target: "next-gen", step: "consent", error: "decision 500", startedAt: ago(0), ms: 4000, log: ["a", "b"], creditsLeft: 1234 };
		const opts = { ...TARGETS["next-gen"], test: true };
		const card = buildCard(report, opts, "failure");
		expect(card).toMatchObject({ schema: "2.0", header: { template: "red", title: { content: "[canary test, ignore] Agent Connect canary failed · next-gen" } } });
		const text = JSON.stringify(card);
		expect(text).toContain("decision 500");
		expect(text).not.toContain("1234");
		expect(buildCard({ ...report, ok: true }, { ...opts, test: false }, "recovery").header.template).toBe("green");
	});

	test("the daily image job says so in its card", () => {
		const report: Report = { ok: false, target: "next-gen", job: "daily-image", imageRun: true, step: "generate_image", error: "charged 21.39 credits, quoted 21", startedAt: ago(0), ms: 4000, log: [] };
		const card = buildCard(report, { ...TARGETS["next-gen"], test: false }, "failure");
		expect(card.header.title.content).toBe("Agent Connect canary failed · next-gen · daily-image");
		expect(card.header.subtitle.content).toContain("image (charge = quote)");
		expect(buildCard({ ...report, job: "hourly", imageRun: false, step: "write" }, { ...TARGETS["next-gen"], test: false }, "failure").header.subtitle.content).toBe("register → consent → token → MCP read/write → side tab → disconnect: write");
	});
});
