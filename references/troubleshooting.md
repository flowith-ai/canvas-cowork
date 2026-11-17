# Troubleshooting

Errors print one JSON line `{"error": CODE, "message": …}` and exit 1.

| Code | Meaning | What to do |
|---|---|---|
| `NOT_LOGGED_IN` | No session, it expired and couldn't renew, or it was ended (Disconnect in Flowith, `logout`) | `cw login` (the user types the code and clicks Allow in the browser) |
| `LOGIN_TIMEOUT` | Nobody allowed the connection within 2.5 minutes | Run `login` again; the user opens the link, types the printed code and clicks Allow |
| `CANVAS_NOT_OPEN` | A "run by the open canvas" command found no window with that canvas | `cw open`, in the browser where `login` was allowed (each browser that allowed the agent holds its key); then run it again |
| `CANVAS_ERROR` | The canvas refused the operation (wrong card kind, still generating…) | Read the message; `cw look` |
| `LOGIN_DENIED` | The user clicked Deny | Ask before trying again |
| `NO_CANVAS` | No canvas chosen | `cw use <ref|title|url>` or `cw new "title"` (generation commands create one when none is active) |
| `NOT_FOUND` / `AMBIGUOUS` | A card or canvas ref didn't match exactly one | `cw look` / `cw canvases` and use the 8-hex ref |
| `INVALID_PARAM` | A value the model doesn't offer (ratio, size, duration, frames + refs…) | The message lists what is allowed; `cw models <id>` |
| `INVALID_MODEL` | Not a model of that kind | `cw models image|video|text|audio` |
| `NO_CREDITS` | Not enough credits, or the plan's credits don't cover that model tier | Tell the user (https://flowith.io/pricing); don't switch models silently |
| `MODEL_LOCKED` | The model needs a higher plan | Tell the user; offer a standard model |
| `RATE_LIMITED` | Too many requests | Wait a minute; batch prompts in one call |
| `GENERATION_FAILED` / `CONTENT_POLICY` / `INVALID_INPUT` | The provider refused or failed (credits are refunded) | The card's `error` says why (`cw read <ref>`). Transient ("Workflow delivery failed", timeouts): `cw retry <ref>`. Refusals: rephrase, another reference, or another model |
| `TIMEOUT` | The command stopped waiting | The work continues on the server: `cw wait <ref>` |
| `SENT_UNKNOWN` (a card's `code`) | The request went out but no answer came back (network, gateway timeout): Flowith may have taken it | `cw wait <ref>`: it finishes if it was taken. `cw retry <ref>` sends it again only once the canvas's charges show it never arrived (it says when) |
| `BUSY` | The card is still generating (or its last send may still be on its way) | `cw wait <ref>`; don't send it again |
| `DRY_RUN` | Internal guard: a dry run was about to change something and stopped | Report it: a preview should never reach this |

Other things worth knowing:

- **A card shows "…" for a long time**: video providers queue; Muse Video can take 5–10 minutes. `cw wait`.
- **`shots`** downloads each card's preview when the canvas made one (clips: a frame), else the original
  picture; `--full` always downloads originals.
- **A cut-out looks like it still has a background**: transparent PNGs keep their colours under zero
  alpha and some viewers draw them; on the canvas it is transparent.
- **The user doesn't see new cards**: they appear live in an open canvas tab of the same account; ask
  the user to open `cw open` (or the `url` in any result). Cards placed far away are brought into view.
- **Several machines / accounts**: `FLOWITH_HOME=/path` keeps a separate session. `login --site <host>`
  (e.g. `next-gen.flowith.io`) signs in to another Flowith site and every later command follows that
  session (default https://beta.flowith.io while 3.0 is in beta; `FLOWITH_URL` does the same per shell).
- Session and caches live in `~/.flowith/` (`canvas-session.json`, mode 600, holds the login token —
  never print or share it). The CLI gets a sign-in of its own (it never shares the browser's), so it can
  renew itself without signing the browser out. `logout` ends that sign-in and forgets it here;
  "Disconnect" in Flowith ends it too (operations stop at once; Supabase drops the sign-in, so the next
  command says `NOT_LOGGED_IN`).
