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

Signing in takes the user one click at most. MCP: the first call opens flowith.io, which connects at
once when they copied the install line there in the last 10 minutes, and otherwise asks them to click
**Allow** once. CLI: `cw login` prints a code they type on the Flowith page before **Allow**. Never ask
for a password, key or token.

## What to call

The hosted tools are Flo's own, by Flo's schemas; cards are named by ref, and every tool but the account
ones takes `canvasId`. The server's own list and descriptions win over this summary.

| Need | MCP tools | CLI |
|---|---|---|
| Account | `get_started { locale? }`, `list_canvases { query?, limit? }`, `create_canvas { title }`, `open_canvas { canvasId }` → `url`, `handoffUrl`, `credits` → `credits` (the balance their Flowith page shows), `askAboveCredits`, `topUpUrl` | `cw help` · `cw canvases` · `cw new` · `cw open --handoff` · `cw credits` |
| Overview: read, then look | `read_canvas` (the map of areas; `area` for one; `refs` + `view: true` for exact cards with their pictures), `view_canvas { mode?: "map" \| "photo", area? }` (an image of the canvas), `find_canvas_nodes`, `read_selection` (what the user selected and sees) | `cw look` · `cw read <ref>` · `cw selection` |
| Micro edits (one call = one undo step) | `edit_canvas { operations: [...], focus? }` for several at once; `create_canvas_node`, `update_canvas_node` (rename, text, colour, size, link / unlink, ungroup), `layout_canvas { script }` (move, align, arrange), `group_canvas_nodes`, `copy_canvas_node`, `delete_canvas_node`, `canvas_comment`, `focus_canvas_nodes` (show the user the result) | `cw arrange` · `cw group` · `cw focus` |
| Making | `generate_image`, `edit_image`, `generate_video`, `generate_audio`, then `get_task { taskId, waitSeconds? }` | `cw image` · `cw edit` · `cw video` · `cw speech` · `cw music` · `cw wait` |
| Card tools and composition | `card_tool`, `upscale_image`, `make_transparent_image`, `image_action`, `video_action`, `create_storyboard`, `lay_out_storyboard`, `storyboard_action`, `make_board_film`, `break_down_video`, `build_director_stage`, `shoot_director_shot`, `director_action`, `timeline_action`, `add_to_cut`, `make_character`, `character_action`, `find_elements`, `save_element`, `library_element` | [references/cli.md](references/cli.md) |
| The user's own files | `prepare_upload { fileName, contentType, sizeBytes }` → run its `command` (an HTTP PUT of the file), then `import_media { uploadId, near? }` | `cw upload <file>` |

## Templates: from what the user asked to the film on their computer

A template is a recipe that makes one finished piece on the user's canvas (a 15-second product film, a set
of shop pictures, a launch video for an app): its inputs, stages, checks and price per tier. The tools:
`get_started { locale, request? }`, `get_template { id, given?, canvasId?, version? }` (the recipe, what is
still missing, each tier's plan and price, the protocol), `open_templates { category?, query? }` → `url`,
`handoffUrl`, `taskId`, `browse_templates { category?, query?, kind? }`, `quote_plan`, `open_budget`, and the
user's brand: `brand`, `save_brand`. `get_template` gives its `protocol`; follow it step by step. In short:

1. **They said what to make** (their first message, or the task carried over from installing Flowith):
   `get_started { locale, request: <their words> }` answers with every template their account can run.
   Choose the one whose `useWhen` fits (none of its `avoidWhen`) and go straight to it; don't offer a list.
   If none fits, say so in a line and offer the closest one or two. **They said nothing yet**: offer
   `get_started`'s three starters by number and title (covers in chat; motion only in the gallery). To
   see them all, `open_templates`, open it as below, say one line ("pick one and I'll make it"), and wait
   for the pick as below. A pick only drafts it: confirm before anything is made.
2. **Ask once for what's missing.** Read `brand` first: its name, logo and colours count as given. Then
   `get_template { id, given }` with everything the user already said or gave in the gallery, and ask in
   one message only for what `missing.ask` lists (with its limits) and for consent where `missing.confirm`
   names a photo of a real person. Never ask twice.
3. **One price, one yes.** On a new canvas (`create_canvas`, then `open_canvas`, opened as below),
   `quote_plan` with the template's plan. Tell the user its total in one line, every stage in it (the
   ones priced on the canvas too), and ask once; never leave a stage's price for later. On their yes,
   `open_budget` with that total and pass its `budgetId` to every paid call: what fits runs without asking
   again. Short of credits: it hands back a top-up page; open it as below and wait for it as below.
