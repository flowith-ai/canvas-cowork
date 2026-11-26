/**
 * Every host package is what hosts/manifest.json generates: a hand edit, a stale file or a manifest change without
 * `node hosts/generate.ts` fails here. Also checks the shapes each host reads, so a generator change can't quietly
 * break one host.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { ROOT, copyPrompt, cursorInstallLink, drift, generate, loadManifest, mcpInstall } from "../generate.ts";

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

	test("every package of one host is the same apart from its channel", () => {
		const [a, b] = m.channels;
		const strip = (dir: string) => [...files].filter(([p]) => p.startsWith(dir)).map(([p]) => p.slice(dir.length)).sort();
		for (const host of m.hosts) expect(strip(`plugins/${host.id}/${a!.id}/`)).toEqual(strip(`plugins/${host.id}/${b!.id}/`));
	});

	test("install.json has a copy prompt per channel and host, pointing at INSTALL.md", () => {
		const install = parse("hosts/install.json");
		for (const channel of install.channels) {
			expect(channel.copyPrompt).toContain(m.installGuide);
			expect(channel.copyPromptTemplate).toEndWith("{task}");
			for (const host of m.hosts) expect(channel.hosts[host.id].copyPrompt).toContain(`in ${host.displayName} by following`);
		}
		expect(copyPrompt(m, m.channels[0]!)).toBe(`Install Flowith in this agent by following ${m.installGuide}, then ${m.copyPrompt.defaultTask}`);
	});

	test("the channel is picked by its name alone: a Flowith Next prompt carries no server URL", () => {
		const next = m.channels.find((c) => c.internal)!;
		const prompt = parse("hosts/install.json").channels.find((c: { id: string }) => c.id === next.id).copyPrompt as string;
		expect(prompt).toStartWith(`Install ${next.displayName} in this agent by following ${m.installGuide}, then `);
		expect(prompt.match(/https?:\/\/\S+/g)).toEqual([`${m.installGuide},`]);
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
});
