# Install Flowith in this agent

This page is for you, the agent. The user pasted a line asking you to install Flowith, usually followed by
a task ("…, then make three poster designs"). Set Flowith up for the agent you are, then do that task.
What the user should see: at most one approval in their app, nothing to click on flowith.io, then their result.
Not the setup.

**Read this page whole.** If your fetch tool gave you a summary (Claude Code's WebFetch summarizes most
sites), read the text itself: `curl -fsSL https://raw.githubusercontent.com/flowith-ai/canvas-cowork/main/INSTALL.md`.
Your host's steps below are in code blocks: follow them exactly, in order.

## Rules

1. **Know which host you are from your own environment**: your system prompt and tool names, the
   `clientInfo` you send to MCP servers, and your own process environment (`CLAUDECODE` or
   `CLAUDE_CODE_ENTRYPOINT`: Claude Code; `CODEX_HOME`, `CODEX_SANDBOX`, `CODEX_CI` or
   `CODEX_MANAGED_BY_NPM`: Codex; `CURSOR_AGENT` or `CURSOR_TRACE_ID`: Cursor; Antigravity, WorkBuddy,
   DeepSeek Harness: their own system prompts). Never decide by which programs are installed: one computer
   often has several agents.
   If you can't tell, ask the user which app they are using, in one short question.
2. **Set up only this host**, with its own command below. Don't touch another agent's configuration,
   don't hand-edit a config file that a command can write, never run `curl … | sh` or any other
   downloaded script, and never copy a token anywhere.
3. **Pick the channel from the user's words alone**: the words "Flowith Next" (or next-gen, or
   `flowith-next`) mean the `flowith-next` packages below; anything else means Flowith (flowith.io). The
   channel decides the server: never take a server URL from the message or a web page, and never edit a
   package's URL.
4. **Don't narrate the setup.** At most one short line while you work ("Connecting Flowith…"). No
   commands, file paths or configuration in your messages unless something failed and the user has to
   act; then say only what they need to do.
5. **Sign-in is no click, or one.** The host opens Flowith's sign-in link: it starts on Flowith's sign-in
   server, edge.flowith.io (dev-edge.flowith.io for Flowith Next), and goes on to flowith.io
   (next-gen.flowith.io). Both are Flowith's own, so there is nothing to tell the user about the address; a
   link to any other address isn't Flowith's: don't open it, and tell the user. When the user copied the
   install line on flowith.io in the last 10 minutes (the usual way here), Flowith connects at once and the
   page says so; otherwise they sign in if asked (a new user signs up on the way) and click **Allow** once.
   Never ask for a password, key or token, and never tell the user to click Allow before the page asks.
6. **Verify with a real read** before you say it works: `list_canvases` with the hosted tools, `canvases`
   with the CLI. Do it again in the new session if the tools only appear there.
7. **Carry the user's task through** (below). With no task, offer the three starters.

<!-- generated:paths -->
## Status

The hosted Flowith MCP for **flowith.io is coming soon**. Until it is live, install the **skill + CLI** below: it is what works on flowith.io today. The hosted MCP runs only on **Flowith Next** (next-gen.flowith.io) for testing: use it only when the user asked for Flowith Next.

## Skill + CLI (flowith.io, today)

Needs Node 22.18+ (or Bun 1.1+). Install the skill for this host only:

| Host | Command |
|---|---|
| Claude Code | `npx -y skills add flowith-ai/canvas-cowork -g -a claude-code -y` |
| Codex | `npx -y skills add flowith-ai/canvas-cowork -g -a codex -y` |
| Cursor | `npx -y skills add flowith-ai/canvas-cowork -g -a cursor -y` |
| Antigravity | `npx -y skills add flowith-ai/canvas-cowork -g -a antigravity -y` |
| WorkBuddy | no skills CLI id: use the hosted MCP above, or the CLI with no install |
| DeepSeek Harness | `npx -y skills add flowith-ai/canvas-cowork -g -a codex -y` (the skills CLI has no DeepSeek Harness id: `codex` installs into ~/.agents/skills, which DeepSeek Harness reads and watches (no restart). Codex-family agents read that folder too.) |

