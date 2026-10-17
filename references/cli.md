# canvas-cowork — full CLI reference

```
S="scripts/index.ts"
bun $S --bot <claude-code|codex|openclaw|cursor|opencode|flowithos> <command> [args] [global flags]
```

## Global flags

| Flag | Effect |
|---|---|
| `--bot <identity>` | required; names the cursor / bot identity |
| `--canvas <convId>` or env `FLOWITH_CANVAS=<convId>` | target this canvas for the command (in-memory; only `create-canvas` / `switch` persist the active canvas) |
| `--json` | compact single-line JSON on stdout; **implies `--quiet`** |
| `--verbose` | `gen` results keep the full node `data` |
| `--quiet` | no progress lines on stderr |
| `--parallel --agent-id <id>` | canvas mode only: own cursor, no auto-alignment (requires `--canvas`) |

Every command prints one JSON object: `{"type":"result","data":…}` or, on failure with exit 1,
`{"type":"error","code":…,"message":…,"data"?:…}`. Codes: `NO_CREDITS`, `MODEL_LOCKED`,
`INVALID_PARAM`, `INVALID_MODEL`, `INVALID_INPUT`, `GENERATION_FAILED`, `RATE_LIMITED`,
`TIMEOUT`, `NOT_LOGGED_IN`, `NO_CANVAS`, `NOT_FOUND`, `BROWSER_NOT_CONNECTED`, `LOCKED`.

## Direct commands (plain HTTP, no browser)

### `gen text|image|video "prompt" ["prompt2" …] [flags]`

| Flag | Applies to | Notes |
|---|---|---|
| `--model <id\|best\|fast>` | all | default `best` for text/image, `fast` for video. `models --aliases` shows the table; override in `~/.flowith/defaults.json` |
| `--follow <nodeId>` | all | parent the new question to that node. Text: the whole thread (question/answer chain up to the root, 20 turns max) is sent as history |
| `--system "…"` | text | system message |
| `--ratio <r>` | image, video | from the model's `supportedAspectRatios`; gpt-image-2 family: ratio (`16:9`) + `--size 1K\|2K\|4K`, or a pixel string (`2048x1152`) |
| `--size <s>` | image | `supportedImageSizes` (`1k`/`2k`/`4k`) or size-matrix tier |
| `--quality <q>` | image | `supportedQualities` (few models) |
| `--ref <file\|url>` (repeatable) | image, video | image: reference images (≤ `maxReferenceImages`). Video on Seedance 2.x: images / video / audio, addressed in the prompt as `image1`, `video1`, `audio1` (1-based per type; unmentioned ones are appended). Other video models: one image = start frame |
| `--duration <s>` | video | `supportedDurations`; default `5` when offered; `-1` = auto (Seedance 2.5) |
| `--resolution <r>` | video | `supportedResolutions`; default `720p` when offered |
| `--no-audio` | video | audio is on by default when the model supports it |
| `--start <img>` / `--end <img>` | video | first / last frame (`--end` needs `supportedKeyframe`); can't be combined with `--ref` |
| `--draft` | video | Seedance 2.5 cheap 480p preview |
| `--no-wait` | all | return `{status:"submitted", nodeId}`; check later with `read-db <nodeId>` |
| `--wait=<s>` / `--timeout <s>` | all | default 300 s (text, image), 600 s (video) |
| `--out <file\|dir/>` | all | save the result: image/video download, text written to the file. Batch: `--out dir/` → `dir/01-<nodeId>.ext` |
| `--jobs <file.json>` | all | batch from a JSON array `[{"prompt":"…","model"?:…,"ratio"?:…,"refs"?:[…],…}]` (flag names or camelCase keys); strings are plain prompts |
| `--title "…"` | all | title for the canvas `gen` auto-creates when none is active |

Several prompts on the command line = batch with shared flags. Batches run 4 at a time
(video 2), keep input order, return one JSON array, and exit 1 only if every job failed.
Positions are planned up front so nodes don't overlap.

Result (`data`): `{status, kind, model, convId, questionNodeId, nodeId, url|text, reasoning?, ratio?, duration?, resolution?, references?, elapsedMs, file?}`.
`status` = `finished` | `submitted` | `failed` | `timeout`. Failures carry `error`, `errorCode` and a trimmed `data` (`error_type`, `error_code`, `refund_amount`).

Where it lands: the active canvas (`--canvas` / `FLOWITH_CANVAS` / last `switch`); with none, `gen` creates `[Bot] <date>`.

### `upload <file> [--conv <convId>]`
Image / video / audio / PDF → `{url, name, type, media}`. Limits: video 100 MB, others 30 MB.

### `models [text|image|video|agent] [<modelId>] [--aliases] [--refresh]` (alias `list-models`)
Default: compact table, one line per model (`id  ratios=…  dur=…  res=…  flags  ~credits`).
`models <id>` → that model's full JSON. `--json` → full objects per mode. `--aliases` → the best/fast table. `--refresh` bypasses the 5-minute cache.

### `credits`
Remaining credits (`remain_quota`, `init_quota`, `to_date`, …).

### Canvases
`create-canvas "title"` (adds `[Bot]`, reuses a same-titled canvas created < 5 min ago, navigates a connected tab) ·
`switch <convId>` · `list` · `search "q"`

### Nodes
`read-db [nodeId] [--full] [--failed] [--conv <convId>]` · `clean-failed` (failed nodes + their orphaned questions) ·
`delete <nodeId>` · `delete-many <id> <id>…`

### Memory
`recall "q" [--type text|image|video|webpage] [--conv <convId>] [--limit n]` · `recall-node <convId> <nodeId>`

### Session
`login` / `connect` · `status [--live]` (`tokenExpiresAt`, `canRefresh`, `browser`) · `whoami` · `open [convId|url]`

## Canvas mode (needs a logged-in Flowith tab)

The live-cursor path: actions are broadcast to the open tab, which submits through the
real composer. Use it when the user is watching or for Agent Neo.

| Command | Notes |
|---|---|
| `set-mode <text\|image\|video\|agent\|neo>` · `set-model <id>` | composer state; every `--mode` on `submit` resets the model to the bot default, so pair `--mode` with `--model` |
| `submit "text" [--mode m] [--model id] [--image <img>]… [--ratio r] [--size s] [--duration d] [--loop] [--no-audio] [--follow id] [--wait[=s]]` | one node; `--image` takes images only (video mode: start/end frames) |
| `submit-batch [--follow id] [--mode m] [--models "a,b"] [--ratio r] [--size s] "p1" "p2"…` | N submits, never waits; audit with `read-db` / `batches` |
| `comment <nodeId> "text"` | cursor label for 30 s |
| `read [nodeId\|--all]` | nodes from browser memory |
| `ping` · `current` | liveness / which canvas the tab shows |
| `batches [id]` · `dream-init "theme"` | batch journal · creative journal (`references/creative-dream.md`) |

Tree rules: chain with `--follow <previous>`, branch variations all `--follow <parent>`,
omit `--follow` only for something unrelated. Independent prompts go in one
`submit-batch` or one `gen … "p1" "p2"`, never one by one with `--wait`.

## Files

`~/.flowith/bot-session.json` (session; access token ~24 h, auto-refreshed when the handshake provided a refresh token) ·
`~/.flowith/defaults.json` (alias overrides) · `~/.flowith/models-cache.json` · `~/.flowith/batches/` · `~/.flowith/creative-journal.md`
