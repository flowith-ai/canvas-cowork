# Flowith in your agent

Let Claude Code, Codex, Cursor, Antigravity or any agent **work directly on your
[Flowith](https://flowith.io) canvas**: generate and edit pictures, clips, text, voice and music, extend
and vary them, upscale / cut out / expand, and organise the canvas, the way Flowith's own in-app agent,
Flo, does. Every result is a card on your canvas, signed with your agent's name, priced and billed
exactly like the cards you make by hand, and an open canvas shows the cards arrive live. Your agent can
open the canvas beside the chat, look at what came out and fix what misses.

This repository is Flowith's distribution for every agent host: the per-host plugins for Flowith's
hosted MCP server, the `canvas-cowork` skill, and the CLI it falls back to.

## Install: paste one line into your agent

<!-- generated:prompts -->
Paste one line into your agent, with your task at the end:

```text
Install Flowith in this agent by following https://raw.githubusercontent.com/flowith-ai/canvas-cowork/main/INSTALL.md, then make three poster designs for an autumn latte.
```

For internal testing of the hosted MCP on next-gen.flowith.io:

```text
Install Flowith Next in this agent by following https://next-gen.flowith.io/agent, then make three poster designs for an autumn latte.
```

Naming the host also works (`Install Flowith in Codex by following …`). [INSTALL.md](./INSTALL.md) tells the agent how to set itself up; [hosts/install.json](./hosts/install.json) has every prompt, command and link for the website.
<!-- /generated:prompts -->

The agent installs Flowith for itself (only for the app you are using) and goes on to your task. Copied
from flowith.io, the line connects your account by itself; otherwise you click **Allow** once there.

## Install by hand

<!-- generated:install -->
### Skill + CLI (flowith.io today)

- Claude Code: `npx -y skills add flowith-ai/canvas-cowork -g -a claude-code -y`
- Codex: `npx -y skills add flowith-ai/canvas-cowork -g -a codex -y`
- Cursor: `npx -y skills add flowith-ai/canvas-cowork -g -a cursor -y`
- Antigravity: `npx -y skills add flowith-ai/canvas-cowork -g -a antigravity -y`
- DeepSeek Harness: `npx -y skills add flowith-ai/canvas-cowork -g -a codex -y`

Then `node scripts/index.ts login` from the skill's folder (your agent does this for you): type the code it prints on the Flowith page and click **Allow**, once.

### Hosted MCP (coming soon to flowith.io)

No local runtime: the agent gets Flowith's tools from a hosted server, and flowith.io connects it without a click when you copied the line there (one click on **Allow** otherwise). It is live on Flowith Next (next-gen.flowith.io) for testing; the Flowith packages turn on when flowith.io ships it.

| Host | Install |
|---|---|
| Claude Code | `claude plugin marketplace add flowith-ai/canvas-cowork`<br>`claude plugin install flowith-next@flowith`<br>then `/reload-plugins`: your agent opens the sign-in page |
| Codex | `codex plugin marketplace add flowith-ai/canvas-cowork`<br>`codex plugin add flowith-next@flowith`<br>`codex mcp login flowith-next` |
| Cursor | [Add to Cursor](https://cursor.com/install-mcp?name=flowith-next&config=eyJ1cmwiOiJodHRwczovL2Zsb3dpdGgtY3JlYXRvci1hZ2VudC1wcmV2aWV3LmZseS5kZXYvbWNwIiwiaGVhZGVycyI6eyJ4LWZsb3dpdGgtbWNwLWNsaWVudCI6ImN1cnNvciIsIngtZmxvd2l0aC1wbHVnaW4tdmVyc2lvbiI6IjIuMC4wIiwieC1mbG93aXRoLWluc3RhbGwtc291cmNlIjoiY3Vyc29yLWRlZXBsaW5rIn19) |
| Antigravity | `agy plugin install https://github.com/flowith-ai/canvas-cowork/tree/main/plugins/antigravity/flowith-next` |
| WorkBuddy | add the `flowith-next` entry to `~/.workbuddy/mcp.json` (INSTALL.md) |
| DeepSeek Harness | the skill + CLI below |
<!-- /generated:install -->

## The CLI

Where the hosted MCP isn't available, the skill drives Flowith through a zero-dependency CLI. It runs on
Node 22.18+ or Bun 1.1+:

```bash
node scripts/index.ts login                          # from the skill's folder; or: bun scripts/index.ts login
npx -y github:flowith-ai/canvas-cowork login         # from anywhere, nothing installed
```

`login` opens Flowith and prints a code: type it on the page and click **Allow**, once. In Codex, the
skill opens the working canvas in the app's browser beside the chat. See
[Live browser](./references/live-browser.md).

```bash
cw() { node scripts/index.ts "$@"; }

cw new "Orange Cat Café"                                  # a canvas (or: cw use <canvas>)
cw image "an orange cat asleep on a café windowsill, morning light" --ratio 4:3 --title "Window cat"
cw edit <ref> "give the cat a small red beret, keep everything else"   # a new card beside it
cw image "latte with paw-print art" "chalkboard menu reading 「猫咪拿铁」" --group "Café set"
cw image "café logo" --model dola-seedream-5-5-261028,gpt-image-2.6-flare   # compare models
cw video "the cat lifts its head and blinks" --first <ref> --duration 5
cw video "pull back to reveal the whole bar" --extend <clip>
cw text "a 10-word slogan for this café" --model claude-opus-5-5,gemini-3.8-flash --ref <ref>
cw speech "Welcome to the Orange Cat Café." --for <clip>
cw upscale <ref> --to 4k · cw cutout <ref> · cw expand <ref> --ratio 9:16
cw look --canvas <canvas-url>                             # inspect this canvas even if the active one changes
cw selection                                              # see what the user selected in the open canvas
cw shots <ref…>                                           # previews to look at
cw group <refs…> --name "Finals" · cw arrange <group> · cw move <ref> --right-of <ref>
cw models video · cw credits
```

`cw help` lists every command. [SKILL.md](./SKILL.md) is the agent's guide (MCP first, the CLI as
fallback), with [the CLI](./references/cli.md), [models](./references/models.md),
[prompting](./references/prompting.md), [workflows](./references/workflows.md) and
[troubleshooting](./references/troubleshooting.md).

## How the CLI works

- **Login**: after you type the CLI's code on Flowith's connect page and allow it, the page gives the
  CLI a sign-in of its own, seals it to the CLI's one-time key and hands it over Flowith's realtime
  service (no local ports, so it works in every browser). Stored in `~/.flowith/canvas-session.json`
  (mode 600); it renews itself, and checks every 2 minutes, also during a long command, that it hasn't been
  disconnected.
- **Canvas tools that live in the page** (split, angles, relight, lip-sync, breakdown, characters, the
  director stage, Organize…) are handed to your open canvas, sealed with a key that browser gave the
  agent at login; disconnecting the agent in Flowith revokes it.
- **Cards** are written to your canvas with your session, labelled with the agent's name; Flowith's
  canvas change feed shows them in any open tab and brings them into view.
- **Placement** uses Flo's own rules: beside the card a result came from, else in free space; several
  results of one request form a group.
- **Generation** goes through the canvas's own routes (`/image_gen/async`, `/video/async`,
  `/completion/async`, card tools), so models, limits, prices and credits are exactly the canvas's.
