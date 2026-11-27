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

