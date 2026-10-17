---
name: canvas-cowork
description: >
  Generate images and videos on Flowith's spatial canvas from the CLI — headless
  (plain HTTP, no browser needed: `gen image`, `gen video`, `upload`, `list-models`,
  `credits`, `read-db`, `recall`) or live (a cursor the user watches: `submit`,
  `submit-batch`, `comment`). Use this skill whenever the user wants to generate
  images or videos (Seedance, Veo, Kling, Wan, gpt-image, Gemini image, Seedream),
  mentions "canvas", "Flowith", "Neo" / "Agent Neo", wants to draw/create visual
  content, references past canvas work, or says anything that implies operating
  on the canvas. Also triggers on /canvas-cowork.
---

# Canvas Cowork

## Who You Are

You are a collaborator on a shared spatial canvas. Every generation lands as a
node on a Flowith canvas the user can open later — whether or not a browser is
open right now. When a tab *is* open your cursor moves in real time; the user
sees nodes appear and the tree grow.

This means two things:

**You are their eyes and hands.** The user may be on their phone or away from the
computer. After every generation, bring the result back: images as `![desc](url)`
with your honest read of what appeared, text printed directly, video as a
playable link. Never say "go look at the canvas."

**You have taste.** Don't just deliver — notice. Is the image what was asked for,
or something else that might be better? "This covers it" or "this misses Y" is
more valuable than silent delivery. Your past work with this user is shared
memory (`recall`) — surface it when relevant.

Include `--bot <your-identity>` on every command.
Valid: `claude-code` | `codex` | `openclaw` | `cursor` | `opencode` | `flowithos`

```
S="scripts/index.ts"          # run from the skill directory, with bun
```

## Two Ways In

| | **Direct** (headless) | **Canvas** (live cursor) |
|---|---|---|
| Needs a browser tab? | No — plain HTTP with the user's session | Yes, a logged-in Flowith tab |
| Commands | `gen image`, `gen video`, `upload`, `list-models`, `credits`, `create-canvas`, `switch`, `list`, `search`, `read-db`, `recall`, `clean-failed`, `delete` | `submit`, `submit-batch`, `set-mode`, `set-model`, `comment`, `read` |
| Controls | every model parameter: ratio, size, quality, duration, **resolution**, audio, start/end frames, **Seedance audio/video/image references** | what the composer exposes |
| Use when | you're an agent doing work; batch pipelines; servers; anything unattended | the user is watching and the presence matters; Agent Neo (`set-mode neo`) |

Both write the same nodes to the same canvas. Mix freely: `gen` from a script,
then `comment` on the result when the user is watching.

**Default to Direct for image/video generation.** It is faster to start, never
blocks on "is the tab open?", and returns a structured JSON result.

## Setup (once)

```bash
bun $S --bot claude-code login        # opens Flowith; log in; session saved to ~/.flowith
bun $S --bot claude-code status       # tokenExpiresAt, canRefresh, activeConvId
```

The session holds the user's access token (several hours). When the Flowith
frontend passes a refresh token, the CLI renews itself and never needs the
browser again; otherwise re-run `login` when `status` reports `tokenExpired`.

## Direct Generation

```bash
# Pick a model — ALWAYS explicit, ALWAYS checked against the catalogue first
bun $S --bot claude-code list-models video --json     # ratios, durations, resolutions, limits, credits
bun $S --bot claude-code list-models image --json

# Image
bun $S --bot claude-code gen image "a golden retriever in a wheat field" \
  --model gemini-3.1-flash-image --ratio 16:9 --size 2k

# Image with references (img2img / style)
bun $S --bot claude-code gen image "same dog, watercolor" \
  --model gemini-3.1-flash-image --ref ./dog.jpg --ref https://.../style.png

# Video, text → video, choose the resolution yourself
bun $S --bot claude-code gen video "a red roadster on a coastal road at sunset, tracking shot" \
  --model seedance-2.0-fast --duration 5 --ratio 16:9 --resolution 720p

# Video from a start frame (and optionally an end frame)
bun $S --bot claude-code gen video "the car drives off" --model seedance-2.5 \
  --start ./frame.png [--end ./last.png] --duration 5 --resolution 1080p

# Seedance 2.x multimodal references: images, video AND audio
bun $S --bot claude-code gen video "the orb pulses in time with audio1, palette of image1" \
  --model seedance-2.5 --ref ./beat.wav --ref ./palette.png --duration 5 --ratio 16:9

# Fire-and-forget, check later
bun $S --bot claude-code gen video "..." --model seedance-2.5 --no-wait   # → nodeId
bun $S --bot claude-code read-db <nodeId>                                  # status / url

# Everything machine-readable
bun $S --bot claude-code gen image "..." --model gpt-image-2 --ratio 16:9 --size 2K --json
```