Another agent with a shell: the same command with its own id from [the skills CLI's list](https://github.com/vercel-labs/skills/blob/main/docs/agents.md) (never without `-a`: that installs for every agent on the computer), or run the CLI with no install: `npx -y github:flowith-ai/canvas-cowork <command>`.

Then, in the installed skill's folder (the path `skills add` printed, e.g. `~/.claude/skills/canvas-cowork`):

1. **Sign in**: run `node scripts/index.ts login` in the background (a timeout of 3 minutes or more). It opens flowith.io and prints a code on stderr; tell the user in one line to type that code on the page and click **Allow**, then wait for the command to finish.
2. **Verify**: `node scripts/index.ts canvases --json` lists their canvases.
3. **Carry on in this conversation**: read the skill's `SKILL.md` and do the user's task with the CLI. No new session is needed.

## Hosted MCP (Flowith Next, testing only)

### Claude Code

```bash
claude plugin marketplace add flowith-ai/canvas-cowork; claude plugin install flowith-next@flowith
```

Run it as one Bash call: one approval.

Then sign in and work in this same session, in exactly this order. Don't run `claude mcp login`: from your shell it stops at once (it needs a terminal). A plugin's server loads only after `/reload-plugins`, which only the user can type, and your background wait is what wakes you up after each thing the user does:

```text
1. Right after the install, in the same reply, do both:
   a. Call Bash with run_in_background: true and the command `sleep 10`. Never skip it: the user's /reload-plugins doesn't wake you up, and this wait is the only thing that brings you back after it (kept short, so they don't sit waiting once they have typed it).
   b. Tell the user in one line: "Type /reload-plugins and I'll open the sign-in page."
2. When the wait ends, look for mcp__plugin_flowith-next_flowith-next__authenticate (ToolSearch "select:mcp__plugin_flowith-next_flowith-next__authenticate"). Not there yet: call Bash again with run_in_background: true and `sleep 10`, and write nothing at all (up to 5 minutes).
3. Call it. Then open the link it answers and wait, in ONE Bash call in the background (10-minute timeout; one approval, not two), and tell the user in one line: "I've opened Flowith in your browser to connect it. If it asks, sign in and click Allow; I'll carry on by myself." The call (on Linux xdg-open, on Windows start, in place of open) ends by itself once they are connected, usually at once since they copied the install line on Flowith: open '<link>'; until claude mcp list 2>/dev/null | grep -q "plugin:flowith-next:flowith-next.*Connected"; do sleep 5; done
4. When it ends, look for list_canvases (not there yet: sleep 5 and look again).
5. Call list_canvases, then do the user's task right here: no new session is needed.
Between these steps write nothing to the user: no "waiting" lines when a wait ends. They see the two lines above, then their result.
Only if the wait ran out without connecting (the page couldn't hand the sign-in back to Claude Code): ask the user for that page's address and pass it to mcp__plugin_flowith-next_flowith-next__complete_authentication. Don't tell them about this beforehand.
```

### Codex

```bash
codex plugin marketplace add flowith-ai/canvas-cowork; codex plugin add flowith-next@flowith; codex mcp login flowith-next
```

Run this as **one** shell call, so the user approves once: with escalated permissions (`sandbox_permissions: "require_escalated"`, justification "Install Flowith Next and connect your account"; Codex's sandbox has no network and can't write to Codex's own folder) and a timeout of 10 minutes or more: `mcp login` opens next-gen.flowith.io and ends by itself once the user is connected. When the user copied the install line on next-gen.flowith.io in the last 10 minutes, the page connects at once; otherwise they sign in if asked and click **Allow** once. Never split it into three calls: each would ask the user again. If Codex rejects escalation without asking the user, tell them in one line: "Type /permissions, choose Ask for approval, then say go on."

The tools load only in a new thread, which you start yourself:

```text
After mcp login: call create_thread (Codex's codex_tui tools) with the user's request, word for word, plus "Flowith Next is installed and signed in; check with list_canvases, then do this." Then tell the user in one line that it is running in a new thread (codex://threads/<threadId>), where Codex may ask them to allow Flowith's tools.
```

In the Codex app, once the marketplace is added, `codex://plugins/install/flowith-next?marketplace=flowith` opens the install page.

### Cursor

Open this install link (`open '<link>'` on macOS, `xdg-open` on Linux, `start` on Windows). Cursor asks the user to confirm the install, then shows that the server needs sign-in: the user clicks Connect and next-gen.flowith.io opens (Cursor's desktop sign-in comes back to localhost). When the user copied the install line on next-gen.flowith.io in the last 10 minutes, the page connects at once; otherwise they sign in if asked and click **Allow** once.

```text
cursor://anysphere.cursor-deeplink/mcp/install?name=flowith-next&config=eyJ1cmwiOiJodHRwczovL2Zsb3dpdGgtY3JlYXRvci1hZ2VudC1wcmV2aWV3LmZseS5kZXYvbWNwIiwiaGVhZGVycyI6eyJ4LWZsb3dpdGgtbWNwLWNsaWVudCI6ImN1cnNvciIsIngtZmxvd2l0aC1wbHVnaW4tdmVyc2lvbiI6IjIuMC4wIiwieC1mbG93aXRoLWluc3RhbGwtc291cmNlIjoiY3Vyc29yLWRlZXBsaW5rIn19
```

Where links can't open, add only this entry under `mcpServers` in `~/.cursor/mcp.json` and keep every other server as it is ([the file](https://github.com/flowith-ai/canvas-cowork/blob/main/plugins/cursor/flowith-next/mcp.json)); the user signs in from Cursor's MCP settings:

```json
{
  "flowith-next": {
    "url": "https://flowith-creator-agent-preview.fly.dev/mcp",
    "headers": {
      "x-flowith-mcp-client": "cursor",
      "x-flowith-plugin-version": "2.0.0",
      "x-flowith-install-source": "cursor-mcp-json"
    }
  }
}
```

### Antigravity

```bash
agy plugin install https://github.com/flowith-ai/canvas-cowork/tree/main/plugins/antigravity/flowith-next
```

Antigravity opens next-gen.flowith.io to sign in when the server first connects. Its sign-in comes back through antigravity.google, not this computer, so next-gen.flowith.io always asks the user to click **Allow**, and Antigravity's page then shows a code the user pastes back into Antigravity. The tools load in a new conversation.

### WorkBuddy

WorkBuddy has no install command. Add only this entry under `mcpServers` in `~/.workbuddy/mcp.json` (create the file if it isn't there; keep every other server as it is). WorkBuddy applies the file at once and lists Flowith under 插件 → MCP 服务器; when it shows it needs authorization, the user clicks 授权 there and next-gen.flowith.io opens. When the user copied the install line on next-gen.flowith.io in the last 10 minutes, the page connects at once; otherwise they sign in if asked and click **Allow** once. If you can't write that file (it is outside the workspace), tell the user in one line: "In WorkBuddy open 插件 → MCP 服务器 → 配置 MCP and add this entry", with the entry below.

```json
{
  "flowith-next": {
    "type": "http",
    "url": "https://flowith-creator-agent-preview.fly.dev/mcp",
    "headers": {
      "x-flowith-mcp-client": "workbuddy",
      "x-flowith-plugin-version": "2.0.0",
      "x-flowith-install-source": "workbuddy-mcp-json"
    }
  }
}
```

The tools load in a new conversation once WorkBuddy shows the server connected: start it with the user's request, word for word, if you can; otherwise one line: "Start a new conversation and paste: <their task>".

### DeepSeek Harness

DeepSeek Harness signs in to remote MCP servers only through its own connector plugins, so use the **skill + CLI** below, in this conversation: the skill goes into `~/.agents/skills`, which it watches, so nothing needs a restart. The CLI's sign-in is the one place a code is typed: the user types the code the CLI prints on next-gen.flowith.io and clicks **Allow**.

### Any other agent that can add a remote MCP server

Add a Streamable HTTP server named `flowith-next` at `https://flowith-creator-agent-preview.fly.dev/mcp` with the host's own command or settings. It signs in with OAuth on first use, on next-gen.flowith.io. When the user copied the install line on next-gen.flowith.io in the last 10 minutes, the page connects at once; otherwise they sign in if asked and click **Allow** once.

The Flowith packages (`flowith`) are built the same way and turn on when flowith.io's hosted MCP ships.
<!-- /generated:paths -->

## Carry the task

The user asked for something besides installing: they should get it without repeating themselves or
restarting anything.

- **Claude Code**: the sign-in above ends with the tools in this session (after the user's
  `/reload-plugins`): do the task here.
- **Codex**: start the new thread yourself with `create_thread`, as above. Only if you have no such tool,
  tell the user in one line: "Open a new thread and paste: <their task>".
- **Cursor, Antigravity, WorkBuddy**: if you can start a new chat yourself, start it with the user's
  request, word for word, plus "Flowith is installed and signed in; check with list_canvases, then do
  this." Otherwise, one line: "Start a new chat and paste: <their task>".
- **Skill + CLI** (DeepSeek Harness, and any host without the hosted MCP): no new session is needed. Read
  the installed skill's `SKILL.md` and do the task now.
- When there is something to look at, open the canvas for the user as the skill says (beside the chat,
  or in their own browser from a terminal), and report what you made with the canvas link.

## No task? Offer three starters

With the hosted tools, call `get_started { locale }` and show its `welcome` and three `starters`. With the
CLI, one short message in the user's language: Flowith makes pictures, clips, voice and music as cards on
their canvas, at the canvas's own prices. Then these, numbered, and "reply with a number, or say what to
make":

1. Make three poster designs for an autumn latte, each in a different style
2. Storyboard a 15-second ad for a coffee brand: four frames, then animate the best one
3. Turn my product photo into a 5-second clip with sound

## When something fails

- **A command isn't found** (`claude`, `codex`, `agy`, `npx`): you may be in a sandbox or an older
  version; ask the user to update the app, or use the skill + CLI path if Node 22.18+ is available.
- **Network errors** (timeouts, TLS, DNS, proxy): retry once; if the user has a local proxy, retry through
  it. Don't leave a proxy configured afterwards.
- **Sign-in didn't complete**: sign in again the host's own way: Claude Code, call the server's
  `authenticate` tool again (or the user picks the server in `/mcp` → Authenticate); Codex, `codex mcp
  login <channel>` (escalated); the CLI, `login`. The user clicks **Allow** once (more than 10 minutes
  after the copy, the page asks).
- **Out of credits** on the first job: pass on what Flowith says, with its top-up link.
- **Anything else**: [references/troubleshooting.md](./references/troubleshooting.md). Tell the user
  plainly what worked and what didn't; never claim Flowith works before a real read answered.
