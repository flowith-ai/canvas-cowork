# Which model for what

The live list is the canvas's own catalogue (the same one its model picker shows): the generation tools'
descriptions name the models they take, and the CLI's `cw models [image|video|text|audio]` lists
ratios, sizes, durations, reference limits and approximate credits (`cw models <id>` for one model's full
limits). Every value you pass is checked against it, and a wrong one answers with the allowed list.
Prices below are what the canvas actually charged in tests, in credits (1 credit = $0.001), 2026-11;
`credits` (`cw spent`) shows yours. "advanced" models (tier t1) need paid credits; free / trial credits cover only
the others.

When you name no model, a card starts on the canvas's own default: **Seedream 5.5** for pictures,
**Seedance 2.5 Flash** for clips, **Gemini 3.8 Flash** for text. Name a model by its id; the display name also works (CLI:
`--model "Nano Banana 2"`).

## Pictures

| Job | Model | Why |
|---|---|---|
| Default; edits, lettering, transparent stickers | `dola-seedream-5-5-261028` (Seedream 5.5, ~21 at its default 2K) | Cheapest at 2K, best at step-by-step edits without blur, renders quoted text verbatim, native transparency (`--transparent`), ≤ 10 refs |
| Hero shots, posters, complex composition | `gpt-image-2.6-flare` (~20 at 1K low) | Strong layout and typography, ≤ 16 refs. Billed by quality × area: the CLI sends `low` at 1K unless you ask; `--quality high --size 2K` is ~170, `max` at 2K ~700 — ask first |
| Photoreal people, product fidelity | `gemini-3-pro-image` (Nano Banana Pro, ~80) / `gemini-3.1-flash-image` (Nano Banana 2, ~45) | Skin and materials; extreme ratios (1:4, 8:1) |
| Many cheap drafts | `gpt-image-2.5-flare` (~6 at 1K low) · `z-image-turbo` (~5) | Exploration before the final |

## Clips

| Job | Model | Notes |
|---|---|---|
| Default, best overall | `seedance-2.5-flash` (~400 / 5 s at 720p) | Sound on by default; first+last frame; up to 10 image / 5 video / 5 audio refs; 4–30 s; extend & edit |
| Top quality, 1080p, long takes, drafts | `seedance-2.5` (~620 / 5 s) | Up to 30 image refs; `--draft` = cheap 480p preview |
| Frame **and** references together, multi-shot | `kling-video/v4` (~1,000 / 5 s at 1080p) | The only model taking `--first` plus `--ref`; always makes its own sound (no `--no-audio`) |
| Very cheap tests, image → clip | `muse-video` (~15 / 5 s) | 720p, 2–10 s, ≤ 9 image refs, sound always on; can take several minutes |
| Extend / edit a clip, 4K | `gemini-omni-1.2-flash` (~450 / 5 s at 720p, ~120 / 4 s at 360p) | `--extend` returns source + new seconds; 16:9 / 9:16 only |
| Text-only cinematic | `wan/v3/text-to-video`, `minimax-h3-text-to-video` | Expensive; ask first |

Seedance extend returns only the new seconds (place it after the source); Omni extend returns the whole
longer clip. Frames (`--first/--last`) and `--ref` can't be mixed except on Kling 4.0.

## Text (cards on the canvas)

Any of `cw models text` — Claude, GPT, Gemini, DeepSeek, Kimi, Grok, MiniMax. Without `--model`, text
cards use `gemini-3.8-flash` (fast, cheap, every plan's credits cover it); name a flagship
(`claude-opus-5-5`, `gpt-6.1-sol`, `gemini-4-argon`) when the writing matters. For "compare N models"
use `cw text "…" --model a,b,c`: one card per model, one group, each card titled with its model.

## Sound

| Job | Model | Notes |
|---|---|---|
| Expressive voice-over | `elevenlabs-v3` (100 / 1k chars) | Default voice is multilingual Bella; `--language zh` for Mandarin |
| Natural Mandarin narration | `minimax-speech-2.8-hd`, `qwen-audio-3.1-tts-plus` | |
| Voice with style instructions in the text | `gemini-3.1-flash-tts` | voices: Kore, Puck, Aoede, Charon, Zephyr |
| Songs / BGM | `suno-chirp-v6` (~132 / song) | `--duration` is reliable only with `--lyrics`; instrumentals vary in length |
| Songs where lyrics set the length | `minimax-music-3.0` | No duration control |

## Card tools

| Tool | Runs on | Notes |
|---|---|---|
| `upscale` picture | SeedVR2 | `--to 2k|4k|8k` (must be larger than the source) |
| `upscale` clip | ByteDance (fast) / Topaz Starlight (`--quality best`) | `--to 2k` (1440p) or `4k` (2160p) |
| `cutout` | Bria RMBG (pictures), video matting (clips) | Result is a transparent PNG / clip; viewers may still show the hidden colour |
| `expand` | FLUX outpaint | Keeps the whole picture, paints only the new margins |
