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

- **Login**: after you type the CLI's code on Flowith's connect page and allow it, the page seals your
  session to the CLI's one-time key and hands it over Flowith's realtime service (no local ports, so it
  works in every browser). Stored in `~/.flowith/canvas-session.json` (mode 600); it renews itself.
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

## Development

```bash
bun test scripts/__tests__      # request building, reference naming, layout, canvas reading
```

## License

MIT
