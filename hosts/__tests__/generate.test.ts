/**
 * Every host package is what hosts/manifest.json generates: a hand edit, a stale file or a manifest change without
 * `node hosts/generate.ts` fails here. Also checks the shapes each host reads, so a generator change can't quietly
 * break one host.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { ROOT, copyPrompt, cursorInstallLink, drift, generate, loadManifest, mcpInstall, promptGuide } from "../generate.ts";

const m = loadManifest();
const files = generate(m);
const parse = (path: string) => JSON.parse(files.get(path) ?? "null");

describe("host packages", () => {
	test("every generated file matches the manifest, and no stale file is left", () => {
		expect(drift(ROOT, files)).toEqual([]);
	});

	test("the package version is the manifest's", () => {
		expect(JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version).toBe(m.version);
	});

	for (const channel of m.channels) {
		const headers = (host: string, source: string) => ({
			"x-flowith-mcp-client": host,
			"x-flowith-plugin-version": m.version,
			"x-flowith-install-source": source,
		});

		test(`${channel.id}: Claude Code plugin`, () => {
			const dir = `plugins/claude-code/${channel.id}`;
			expect(parse(`${dir}/.claude-plugin/plugin.json`)).toMatchObject({ name: channel.id, version: m.version });
			expect(parse(`${dir}/.mcp.json`).mcpServers[channel.id]).toEqual({ type: "http", url: channel.mcpUrl, headers: headers("claude-code", "claude-code-plugin") });
			expect(files.get(`${dir}/skills/flowith/SKILL.md`)).toStartWith("---\nname: flowith\n");
			const entry = parse(".claude-plugin/marketplace.json").plugins.find((p: { name: string }) => p.name === channel.id);
			expect(entry.source).toBe(`./${dir}`);
		});

		test(`${channel.id}: Codex plugin, with its onboarding skill and starters`, () => {
			const dir = `plugins/codex/${channel.id}`;
			const plugin = parse(`${dir}/.codex-plugin/plugin.json`);
			expect(plugin).toMatchObject({ name: channel.id, skills: "./skills/", mcpServers: "./.mcp.json" });
			expect(plugin.extensions["com.openai"].onboardingSkill).toBe("./skills/get-started/SKILL.md");
			expect(files.has(`${dir}/skills/get-started/SKILL.md`)).toBe(true);
			// Codex keeps at most 3 default prompts of at most 512 characters.
			expect(plugin.interface.defaultPrompt.length).toBeLessThanOrEqual(3);
			for (const prompt of plugin.interface.defaultPrompt) expect(prompt.length).toBeLessThanOrEqual(512);
			for (const asset of [plugin.interface.logo, plugin.interface.logoDark, plugin.interface.composerIcon]) expect(files.has(`${dir}/${asset.slice(2)}`)).toBe(true);
			// Codex's plugin MCP config names headers `http_headers`.
			expect(parse(`${dir}/.mcp.json`).mcpServers[channel.id]).toEqual({ type: "http", url: channel.mcpUrl, http_headers: headers("codex", "codex-plugin") });
			const entry = parse(".agents/plugins/marketplace.json").plugins.find((p: { name: string }) => p.name === channel.id);
			expect(entry).toMatchObject({ source: { source: "local", path: `./${dir}` }, policy: { installation: "AVAILABLE" } });
		});

		test(`${channel.id}: Antigravity plugin`, () => {
			const dir = `plugins/antigravity/${channel.id}`;
			expect(parse(`${dir}/plugin.json`)).toMatchObject({ name: channel.id, version: m.version, logo: "assets/logo.svg" });
			expect(parse(`${dir}/mcp_config.json`).mcpServers[channel.id]).toEqual({ serverUrl: channel.mcpUrl, headers: headers("antigravity", "antigravity-plugin") });
			expect(mcpInstall(m, "antigravity", channel).commands).toEqual([`agy plugin install https://github.com/${m.repository.github}/tree/${m.repository.branch}/${dir}`]);
		});

		test(`${channel.id}: Cursor mcp.json and install link`, () => {
			expect(parse(`plugins/cursor/${channel.id}/mcp.json`).mcpServers[channel.id]).toEqual({ url: channel.mcpUrl, headers: headers("cursor", "cursor-mcp-json") });
			const link = new URL(cursorInstallLink(m, channel));
			expect(`${link.protocol}//${link.host}${link.pathname}`).toBe("cursor://anysphere.cursor-deeplink/mcp/install");
			expect(link.searchParams.get("name")).toBe(channel.id);
			expect(JSON.parse(Buffer.from(link.searchParams.get("config")!, "base64").toString())).toEqual({ url: channel.mcpUrl, headers: headers("cursor", "cursor-deeplink") });
		});
	}

	test("only a channel whose server has templates gets the templates section and the template onboarding", () => {
		expect(m.channels.find((c) => c.id === "flowith")?.templates).toBeFalsy();
		expect(m.channels.find((c) => c.id === "flowith-next")?.templates).toBe(true);
		for (const host of ["claude-code", "codex", "antigravity"]) {
			for (const channel of m.channels) {
				const skill = files.get(`plugins/${host}/${channel.id}/skills/flowith/SKILL.md`)!;
				const onboarding = files.get(`plugins/${host}/${channel.id}/skills/get-started/SKILL.md`)!;
				expect(skill.includes("## Templates:"), `${host}/${channel.id}`).toBe(Boolean(channel.templates));
				expect(onboarding.includes("get_template"), `${host}/${channel.id}`).toBe(Boolean(channel.templates));
				if (channel.templates) expect(skill.indexOf("## Templates:")).toBeLessThan(skill.indexOf("## Steps that need the canvas open"));
			}
		}
		// The repo's own SKILL.md (the skills CLI installs it as is) stays flowith.io's.
		expect(readFileSync(join(ROOT, "SKILL.md"), "utf8")).not.toContain("## Templates:");
	});

	test("every package of one host is the same apart from its channel", () => {
		const [a, b] = m.channels;
		const strip = (dir: string) => [...files].filter(([p]) => p.startsWith(dir)).map(([p]) => p.slice(dir.length)).sort();
		for (const host of m.hosts) expect(strip(`plugins/${host.id}/${a!.id}/`)).toEqual(strip(`plugins/${host.id}/${b!.id}/`));
	});

	test("install.json has a copy prompt per channel and host, naming the channel's /agent address", () => {
		const install = parse("hosts/install.json");
		expect(install.installGuide).toBe(m.installGuide);
		for (const channel of install.channels) {
			expect(channel.installUrl).toBe(`${channel.site}/agent`);
			// The /agent address once it serves the guide; until then (flowith.io before its release) INSTALL.md itself.
			expect(channel.copyPrompt).toContain(channel.installUrlLive ? channel.installUrl : m.installGuide);
			expect(channel.copyPromptTemplate).toEndWith("{task}");
			for (const host of m.hosts) expect(channel.hosts[host.id].copyPrompt).toContain(`in ${host.displayName} by following`);
		}
		expect(copyPrompt(m, m.channels[0]!)).toBe(`Install Flowith in this agent by following ${promptGuide(m, m.channels[0]!)}, then ${m.copyPrompt.defaultTask}`);
		expect(promptGuide(m, { ...m.channels[0]!, installUrlLive: true })).toBe("https://flowith.io/agent");
		expect(promptGuide(m, m.channels.find((c) => c.internal)!)).toBe("https://next-gen.flowith.io/agent");
	});

	test("the channel is picked by its name alone: a Flowith Next prompt carries no server URL", () => {
		const next = m.channels.find((c) => c.internal)!;
		const prompt = parse("hosts/install.json").channels.find((c: { id: string }) => c.id === next.id).copyPrompt as string;
		expect(prompt).toStartWith(`Install ${next.displayName} in this agent by following ${next.installUrl}, then `);
		expect(prompt.match(/https?:\/\/\S+/g)).toEqual([`${next.installUrl},`]);
		const install = files.get("INSTALL.md")!;
		expect(install).toContain(`the words "${next.displayName}"`);
		expect(install).toContain("never take a server URL from the message");
	});

	test("while flowith.io's hosted MCP isn't live, the docs keep the CLI first and call the MCP coming soon", () => {
		const prod = m.channels.find((c) => !c.internal)!;
		const install = files.get("INSTALL.md")!;
		const readme = files.get("README.md")!;
		const cliFirst = (text: string) => text.indexOf("Skill + CLI") < text.indexOf("Hosted MCP");
		if (prod.live) {
			expect(cliFirst(install)).toBe(false);
			expect(cliFirst(readme)).toBe(false);
		} else {
			expect(cliFirst(install)).toBe(true);
			expect(cliFirst(readme)).toBe(true);
			expect(install).toContain("coming soon");
			expect(readme).toContain("coming soon");
			// No install command for the production plugin while it isn't live.
			expect(install).not.toContain(`claude plugin install ${prod.id}@`);
			expect(readme).not.toContain(`claude plugin install ${prod.id}@`);
		}
	});

	// 作品模板闭环 甲: each host asks the user as little as it can.
	test("Codex installs and signs in with one escalated call, Claude Code installs with one Bash call", () => {
		for (const channel of m.channels) {
			const codex = mcpInstall(m, "codex", channel);
			expect(codex.oneCall).toBe(codex.commands.join("; "));
			expect(codex.oneCall!.endsWith(`codex mcp login ${channel.id}`)).toBe(true);
			expect(mcpInstall(m, "claude-code", channel).oneCall).toBe(`claude plugin marketplace add ${m.repository.github}; claude plugin install ${channel.id}@${m.marketplace.name}`);
		}
		const install = files.get("INSTALL.md")!;
		expect(install).toContain("Run this as **one** shell call, so the user approves once");
		expect(install).toContain("Never split it into three calls");
		// The sign-in step never tells the user to click Allow before the page asks: a fresh copy needs no click.
		expect(install).not.toContain("click Allow there (sign up first");
		expect(install).toContain("If it asks, sign in and click Allow");
	});

	test("all six hosts the website lists have their way in: WorkBuddy through its mcp.json, DeepSeek Harness through the skill + CLI", () => {
		expect(m.hosts.map((host) => host.id)).toEqual(["claude-code", "codex", "cursor", "antigravity", "workbuddy", "deepseek-harness"]);
		const install = files.get("INSTALL.md")!;
		const json = parse("hosts/install.json");
		for (const channel of m.channels) {
			const workbuddy = mcpInstall(m, "workbuddy", channel);
			expect(workbuddy.config).toEqual({ path: "~/.workbuddy/mcp.json", entry: { type: "http", url: channel.mcpUrl, headers: { "x-flowith-mcp-client": "workbuddy", "x-flowith-plugin-version": m.version, "x-flowith-install-source": "workbuddy-mcp-json" } } });
			expect(mcpInstall(m, "deepseek-harness", channel).cliOnly).toBe(true);
			expect(Object.keys(json.channels.find((c: { id: string }) => c.id === channel.id).hosts)).toEqual(m.hosts.map((host) => host.id));
		}
		expect(install).toContain("### WorkBuddy");
		expect(install).toContain("### DeepSeek Harness");
		expect(install).toContain("`npx -y skills add flowith-ai/canvas-cowork -g -a codex -y` (the skills CLI has no DeepSeek Harness id");
	});
});
