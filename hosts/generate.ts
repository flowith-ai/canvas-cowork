#!/usr/bin/env node
/**
 * Writes every host package from hosts/manifest.json: the Claude Code marketplace and plugins, the Codex
 * marketplace and plugins (with an onboarding skill), the Antigravity plugins, Cursor's mcp.json and install
 * links, hosts/install.json (what the website's "Connect an agent" dialog shows) and the generated parts of
 * README.md and INSTALL.md. One package per host and channel; files are copies, never symlinks (Codex refuses a
 * symlinked manifest, and an installed plugin is copied out of this repo).
 *
 *   node hosts/generate.ts           write everything (Bun works too)
 *   node hosts/generate.ts --check   list what differs from the manifest; exit 1 if anything does
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export interface Channel {
	id: string;
	displayName: string;
	site: string;
	mcpUrl: string;
	/** The install address copy prompts name: <site>/agent, which serves INSTALL.md to agents and a page to people. */
	installUrl: string;
	/** False until installUrl serves the guide (flowith.io/agent ships with hypergpt-frontend's release): prompts then
	 * name installGuide. Default true. */
	installUrlLive?: boolean;
	/** Whether this channel's hosted MCP (and its sign-in) is live. Off: the docs keep the CLI primary. */
	live: boolean;
	internal?: boolean;
	note?: string;
}

export interface Host {
	id: "claude-code" | "codex" | "cursor" | "antigravity" | "workbuddy" | "deepseek-harness";
	displayName: string;
	/** The agent id `npx skills add -a` takes for this host; null when the skills CLI doesn't know it. */
	skillsAgent: string | null;
	/** Why that id, when it isn't the host's own. */
	skillsNote?: string;
}

export interface Manifest {
	name: string;
	displayName: string;
	version: string;
	description: string;
	longDescription: string;
	author: { name: string; url: string };
	homepage: string;
	privacyPolicyURL: string;
	termsOfServiceURL: string;
	license: string;
	brandColor: string;
	category: string;
	keywords: string[];
	repository: { github: string; branch: string };
	marketplace: { name: string; displayName: string };
	skill: { name: string; source: string; references: string };
	headers: { client: string; version: string; installSource: string };
	channels: Channel[];
	hosts: Host[];
	starters: { en: string[]; zh: string[] };
	/** INSTALL.md's own address (raw GitHub): what each channel's installUrl passes on. */
	installGuide: string;
	copyPrompt: { template: string; anyHost: string; defaultTask: string };
}

/** Directories this generator owns entirely: any file in them it doesn't write is stale. */
export const OWNED_DIRS = ["plugins"];
/** Hand-written files with generated regions (`<!-- generated:name -->` … `<!-- /generated:name -->`). */
export const DOCS = ["README.md", "INSTALL.md"];

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
/**
 * The MCP server's name inside the Claude Code plugins, the same for every channel. Claude Code names a plugin's tools
 * "plugin:<plugin>:<server> — <tool title>" and offers "Yes, and don't ask again" only while that name is under 48
 * columns (2.1.332); with the plugin's id twice ("plugin:flowith-next:flowith-next", 32), every title over 12 characters
 * lost it, so each wait for the user (get_task) asked again (作品模板闭环 戊, 11-28). With "flowith", titles up to 17
 * characters keep it on Flowith Next and up to 22 on flowith.io.
 */
const CLAUDE_CODE_SERVER = "flowith";

const githubUrl = (m: Manifest) => `https://github.com/${m.repository.github}`;
const treeUrl = (m: Manifest, path: string) => `${githubUrl(m)}/tree/${m.repository.branch}/${path}`;
const blobUrl = (m: Manifest, path: string) => `${githubUrl(m)}/blob/${m.repository.branch}/${path}`;
const hostOf = (url: string) => new URL(url).host;
const packageDir = (host: Host["id"], channel: Channel) => `plugins/${host}/${channel.id}`;

export function loadManifest(root = ROOT): Manifest {
	return JSON.parse(readFileSync(join(root, "hosts/manifest.json"), "utf8")) as Manifest;
}

/** The headers every package's MCP config sends, where its host can send headers. */
export function headersFor(m: Manifest, host: Host["id"], installSource: string): Record<string, string> {
	return { [m.headers.client]: host, [m.headers.version]: m.version, [m.headers.installSource]: installSource };
}

/**
 * Cursor's documented install link: the name, and base64 of the server's own config (no mcpServers wrapper).
 * `web` is the same install through cursor.com/install-mcp, for pages that can't link a `cursor://` URL (GitHub).
 */