- **Models** come live from the canvas catalogue; every parameter is validated against it.

## Already using canvas-cowork?

Nothing to redo: the same commands, the same sign-in (`~/.flowith/canvas-session.json`) and `bun
scripts/index.ts` all keep working. What 2.0 adds: the CLI also runs on Node 22.18+ (`node
scripts/index.ts`, or `npx -y github:flowith-ai/canvas-cowork` with nothing installed), the skill uses
Flowith's hosted MCP tools when your agent has them, and `login` no longer opens a local port (the page
hands the sign-in over Flowith's realtime service, as it already did for this CLI). Update the skill with
`npx skills update`.

## Upgrading from the previous canvas-cowork

This is a new skill, not a drop-in update: commands, output and login changed.

- **Log in again** (`login`): the new login is a sign-in of its own, separate from your browser's. The
  previous version's `~/.flowith/bot-session.json` (a copy of your browser's session) is no longer read;
  `login` and `logout` delete it. It is not signed out, since that would sign your browser out too.
- **Default site** is https://flowith.io. Use `login --site beta.flowith.io` or name a preview to use a
  different environment. Existing sign-ins stay on the site that approved them.
- **Commands**: `gen` / `submit` → `image` · `video` · `text`; `submit-batch` → one `image "a" "b" …`;
  `create-canvas` → `new`; `read-db` → `look` / `read`; `list-models` → `models`; `upload` → `add`, or
  `--ref <file>`; `delete-many` / `clean-failed` → `delete <refs…>`; `recall` → `canvases <words>` +
  `look`. The old names print their replacement.
- **Gone**: Neo, `set-mode`, `comment`, batch audit, creative-dream, `best` / `fast` presets,
  `defaults.json`, `--follow` history and `--out` on generation (use `save <refs> --out dir`).