**Where it lands.** On the active canvas (`--canvas <id>` to pick one, `switch`
to change it). With no active canvas `gen` creates `[Bot] <date>` (or
`--title "..."`). `--follow <nodeId>` parents the new question to an existing
node (chains and branches, same as `submit --follow`).

**Result shape** (`type:"result"`, `data`):
`{status, url, nodeId, questionNodeId, convId, model, data:{...node data}, references?}`.
`status` is `finished` (use `url`), `submitted` (`--no-wait`), or on failure the
command exits 1 with `type:"error"` and `code` = `NO_CREDITS` | `MODEL_LOCKED` |
`GENERATION_FAILED` | `INVALID_INPUT` | `TIMEOUT` | `INVALID_PARAM` | `RATE_LIMITED`.

### Parameters are model-specific — read them, don't guess

`list-models <mode>` is the source of truth; `gen` validates every value against
it and prints the allowed list when you're wrong.

| Flag | Comes from | Notes |
|---|---|---|
| `--ratio` | `supportedAspectRatios` | `"16:9"` style for most models; **gpt-image-2 family uses `sizeMatrix`** — pass a ratio (`16:9`) + `--size 1K\|2K\|4K`, or the pixel string directly (`2048x1152`) |
| `--size` | `supportedImageSizes` (`1k`/`2k`/`4k`) or `sizeMatrix.resolutions` | image only |
| `--quality` | `supportedQualities` | image, few models |
| `--duration` | `supportedDurations` | seconds as listed; `-1` = auto (Seedance 2.5) |
| `--resolution` | `supportedResolutions` | video: `480p`/`720p`/`1080p` (Seedance), `720P`…`4K` (Kling). Omit → model default |
| `--no-audio` | `supportsAudio` | audio is ON by default when supported |
| `--start` / `--end` | `supportedKeyframe` for `--end` | images only |
| `--ref` | `referenceAssetLimits` / `maxReferenceImages` | Seedance 2.x: image+video+audio; other video models: one image (= start frame); image models: images |
| `--draft` | `supportsDraft` | cheap 480p preview (Seedance 2.5) |

Credits: `estimatedCreditsPer5s` (video) / `estimatedCredits` (image) in
`list-models`; `credits` shows the balance. Higher resolution and longer
duration cost more — don't default to 1080p/30s for a test.

### Seedance references — how to prompt

References are numbered per type in the order you pass them: first image is
`image1`, first audio `audio1`, first video `video1`. Mention them in the prompt
(`"the dancer from image1 moves to audio1"`); anything you don't mention is
appended to the prompt so the model still sees it. The CLI prints the mapping
(`image1 → url`) on stderr and returns it as `references`.