export function cursorInstallLink(m: Manifest, channel: Channel, web = false): string {
	const config = { url: channel.mcpUrl, headers: headersFor(m, "cursor", "cursor-deeplink") };
	const query = `name=${encodeURIComponent(channel.id)}&config=${encodeURIComponent(Buffer.from(JSON.stringify(config)).toString("base64"))}`;
	return web ? `https://cursor.com/install-mcp?${query}` : `cursor://anysphere.cursor-deeplink/mcp/install?${query}`;
}

export const codexInstallLink = (m: Manifest, channel: Channel) => `codex://plugins/install/${channel.id}?marketplace=${m.marketplace.name}`;

/** Each channel's plugin is named after it, and so is its MCP server: `flowith`, `flowith-next`. */
const channelDescription = (m: Manifest, channel: Channel) =>
	channel.live
		? channel.internal
			? `${m.description} ${channel.displayName}: ${channel.note ?? channel.site}`
			: m.description
		: `${m.description} Coming soon: the hosted server for ${new URL(channel.site).host} is not live yet; use the canvas-cowork skill and CLI until it is.`;

// ---------- skills ----------

/** The craft skill (SKILL.md and its references), named for the plugin, and the onboarding skill. */
function skillFiles(m: Manifest, root: string): Record<string, string> {
	const files: Record<string, string> = {};
	const source = readFileSync(join(root, m.skill.source), "utf8");
	if (!/^---\nname: [^\n]+\n/.test(source)) throw new Error(`${m.skill.source} must start with front matter whose first line is \`name:\`.`);
	files[`skills/${m.skill.name}/SKILL.md`] = source.replace(/^---\nname: [^\n]+\n/, `---\nname: ${m.skill.name}\n`);
	for (const name of readdirSync(join(root, m.skill.references)).filter((f) => f.endsWith(".md")).sort())
		files[`skills/${m.skill.name}/${m.skill.references}/${name}`] = readFileSync(join(root, m.skill.references, name), "utf8");
	files["skills/get-started/SKILL.md"] = getStartedSkill(m);
	checkLinks(files);
	return files;
}

/** A relative link in a copied skill must land inside the copy; anything else is written as a full URL. */
function checkLinks(files: Record<string, string>) {
	for (const [path, text] of Object.entries(files)) {
		for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
			if (/^[a-z][a-z0-9+.-]*:/i.test(target!) || target!.startsWith("#")) continue;
			const resolved = posix.normalize(posix.join(posix.dirname(path), target!.split("#")[0]!));
			if (!(resolved in files)) throw new Error(`${path} links to ${target}, which a plugin's copy of the skill doesn't have. Link it as a full URL.`);
		}
	}
}

function getStartedSkill(m: Manifest): string {
	const list = (items: string[]) => items.map((s, i) => `${i + 1}. ${s}`).join("\n");
	return `---
name: get-started
description: Welcome someone who just installed ${m.displayName} in one short message, with three things to try. Use right after ${m.displayName} is installed, when the user picks Set up, or asks how to start with ${m.displayName} or what to try first.
---

# Get started with ${m.displayName}

If ${m.displayName} was installed in the middle of a task (the user asked for something besides installing it), skip the
welcome: check the connection as in step 1, then do that task with the \`${m.skill.name}\` skill in this conversation.

1. Check the connection with a real read: \`list_canvases { limit: 5 }\`. The first call may open ${m.displayName} in the
   browser; the user signs in if asked and clicks **Allow** once. Don't say it works before that read answers. If
   the tools aren't here, follow https://github.com/${m.repository.github}/blob/${m.repository.branch}/INSTALL.md.
2. Call \`get_started { locale }\` with the user's language (\`en\`, \`zh\`; for another language take \`en\` and
   translate faithfully). Write one short message from it, and call no other tools for it:
   - its \`welcome\`, in one or two sentences;
   - its three \`starters\` as a numbered list (each starter's \`title\`; keep its \`prompt\` for when they pick it);
   - one closing line: reply with a number, or say what to make.

   If \`get_started\` isn't in your tools, say in one or two sentences that ${m.displayName} makes pictures, clips,
   voice and music as cards on their own canvas, and offer these, word for word (in Chinese, the second list):

${list(m.starters.en).replace(/^/gm, "   ")}

${list(m.starters.zh).replace(/^/gm, "   ")}
3. When they answer, do it with the \`${m.skill.name}\` skill (a number: that starter's \`prompt\`). A starter that needs
   their file (a product photo): ask for it first.

Never explain how ${m.displayName} was installed or configured, and don't mention models, plans or credits here.
`;
}

