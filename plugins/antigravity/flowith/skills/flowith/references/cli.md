# The canvas-cowork CLI

The fallback for hosts where Flowith's MCP server can't be added (or isn't live for the user's site yet).
It does everything the hosted tools do, plus the canvas tools they don't cover yet. Zero dependencies.

## Running it

| Where | Command |
|---|---|
| This skill's folder, Node 22.18+ | `node scripts/index.ts <command>` |
| This skill's folder, Bun 1.1+ | `bun scripts/index.ts <command>` |
| Anywhere (Node 22.18+, no install) | `npx -y github:flowith-ai/canvas-cowork <command>` |

Below, `cw` stands for whichever you use (`cw() { node scripts/index.ts "$@"; }`). `cw help` lists every
command and `cw <command> --help` its flags. Node 22.6 to 22.17 can run it with
`node --experimental-strip-types scripts/index.ts`.

## First time

`cw login` opens Flowith and prints a code on stderr. The user signs in, types the code and clicks
**Allow**. Run it in the background (or with a timeout of 3 minutes or more) and pass the code on in one
line. The session renews itself afterwards (`cw whoami`). `login --site <host>` signs in to beta or a
preview; an existing session keeps its original site. `--no-open` prints the link instead of opening it
(for a host's own browser: open that link there). See [Live browser](live-browser.md) for live work in
Codex.

Sessions live in `~/.flowith/canvas-session.json` (mode 600; never print or share it). `FLOWITH_HOME=/path`
keeps a separate session per account or environment.

## The loop

```bash
cw canvases [words]            # find a canvas;  cw use <ref|title|URL>  ·  cw new "Title"
cw look                        # every card: ref, kind, "title", model, ratio, status, @x,y w×h, ← sources
cw selection                   # refs selected by the user in the open canvas
cw image "prompt" --title "短标题"            # → card ref + url; waits for the result
cw shots <ref…>                # downloads previews; then Read the files to SEE them
cw edit <ref> "what to change"  # a new picture made from that one, beside it (延伸 / 改图)
cw video "prompt" --first <image ref> --title "…"  # image → video, beside the image
```

Cards are named by **ref** (first 8 hex of the id, from `look` / command output); a longer prefix or the
exact title also works. Commands print JSON (`--json` for one line). Errors exit 1 with
`{"error": CODE, "message": …}` ([troubleshooting](troubleshooting.md)).

## CLI specifics of the rules

- **Pin the canvas**: for a multi-step task, pass `--canvas <url>` on each command, so another agent
  changing the active canvas can't redirect your work. `--near <ref>` places without referencing.
- **See results**: `cw shots <refs>` then Read each file (a clip gives its first frame; `--full`
  downloads the clip).
- **One call**: `cw image "a" "b" "c"`, `--n 4` for variations, `cw text … --model a,b,c`: they run in
  parallel and land as one group.
- **Tidy**: `--near`, `--group "name"`, `--into <group>`; `--title` on every card; `cw note` for a plan;
  `cw focus <refs…>` to show a review point (it changes the browser's selection: leave it alone while
  the user is editing); `cw look "group name"` recovers a batch and its member refs.
- **Credits**: `--dry-run` shows a request and its `estimatedCredits` without sending anything (commands
  that only change the canvas have no dry run and say so). Ask the user before anything over ~1,000
  credits **and whenever `estimatedCredits` is `null`** (priced only when made: a source clip of unknown
  length, Gemini Omni editing a clip). A clip's estimate is the worker's own price for that very request;
  a picture's is the catalogue's price for its size and reference pictures, at the user's member rate.
  Finished pictures and clips report `chargedCredits` (the canvas's own charge, refunds included), or
  `null` with a `chargedNote` when it can't be tied to the request. `cw spent` totals a canvas.
  `NO_CREDITS` / `MODEL_LOCKED`: stop and tell the user.
- **Long jobs**: run video commands with a long shell timeout (≥ 600 s) or in the background, or pass
  `--no-wait` and later `cw wait <ref>`. Keep the returned refs, and inspect the canvas before resending
  a browser operation that could have started without a result reaching you.
- **Text**: `cw text` for a model's writing on the canvas, `cw note` for your plan, script or brief.

## Commands

| Need | Command |
|---|---|
| Pictures | `image "p" ["p2"…] [--model] [--ratio 16:9] [--size 2k] [--quality high] [--n 4] [--ref card\|file\|url]… [--transparent]` |
| Change a picture | `edit <ref> "change" ["change2"…] [--model] [--ratio] [--size] [--title] [--ref more…]` (one new card per change) · `vary <ref> [--n 3]` (same prompt again; pictures, clips, text) |
| Failed card | `retry [refs]`: runs a failed card again in place (no refs: every failed card). Never a card still generating or finished (`vary` makes another take). A card whose send got no answer (`SENT_UNKNOWN`) is sent again only once the canvas's charges show it never arrived. Two `retry` commands on one card, on any machine, send it once: the other gets `BUSY`. (A retry clicked on the canvas page, or from an older canvas-cowork, isn't held off: don't retry a card the user is retrying.) |
| Clips | `video "p" [--model] [--first ref] [--last ref] [--ref …]… [--duration 5] [--resolution 720p] [--ratio] [--no-audio] [--draft]` |
| Continue / edit a clip | `video "what happens next" --extend <clip>` · `video "change" --edit-video <clip>` (Seedance or Gemini Omni) |
| Text from models | `text "p" [--model a,b,c] [--ref card…] [--system "…"]` |
| Voice / music | `speech "words" [--model elevenlabs-v3] [--voice id] [--for card]` · `music "style, mood" [--lyrics "…"] [--duration 30] [--for card]` |
| Card tools | `upscale <ref> [--to 4k]` (picture 2k/4k/8k, clip 2k/4k `--quality best`) · `cutout <ref>` (transparent background, picture or clip) · `expand <ref> --ratio 16:9` |
| Your files | `add <file\|url…> [--group]` (pictures, clips, sounds become cards) · `note "text" [--title]` · `write <text card> "new text"` |
| Organise | `move <ref> --to x,y \| --right-of r \| --below r` · `arrange <refs…> --as row\|column\|grid` · `arrange <group>` · `group <refs…> --name "…"` · `ungroup <g>` · `rename <ref> "title"` · `link <from> <to>` / `unlink` · `copy <ref>` · `delete <refs…>` |
| Read | `look [words] [--kind image] [--status running] [--by codex]` · `read <ref…> [--full]` · `shots [refs] [--full]` · `save <refs…> --out dir` · `wait [refs]` |
| Account | `credits` · `spent [--since 30m]` · `models [image\|video\|text\|audio]` · `models <id>` · `whoami` · `open` · `logout` · `<command> --help` |

**Run by the open canvas**: the canvas's own tools, exactly as Flo uses them. They need the target canvas
open in the browser profile that approved `login`. See
[canvas controls](live-browser.md#sign-in-and-canvas-controls).

| Need | Command |
|---|---|
| Exchange context | `selection` reads the current selection · `focus <refs…>` selects and centres cards in the browser |
| Tidy | `tidy` (the canvas's Organize: removes overlaps) · `tidy <refs…> --as row\|column\|grid\|left\|top\|hdistribute\|vdistribute` |
| Picture tools | `split <ref> --rows 2 --cols 2` (grid → cells) · `angles <ref> [--angles low,closeUp,wide,side,back,high,overShoulder]` · `relight <ref> --preset window\|golden\|blueHour\|neon\|rim\|noir\|studio\|candle` |
| Clip tools | `lipsync <clip> --with <sound>` · `motion <clip> --with <character picture>` · `soundtrack <clip> [--voice "line"]` (music by default) |
| Film tools | `breakdown <clip>` (拉片: shots, frames, prompts) · `character <picture> --name "Mia" [--subject human\|animal\|anthro\|creature] [--style …]` (角色卡) · `cut <refs…> [--into <cut>]` (加入剪辑) · `stage "scene, cast, cameras" [--cast refs]` (导演台 previs) · `shoot <stage> [--shots all]` |
| Anything else Flo can do on the canvas | `do <operation> --input '{…}'` (ids are full card ids) |

Most commands wait for their result; a failed card makes the command exit 1 with `next` saying what to
do. Placement: new cards sit beside `--near <ref>` (else the first card reference, else free space, right
then down: Flo's own placement rules). Geometry in `look` is top-left `@x,y` and `w×h` in canvas units.

## References in prompts

`@image1 @image2 @video1 @audio1`, numbered per kind in `--ref` order. The CLI rewrites them to each
model's own naming (Seedance 图片1/视频1/音频1, Kling `@image_1`, Gemini Omni `<IMAGE_REF_0>`, MiniMax H3
`<Picture 1>`, image models 图1 / image 1) and refuses a name that isn't sent. See
[prompting](prompting.md).
