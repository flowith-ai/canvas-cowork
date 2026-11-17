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
cw look                                                   # every card with its ref, model, status, place
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

## Upgrading from the previous canvas-cowork

This is a new skill, not a drop-in update: commands, output and login changed.

- **Log in again** (`login`): the new login is a sign-in of its own, separate from your browser's. The
  previous version's `~/.flowith/bot-session.json` (a copy of your browser's session) is no longer read;
  `login` and `logout` delete it. It is not signed out, since that would sign your browser out too.
- **Default site** is https://beta.flowith.io while 3.0 is in beta (`login --site …` for another).
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
- On beta, the page's Disconnect only drops the canvas operation key until the frontend that ends the
  sign-in reaches it (hypergpt-frontend #753; it is on the next-gen preview); `logout` ends it on every
  site.

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

## Going live on flowith.io

The 3.0 login needs, on production: the frontend's relay login and Disconnect (`cli-handshake.ts`,
`agent-sign-ins.ts`) and the worker's `POST /user/agent-session`, `/user/agent-session/end` and
`/video/price` (clip prices; without it a clip's price shows as unknown). Once they are on flowith.io and
edge.flowith.io, change `DEFAULT_SITE` and
`workerFor` in `scripts/lib/session.ts` and the site named in these docs. A session keeps the site and
worker it was made on, so existing beta logins stay on beta: ask users to `login` again. A different
Supabase project also needs the relay's Supabase URL and key (`session.ts`).

## Development

```bash
bun test scripts/__tests__      # unit tests, and the real CLI against a stand-in Flowith (cli.test.ts)
```

## License

MIT
