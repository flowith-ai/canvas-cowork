# Flowith canvas API — raw HTTP recipes

Everything the CLI's direct mode does is plain HTTP against the two backends
the Flowith web app uses. Use this when you can't run `bun` (or want to call
the API from another language). Field names are exactly what the frontend
sends.

## Auth

You need the user's Supabase session. Get it from `~/.flowith/bot-session.json`
after `bun scripts/index.ts --bot <id> login` (fields: `supabaseUrl`,
`supabaseKey`, `accessToken`, optional `refreshToken`, `workerURL`).

| Backend | Base | Headers |
|---|---|---|
| Edge worker | `https://edge.flowith.io` (`workerURL`) | `Authorization: <accessToken>` — raw JWT, **no** `Bearer` |
| Supabase PostgREST | `<supabaseUrl>/rest/v1/` | `apikey: <supabaseKey>`, `Authorization: Bearer <accessToken>` |

Refresh (only when the handshake gave you a `refreshToken`):

```bash
curl -s "$SUPABASE_URL/auth/v1/token?grant_type=refresh_token" \
  -H "apikey: $SUPABASE_KEY" -H 'Content-Type: application/json' \
  -d "{\"refresh_token\":\"$REFRESH_TOKEN\"}"
# → { access_token, refresh_token, expires_at, ... }  (the old refresh token is now invalid)
```

## Models (public, no auth)

```bash
curl -s 'https://edge.flowith.io/models?logo=1&desc=1' | jq '."seedance-2.5"'
```

Per model: `media` (text|image|video), `tier`, `supportedAspectRatios`,
`supportedImageSizes`, `sizeMatrix` (gpt-image-2 family), `supportedDurations`
(strings; `"-1"` = auto), `supportedResolutions`, `supportsAudio`,
`supportedKeyframe`, `supportsDraft`, `referenceAssetLimits`,
`maxReferenceImages`, `estimatedPricePer5s` / `estimatedPrice` (credits).

## Upload

```bash
curl -s https://edge.flowith.io/file/store -H "Authorization: $TOKEN" \
  -F file=@clip.mp4 -F type=mp4 -F conv_id=$CONV
# → {"url":"https://r2-bucket.flowith.net/f/.../clip.mp4"}
```

`type` is `image` for images, otherwise the file extension (`mp4`, `wav`, `pdf`).
Limits the app enforces: video 100 MB, others 30 MB.

## Canvas + nodes (PostgREST)

