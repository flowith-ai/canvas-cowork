# Workflows

`cw` = `bun scripts/index.ts`. Each recipe ends the same way: `cw shots` the results, look at them, fix
what misses, then tell the user what is on the canvas (refs + url).

## A short film: idea → shots → frames → clips

1. Write the plan as a card so the user can follow and edit it:
   `cw note "$(cat plan.md)" --title "分镜"` (one line per shot: what we see, camera, sound, seconds).
2. Fix the look once: make the hero frame or character sheet first and judge it.
   `cw image "…hero frame…" --ratio 16:9 --title "主角定妆"`
3. All frames in one call, each naming the hero as a reference, as one group:
   `cw image "镜头1：…" "镜头2：…" "镜头3：…" --ref <hero> --ratio 16:9 --group "分镜画面"`
4. Review the frames (`cw shots`), redo the weak ones with `cw edit <ref> "…"`.
5. One clip per frame, beside its frame (background / long timeout):
   `cw video "镜头1 的动作和声音…" --first <frame1> --duration 5 --title "镜头1"` …
   Test on `--model muse-video` or `--draft` (Seedance 2.5, 480p) first when the user is price-sensitive.
6. Continue a shot: `cw video "接着…" --extend <clip>`. Voice-over / music for the cut:
   `cw speech "旁白…" --for <clip>` · `cw music "warm acoustic, 90 bpm" --for <clip> --duration 30`.
7. Put the clips in order: `cw group <clip refs…> --name "成片"` then `cw arrange <group>`.

## Product shots for every channel

1. `cw add product.png --title "产品原图"` (or use the user's card).
2. Scenes from the product, product kept exact:
   `cw image "@image1 放在大理石台面上，晨光，留白在左侧" "@image1 被一只手拿着，户外逆光" --ref <product> --group "产品场景"`
3. Formats: `cw expand <ref> --ratio 9:16`, `--ratio 4:5`, `--ratio 16:9`.
4. Cut-out for the store: `cw cutout <ref>`; sharper print: `cw upscale <ref> --to 4k`.
5. A 5-second product clip: `cw video "镜头缓慢环绕 @image1，柔和反光" --ref <best scene> --duration 5`.

## The same character everywhere

1. Reference sheet: `cw image "角色设定：同一个女孩的正面、侧面、背面全身，白底" --ratio 16:9 --title "角色设定"`.
2. Every later picture or clip passes it: `--ref <sheet>` and says "same girl as @image1".
3. For clips with dialogue keep one speaker per shot and quote the line.

## Compare models

- Pictures: `cw image "…" --model dola-seedream-5-5-261028,gpt-image-2.6-flare,gemini-3-pro-image --title "对比"`
  — one card per model in one group, each titled with its model.
- Text: `cw text "…" --model claude-opus-5-5,gpt-6.1-sol,gemini-4-argon` — one card per model.
- Clips: run one `cw video … --model X` per model with the same prompt and `--into <group>`; ask first,
  video comparisons are expensive.

## Tidy a canvas

1. `cw look` — read groups, loose cards and their links.
2. Decide groups by meaning (characters, scenes, drafts, finals), then
   `cw group <refs…> --name "…"` per set; `cw arrange <group>` lays a group out on Flo's grid.
3. Line up loose cards: `cw arrange <refs…> --as row|column|grid` (the block moves to free space if it
   would cover something). Place one card exactly: `cw move <ref> --right-of <other>`.
4. Rename unclear cards (`cw rename <ref> "…"`); link sources the canvas doesn't show yet
   (`cw link <source> <result>`). Delete only what the user agreed to.

## Work with what the user already has

- "Make this into a video" with a card selected on screen: ask for or `look` up the ref, then
  `cw video "…" --first <ref>`.
- "Use the logo from my desktop": `cw add ~/Desktop/logo.png` then pass its ref, or `--ref ~/Desktop/logo.png`.
- "Download everything": `cw save <refs…> --out ./export/`.