- **Defaults**: pictures Seedream 5.5 (1K), clips Seedance 2.5 Flash (5 s, 720p), text Gemini 3.8 Flash.
  Results are JSON with card refs; prices come from the live catalogue.

## Signing out

`logout` ends this CLI's sign-in at Flowith and deletes it here (a login an older page made from the
browser's own session is only forgotten, never signed out: that would sign the browser out).
Disconnecting the agent in Flowith (Settings → Agents, or the canvas's agent menu) ends it too.

What ending it does, and what it doesn't:

- **At once**: the sign-in can't be renewed or used to open another; Supabase Auth refuses its token;
  operations handed to the open canvas stop.
- **Within about 2 minutes**: this CLI stops. A command asks Flowith whether the sign-in is still on
  when it starts (unless another command did in the last 2 minutes) and every 2 minutes while it runs
  (a long `wait` included), then says `NOT_LOGGED_IN` and deletes the login here.
- **Not at once**: the access token already issued (it lasts up to 1 hour) is still accepted by
  Flowith's data and generation APIs until it expires. Anyone holding a copy of it could use it until
  then; nothing else of the login (no renewal) is left.
- Ending a sign-in doesn't cancel a generation Flowith already took.
- The page's Disconnect ends sign-ins it approved since its update (on beta and next-gen; beta got it with
  hypergpt-frontend #753). A CLI login approved before that is unknown to the page: `logout`, then
  `login` again, so a later Disconnect can end it.

The login link and code are for you alone: never forward them.

## Retrying safely

`retry` runs failed cards again in place, and never sends one twice:

- It checks each card again once it holds it on this machine, then claims it in Flowith with one
  conditional database update: only if the card is still exactly as read (its type and data). Of two
  `retry` commands on one card, even on different machines, only one claims it; the other sends nothing
  and says `BUSY`. A card that changed or was removed is left out; the rest of a batch still goes.
- If the claim's answer is lost, the card is read back: carrying this command's claim, it is sent;
  otherwise nothing is sent, and the next `retry` tells from the card whether the claim took.
- This holds between copies of this CLI. A retry clicked on the canvas page, or from an older
  canvas-cowork, doesn't take part: don't retry a card from the page and an agent at the same moment.
- A send whose answer was lost (`SENT_UNKNOWN`) is sent again only once the canvas's charges show it
  never arrived.

## Environments

The login opens `/blank` on the chosen site, where the canvas app handles the connection request.
The browser supplies the worker URL and the CLI keeps both the site and worker with its session.
Use a separate `FLOWITH_HOME` for each account or environment you use in parallel. A preview on a different
Supabase project also needs that project's relay URL and publishable key (`scripts/lib/session.ts`).

## Development

```bash
bun test scripts/__tests__ hosts/__tests__          # unit tests, the real CLI against a stand-in Flowith, host packages
CW_TEST_RUNTIME=node bun test scripts/__tests__     # the same CLI tests with the CLI running on Node
node hosts/generate.ts                              # rewrite every host package after changing the manifest or the skill
```

Every host package is generated from [hosts/manifest.json](./hosts/manifest.json) (version, MCP URLs per
channel, headers, starters) plus `SKILL.md`, `references/` and `hosts/assets/`:

| Generated | For |
|---|---|
| `.claude-plugin/marketplace.json`, `plugins/claude-code/<channel>/` | Claude Code marketplace and plugins (`.mcp.json`, skills) |
| `.agents/plugins/marketplace.json`, `plugins/codex/<channel>/` | Codex marketplace and plugins (`.mcp.json`, skills, `get-started` onboarding skill) |
| `plugins/antigravity/<channel>/` | Antigravity plugins (`plugin.json`, `mcp_config.json`, skills) |
| `plugins/cursor/<channel>/mcp.json` | Cursor's server entry; the install link is in `hosts/install.json` |
| `hosts/install.json` | Every copy prompt, command and one-click link, for the website's Connect an agent dialog |
| The marked regions of README.md and INSTALL.md | Install commands, so the docs can't drift from the packages |

Channels: `flowith` (https://agent.flowith.io/mcp) and `flowith-next`
(https://flowith-creator-agent-preview.fly.dev/mcp, next-gen testing). Each MCP config sends
`x-flowith-mcp-client`, `x-flowith-plugin-version` and `x-flowith-install-source` where the host takes
headers. `hosts/__tests__/generate.test.ts` fails when a generated file differs from what the manifest
generates. When the production MCP ships, set the `flowith` channel's `live` to `true` and regenerate:
the docs then lead with the hosted MCP and keep the CLI as the fallback.

## License

MIT
