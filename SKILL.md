---
name: canvas-cowork
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
| A first look, three starters | `get_started { locale? }` → `welcome`, `starters` (title, prompt, cover) | `cw help` |
| Find a canvas | `list_canvases { query?, limit? }` → `canvasId`, `title`, `url` each | `cw canvases [words]` |
| Start one | `create_canvas { title }` → `canvasId`, `url` | `cw new "Title"` |
| Show it beside the chat | `open_canvas { canvasId }` → `url`, `handoffUrl` | `cw open --handoff --canvas <url>` |
| See what is on it | `read_canvas { canvasId }`: the canvas map (its areas); `area` for one area's cards, `refs` for exact cards | `cw look` · `cw read <ref>` |
| Find cards | `find_canvas_nodes { canvasId, text?, kinds?, state?, placedBy?, groupRef?, … }` | `cw look [words] --kind image` |
| Pictures | `generate_image { canvasId, title, prompt, model?, aspectRatio?, quality?, resolution?, near? }` | `cw image "p" ["p2"…]` |
| Wait for a job | `get_task { taskId, waitSeconds? }` (0–50 s, default 20) | `cw wait <ref>` |
| Credits | `credits` → `availableCredits`, `askAboveCredits`, `topUpUrl` | `cw credits` · `cw spent` |
| Change a picture, clips, voice and music | `edit_image`, `generate_video`, `generate_audio` (same answers as `generate_image`) | `cw edit` · `cw video` · `cw speech` · `cw music` |

`edit_image`, `generate_video` and `generate_audio` are arriving in the hosted tools; until they are in your
tool list, the CLI does them (it has a one-click sign-in of its own). The CLI also has the card tools
the hosted tools don't cover yet (upscale, cut-out, expand, retry, vary, group / arrange, and the
canvas's own split, angles, relight, lip-sync, 拉片, characters, director stage):
[references/cli.md](references/cli.md). Where the server's own tool descriptions differ from this
table, they win.

## How a generation answers

A generation answers at once; it never blocks until the picture exists.

- `status: "generating"` with `taskId` and `card` (the ref of the card already on the canvas, showing
  it generating). Start every independent generation of the request first, then wait: call
  `get_task { taskId, waitSeconds: 50 }` and call it again while it says `generating`. A picture is
  usually done within a call or two; a clip takes 1 to 8 minutes. `done` gives `results` (kind, title,
  url) and a `message`; `failed` gives a `message` (and `topUpUrl` when it was credits); `cancelled`
  means the user stopped it. The work runs on Flowith whatever happens to your call: never send it again
  because it is slow; keep the `taskId` and check it.
- `status: "needs_approval"` with `credits`, `askAboveCredits` and a `message`: it costs more than the
  user's ask-above limit. Ask the user, with the price in their words; only on a yes, send the same call
  again with `approveCredits: <credits>` (it is then capped at that price). Nothing was placed or charged.
- `status: "not_started"` with a `message` and `topUpUrl`: their credits can't pay for it. Nothing was
  placed or charged. Tell the user in Flowith's words with the `topUpUrl`; don't switch to a cheaper
  model unless they ask.

## Show the canvas while you work

When creating, editing or reviewing cards in a desktop agent with a browser beside the chat (Codex's
in-app browser, Antigravity's, Cursor's, Claude's browser pane), open the exact canvas there before
making changes. Skip it for list, account, model or price lookups, or when the user wants headless work.

- **MCP**: `open_canvas { canvasId }` (after `create_canvas` too: that answer has no `handoffUrl`).
  Open its `handoffUrl` in the host's side browser: it signs that tab in as the user and shows the
  canvas laid out for a side pane. It works once, within `expiresIn` seconds; call `open_canvas` again
  rather than reusing it, and never paste it into the chat (`url` is the link to share). No
  `handoffUrl` in the answer: open `url`, and the user signs in to Flowith in that tab once.
- **CLI**: `cw new "Title" --json` or `cw open --handoff --canvas <ref|url> --json` returns
  `browserHandoff.url`, a plain canvas link; the user signs in to Flowith in that tab once.

Reuse the same tab, check it shows the target canvas, and leave it open at the end. Your cards appear
there live as you make them. Sign-in prompts and hosts without a browser:
[references/live-browser.md](references/live-browser.md).

## The loop

1. **Find the canvas and the source cards**: the canvas the user named or has open (`list_canvases`),
   the cards they described (`find_canvas_nodes`, `read_canvas`). Read the canvas before building on it;
   keep its `canvasId` for every later call of a multi-step task.
2. **Make it**: start every generation the request needs, each with a short `title`, beside its source
   (`near: <ref>`), then wait on their tasks with `get_task`.
3. **Look at every result**: open each result's `url` (download the picture and view it; a clip: its
   frames) and say what you actually see. Redo or edit what misses the brief before you report.
4. **Report** the cards you made (titles or refs) with the canvas `url`.

## Rules

1. **Build on the user's cards.** When they say "this one" or "the ones I selected", find the exact card
   (`find_canvas_nodes`, `read_canvas` with `refs`; CLI: `cw selection`), or ask. Place results beside
   their source (`near`); where a tool takes references or first frames, pass the source cards so the
   canvas links result to source.
2. **See every result before you report it.** Say what you see; never describe a picture you haven't
   looked at.
3. **Start everything, then wait.** Several pictures for one request: start them all, then wait on
   their tasks; don't make one, wait, make the next. (The CLI takes several prompts in one call.)
4. **Keep the canvas tidy.** Related work goes together (beside its source, or as a named group); give
   every card a short title (≤ 12 字 / 5 words): it is what the user reads on the canvas. For
   multi-stage work, put a short plan on the canvas as a note card. Never delete or rewrite the user's
   own cards unless asked.
5. **Mind credits** (1 credit = $0.001). The hosted tools stop at the user's ask-above limit with
   `needs_approval`: ask, and resend with `approveCredits` only on a yes. Out of credits (`not_started`)
   or a model above their plan: stop and pass on what it says with its `topUpUrl`; don't silently switch
   models. `credits` shows the balance and the limit. Ask before anything large even under the limit: a
   batch of clips, 1080p or long clips, Kling 4.0, Wan. The CLI shows a price with `--dry-run`.
6. **Clips take 1 to 8 minutes.** Wait with `get_task { taskId, waitSeconds: 50 }` (CLI: a long shell
   timeout, or `--no-wait` and `cw wait`). A generation keeps running on Flowith even if your call
   stops: check its task or the canvas before sending anything again.
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
