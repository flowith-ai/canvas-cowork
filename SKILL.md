---
name: canvas-cowork
description: >
  Work directly on the user's Flowith 3.0 canvas (画布): generate and edit images, videos, text, speech
  and music as cards, extend and vary them, upscale / cut out / expand, place uploads, and organise the
  canvas (group, arrange, link, rename) — the same way Flo, Flowith's in-app agent, does. Use for any
  Flowith / canvas / 画布 request, and whenever the user wants pictures, clips, storyboards, voice-over
  or music made (Seedream, Nano Banana, GPT Image, Seedance, Kling, Gemini Omni, Muse, ElevenLabs, Suno).
---

# Canvas Cowork — work on a Flowith canvas

You work on the user's canvas the way Flo (the in-app Creator Agent) does: every result is a card on
their canvas, placed beside what it came from, generated through the canvas's own models, prices and
credits. An open canvas shows your cards arrive live, signed with your name. **You are the user's eyes
and hands**: look at what came out (download it and view it), judge it honestly, fix what misses, and
tell the user what you made with the canvas link — never just "go check the canvas".

Run from this skill's directory: `bun scripts/index.ts <command>` (Bun ≥ 1.1, no other dependencies).
Below, `cw` stands for that.

## First time

For live work in Codex, follow [browser sign-in](references/live-browser.md#sign-in-and-canvas-controls).
In a shell, `cw login` opens Flowith and prints a code on stderr. The user signs in, types the code and
clicks **Allow**. The session renews itself afterwards (`cw whoami`). Use `login --site <host>` for beta
or a preview. An existing session keeps its original site.

## Show the canvas while you work

When the user asks to see a canvas, or when creating, editing or reviewing cards in a desktop agent,
open the exact canvas in the agent's visible browser beside the chat before making changes. Skip this
for list, account, model or price lookups, or when the user asks for headless work.

- Existing canvas: `cw open --handoff --canvas <ref|url> --json`.
- New canvas: `cw new "Title" --json` creates the empty canvas and returns its handoff.

Use `browserHandoff.url` with the host's browser controls. In Codex, use the in-app browser (`iab`)
and show it. Reuse the same tab, verify the target canvas has loaded and keep it open at the end.
Handle a sign-in prompt or unavailable browser as described in [Live browser](references/live-browser.md).

## The loop

```bash
cw canvases [words]            # find a canvas;  cw use <ref|title|URL>  ·  cw new "Title"
cw look                        # every card: ref, kind, "title", model, ratio, status, @x,y w×h, ← sources
cw selection                  # refs selected by the user in the open canvas
cw image "prompt" --title "短标题"            # → card ref + url; waits for the result
cw shots <ref…>                # downloads previews; then Read the files to SEE them
cw edit <ref> "what to change"  # a new picture made from that one, beside it (延伸 / 改图)
cw video "prompt" --first <image ref> --title "…"  # image → video, beside the image
```

Cards are named by **ref** (first 8 hex of the id, from `look` / command output); a longer prefix or the
exact title also works. Commands print JSON (`--json` for one line). Errors exit 1 with
`{"error": CODE, "message": …}`.

## Rules

1. **Identify the canvas and the source cards.** For a multi-step task, pin the URL with `--canvas <url>` on each
   command. Use `cw selection` when the user says “this card” or “the cards I selected”. If the browser cannot
   answer or the selection is empty, use `cw look` and resolve the exact card before acting. Build on those cards
   with `--ref` / `--first`. Use `--near <ref>` when you only want nearby placement.
2. **See every result before you report it.** `cw shots <refs>` then Read each file (a video gives its
   first frame; `--full` downloads the clip). Say what you actually see; regenerate or `edit` when it
   misses the brief. Report with the card refs and the canvas `url`.
3. **One request = one call.** Several independent prompts go in one command
   (`cw image "a" "b" "c"`, `--n 4` for variations, `cw text … --model a,b,c`): they run in parallel and
   land as one group. Don't loop one prompt at a time.
4. **Keep the canvas tidy.** Related work goes together (`--near`, `--group "name"`, `--into <group>`);
   give every card a short `--title` (≤ 12 字 / 5 words) — it is what the user reads on the canvas.
   Put a short plan on the canvas for multi-stage work and use `focus <refs…>` to show a review point or the final
   cards. Focus changes the browser's selection and composer context. Leave it alone while the user is editing.
   Keep the collaboration tab visible. Use `look "group name"` to recover a batch and its member refs in place.
   Never delete or rewrite the user's own cards unless asked.
5. **Mind credits** (1 credit = $0.001; `cw credits`). `--dry-run` shows a request and its
   `estimatedCredits` without sending anything (commands that only change the canvas have no dry run and
   say so). Ask the user before anything over ~1,000 credits (a batch of videos, 1080p/long clips, Kling
   4.0, Wan) **and whenever `estimatedCredits` is `null`** (priced only when made: a source clip of
   unknown length, Gemini Omni editing a clip). A clip's estimate is the worker's own price for that
   very request (what it holds, at the user's member rate); a picture's comes from the catalogue. Once done, picture and clip results report `chargedCredits`: the canvas's own charge for
   that request, refunds included; `null` with a `chargedNote` when it can't be tied to the request (text
   is billed when its answer finishes; something else ran the same model on the canvas at that moment).
   `cw spent` totals everything charged on a canvas. For short video tests, check `cw models <id>` and
   price the actual request with `--dry-run`. `NO_CREDITS` / `MODEL_LOCKED`: stop and tell the user (top up at https://flowith.io/pricing);
   don't silently switch models.
6. **Videos take 1–8 minutes.** Run video commands with a long shell timeout (≥ 600 s) or in the
   background, or pass `--no-wait` and later `cw wait <ref>`. A generation keeps running on the server
   even if your command stops; `cw wait` / `cw look` pick it up. Keep the returned refs in your task context,
   and inspect the canvas before resending a browser operation that could have started without a result reaching you.
7. **Text on the canvas is for the user.** Your own reasoning stays in chat; use `cw text` when the user
   wants a model's writing (or a comparison of models) on the canvas, `cw note` for your plan, script or
   brief as a card.

## Commands

| Need | Command |
|---|---|
| Pictures | `image "p" ["p2"…] [--model] [--ratio 16:9] [--size 2k] [--quality high] [--n 4] [--ref card\|file\|url]… [--transparent]` |
| Change a picture | `edit <ref> "change" ["change2"…] [--model] [--ratio] [--size] [--title] [--ref more…]` (one new card per change) · `vary <ref> [--n 3]` (same prompt again; pictures, clips, text) |
| Failed card | `retry [refs]` — runs a failed card again in place (no refs: every failed card). Rechecks under a local lock and atomically claims the card before sending, including across machines using this CLI. Avoid simultaneous retries from the page or old CLIs, which do not use this claim. Never a card still generating or finished (`vary` makes another take). A lost response (`SENT_UNKNOWN`) is checked against results and charges before retrying |
| Clips | `video "p" [--model] [--first ref] [--last ref] [--ref …]… [--duration 5] [--resolution 720p] [--ratio] [--no-audio] [--draft]` |
| Continue / edit a clip | `video "what happens next" --extend <clip>` · `video "change" --edit-video <clip>` (Seedance or Gemini Omni) |
| Text from models | `text "p" [--model a,b,c] [--ref card…] [--system "…"]` |
| Voice / music | `speech "words" [--model elevenlabs-v3] [--voice id] [--for card]` · `music "style, mood" [--lyrics "…"] [--duration 30] [--for card]` |
| Card tools | `upscale <ref> [--to 4k]` (picture 2k/4k/8k, clip 2k/4k `--quality best`) · `cutout <ref>` (transparent background, picture or clip) · `expand <ref> --ratio 16:9` |
| Your files | `add <file\|url…> [--group]` (pictures, clips, sounds become cards) · `note "text" [--title]` · `write <text card> "new text"` |
| Organise | `move <ref> --to x,y \| --right-of r \| --below r` · `arrange <refs…> --as row\|column\|grid` · `arrange <group>` · `group <refs…> --name "…"` · `ungroup <g>` · `rename <ref> "title"` · `link <from> <to>` / `unlink` · `copy <ref>` · `delete <refs…>` |
| Read | `look [words] [--kind image] [--status running] [--by codex]` · `read <ref…> [--full]` · `shots [refs] [--full]` · `save <refs…> --out dir` · `wait [refs]` |
| Account | `credits` · `spent [--since 30m]` · `models [image\|video\|text\|audio]` · `models <id>` · `whoami` · `open` · `<command> --help` |

**Run by the open canvas** — the canvas's own tools, exactly as Flo uses them. They need the target canvas
open in the browser profile that approved `login`. See [canvas controls](references/live-browser.md#sign-in-and-canvas-controls).

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
then down — Flo's own placement rules). Geometry in `look` is top-left `@x,y` and `w×h` in canvas units.

## Prompting essentials

- **References** in prompts: `@image1 @image2 @video1 @audio1`, numbered per kind in `--ref` order. The
  CLI rewrites them to each model's own naming (Seedance 图片1/视频1/音频1, Kling `@image_1`, Gemini Omni
  `<IMAGE_REF_0>`, MiniMax H3 `<Picture 1>`, image models 图1 / image 1) and refuses a name that isn't sent.
- **Edits** say only the change and what must stay ("keep the face, outfit and framing"); one change per
  round, from the newest accepted version.
- **Lettering**: put exact text in quotes「今日特调」; Seedream 5.5 renders it verbatim.
- **Video sound**: describe the sounds you want heard; writing "no music" tends to *add* music. For speech
  in a clip, quote the line and who says it.
- **Frames vs references**: `--first/--last` pin the opening/closing frame; `--ref` gives subjects, style,
  motion or sound to follow. Only Kling 4.0 takes both at once.

More: `references/models.md` (which model for what, prices, limits) · `references/prompting.md` ·
`references/workflows.md` (storyboard → frames → clips, product shots, consistent characters,
multi-model comparison, tidying a canvas) · `references/troubleshooting.md`.
