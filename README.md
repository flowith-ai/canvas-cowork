# Canvas Cowork

Let Claude Code, Codex, Cursor or any agent with a shell **work directly on your
[Flowith](https://flowith.io) 3.0 canvas** — generate and edit pictures, clips, text, voice and music,
extend and vary them, upscale / cut out / expand, and organise the canvas — the way Flowith's own
in-app agent, Flo, does. Every result is a card on your canvas, priced and billed exactly like the
cards you make by hand, and an open canvas shows the agent's cards arrive live.

## Install

```bash
npx skills add flowith-ai/canvas-cowork
```

Requires [Bun](https://bun.sh) ≥ 1.1. No other dependencies.

## First run

```bash
bun scripts/index.ts login     # opens Flowith and prints a code: type it on the page, click Allow — once
```

In Codex, the skill opens the working canvas in the app's browser beside the chat. Sign in to Flowith
there to watch cards appear and follow reviews. See [Live browser](./references/live-browser.md).

## What it can do

```bash
cw() { bun scripts/index.ts "$@"; }

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

`bun scripts/index.ts help` lists every command; [SKILL.md](./SKILL.md) is the agent's guide, with
[models](./references/models.md), [prompting](./references/prompting.md),
[workflows](./references/workflows.md) and [troubleshooting](./references/troubleshooting.md).

## How it works

- **Login**: after you type the CLI's code on Flowith's connect page and allow it, the page gives the
  CLI a sign-in of its own, seals it to the CLI's one-time key and hands it over Flowith's realtime
  service (no local ports, so it works in every browser). Stored in `~/.flowith/canvas-session.json`
  (mode 600); it renews itself. New commands check whether it was disconnected, using a two-minute
  cache. A command already running does not periodically recheck that cache.
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
On sites with the Disconnect update, disconnecting the agent in Flowith (Settings → Agents, or the
canvas's agent menu) ends it too: canvas operations stop and the sign-in can no longer renew. New CLI
commands check Supabase Auth once the two-minute cache expires. Existing access tokens can still
reach the worker and PostgREST until they expire (up to one hour); this does not cancel an already
accepted generation or guarantee that a running command stops within two minutes.

The Disconnect update is deployed on beta and next-gen (hypergpt-frontend #753 brought it to beta).
For a CLI login approved before that update, use CLI `logout`, then `login` again so the page remembers
the independent sign-in it must end. The login link and code are for you alone: never forward them.

## Retrying safely

`retry` rechecks cards after taking its local lock and claims the checked card version with a
conditional database update before submitting. Two copies of this updated CLI, even on different
machines, cannot both claim the same version. If a card changed or was removed, retry stops without
submitting it. A lost claim response is recovered only by reading back that command's unique claim.

This coordinates updated CLI clients. Older CLIs and the page's Retry button do not use this claim;
avoid retrying the same card from the page and an agent at once. A request whose submission outcome
is unknown is left alone while its result and billing records are checked.

## Environments

The login opens `/blank` on the chosen site, where the canvas app handles the connection request.
The browser supplies the worker URL and the CLI keeps both the site and worker with its session.
Use a separate `FLOWITH_HOME` for each account or environment you use in parallel. A preview on a different
Supabase project also needs that project's relay URL and publishable key (`scripts/lib/session.ts`).

## Development

```bash
bun test scripts/__tests__      # unit tests, and the real CLI against a stand-in Flowith (cli.test.ts)
```

## License

MIT