const assets = (root: string) => ({
	"assets/logo.svg": readFileSync(join(root, "hosts/assets/logo.svg"), "utf8"),
	"assets/logo-dark.svg": readFileSync(join(root, "hosts/assets/logo-dark.svg"), "utf8"),
});

// ---------- packages ----------

function claudeCodePackage(m: Manifest, channel: Channel, skills: Record<string, string>): Record<string, string> {
	return {
		".claude-plugin/plugin.json": json({
			name: channel.id,
			version: m.version,
			description: channelDescription(m, channel),
			author: m.author,
			homepage: m.homepage,
			repository: githubUrl(m),
			license: m.license,
			keywords: m.keywords,
		}),
		".mcp.json": json({
			mcpServers: { [CLAUDE_CODE_SERVER]: { type: "http", url: channel.mcpUrl, headers: headersFor(m, "claude-code", "claude-code-plugin") } },
		}),
		...skills,
	};
}

function codexPackage(m: Manifest, channel: Channel, skills: Record<string, string>, root: string): Record<string, string> {
	return {
		".codex-plugin/plugin.json": json({
			name: channel.id,
			version: m.version,
			description: channelDescription(m, channel),
			author: m.author,
			homepage: m.homepage,
			repository: githubUrl(m),
			license: m.license,
			keywords: m.keywords,
			skills: "./skills/",
			mcpServers: "./.mcp.json",
			extensions: { "com.openai": { onboardingSkill: "./skills/get-started/SKILL.md" } },
			interface: {
				displayName: channel.displayName,
				shortDescription: "Pictures, clips and sound on your canvas",
				longDescription: m.longDescription,
				developerName: m.author.name,
				category: m.category,
				capabilities: ["Interactive", "Read", "Write"],
				websiteURL: channel.site,
				privacyPolicyURL: m.privacyPolicyURL,
				termsOfServiceURL: m.termsOfServiceURL,
				defaultPrompt: m.starters.en,
				brandColor: m.brandColor,
				composerIcon: "./assets/logo.svg",
				logo: "./assets/logo.svg",
				logoDark: "./assets/logo-dark.svg",
			},
		}),
		// Codex's plugin MCP config takes `http_headers` (its config.toml name), not `headers`.
		".mcp.json": json({
			mcpServers: { [channel.id]: { type: "http", url: channel.mcpUrl, http_headers: headersFor(m, "codex", "codex-plugin") } },
		}),
		...assets(root),
		...skills,
	};
}

function antigravityPackage(m: Manifest, channel: Channel, skills: Record<string, string>, root: string): Record<string, string> {
	return {
		"plugin.json": json({
			$schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
			name: channel.id,
			displayName: channel.displayName,
			version: m.version,
			description: channelDescription(m, channel),
			logo: "assets/logo.svg",
			author: m.author,
			homepage: m.homepage,
			repository: githubUrl(m),
			license: m.license,
			keywords: m.keywords,
			suggestedPrompts: m.starters.en,
		}),
		// Antigravity takes remote servers as `serverUrl` (Streamable HTTP), not `url`.
		"mcp_config.json": json({
			mcpServers: { [channel.id]: { serverUrl: channel.mcpUrl, headers: headersFor(m, "antigravity", "antigravity-plugin") } },
		}),
		...assets(root),
		...skills,
	};
}

function cursorPackage(m: Manifest, channel: Channel): Record<string, string> {
	return {
		"mcp.json": json({ mcpServers: { [channel.id]: { url: channel.mcpUrl, headers: headersFor(m, "cursor", "cursor-mcp-json") } } }),
	};
}

// ---------- install commands (docs, install.json) ----------

export interface HostInstall {
	/** Shell commands, in order, that install and sign in on this host. */
	commands: string[];
	/** The same commands as one shell call, for a host that asks for approval per call: one approval, not one each. */
	oneCall?: string;
	/** A link the host opens to install in one click, where it has one. */
	oneClick?: string;
	/** The same one-click install as an https link, for web pages. */
	webLink?: string;
	/** What opens the tools: a new session or thread, or nothing. */
	thenNew?: string;
	/** A host whose agent adds the server by writing its MCP config: the file, and the one entry to add under mcpServers. */
	config?: { path: string; entry: Record<string, unknown> };
	/** A host that can't sign in to a remote MCP server like this one: it uses the skill + CLI. */
	cliOnly?: true;
}

/**
 * Commands joined into one shell call. `;`, not `&&`: adding a marketplace or plugin that is already there (a second
 * install) fails harmlessly, and the last command (the sign-in) still runs and gives the call its exit status.
 */
