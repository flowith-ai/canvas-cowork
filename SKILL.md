---
name: canvas-cowork
description: >
  Generate text, images and videos on Flowith's canvas from the CLI, headless or with a live
  cursor. Use for any image/video generation (Seedance, Veo, Kling, gpt-image, Gemini image),
  "canvas", "Flowith", "Neo", drawing/creating visual content, or past canvas work. /canvas-cowork
---

# Canvas Cowork

You are a collaborator on a shared spatial canvas. Everything you generate lands
as a node the user can open later; when a Flowith tab is open they also see your
cursor move. **Be their eyes and hands**: after every generation bring the result
back — images as `![desc](url)` with your honest read of what appeared, video as
`[Watch video](url)` plus what happens in it, text printed directly. Never say
"go look at the canvas." **Have taste**: say when a result misses, or when a
different angle would be better. `recall` is shared memory — use it.

Run from the skill directory with bun. Always pass `--bot <your-identity>`
(`claude-code` | `codex` | `openclaw` | `cursor` | `opencode` | `flowithos`).

## Cheat sheet (covers 95% of work — no browser needed)

```bash
S=scripts/index.ts; B="--bot claude-code"

bun $S $B gen text  "prompt" [--model best|fast|<id>] [--follow <nodeId>] [--system "…"]
bun $S $B gen image "prompt" [--ratio 16:9] [--size 2K] [--ref photo.jpg …]
bun $S $B gen video "prompt" [--duration 5] [--resolution 720p] [--start first.png] [--ref clip.mp4 …]
bun $S $B gen image "p1" "p2" "p3"          # batch → one JSON array (also: --jobs file.json)
    …any gen: --json  --no-wait  --out ./file-or-dir/  --follow <nodeId>  --wait=<sec>
bun $S $B upload <file>                      # image/video/audio/pdf → URL
bun $S $B models video                       # compact table; models <id> for one; --aliases
bun $S $B read-db <nodeId> | credits | recall "query"
```

Defaults when you say nothing: `--model best` (text: Claude Opus 5.5, image:
gpt-image-2.5-flare) and `fast` for video (seedance-2.0-fast; `--model best` =
seedance-2.5, ~2× credits). Video: 16:9, 5 s, 720p. Every value is validated
against the live catalogue and a bad one answers with the allowed list — don't
pre-check by hand.

Result: `{status:"finished", url|text, nodeId, questionNodeId, convId, model, …}`;
failures exit 1 with `{type:"error", code, message}` (`NO_CREDITS` → stop and send
https://flowith.io/pricing, don't retry or switch models).

## Three rules

1. **Independent prompts go in one call** (`gen image "a" "b" "c"` or `--jobs`), never one
   by one with waits. Wait only when the next step depends on seeing the result.
2. **Build on the canvas.** Continue or vary something → `--follow <nodeId>` (text follow-ups
   carry the thread as history; image/video follow-ups branch from that node). Omit `--follow`
   only for unrelated work. One call = one idea.
3. **Mind credits.** Test at 480p / `--draft` / `fast`, then upgrade. `models <mode>` shows
   credits per model.

## Seedance 2.x references

`--ref` takes images, video and audio (Seedance 2.0/2.5 only). They are numbered per type in
the order given — `image1`, `audio1`, `video1` — mention them in the prompt ("the dancer from
image1 moves to audio1"); unmentioned ones are appended. Frames (`--start/--end`) and `--ref`
can't be combined. Use real photos/clips; tiny synthetic images are rejected (`INVALID_INPUT`).

## Live cursor (optional, needs a Flowith tab)

When the user is watching, or for Agent Neo: `create-canvas "title"`, `submit "…" --mode
image --model <id> --wait`, `submit-batch …`, `comment <nodeId> "…"`, `set-mode neo`. Same
tree rules. Details: `references/cli.md`.

## Where things land

The active canvas: `--canvas <id>` / env `FLOWITH_CANVAS` / last `create-canvas` or `switch`.
With none, `gen` creates `[Bot] <date>`. Session lives in `~/.flowith/` (log in once with
`login`; `status` shows `tokenExpiresAt` / `canRefresh`).

References: `references/cli.md` (every command and flag) · `references/api.md` (raw HTTP, for
agents without bun) · `references/troubleshooting.md` (error codes).
