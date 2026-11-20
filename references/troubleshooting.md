# Troubleshooting

Errors print one JSON line `{"error": CODE, "message": …}` and exit 1.

| Code | Meaning | What to do |
|---|---|---|
| `NOT_LOGGED_IN` | No session, it expired and couldn't renew, or it was ended (Disconnect in Flowith, `logout`) | `cw login` (the user types the code and clicks Allow in the browser) |
| `LOGIN_TIMEOUT` | Nobody allowed the connection within 2.5 minutes | Run `login` again; the user opens the link, types the printed code and clicks Allow |
| `LOGIN_UNAVAILABLE` | Neither the Realtime relay nor the local connection is available | Check network access to Flowith Realtime, then run `login` again |
| `CANVAS_NOT_OPEN` | No browser acknowledged the operation | Open the reported canvas in the browser that approved `login`. Inspect the canvas before resending an operation that could create cards or spend credits |
| `REALTIME_UNAVAILABLE` | The CLI could not connect to the browser's relay | Check network access to Flowith Realtime. `cw look` and other direct commands can still work |
| `CANVAS_ERROR` | The canvas refused the operation (wrong card kind, still generating…) | Read the message; `cw look` |
| `CANVAS_SITE_MISMATCH` | A canvas URL belongs to a different site than the active sign-in | Use the session for that site, for example with its own `FLOWITH_HOME` |
| `LOGIN_DENIED` | The user clicked Deny | Ask before trying again |
| `NO_CANVAS` | No canvas chosen | `cw use <ref|title|url>` or `cw new "title"` (generation commands create one when none is active) |
| `NOT_FOUND` / `AMBIGUOUS` | A card or canvas ref didn't match exactly one | `cw look` / `cw canvases` and use the 8-hex ref |
| `INVALID_PARAM` | A value the model doesn't offer (ratio, size, duration, frames + refs…) | The message lists what is allowed; `cw models <id>` |
| `INVALID_MODEL` | Not a model of that kind | `cw models image|video|text|audio` |
| `NO_CREDITS` | Not enough credits, or the plan's credits don't cover that model tier | Tell the user (https://flowith.io/pricing); don't switch models silently |
| `MODEL_LOCKED` | The model needs a higher plan | Tell the user; offer a standard model |
| `RATE_LIMITED` | Too many requests | Wait a minute; batch prompts in one call |
| `GENERATION_FAILED` / `CONTENT_POLICY` / `INVALID_INPUT` | The provider refused or failed (credits are refunded) | The card's `error` says why (`cw read <ref>`). Transient ("Workflow delivery failed", timeouts): `cw retry <ref>`. Refusals: rephrase, another reference, or another model |
| `TIMEOUT` | The browser acknowledged the command and the result did not arrive in time | Inspect the reported canvas and use `cw wait <ref>` for any result cards it created before considering a retry |
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
  session (default https://flowith.io; `FLOWITH_URL` can select the site per shell).
- Session and caches live in `~/.flowith/` (`canvas-session.json`, mode 600, holds the login token —
  never print or share it). The CLI gets a sign-in of its own (it never shares the browser's), so it can
  renew itself without signing the browser out. `logout` ends that sign-in and forgets it here;
  on sites with the Disconnect update, the page can end it too. New commands check Auth with a
  two-minute cache; running commands do not periodically check. Existing access tokens may still
  work until expiry (up to one hour), and accepted generations are not cancelled. Beta includes the
  Disconnect update from hypergpt-frontend #753. If you logged in before that update, use CLI `logout`
  and `login` again so the page can track and end the independent sign-in.
- **Retry says the card changed**: another client edited, deleted or claimed it after it was read.
  Run `look` again. Updated CLIs coordinate retries through a conditional database claim; the page's
  Retry button and older CLIs do not, so avoid retrying the same card from both at once.