const oneCall = (commands: string[]) => commands.join("; ");

/** What a sign-in asks of the user (作品模板闭环 甲): nothing right after a copy on the site, else one click. */
const signInNote = (site: string) =>
	`When the user copied the install line on ${site} in the last 10 minutes, the page connects at once; otherwise they sign in if asked and click **Allow** once.`;

export function mcpInstall(m: Manifest, host: Host["id"], channel: Channel): HostInstall {
	const repo = m.repository.github;
	const plugin = `${channel.id}@${m.marketplace.name}`;
	switch (host) {
		case "claude-code":
			// No `claude mcp login` here: run from the agent's own shell it stops at once (Claude Code 2.1.318 waits for a
			// pasted redirect URL only when stdin is a terminal). The agent signs in with the server's `authenticate` tool.
			return {
				commands: [`claude plugin marketplace add ${repo}`, `claude plugin install ${plugin}`],
				oneCall: oneCall([`claude plugin marketplace add ${repo}`, `claude plugin install ${plugin}`]),
				thenNew: "this session, after the user types `/reload-plugins`",
			};
		case "codex":
			return {
				commands: [`codex plugin marketplace add ${repo}`, `codex plugin add ${plugin}`, `codex mcp login ${channel.id}`],
				oneCall: oneCall([`codex plugin marketplace add ${repo}`, `codex plugin add ${plugin}`, `codex mcp login ${channel.id}`]),
				oneClick: codexInstallLink(m, channel),
				thenNew: "a new thread",
			};
		case "cursor":
			return {
				commands: [],
				oneClick: cursorInstallLink(m, channel),
				webLink: cursorInstallLink(m, channel, true),
				thenNew: "a new chat once the server shows as connected",
			};
		case "antigravity":
			return { commands: [`agy plugin install ${treeUrl(m, packageDir("antigravity", channel))}`], thenNew: "a new conversation" };
		case "workbuddy":
			// WorkBuddy (Tencent) has no install command or link: its MCP servers live in ~/.workbuddy/mcp.json (插件 → MCP 服务器 →
			// 配置 MCP edits the same file). The entry is the CodeBuddy family's remote shape; not yet run on a real WorkBuddy.
			return {
				commands: [],
				config: { path: "~/.workbuddy/mcp.json", entry: { type: "http", url: channel.mcpUrl, headers: headersFor(m, "workbuddy", "workbuddy-mcp-json") } },
				thenNew: "a new conversation once WorkBuddy shows the server connected",
			};
		case "deepseek-harness":
			// Its MCP client signs in only its own connector plugins (deepseek-harness packages/mcp/mcp-account): any other server
			// needs a bearer token pasted into its config, which Flowith never hands out. So the skill + CLI, in this conversation.
			return { commands: [], cliOnly: true, thenNew: "this conversation" };
	}
}

/** The skills CLI's install for this host, or null when the CLI doesn't know it (the CLI then runs with no install). */
export const cliInstall = (m: Manifest, host: Host) => (host.skillsAgent ? `npx -y skills add ${m.repository.github} -g -a ${host.skillsAgent} -y` : null);

/** The address a channel's copy prompts name: its /agent address once that serves the guide, else INSTALL.md itself. */
export const promptGuide = (m: Manifest, channel: Channel) => (channel.installUrlLive === false ? m.installGuide : channel.installUrl);

export function copyPrompt(m: Manifest, channel: Channel, host?: Host, task = m.copyPrompt.defaultTask) {
	return m.copyPrompt.template
		.replace("{channel}", channel.displayName)
		.replace("{host}", host?.displayName ?? m.copyPrompt.anyHost)
		.replace("{guide}", promptGuide(m, channel))
		.replace("{task}", task);
}

function installJson(m: Manifest): string {
	return json({
		$comment: "Generated from hosts/manifest.json by hosts/generate.ts; don't edit by hand. What the website's Connect an agent dialog shows.",
		version: m.version,
		installGuide: m.installGuide,
		headers: m.headers,
		channels: m.channels.map((channel) => ({
			id: channel.id,
			displayName: channel.displayName,
			site: channel.site,
			mcpUrl: channel.mcpUrl,
			installUrl: channel.installUrl,
			installUrlLive: channel.installUrlLive ?? true,
			live: channel.live,
			internal: channel.internal ?? false,
			copyPrompt: copyPrompt(m, channel),
			copyPromptTemplate: copyPrompt(m, channel, undefined, "{task}"),
			hosts: Object.fromEntries(
				m.hosts.map((host) => [
					host.id,
					{
						displayName: host.displayName,
						copyPrompt: copyPrompt(m, channel, host),
						mcp: mcpInstall(m, host.id, channel),
						cli: { commands: [cliInstall(m, host) ?? `npx -y github:${m.repository.github} login`] },
					},
				]),
			),
		})),
	});
}