A canvas is a `conversation` row; nodes are `flow_node` rows linked by `p_id`
(the root question's `p_id` is the canvas id).

```bash
# create a canvas
curl -s "$SUPABASE_URL/rest/v1/conversation" -H "apikey: $SUPABASE_KEY" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -H 'Prefer: return=representation' \
  -d "{\"id\":\"$CONV\",\"title\":\"[Bot] API test\",\"is_absolute_mode\":true,\"user_id\":\"$USER_ID\"}"

# list nodes
curl -s "$SUPABASE_URL/rest/v1/flow_node?conv_id=eq.$CONV&is_delete=not.is.true&select=id,type,p_id,data,position&order=created_at.asc" \
  -H "apikey: $SUPABASE_KEY" -H "Authorization: Bearer $TOKEN"
```

Node types: `"1"` question, `"2"` response (images), `"13"` video, `"22"`
no-credits, `"25"` model-locked. Generation nodes carry
`data.status`: `init` → `running` → `finished` | `failed`.

## Generate an image

1. Insert the question node and the response node (status `init`):

```json
[
 {"id":"<Q>","conv_id":"<CONV>","p_id":"<CONV or parent node>","c_ids":[],"type":"1",
  "position":{"x":0,"y":0},
  "data":{"timestamp":"<unix s>","value":"a golden retriever"}},
 {"id":"<N>","conv_id":"<CONV>","p_id":"<Q>","c_ids":[],"type":"2",
  "position":{"x":0,"y":130},
  "data":{"title":"AI","value":"","mode":"image_generation","isImage":true,"status":"init",
          "timestamp":"<unix s>","model":"gemini-3.1-flash-image","aspect_ratio":"1:1","ratio":"1:1"}}
]
```

`POST $SUPABASE_URL/rest/v1/flow_node` with `Prefer: resolution=merge-duplicates`.

2. Fire the generation:

```bash
curl -s https://edge.flowith.io/image_gen/async -H "Authorization: $TOKEN" \
  -H 'Content-Type: application/json' -d '{
  "target_feature":"image_generation",
  "model":"gemini-3.1-flash-image",
  "nodeId":"<N>", "convId":"<CONV>",
  "messages":[{"role":"user","content":"a golden retriever"}],
  "aspect_ratio":"1:1",            // from supportedAspectRatios
  "image_size":"2k",               // from supportedImageSizes (omit for gpt-image-2)
  "styleUrls":["https://.../ref.png"]   // optional reference images
}'
```

gpt-image-2 family: send the pixel string from `sizeMatrix.sizes[ratio][tier]`
as `aspect_ratio` (e.g. `"2048x1152"`) and no `image_size`.

3. Poll `flow_node?id=eq.<N>&select=type,data` until `data.status` is
`finished` (`data.value` = image URL) or `failed`.

## Generate a video

Same two inserts, response node `type:"13"`:

```json
{"id":"<N>","conv_id":"<CONV>","p_id":"<Q>","c_ids":[],"type":"13","position":{"x":0,"y":130},
 "data":{"title":"AI","value":"","timestamp":"<unix s>","model":"seedance-2.0-fast",
         "mode":"image_generation","status":"init","draft":false,"duration":"5","audio":true,
         "fileList":[],"ratio":"16:9","aspect_ratio":"16:9","resolution":"720p","aspectRatio":1.7778}}
```

```bash
curl -s https://edge.flowith.io/video/async -H "Authorization: $TOKEN" \
  -H 'Content-Type: application/json' -d '{
  "target_feature":"video_generation",
  "nodeId":"<N>", "convId":"<CONV>", "parentNodeId":"<Q>",
  "position":{"x":0,"y":130},
  "model":"seedance-2.0-fast",
  "prompt":"a red sports car on a coastal road at sunset",
  "aspect_ratio":"16:9",           // supportedAspectRatios
  "duration":"5",                  // supportedDurations (string)
  "resolution":"720p",             // supportedResolutions
  "audio":true,
  "imageURL":"https://.../start.png",          // optional start frame
  "keyFrames":["https://.../start.png","https://.../end.png"],  // optional, both frames
  "image_urls":[], "video_urls":[], "audio_urls":[],           // Seedance 2.x references
  "draft":false
}'
```

Seedance 2.x references: put URLs in `image_urls` / `video_urls` / `audio_urls`
and refer to them in the prompt as `image1`, `video1`, `audio1` (1-based per
type). Frames and references are mutually exclusive. Limits come from
`referenceAssetLimits`.

Poll the node: `data.status === "finished"` → `data.videoId` (and `data.value`)
is the mp4 URL. On failure `data.error`, `data.error_type`, `data.error_code`,
`data.refund_amount` are set.

## Generate text

Same two inserts, response node `type:"2"` with `mode:"General"`:

```json
{"id":"<N>","conv_id":"<CONV>","p_id":"<Q>","c_ids":[],"type":"2","position":{"x":0,"y":130},
 "data":{"title":"AI","value":"","mode":"General","isImage":false,"status":"init",
         "timestamp":"<unix s>","model":"claude-opus-5-5"}}
```

```bash
curl -s 'https://edge.flowith.io/completion/async?mode=general' -H "Authorization: $TOKEN" \
  -H 'Content-Type: application/json' -d '{
  "target_feature":"text_completion",
  "model":"claude-opus-5-5",
  "nodeId":"<N>", "convId":"<CONV>",
  "messages":[
    {"role":"system","content":"Be brief."},            // optional
    {"role":"user","content":"earlier question"},        // thread history, oldest first
    {"role":"assistant","content":"earlier answer"},
    {"role":"user","content":"the new prompt"}
  ]
}'
# → {"nodeId":"<N>","convId":"<CONV>","status":"processing"}
```

Poll the node: `data.status` goes `running` → `finished`; `data.value` is the answer
(markdown), `data.reasoning` the model's thinking when it exposes it. Text models are
the catalogue entries with `media:"text"` (Claude, GPT, Gemini, DeepSeek, Kimi, …).

## Credits

```bash
curl -s https://edge.flowith.io/user/credits -H "Authorization: $TOKEN"
# → [{ remain_quota, init_quota, sub_type, to_date, ... }]
```

## Errors

| HTTP | Body | Meaning |
|---|---|---|
| 401 | – | token expired / not logged in |
| 402 | `"expired"` \| `"daily_limited"` \| `{reason, model, modelTier, ...}` | no credits (`reason:"is_free_user"` + `modelTier:"t1"` = model locked for free plan) |
| 403 | `{error, reason}` | forbidden |
| 429 | `{reason, limit, resetTime, retryAfterSeconds}` | rate limited |
| 500 | `{error, error_type:"content_policy", error_code:"invalid_input"}` | reference media / settings rejected |

## Other endpoints the CLI uses

- `POST /bookshelf/search {query, limit, filters:{types?,convId?}}` — memory recall
- `POST /bookshelf/get {pattern:"conv/node", convId, nodeId}` — one entry (404 = none)
- `POST /user/d-nodes {ids, conv_id}` — delete nodes
