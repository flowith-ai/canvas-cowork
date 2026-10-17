# Canvas Cowork

Generate images and videos on [Flowith](https://flowith.io)'s spatial canvas from the CLI — **headless** (plain HTTP, for agents and pipelines) or **live** (a cursor on the canvas the user watches). Create canvases, read results, recall past work, manage nodes.

## Install

```bash
npx skills add flowith-ai/canvas-cowork
```

## What It Does

- **Generate** images and videos directly — every model parameter (ratio, size, quality, duration, resolution, audio, start/end frames, Seedance image/video/audio references), no browser needed
- **Upload** images, video, audio, PDFs
- **Read** results back — images as markdown, video as links, nodes from the database
- **Recall** past work across all canvases with semantic search
- **Live mode**: a cursor on the canvas, `submit` through the composer, batch submits, comments, Agent Neo

## Quick Start

```bash
S=scripts/index.ts
bun $S --bot claude-code login                      # once: opens Flowith, log in

bun $S --bot claude-code list-models video --json   # what each model accepts + credits
bun $S --bot claude-code gen video "a red roadster on a coastal road at sunset" \
  --model seedance-2.0-fast --duration 5 --ratio 16:9 --resolution 720p
# → {"type":"result","data":{"status":"finished","url":"https://vg.flowith.net/....mp4", ...}}

bun $S --bot claude-code gen image "a golden retriever in a wheat field" \
  --model gemini-3.1-flash-image --ratio 16:9 --size 2k

# Seedance 2.x: reference audio / video / images
bun $S --bot claude-code gen video "the orb pulses to audio1, palette of image1" \
  --model seedance-2.5 --ref ./beat.wav --ref ./palette.png --duration 5

# Live mode (a Flowith tab open): many at once, with a cursor the user sees
bun $S --bot claude-code create-canvas "Dog Artwork"
bun $S --bot claude-code submit-batch --mode image --models gemini-3.1-flash-image "husky" "corgi" "poodle"
bun $S --bot claude-code read-db --full
```

## Requirements

- A [Flowith](https://flowith.io) account (log in once through the browser handshake)
- [Bun](https://bun.sh) — or call the HTTP API directly, see [references/api.md](./references/api.md)

## Documentation

- [SKILL.md](./SKILL.md) — full command reference and how an agent should work on the canvas
- [references/api.md](./references/api.md) — raw HTTP recipes (models, upload, image/video generation, polling)
- [references/troubleshooting.md](./references/troubleshooting.md) — error codes and fixes

## Development

```bash
bun test scripts/__tests__      # request builders, model validation, layout — no network
```

## License

MIT