// ---------- docs ----------

const fence = (lines: string[]) => ["```bash", ...lines, "```"].join("\n");

/** Claude Code's sign-in steps for a hosted channel (INSTALL.md). */
function claudeCodeSteps(channel: Channel): string[] {
	const tool = (name: string) => `mcp__plugin_${channel.id}_${CLAUDE_CODE_SERVER}__${name}`;
	return [
		"Then sign in and work in this same session, in exactly this order. Don't run `claude mcp login`: from your shell it stops at once (it needs a terminal). A plugin's server loads only after `/reload-plugins`, which only the user can type, and your background wait is what wakes you up after each thing the user does:",
		"",
		"```text",
		"1. Right after the install, in the same reply, do both:",
		"   a. Call Bash with run_in_background: true and the command `sleep 10`. Never skip it: the user's /reload-plugins doesn't wake you up, and this wait is the only thing that brings you back after it (kept short, so they don't sit waiting once they have typed it).",
		`   b. Tell the user in one line: "Type /reload-plugins and I'll open the sign-in page."`,
		`2. When the wait ends, look for ${tool("authenticate")} (ToolSearch "select:${tool("authenticate")}"). Not there yet: call Bash again with run_in_background: true and \`sleep 10\`, and write nothing at all (up to 5 minutes).`,
		`3. Call it. Then open the link it answers and wait, in ONE Bash call in the background (10-minute timeout; one approval, not two), and tell the user in one line: "I've opened Flowith in your browser to connect it. If it asks, sign in and click Allow; I'll carry on by myself." The call (on Linux xdg-open, on Windows start, in place of open) ends by itself once they are connected, usually at once since they copied the install line on Flowith: open '<link>'; until claude mcp list 2>/dev/null | grep -q "plugin:${channel.id}:${CLAUDE_CODE_SERVER}.*Connected"; do sleep 5; done`,
		"4. When it ends, look for list_canvases (not there yet: sleep 5 and look again).",
		"5. A task: call list_canvases, then do it right here (no new session is needed). No task: call only get_started (it reads the account, so it is the check) and offer its starters.",
		"Between these steps write nothing to the user: no \"waiting\" lines when a wait ends. They see the two lines above, then their result.",
		`Only if the wait ran out without connecting (the page couldn't hand the sign-in back to Claude Code): ask the user for that page's address and pass it to ${tool("complete_authentication")}. Don't tell them about this beforehand.`,
		"```",
	];
}

