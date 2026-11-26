# Install Flowith in this agent

This page is for you, the agent. The user pasted a line asking you to install Flowith, usually followed by
a task ("…, then make three poster designs"). Set Flowith up for the agent you are, then do that task.
What the user should see: one sign-in click on flowith.io, then their result. Not the setup.

**Read this page whole.** If your fetch tool gave you a summary (Claude Code's WebFetch summarizes most
sites), read the text itself: `curl -fsSL https://raw.githubusercontent.com/flowith-ai/canvas-cowork/main/INSTALL.md`.
Your host's steps below are in code blocks: follow them exactly, in order.

## Rules

1. **Know which host you are from your own environment**: your system prompt and tool names, the
   `clientInfo` you send to MCP servers, and your own process environment (`CLAUDECODE` or
   `CLAUDE_CODE_ENTRYPOINT`: Claude Code; `CODEX_HOME`, `CODEX_SANDBOX`, `CODEX_CI` or
   `CODEX_MANAGED_BY_NPM`: Codex; `CURSOR_AGENT` or `CURSOR_TRACE_ID`: Cursor; Antigravity: its own
   system prompt). Never decide by which programs are installed: one computer often has several agents.
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
5. **Sign-in is one click.** The host opens flowith.io; the user signs in if asked (a new user signs up on
   the way) and clicks **Allow** once. Never ask for a password, key or token.
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

Another agent with a shell: the same command with its own id from [the skills CLI's list](https://github.com/vercel-labs/skills/blob/main/docs/agents.md) (never without `-a`: that installs for every agent on the computer), or run the CLI with no install: `npx -y github:flowith-ai/canvas-cowork <command>`.

Then, in the installed skill's folder (the path `skills add` printed, e.g. `~/.claude/skills/canvas-cowork`):

1. **Sign in**: run `node scripts/index.ts login` in the background (a timeout of 3 minutes or more). It opens flowith.io and prints a code on stderr; tell the user in one line to type that code on the page and click **Allow**, then wait for the command to finish.
2. **Verify**: `node scripts/index.ts canvases --json` lists their canvases.
3. **Carry on in this conversation**: read the skill's `SKILL.md` and do the user's task with the CLI. No new session is needed.

## Hosted MCP (Flowith Next, testing only)

### Claude Code

```bash
claude plugin marketplace add flowith-ai/canvas-cowork
claude plugin install flowith-next@flowith
```

Then sign in and work in this same session, in exactly this order. Don't run `claude mcp login`: from your shell it stops at once (it needs a terminal). A plugin's server loads only after `/reload-plugins`, which only the user can type, and your background wait is what wakes you up after each thing the user does:

```text
1. Run `sleep 20` in the background, then tell the user in one line: "Type /reload-plugins and I'll open the sign-in page."
2. When the wait ends, look for mcp__plugin_flowith-next_flowith-next__authenticate (ToolSearch "select:mcp__plugin_flowith-next_flowith-next__authenticate"). Not there yet: sleep 20 in the background again (up to 5 minutes).
3. Call it. Open the link it answers for the user (open '<link>' on macOS, xdg-open on Linux, start on Windows) and tell them in one line to click Allow on that page (a new user signs up there first). Run `sleep 20` in the background again.
4. When the wait ends, look for list_canvases. Not there yet: sleep 20 in the background again (up to 10 minutes). The tools arrive by themselves after Allow.
5. Call list_canvases, then do the user's task right here: no new session is needed.
If the page after Allow couldn't reach Claude Code: ask the user for that page's address and pass it to mcp__plugin_flowith-next_flowith-next__complete_authentication.
```

### Codex

```bash
codex plugin marketplace add flowith-ai/canvas-cowork
codex plugin add flowith-next@flowith
codex mcp login flowith-next
```

Codex's sandbox has no network and can't write to Codex's own folder, and these commands need both: run each with escalated permissions (`sandbox_permissions: "require_escalated"` and a short reason such as "Install Flowith Next") so the user approves it. If Codex rejects escalation without asking the user, tell them in one line: "Type /permissions, choose Ask for approval, then say go on." `mcp login` opens next-gen.flowith.io; the user clicks **Allow** (run it in the background and wait for it).

The tools load only in a new thread, which you start yourself:

```text
After mcp login: call create_thread (Codex's codex_tui tools) with the user's request, word for word, plus "Flowith Next is installed and signed in; check with list_canvases, then do this." Then tell the user in one line that it is running in a new thread (codex://threads/<threadId>), where Codex may ask them to allow Flowith's tools.
```

In the Codex app, once the marketplace is added, `codex://plugins/install/flowith-next?marketplace=flowith` opens the install page.

### Cursor

Open this install link (`open '<link>'` on macOS, `xdg-open` on Linux, `start` on Windows); Cursor asks the user to confirm, then to sign in:

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

Antigravity opens next-gen.flowith.io to sign in when the server first connects. The tools load in a new conversation.

### Any other agent that can add a remote MCP server

Add a Streamable HTTP server named `flowith-next` at `https://flowith-creator-agent-preview.fly.dev/mcp` with the host's own command or settings. It signs in with OAuth on first use (the user clicks **Allow** on next-gen.flowith.io).

The Flowith packages (`flowith`) are built the same way and turn on when flowith.io's hosted MCP ships.
<!-- /generated:paths -->

## Carry the task

The user asked for something besides installing: they should get it without repeating themselves or
restarting anything.

- **Claude Code**: the sign-in above ends with the tools in this session (after the user's
  `/reload-plugins`): do the task here.
- **Codex**: start the new thread yourself with `create_thread`, as above. Only if you have no such tool,
  tell the user in one line: "Open a new thread and paste: <their task>".
- **Cursor, Antigravity**: if you can start a new chat yourself, start it with the user's request, word
  for word, plus "Flowith is installed and signed in; check with list_canvases, then do this."
  Otherwise, one line: "Start a new chat and paste: <their task>".
- **Skill + CLI**: no new session is needed. Read the installed skill's `SKILL.md` and do the task now.
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
  login <channel>` (escalated); the CLI, `login`. The user clicks **Allow** once.
- **Out of credits** on the first job: pass on what Flowith says, with its top-up link.
- **Anything else**: [references/troubleshooting.md](./references/troubleshooting.md). Tell the user
  plainly what worked and what didn't; never claim Flowith works before a real read answered.
