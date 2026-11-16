// Vendored from hypergpt-frontend src/features/video-studio/reference-names.ts (feat/super-creator, 2026-11-16),
// the one place that says how each model's request names the pictures, clips and sounds sent with it.
// The Creator Agent mirrors the same file; keep this copy in step with it.
/**
 * How a request names the pictures, clips and sounds sent with it: the one place for every model's names, used by the
 * composer, the storyboard and (mirrored) the Creator Agent (creater-agent apps/agent/src/media-rules/reference-names.ts,
 * checked by its media-rules parity test against scripts/export-media-rules-fixtures.ts).
 * - Seedance: 图片1, 视频1, 音频1, the rule form of BytePlus's / Volcengine's Chinese prompt guides ("提示词中可使用图片1、
 *   图片2……进行准确指代"), in the language its requests are written in (prompt-compile).
 * - MiniMax H3: <Picture 1>, <Video 1>, <Audio 1>, the tags H3-Base was trained on (MiniMax's H3 deploy guide: "refer to
 *   inputs in connection order with tags such as <Picture 1>, <Video 1>, and <Audio 1>"); AtlasCloud passes the prompt
 *   as-is unless its Context-IR rewriter (prompt_expansion) is on, which we don't use.
 * - Gemini Omni: <IMAGE_REF_0>, from 0, as fal (our route to it) documents; Google marks these tags for retirement in
 *   future models.
 * - Image models: by place, in the request's language: 图1 / image 1.
 * Each kind is numbered on its own from 1, in send order.
 * People and agents also write their own spellings (@Image1, @图片1, Image1; BytePlus's guides and the canvas's model
 * tips use them). The binding lines use the names above, so every spelling that can only mean a sent item is given the
 * model's name: one request never calls the same picture two ways. Words in prose ("图片1", "Image 1", "视频5秒",
 * "image 16:9") are left as written: they may be amounts, ratios or ordinary words, and models read them either way.
 */

export type MediaKind = "image" | "video" | "audio"
export type MediaNamer = (kind: MediaKind, index: number) => string

const SEEDANCE_KIND_WORDS: Record<MediaKind, string> = { image: "图片", video: "视频", audio: "音频" }
export const seedanceReferenceName: MediaNamer = (kind, index) => `${SEEDANCE_KIND_WORDS[kind]}${index}`
const H3_KIND_WORDS: Record<MediaKind, string> = { image: "Picture", video: "Video", audio: "Audio" }
export const minimaxH3ReferenceName: MediaNamer = (kind, index) => `<${H3_KIND_WORDS[kind]} ${index}>`
export const geminiOmniReferenceName: MediaNamer = (kind, index) => `<${kind.toUpperCase()}_REF_${index - 1}>`
/** Kling numbers keyframes first, then references of the same kind. Elements/voices have their own explicit slots. */
export const klingReferenceName: MediaNamer = (kind, index) => `@${kind}_${index}`
/** An image model's pictures, by place in the request's language. */
export const imageReferenceNameFor = (language: "zh" | "en"): MediaNamer => (_kind, index) =>
  language === "zh" ? `图${index}` : `image ${index}`

const KIND_OF: Record<string, MediaKind> = {
  image: "image", picture: "image", video: "video", audio: "audio",
  图片: "image", 图像: "image", 图: "image", 视频: "video", 音频: "audio",
}
const kindOf = (word: string) => KIND_OF[word.toLowerCase()]!

// A number glued to one of these is an amount or a ratio, not a name ("@视频5秒", "video9:16", "image4k").
const NOT_A_NAME = String.raw`(?!\d|\.\d|\s*[:：/×*]\s*\d|[秒张个帧%]|(?:s|k|p|fps)(?![A-Za-z]))`
const LATIN_EDGE = "(?<![A-Za-z0-9_])"
// Nor is a file name ("image1.png").
const LATIN_END = String.raw`(?![A-Za-z0-9_]|\.[A-Za-z0-9])`

/** The spellings that can only mean a sent item; each captures the kind word and the number. */
const SPELLINGS: readonly RegExp[] = [
  // <Image_1>, <video 2> (BytePlus's templates), <Picture 1> (MiniMax's): the brackets go with it
  new RegExp(String.raw`<\s?(image|picture|video|audio)[\s_]?(\d{1,2})\s?>`, "giu"),
  // @Image1, @image 1, @Image_1, @图片1, @图片 1, @视频1, @音频 1, @图1
  new RegExp(String.raw`@\s?(image|video|audio|图片|图像|图|视频|音频)[\s_]?(\d{1,2})${NOT_A_NAME}`, "giu"),
  // Image1, IMAGE1, image_1
  new RegExp(String.raw`${LATIN_EDGE}(image|video|audio)_?(\d{1,2})${NOT_A_NAME}${LATIN_END}`, "giu"),
]

const HAN_OR_WORD = /[\p{Script=Han}A-Za-z0-9]/u
// Links and paths are left as written ("https://…/image1.png", "./refs/video1.mp4"); a file name is left by LATIN_END.
const LINK = /\b(?:https?|data|blob):[!-~]+|(?<=^|[\s("'])\.{0,2}\/[\w.-]+(?:\/[\w.-]+)*/giu

export type NamedReference = { kind: MediaKind; index: number; name: string }

/**
 * The words with every spelling of a sent item rewritten to the model's name, and the items they name in order. A
 * Latin name next to Chinese gets a space each side, as the composer puts its tokens. Only kinds the model names are
 * touched (an image model's "video 1" stays as written).
 */
export const nameMediaReferences = (
  text: string,
  nameOf: MediaNamer,
  kinds: readonly MediaKind[] = ["image", "video", "audio"],
): { text: string; references: NamedReference[] } => {
  type Hit = { start: number; end: number; kind: MediaKind; index: number }
  const links = Array.from(text.matchAll(LINK), match => ({ start: match.index!, end: match.index! + match[0].length }))
  const hits: Hit[] = []
  for (const pattern of SPELLINGS) {
    for (const match of text.matchAll(pattern)) {
      const kind = kindOf(match[1]!)
      if (!kinds.includes(kind)) continue
      const start = match.index!
      const end = start + match[0].length
      if ([...hits, ...links].some(span => start < span.end && end > span.start)) continue
      hits.push({ start, end, kind, index: Number(match[2]) })
    }
  }
  hits.sort((a, b) => a.start - b.start)
  let out = ""
  let at = 0
  const references: NamedReference[] = []
  for (const hit of hits) {
    const name = nameOf(hit.kind, hit.index)
    const before = text.slice(at, hit.start)
    const latin = /^[A-Za-z<]/.test(name)
    const padBefore = latin && HAN_OR_WORD.test(before.slice(-1) || out.slice(-1)) && !/\s$/.test(before) ? " " : ""
    const next = text.charAt(hit.end)
    const padAfter = latin && next && HAN_OR_WORD.test(next) ? " " : ""
    out += `${before}${padBefore}${name}${padAfter}`
    at = hit.end
    references.push({ kind: hit.kind, index: hit.index, name })
  }
  return { text: out + text.slice(at), references }
}