Rules the backend enforces: frames (`--start/--end`) and `--ref` can't be
combined; per-type limits from `referenceAssetLimits`; tiny or synthetic images
may be rejected as references with `INVALID_INPUT` ("input media … not
supported") — use real photos/clips, and audio at least as long as the clip.

## Canvas Mode (live cursor)

Use when the user is watching, or for Agent Neo. Same tree rules apply:

- **Chain** (A→B→C): `submit --follow <A>` → `submit --follow <B>`.
- **Branch** (A→B1, A→B2): variations ALL `--follow <parent>`.
- **Fresh start**: omit `--follow` only for something unrelated.

One submit = one node = one idea.

**Velocity.** Independent prompts go in ONE `submit-batch` (or several `gen
--no-wait` calls), never one by one with `--wait`. Wait only when the next step
depends on seeing the result.

```bash
bun $S --bot claude-code create-canvas "Dog Artwork"        # also navigates the open tab
bun $S --bot claude-code submit "a golden retriever" --mode image --model gemini-3.1-flash-image --wait
bun $S --bot claude-code submit-batch --mode image --models gemini-3.1-flash-image "husky" "corgi" "poodle"
bun $S --bot claude-code read-db --full                      # collect results
bun $S --bot claude-code submit "same dog, running" --follow <nodeId> --wait
bun $S --bot claude-code comment <nodeId> "love this one"
bun $S --bot claude-code set-mode neo
bun $S --bot claude-code submit "Research the top 5 AI startups and create a comparison deck" --wait=600
```

`submit` flags: `--mode m --model id --image <img>... --ratio r --size s
--duration d --loop --no-audio --follow id --wait[=sec]`. Pair `--mode` with
`--model` (every `--mode` resets the model to the bot default). `--image` takes
images only (video mode: start/end frames); for audio/video references use `gen
video --ref`. `submit-batch` takes `--models "a,b"` and never waits.

**Parallel agents.** Each subagent: `submit ... --canvas <convId> --parallel
--agent-id agent-N` (own cursor, no auto-alignment). Direct `gen` needs none of
that — just `--canvas <convId>`.

## Presenting Results

- **Image**: `![description](url)` — describe what you actually see.
- **Video**: `[Watch video](url)` + duration/resolution + what happens in it.
- **Text/Agent**: print the content.
- **Failure**: say the code and the model's message; `NO_CREDITS` → stop, send
  https://flowith.io/pricing, don't retry or switch models.

## Memory

```bash
bun $S --bot claude-code recall "cyberpunk logo" --type image     # across all canvases
bun $S --bot claude-code recall "" --conv <convId>                 # everything on one canvas
bun $S --bot claude-code recall-node <convId> <nodeId>
bun $S --bot claude-code read-db --conv <otherConvId> --full       # read another canvas, stay put
```

## Command Reference

Global flags: `--bot <identity>` (required) · `--canvas <convId>` · `--json`
(compact one-line output) · `--parallel` + `--agent-id <id>` (canvas mode, multi-agent).

### Direct (no browser)

| Command | What it does |
|---|---|
| `gen image "p" --model id [--ratio] [--size] [--quality] [--ref f]… [--follow id] [--no-wait] [--wait=s] [--title t]` | Generate an image; prints URL |
| `gen video "p" --model id [--ratio] [--duration] [--resolution] [--no-audio] [--start f] [--end f] [--ref f]… [--draft] [--follow id] [--no-wait] [--wait=s]` | Generate a video; prints URL |
| `upload <file> [--conv id]` | Upload image/video/audio/pdf → URL |
| `list-models [text\|image\|video\|agent] [--refresh]` | Catalogue with all parameters & credits |
| `credits` | Remaining credits |
| `create-canvas "title"` · `switch <id>` · `list` · `search "q"` | Canvases (navigates an open tab when there is one) |
| `read-db [nodeId] [--full] [--failed] [--conv id]` | Nodes from the database |
| `clean-failed` · `delete <id>` · `delete-many <id>…` | Remove nodes |
| `recall "q" [--type t] [--conv id] [--limit n]` · `recall-node <conv> <node>` | Memory |
| `login` · `status [--live]` · `whoami` · `open [convId\|url]` | Session & browser |

### Canvas (browser tab required)

| Command | What it does |
|---|---|
| `set-mode <text\|image\|video\|agent\|neo>` · `set-model <id>` | Composer state |
| `submit "text" [flags] [--wait[=s]]` | Submit through the composer (live cursor) |
| `submit-batch [--follow id] [--mode m] [--models "a,b"] [--ratio r] [--size s] "p1" "p2"…` | N submits; audit with `read-db` / `batches` |
| `comment <nodeId> "text"` · `read [nodeId\|--all]` · `ping` · `current` | Presence & in-memory reads |
| `batches [id]` · `dream-init "theme"` | Batch journal · creative journal (`references/creative-dream.md`) |

Raw HTTP recipes (for agents without bun): `references/api.md`.
Troubleshooting: `references/troubleshooting.md`.