function mcpSection(m: Manifest, channel: Channel): string {
	const site = hostOf(channel.site);
	const parts: string[] = [];
	for (const host of m.hosts) {
		const install = mcpInstall(m, host.id, channel);
		parts.push(`### ${host.displayName}\n`);
		if (host.id === "claude-code") {
			parts.push(
				fence([install.oneCall!]),
				"",
				`Run it as one Bash call: one approval. The plugin holds only the address of Flowith's remote MCP server (\`.mcp.json\`) and two skills (\`flowith\`, \`get-started\`): no hooks, commands or code that runs on this computer. It is at ${treeUrl(m, `plugins/claude-code/${channel.id}`)}.`,
				"",
				...claudeCodeSteps(channel),
			);
		} else if (host.id === "codex")
			parts.push(
				fence([install.oneCall!]),
				"",
				`Run this as **one** shell call, so the user approves once: with escalated permissions (\`sandbox_permissions: "require_escalated"\`, justification "Install ${channel.displayName} and connect your account"; Codex's sandbox has no network and can't write to Codex's own folder) and a timeout of 10 minutes or more: \`mcp login\` opens ${site} and ends by itself once the user is connected. ${signInNote(site)} Never split it into three calls: each would ask the user again. If Codex rejects escalation without asking the user, tell them in one line: "Type /permissions, choose Ask for approval, then say go on."`,
				"",
				"The tools load only in a new thread, which you start yourself:",
				"",
				"```text",
				`After mcp login: call create_thread (Codex's codex_tui tools) with the user's request, word for word, plus "${channel.displayName} is installed and signed in; check with list_canvases, then do this." Then tell the user in one line that it is running in a new thread (codex://threads/<threadId>), where Codex may ask them to allow Flowith's tools.`,
				"```",
				"",
				`In the Codex app, once the marketplace is added, \`${install.oneClick}\` opens the install page.`,
			);
		else if (host.id === "cursor")
			parts.push(
				`Open this install link (\`open '<link>'\` on macOS, \`xdg-open\` on Linux, \`start\` on Windows). Cursor asks the user to confirm the install, then shows that the server needs sign-in: the user clicks Connect and ${site} opens (Cursor's desktop sign-in comes back to localhost). ${signInNote(site)}`,
				"",
				"```text",
				install.oneClick!,
				"```",
				"",
				`Where links can't open, add only this entry under \`mcpServers\` in \`~/.cursor/mcp.json\` and keep every other server as it is ([the file](${blobUrl(m, `${packageDir("cursor", channel)}/mcp.json`)})); the user signs in from Cursor's MCP settings:`,
				"",
				"```json",
				JSON.stringify({ [channel.id]: { url: channel.mcpUrl, headers: headersFor(m, "cursor", "cursor-mcp-json") } }, null, 2),
				"```",
			);
		else if (host.id === "antigravity")
			parts.push(
				fence(install.commands),
				"",
				`Antigravity opens ${site} to sign in when the server first connects. Its sign-in comes back through antigravity.google, not this computer, so ${site} always asks the user to click **Allow**, and Antigravity's page then shows a code the user pastes back into Antigravity. The tools load in ${install.thenNew}.`,
			);
		else if (host.id === "workbuddy")
			parts.push(
				`WorkBuddy has no install command. Add only this entry under \`mcpServers\` in \`${install.config!.path}\` (create the file if it isn't there; keep every other server as it is). WorkBuddy applies the file at once and lists Flowith under 插件 → MCP 服务器; when it shows it needs authorization, the user clicks 授权 there and ${site} opens. ${signInNote(site)} If you can't write that file (it is outside the workspace), tell the user in one line: "In WorkBuddy open 插件 → MCP 服务器 → 配置 MCP and add this entry", with the entry below.`,
				"",
				"```json",
				JSON.stringify({ [channel.id]: install.config!.entry }, null, 2),
				"```",
				"",
				`The tools load in ${install.thenNew}: start it with the user's request, word for word, if you can; otherwise one line: "Start a new conversation and paste: <their task>".`,
			);
		else
			parts.push(
				`DeepSeek Harness signs in to remote MCP servers only through its own connector plugins, so use the **skill + CLI** below, in ${install.thenNew}: the skill goes into \`~/.agents/skills\`, which it watches, so nothing needs a restart. The CLI's sign-in is the one place a code is typed: the user types the code the CLI prints on ${site} and clicks **Allow**.`,
			);
		parts.push("");
	}
	parts.push(
		"### Any other agent that can add a remote MCP server\n",
		`Add a Streamable HTTP server named \`${channel.id}\` at \`${channel.mcpUrl}\` with the host's own command or settings. It signs in with OAuth on first use, on ${site}. ${signInNote(site)}`,
	);
	return parts.join("\n");
}

