# Troubleshooting

## Error Format

Errors are structured JSON on stdout (exit code 1):
```json
{"type":"error","actionId":null,"code":"NOT_LOGGED_IN","message":"...","data":{...}}
```
`data` carries the backend body when there is one (e.g. the failed node for `gen`).

## Error Codes

| Code | Meaning | What to do |
|---|---|---|
| `NO_CREDITS` | Account has no remaining credits (HTTP 402 / node type 22) | **Stop immediately. Do NOT retry or switch models.** Send the pricing link: https://flowith.io/pricing |
| `MODEL_LOCKED` | Model needs a paid plan (node type 25 / 402 `is_free_user`) | Tell the user; pick a model their plan allows |
| `NOT_LOGGED_IN` | Token expired or revoked and no refresh token | Re-run `login` (log in at the opened browser), then retry |
| `INVALID_PARAM` | A flag value isn't valid for the model | The message lists the allowed values; fix and retry |
| `INVALID_MODEL` | Unknown model id / wrong mode | `list-models <mode>`; `data.available` lists ids |
| `INVALID_INPUT` / `CONTENT_POLICY` | Backend rejected reference media or settings (HTTP 500 with `error_type:"content_policy"`) | Use real photos/clips (tiny synthetic images are rejected as Seedance references), audio at least as long as the clip, frames **or** refs not both |
| `GENERATION_FAILED` | The model failed; credits are refunded (`data.refund_amount`) | Simplify the prompt / change model; `clean-failed` to tidy |
| `RATE_LIMITED` | HTTP 429 | Wait `retryAfterSeconds` (in `data`), retry |
| `TIMEOUT` | `gen --wait` ran out | `read-db <nodeId>` later; the job keeps running server-side |
| `NO_CANVAS` | No active canvas for a node command | `create-canvas`, `switch <id>` or `--canvas <id>` |
| `BROWSER_NOT_CONNECTED` | Canvas-mode command, tab didn't respond | Ensure the Flowith tab is fully loaded, or use the direct command instead |
| `LOCKED` | Frontend rate limit (30 actions / 10 s) | Wait 2 s, retry |
| `INVALID_SESSION` | Session file corrupted | Delete `~/.flowith/bot-session.json`, re-run `login` |
| `Submit handler not available` | `submit` without a canvas page open | `create-canvas` or `switch <id>` first, or use `gen` |

## Session & tokens

- `status` shows `tokenExpiresAt`, `tokenExpired`, `canRefresh`.
- `canRefresh: true` means the frontend handed over a refresh token; direct
  commands refresh automatically when < 5 min remain. If a refresh is rejected
  (the browser tab rotated the token first) the CLI drops it and falls back to
  the browser handshake — just run `login`.
- `login` on macOS with Safari as the default browser: the handshake page is
  opened in Chrome/Arc/Edge/Brave instead (Safari blocks `ws://127.0.0.1`).
  If that browser isn't logged in to Flowith, log in there once.

## Generation notes

- Direct `gen` writes the question + response nodes itself, then the backend
  fills the result in. A tab open on that canvas shows them live via realtime.
- Draft mode (`--draft`, Seedance 2.5) always renders 480p.
- Video resolution is only honoured when the model lists `supportedResolutions`.
- `read-db <nodeId>` on a video node: `data.status`, `data.videoId` (URL),
  `data.resolution`, `data.refund_amount` on failure.

## Canvas mode

- `--wait` blocks the CLI; you cannot change the model mid-generation. Submit
  without `--wait`, then `read-db`.
- Batches: `batches` lists runs, `batches <id>` per-prompt status; items with a
  `questionNodeId` landed — only resubmit the others.
- Commands auto-retry up to 2 times on WebSocket failure, re-opening the browser.