4. **Make it, check it, hand it over.** Run the stages in order (a stage with a gate: show it and wait for
   their ok). Run every check and fix a failed shot alone. Export the finished piece and **save the files
   on the user's computer** with your own tools, named after the piece: in the project you're working in
   (a `marketing/` folder unless they name one), else their Downloads folder. Say each path, what it
   spent and the canvas link (the editable project stays there).
5. **Changes after.** Words (subtitles, titles) are edited on the cut, never regenerated, and cost
   nothing. Another shape or length (a 16:9 of a 9:16 film): don't assume a method. Look at the cut
   (`timeline_action` preview) and decide shot by shot: crop when the subject stays whole, extend or make
   it again at the new shape when it would not. Say which and why in a line, price what costs and ask once.
6. **Their brand.** When they give a brand (name, logo, colours) and want it remembered, `save_brand`
   (the logo as a Flowith file: `import_media` it, then its `url`). It is on their Flowith account: every
   chat, every agent and the cut editor have it after.

**Opening a page** (the gallery, a canvas, a top-up): with a side browser beside you, open its `handoffUrl`
there (the narrow side-tab layout; it signs that browser in). With none (Claude Code in a terminal), open
its `url` in the user's own browser; never `handoffUrl` there.

**Waiting for the user** (a pick in the gallery, a payment on the top-up page): call
`get_task { taskId, waitSeconds: 50 }` again each time it answers `waiting`, until it answers `done`
(then go on) or `expired` (a pick lasts 30 minutes, a top-up an hour: then say so in a line). Don't stop to
ask them to tell you when they're done, and don't repeat your invitation: the page hands their pick or
payment back to you by itself.

A template whose `forYou.canRun` is false: say why before anything else (it needs a plan: `upgradeUrl`;
short of credits: how many, with `topUpUrl`).

## Steps that need the canvas open

Edits, layout, selection and some card tools run in the user's open canvas (that is where their undo
history lives). With no canvas open they answer `status: "needs_canvas"` with `url` and `handoffUrl`:
open `handoffUrl` yourself (the side browser, or in a terminal `open '<handoffUrl>'` on macOS,
`xdg-open` on Linux, `start` on Windows), wait a few seconds for it to load, and call the same tool again.
Don't ask the user to open it and report back. `status: "running"` with a `taskId`: wait with `get_task`.

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
- `status: "quoted"` with `quoteId` and `credits` (a paid canvas step: card tools, image and video actions,
  storyboard retries, director stage, characters, code runs): its price; nothing was made. Tell the user the
  price and run it only on their yes: call the same tool again with `confirm: { quoteId, credits }` (above
  their limit that answers `needs_approval`: send `approveCredits` too). A yes the user gave for this
  price earlier in the request counts.
- `status: "not_started"` with a `message` and `topUpUrl` (or `claimUrl`): their credits can't pay for it.
  Nothing was placed or charged. Tell the user in Flowith's words with the link; don't switch to a cheaper
  model unless they ask.

## Show the canvas while you work

When creating, editing or reviewing cards in a desktop agent with a browser beside the chat (Codex's
in-app browser, Antigravity's, Cursor's, Claude's browser pane), open the exact canvas there before
making changes. In a terminal with no browser of its own (Claude Code, the Codex CLI), open it in the
user's own browser once there is something to look at: `open '<handoffUrl>'` on macOS, `xdg-open` on
Linux, `start` on Windows. Skip it for list, account, model or price lookups, or when the user wants
headless work.

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