function cliSection(m: Manifest): string {
	return [
		"Needs Node 22.18+ (or Bun 1.1+). Install the skill for this host only:",
		"",
		"| Host | Command |",
		"|---|---|",
		...m.hosts.map((host) => {
			const command = cliInstall(m, host);
			const note = host.skillsNote ? ` (${host.skillsNote})` : "";
			return `| ${host.displayName} | ${command ? `\`${command}\`${note}` : `no skills CLI id: use the hosted MCP above, or the CLI with no install`} |`;
		}),
		"",
		`Another agent with a shell: the same command with its own id from [the skills CLI's list](https://github.com/vercel-labs/skills/blob/main/docs/agents.md) (never without \`-a\`: that installs for every agent on the computer), or run the CLI with no install: \`npx -y github:${m.repository.github} <command>\`.`,
		"",
		"Then, in the installed skill's folder (the path `skills add` printed, e.g. `~/.claude/skills/canvas-cowork`):",
		"",
		"1. **Sign in**: run `node scripts/index.ts login` in the background (a timeout of 3 minutes or more). It opens flowith.io and prints a code on stderr; tell the user in one line to type that code on the page and click **Allow**, then wait for the command to finish.",
		"2. **Verify**: `node scripts/index.ts canvases --json` lists their canvases.",
		"3. **Carry on in this conversation**: read the skill's `SKILL.md` and do the user's task with the CLI. No new session is needed.",
	].join("\n");
}

/** The generated regions of README.md and INSTALL.md. */
export function docRegions(m: Manifest): Record<string, Record<string, string>> {
	const prod = m.channels.find((c) => !c.internal) ?? m.channels[0]!;
	const next = m.channels.filter((c) => c.internal);
	const prodHost = new URL(prod.site).host;

	const installPaths = prod.live
		? [
				`## Hosted MCP (${prod.displayName})`,
				"",
				`Use this. Configure only this host. For ${next.map((c) => c.displayName).join(", ")}, use the same commands with \`${next.map((c) => c.id).join("`, `")}\` in place of \`${prod.id}\`.`,
				"",
				mcpSection(m, prod),
				"",
				"## Skill + CLI (only where the host can't add a remote MCP server)",
				"",
				cliSection(m),
			]
		: [
				"## Status",
				"",
				`The hosted ${m.displayName} MCP for **${prodHost} is coming soon**. Until it is live, install the **skill + CLI** below: it is what works on ${prodHost} today. The hosted MCP runs only on ${next.map((c) => `**${c.displayName}** (${new URL(c.site).host})`).join(", ")} for testing: use it only when the user asked for ${next.map((c) => c.displayName).join(" or ")}.`,
				"",
				`## Skill + CLI (${prodHost}, today)`,
				"",
				cliSection(m),
				"",
				...next.flatMap((channel) => [`## Hosted MCP (${channel.displayName}, testing only)`, "", mcpSection(m, channel), ""]),
				`The ${prod.displayName} packages (\`${prod.id}\`) are built the same way and turn on when ${prodHost}'s hosted MCP ships.`,
			];

	const readmePrompts = [
		"Paste one line into your agent, with your task at the end:",
		"",
		"```text",
		copyPrompt(m, prod, undefined, "make three poster designs for an autumn latte."),
		"```",
		"",
		...(next.length
			? [
					`For internal testing of the hosted MCP on ${next.map((c) => new URL(c.site).host).join(", ")}:`,
					"",
					"```text",
					...next.map((c) => copyPrompt(m, c, undefined, "make three poster designs for an autumn latte.")),
					"```",
					"",
				]
			: []),
		`Naming the host also works (\`Install ${prod.displayName} in Codex by following …\`). [INSTALL.md](./INSTALL.md) tells the agent how to set itself up; [hosts/install.json](./hosts/install.json) has every prompt, command and link for the website.`,
	].join("\n");

	const hostTable = (channel: Channel) =>
		[
			"| Host | Install |",
			"|---|---|",
			...m.hosts.map((host) => {
				const install = mcpInstall(m, host.id, channel);
				const cmds = [
					...install.commands.map((c) => `\`${c}\``),
					...(host.id === "claude-code" ? ["then `/reload-plugins`: your agent opens the sign-in page"] : []),
					...(install.config ? [`add the \`${channel.id}\` entry to \`${install.config.path}\` (INSTALL.md)`] : []),
					...(install.cliOnly ? ["the skill + CLI below"] : []),
				].join("<br>");
				const link = install.webLink ? `[Add to Cursor](${install.webLink})` : "";
				return `| ${host.displayName} | ${[cmds, link].filter(Boolean).join("<br>")} |`;
			}),
		].join("\n");

	const readmeInstall = (
		prod.live
			? [
					`### Hosted MCP (recommended)\n`,
					hostTable(prod),
					"",
					"Sign-in happens on first use: the host opens flowith.io, which connects at once if you copied the line there; otherwise you click **Allow** once.",
					"",
					"### Skill + CLI (hosts that can't add a remote MCP server)\n",
					m.hosts.flatMap((host) => (cliInstall(m, host) ? [`- ${host.displayName}: \`${cliInstall(m, host)}\``] : [])).join("\n"),
				]
			: [
					`### Skill + CLI (${prodHost} today)\n`,
					m.hosts.flatMap((host) => (cliInstall(m, host) ? [`- ${host.displayName}: \`${cliInstall(m, host)}\``] : [])).join("\n"),
					"",
					"Then `node scripts/index.ts login` from the skill's folder (your agent does this for you): type the code it prints on the Flowith page and click **Allow**, once.",
					"",
					`### Hosted MCP (coming soon to ${prodHost})\n`,
					`No local runtime: the agent gets ${m.displayName}'s tools from a hosted server, and flowith.io connects it without a click when you copied the line there (one click on **Allow** otherwise). It is live on ${next.map((c) => `${c.displayName} (${new URL(c.site).host})`).join(", ")} for testing; the ${prod.displayName} packages turn on when ${prodHost} ships it.`,
					"",
					...next.flatMap((c) => [hostTable(c), ""]),
				]
	).join("\n");

	return {
		"README.md": { prompts: readmePrompts, install: readmeInstall.trimEnd() },
		"INSTALL.md": { paths: installPaths.join("\n").trimEnd() },
	};
}

/** Replaces each generated region of a doc; throws if a region's markers are missing. */
export function fillRegions(text: string, regions: Record<string, string>, path: string): string {
	let out = text;
	for (const [name, body] of Object.entries(regions)) {
		const pattern = new RegExp(`(<!-- generated:${name} -->\\n)[\\s\\S]*?(<!-- /generated:${name} -->)`);
		if (!pattern.test(out)) throw new Error(`${path} has no <!-- generated:${name} --> … <!-- /generated:${name} --> region.`);
		out = out.replace(pattern, (_, open: string, close: string) => `${open}${body}\n${close}`);
	}
	return out;
}

// ---------- everything ----------

/** Every generated file: repo-relative path → contents. */
export function generate(m: Manifest = loadManifest(), root = ROOT): Map<string, string> {
	const files = new Map<string, string>();
	const add = (dir: string, entries: Record<string, string>) => {
		for (const [path, text] of Object.entries(entries)) files.set(dir ? `${dir}/${path}` : path, text);
	};
	const skills = skillFiles(m, root);
	for (const channel of m.channels) {
		add(packageDir("claude-code", channel), claudeCodePackage(m, channel, skills));
		add(packageDir("codex", channel), codexPackage(m, channel, skills, root));
		add(packageDir("antigravity", channel), antigravityPackage(m, channel, skills, root));
		add(packageDir("cursor", channel), cursorPackage(m, channel));
	}
	files.set(
		".claude-plugin/marketplace.json",
		json({
			name: m.marketplace.name,
			owner: m.author,
			metadata: { description: `${m.displayName} for Claude Code`, version: m.version },
			plugins: m.channels.map((channel) => ({
				name: channel.id,
				source: `./${packageDir("claude-code", channel)}`,
				description: channelDescription(m, channel),
				version: m.version,
				author: m.author,
				homepage: m.homepage,
				license: m.license,
				keywords: m.keywords,
				category: m.category.toLowerCase(),
			})),
		}),
	);
	files.set(
		".agents/plugins/marketplace.json",
		json({
			name: m.marketplace.name,
			interface: { displayName: m.marketplace.displayName },
			plugins: m.channels.map((channel) => ({
				name: channel.id,
				source: { source: "local", path: `./${packageDir("codex", channel)}` },
				policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
				category: m.category,
			})),
		}),
	);
	files.set("hosts/install.json", installJson(m));
	const regions = docRegions(m);
	for (const doc of DOCS) files.set(doc, fillRegions(readFileSync(join(root, doc), "utf8"), regions[doc] ?? {}, doc));
	return files;
}

function walk(root: string, dir: string): string[] {
	const abs = join(root, dir);
	if (!existsSync(abs)) return [];
	return readdirSync(abs, { withFileTypes: true }).flatMap((entry) => {
		const path = `${dir}/${entry.name}`;
		return entry.isDirectory() ? walk(root, path) : [path];
	});
}

/** Files that differ from what the manifest generates, are missing, or are stale in a generated directory. */
export function drift(root = ROOT, files = generate(loadManifest(root), root)): string[] {
	const out: string[] = [];
	for (const [path, text] of files) {
		const abs = join(root, path);
		if (!existsSync(abs)) out.push(`missing: ${path}`);
		else if (readFileSync(abs, "utf8") !== text) out.push(`differs: ${path}`);
	}
	for (const dir of OWNED_DIRS) for (const path of walk(root, dir)) if (!files.has(path)) out.push(`stale: ${path}`);
	return out;
}

export function write(root = ROOT, files = generate(loadManifest(root), root)) {
	for (const dir of OWNED_DIRS) for (const path of walk(root, dir)) if (!files.has(path)) rmSync(join(root, path));
	for (const [path, text] of files) {
		const abs = join(root, path);
		mkdirSync(dirname(abs), { recursive: true });
		if (!existsSync(abs) || readFileSync(abs, "utf8") !== text) writeFileSync(abs, text);
	}
	return [...files.keys()];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	if (process.argv.includes("--check")) {
		const problems = drift();
		if (problems.length) {
			process.stderr.write(`Host packages differ from hosts/manifest.json (run \`node hosts/generate.ts\`):\n${problems.map((p) => `  ${p}`).join("\n")}\n`);
			process.exit(1);
		}
		process.stdout.write("Host packages match hosts/manifest.json.\n");
	} else {
		const written = write();
		process.stdout.write(`Wrote ${written.length} files from hosts/manifest.json.\n`);
	}
}
