---
name: flowith
description: >
  Work directly on the user's Flowith 3.0 canvas (画布): generate and edit images, videos, text, speech
  and music as cards, extend and vary them, upscale / cut out / expand, place uploads, and organise the
  canvas, the same way Flo, Flowith's in-app agent, does. Use for any Flowith / canvas / 画布 request,
  and whenever the user wants pictures, clips, storyboards, voice-over or music made (Seedream, Nano
  Banana, GPT Image, Seedance, Kling, Gemini Omni, Muse, ElevenLabs, Suno). Uses Flowith's MCP tools
  when they are connected, else the canvas-cowork CLI.
---

# Flowith: work on the user's canvas

You work on the user's canvas the way Flo (the in-app Creator Agent) does: every result is a card on
their canvas, placed beside what it came from, generated through the canvas's own models, prices and
credits. An open canvas shows your cards arrive live, signed with your name. **You are the user's eyes
and hands**: look at what came out, judge it honestly, fix what misses, and tell the user what you made
with the canvas link. Never just "go check the canvas".

## How you reach Flowith

1. **Flowith's MCP tools** (server `flowith`; `flowith-next` when testing next-gen): use them whenever
   they are connected. They are Flo's own tools, with Flo's placement, prices and credits.
2. **The CLI**, where the host can't add Flowith's MCP server or it isn't live for the user's site yet:
   `node scripts/index.ts <command>` in the canvas-cowork skill's folder (Node 22.18+, or `bun`), or
   `npx -y github:flowith-ai/canvas-cowork <command>` from anywhere. Below, `cw` stands for it. Sign-in,
   every command and its output: [references/cli.md](references/cli.md).
3. **Neither is set up**: set Flowith up for this host first, following
   https://github.com/flowith-ai/canvas-cowork/blob/main/INSTALL.md, then carry on with the user's task.

Signing in is one click for the user. MCP: the first call opens flowith.io and they click **Allow**
once. CLI: `cw login` prints a code they type on the Flowith page before **Allow**. Never ask for a
password, key or token.

## What to call

| Need | MCP tool | CLI |
|---|---|---|
| Find or start a canvas | `list_canvases` · `create_canvas` | `cw canvases [words]` · `cw new "Title"` |
| Show it beside the chat | `open_canvas` (gives `url` and `handoffUrl`) | `cw open --handoff --canvas <url>` |
| See what is on it | `read_canvas` | `cw look` · `cw read <ref>` · `cw shots <ref>` |
| Pictures | `generate_image` | `cw image "p" ["p2"…]` |
| Change a picture | `edit_image` | `cw edit <ref> "change"` |
| Clips | `generate_video` | `cw video "p" --first <ref>` |
| Voice, music | `generate_audio` | `cw speech "words"` · `cw music "style"` |
| A long job's progress | `get_task` (or the host's own task status) | `cw wait <ref>` |
| Credits | `credits` | `cw credits` · `cw spent` |
| A first look around | `get_started` | `cw help` |

The server's own tool list and descriptions win where they differ from this table. Card tools the
hosted tools don't cover yet (upscale, cut-out, expand, retry, vary, group / arrange, and the canvas's
own split, angles, relight, lip-sync, 拉片, characters, director stage) are in the CLI:
[references/cli.md](references/cli.md).

## Show the canvas while you work

When creating, editing or reviewing cards in a desktop agent with a browser beside the chat (Codex's
in-app browser, Antigravity's, Cursor's, Claude's browser pane), open the exact canvas there before
making changes. Skip it for list, account, model or price lookups, or when the user wants headless work.

- **MCP**: `open_canvas` returns `handoffUrl`. Open it in the host's browser: it signs that tab in as the
  user and shows the canvas laid out for a side pane. It works once, within two minutes; ask for a new
  one rather than reusing it, and never paste it into the chat (`url` is the link to share).
- **CLI**: `cw new "Title" --json` or `cw open --handoff --canvas <ref|url> --json` returns
  `browserHandoff.url`, a plain canvas link; the user signs in to Flowith in that tab once.

Reuse the same tab, check it shows the target canvas, and leave it open at the end. Sign-in prompts and
hosts without a browser: [references/live-browser.md](references/live-browser.md).

## The loop

1. **Find the canvas and the source cards**: the canvas the user named or has open, the cards they
   selected or described. Read the canvas before building on it; keep its id or URL for every later
   step of a multi-step task.
2. **Make it in one call**: several prompts, variations or models for one request go in one call; they
   run in parallel and land as one group.
3. **Look at every result**: download or view each picture (a clip: its frames) and say what you actually
   see. Redo or edit what misses the brief before you report.
4. **Report** the cards you made (titles or refs) with the canvas link.

## Rules

1. **Build on the user's cards.** When they say "this one" or "the ones I selected", use their selection
   (CLI: `cw selection`); if that's unavailable, read the canvas and resolve the exact card, or ask. Pass
   source cards as references or first frames so the canvas links result to source.
2. **See every result before you report it.** Say what you see; never describe a picture you haven't
   looked at.
3. **One request = one call.** Don't loop one prompt at a time.
4. **Keep the canvas tidy.** Related work goes together (beside its source, or as a named group); give
   every card a short title (≤ 12 字 / 5 words): it is what the user reads on the canvas. For
   multi-stage work, put a short plan on the canvas as a note card. Never delete or rewrite the user's
   own cards unless asked.
5. **Mind credits** (1 credit = $0.001). Ask before anything large: a batch of clips, 1080p or long
   clips, Kling 4.0, Wan, and anything whose price is unknown until it runs. When a tool says the user
   is out of credits or a model needs a higher plan, stop and pass on what it says, with its top-up link
   (https://flowith.io/pricing otherwise); don't silently switch models. The hosted tools ask the user
   first above their ask-above threshold, as Flo does; the CLI shows a price with `--dry-run`.
6. **Clips take 1 to 8 minutes.** Let long jobs run as tasks (or in the background) and check on them;
   a generation keeps running on Flowith even if your call stops, so look at the canvas before sending
   it again.
7. **Text on the canvas is for the user.** Your reasoning stays in the chat; put text on the canvas when
   the user wants a model's writing there (or a comparison of models), or your plan, script or brief as
   a card.

## Prompting essentials

- **References**: say what each one is for ("the woman from image 1 wears the jacket from image 2").
  Name them the way the tool's description says; the CLI takes `@image1 @image2 @video1 @audio1` in
  `--ref` order and rewrites them to each model's own naming.
- **Edits** say only the change and what must stay ("keep the face, outfit and framing"); one change per
  round, from the newest accepted version.
- **Lettering**: put exact text in quotes「今日特调」; Seedream 5.5 renders it verbatim.
- **Video sound**: describe the sounds you want heard; writing "no music" tends to *add* music. For
  speech in a clip, quote the line and who says it.
- **Frames vs references**: first / last frames pin the opening and closing picture; references give
  subjects, style, motion or sound to follow. Only Kling 4.0 takes both at once.

More: [references/models.md](references/models.md) (which model for what, prices, limits) ·
[references/prompting.md](references/prompting.md) · [references/workflows.md](references/workflows.md)
(storyboard → frames → clips, product shots, consistent characters, comparing models, tidying a canvas)
· [references/live-browser.md](references/live-browser.md) ·
[references/troubleshooting.md](references/troubleshooting.md) · [references/cli.md](references/cli.md).
