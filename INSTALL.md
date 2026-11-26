# Install Flowith in this agent

This page is for you, the agent. The user pasted a line asking you to install Flowith, usually followed by
a task ("…, then make three poster designs"). Set Flowith up for the agent you are, then do that task.
What the user should see: one sign-in click on flowith.io, then their result. Not the setup.

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
3. **Pick the channel from the user's words**: Flowith (flowith.io) unless they said Flowith Next,
   next-gen or `flowith-next`.
4. **Don't narrate the setup.** At most one short line while you work ("Connecting Flowith…"). No
   commands, file paths or configuration in your messages unless something failed and the user has to
   act; then say only what they need to do.
5. **Sign-in is one click.** The host opens flowith.io; the user signs in if asked (a new user signs up on
   the way) and clicks **Allow** once. Never ask for a password, key or token.
6. **Verify with a real read** (list the user's canvases) before you say it works. Do it again in the new
   session if the tools only appear there.
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
claude mcp login plugin:flowith-next:flowith-next
```

`mcp login` opens next-gen.flowith.io; the user clicks **Allow** (run it in the background and wait for it). The tools load in a new session, or `/reload-plugins` in this one.

### Codex

```bash
codex plugin marketplace add flowith-ai/canvas-cowork
codex plugin add flowith-next@flowith
codex mcp login flowith-next
```

`mcp login` opens next-gen.flowith.io; the user clicks **Allow** (run it in the background and wait for it). The tools load in a new thread. In the Codex app, once the marketplace is added, `codex://plugins/install/flowith-next?marketplace=flowith` opens the install page.

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

- **Hosted MCP**: the tools appear in a new session (Claude Code also loads them with `/reload-plugins`).
  If you can start a new session, thread or task yourself (Claude Code's `spawn_task`, a Codex tool that
  opens a new thread), start it with the user's original request, word for word, plus "Flowith is
  installed and signed in; check with a real read, then do this." Otherwise tell the user the one thing
  to do, in one line, with their task ready to paste:
  - Claude Code: "Type `/reload-plugins`, then say: <their task>"
  - Codex: "Open a new thread and paste: <their task>"
  - Cursor, Antigravity: "Start a new chat and paste: <their task>"
- **Skill + CLI**: no new session is needed. Read the installed skill's `SKILL.md` and do the task now.
- When there is something to look at, open the canvas beside the chat as the skill says, and report what
  you made with the canvas link.

## No task? Offer three starters

One short message in the user's language: Flowith makes pictures, clips, voice and music as cards on their
canvas, at the canvas's own prices. Then these, numbered, and "reply with a number, or say what to make":

1. Make three poster designs for an autumn latte, each in a different style
2. Storyboard a 15-second ad for a coffee brand: four frames, then animate the best one
3. Turn my product photo into a 5-second clip with sound

## When something fails

- **A command isn't found** (`claude`, `codex`, `agy`, `npx`): you may be in a sandbox or an older
  version; ask the user to update the app, or use the skill + CLI path if Node 22.18+ is available.
- **Network errors** (timeouts, TLS, DNS, proxy): retry once; if the user has a local proxy, retry through
  it. Don't leave a proxy configured afterwards.
- **Sign-in didn't complete**: run the host's login again (Claude Code `claude mcp login
  plugin:<channel>:<channel>`, Codex `codex mcp login <channel>`, CLI `login`). The user clicks **Allow**
  once.
- **Out of credits** on the first job: pass on what Flowith says, with its top-up link.
- **Anything else**: [references/troubleshooting.md](./references/troubleshooting.md). Tell the user
  plainly what worked and what didn't; never claim Flowith works before a real read answered.
