# Prompting on the canvas

The canvas sends your words as written. How references are named is the one mechanical part: with Flowith's
MCP tools, follow each tool's description; the CLI rewrites `@image1`-style names to each model's own naming
and names unnamed references at the end, so every item sent is named once. Everything else, the craft, is
yours. Commands below are the CLI's (`cw`, see [cli](cli.md)); the hosted tools take the same prompts.

## References

- Number them per kind in `--ref` order: `@image1`, `@image2`, `@video1`, `@audio1`. A `--ref` can be a
  card ref on the canvas, a local file (uploaded) or a URL.
- What each becomes: Seedance / Muse `图片1 视频1 音频1` · Kling 4.0 `@image_1` (its first/last frames
  count first) · Gemini Omni `<IMAGE_REF_0>` · MiniMax H3 `<Picture 1>` · picture models `图1` / `image 1`
  (Chinese prompt → 图N).
- Say each reference's job: "the woman from @image1 wears the jacket from @image2, in the lighting of
  @image3". Unexplained references dilute the result.
- Cards you pass as `--ref`, `--first` or `--extend` are linked on the canvas (a line from the source).

## Pictures

- Lead with subject and action, then setting, light, lens/medium, mood. Specific beats adjectives.
- **Edits** (`cw edit <ref> "…"`): only the delta plus what must stay — "Change the jacket to red
  leather; keep her face, pose, background and framing." One change per round; chain from the newest
  accepted card. For a re-framing ("close-up of her hands") don't add a keep-line, it blocks the change.
- **Lettering**: exact words in quotes — `招牌写着「橘猫咖啡」` / `a sign reading "ORANGE CAT CAFE"`.
  Seedream 5.5 and GPT Image 2.6 render it verbatim; keep it short.
- **Stickers / cut-outs**: `--transparent` on Seedream 5.5 (keeps glass, steam and hair), or `cw cutout`
  on an existing picture.
- **Consistency across a set**: make one hero picture first, then pass it as `--ref` to every other shot
  ("same girl as @image1, same outfit"). For a character used across many shots, keep a front + side
  reference sheet card and always pass it.

## Clips

- Structure: subject + action over time, camera move, setting, light, sound. One shot per clip unless the
  model handles multi-shot (Seedance 2.5, Kling 4.0): "Shot 1: … Shot 2: …".
- **Camera**: name one move — slow push-in, dolly left, handheld follow, static wide, orbit.
- **Sound**: describe what is heard ("rain on the window, a kettle whistling, she says: 「我回来了」").
  Writing "no music" tends to add music; describing only diegetic sound keeps it quiet. Chinese prompts on
  Seedance respect 「不要背景音乐」.
- **Dialogue**: quote the exact line and the speaker; keep lines short enough for the duration.
- **Image → clip**: `--first <picture>` fixes the opening frame; describe the motion, not the picture.
  `--first` + `--last` interpolates between two pictures.
- **Continue a clip**: `cw video "what happens next" --extend <clip>` (Seedance: same continuous shot from
  the last frame; Omni: returns source + new seconds).
- Real people: Seedance refuses some realistic faces as references; use the canvas's character tools or
  stylised references if a request fails with a content error.

## Text cards

`cw text` sends your prompt plus the text of every `--ref` text card (and pictures as images) to each
model. Give the format you want ("three bullet points, under 60 characters each").
