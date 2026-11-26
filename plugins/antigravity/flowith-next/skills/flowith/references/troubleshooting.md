# Troubleshooting

## Flowith's MCP tools

| What happens | What to do |
|---|---|
| The tools aren't there right after installing | A host loads a new server only in a new session or after a reload: Claude Code after the user types `/reload-plugins` (then sign in with the server's `authenticate` tool), Codex in a new thread (start it with `create_thread`), Antigravity / Cursor in a new conversation. Carry the user's task into it |
| Sign-in didn't happen, or the server says it isn't authorised | Sign in again the host's own way: Claude Code, the server's `authenticate` tool (or `/mcp` → Authenticate; `claude mcp login` can't finish from an agent's shell), Codex `codex mcp login flowith` (escalated), Cursor / Antigravity the server's Authenticate button. The user clicks **Allow** on flowith.io |
| It worked, then every call is refused | The user disconnected this agent in Flowith (Connections), or the sign-in expired: sign in again as above |
| `status: "needs_approval"` | Above the user's ask-above limit; nothing was placed. Ask the user with the price; on a yes, send the same call with `approveCredits: <credits>` |
| `status: "not_started"` | Their credits can't pay for it; nothing was placed or charged. Pass on the `message` with its `topUpUrl`; don't switch models silently |
| `get_task` keeps saying `generating` | Clips take 1 to 8 minutes: keep calling it (`waitSeconds: 50`). Don't send the generation again; it is running on Flowith |
| `get_task` says `failed` | Read its `message`: rephrase or pick another model for a refusal, top up for credits (`topUpUrl`) |
| The hosted server answers 404 | It isn't live for that site yet: use the CLI ([cli](cli.md)) |
| `handoffUrl` shows "link expired" | It works once, within `expiresIn` seconds: call `open_canvas` again |

## CLI errors

Errors print one JSON line `{"error": CODE, "message": …}` and exit 1.

| Code | Meaning | What to do |
|---|---|---|
| `NOT_LOGGED_IN` | No session, it expired and couldn't renew, or it was ended (Disconnect in Flowith, `logout`) | `cw login` (the user types the code and clicks Allow in the browser) |
| `LOGIN_TIMEOUT` | Nobody allowed the connection within 2.5 minutes | Run `login` again; the user opens the link, types the printed code and clicks Allow |
| `LOGIN_UNAVAILABLE` | Flowith's realtime service, which carries the sign-in back to the CLI, can't be reached | Check network access to Flowith Realtime (`*.supabase.co`), then run `login` again |
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
| `NOT_SENT` (a card's `code`) | A `retry` claimed the card but its request never went (the claim's answer was lost) | `cw retry <ref>` sends it; don't wait on it |
| `BUSY` | The card is still generating (or its last send may still be on its way), or another `retry` (on another machine) ran it first, or it changed while the command ran | `cw wait <ref>` or `cw look`; don't send it again |
| `DRY_RUN` | Internal guard: a dry run was about to change something and stopped | Report it: a preview should never reach this |

Other things worth knowing:

- **A card shows "…" for a long time**: video providers queue; Muse Video can take 5–10 minutes. `cw wait`.
- **`shots`** downloads each card's preview when the canvas made one (clips: a frame), else the original
  picture; `--full` always downloads originals.
- **A cut-out looks like it still has a background**: transparent PNGs keep their colours under zero
  alpha and some viewers draw them; on the canvas it is transparent.
- **The user doesn't see new cards**: they appear live in an open canvas tab of the same account. Reuse the tab
  if it is already open. See [Live browser](live-browser.md) for opening the result in the host and checking access.
- **Focus or selection is acknowledged and times out**: on older canvases a duplicate background tab can
  take the command and block the canvas while its camera animation is paused. Bring the original tab forward
  once to release it and keep only one copy of the canvas open. Check the visible selection before retrying.
  Direct commands such as `look`, `image` and `wait` can continue during this.
- **Several machines / accounts**: `FLOWITH_HOME=/path` keeps a separate session. `login --site <host>`
  (e.g. `next-gen.flowith.io`) signs in to another Flowith site and every later command follows that
  session (default https://flowith.io; `FLOWITH_URL` can select the site per shell).
- **Retry says a card changed**: another `retry` (another machine), an edit or its result came in after it
  was read. Run `look` again. Retries from this CLI are claimed in Flowith; a retry clicked on the page
  or from an older canvas-cowork isn't, so don't retry one card from both at once.
- Session and caches live in `~/.flowith/` (`canvas-session.json`, mode 600, holds the login token —
  never print or share it). The CLI gets a sign-in of its own (it never shares the browser's), so it can
  renew itself without signing the browser out. `logout` ends that sign-in and forgets it here;
  "Disconnect" in Flowith ends it too: it can't renew, canvas operations stop at once, and the CLI says
  `NOT_LOGGED_IN` within about 2 minutes (it checks when a command starts and every 2 minutes while one
  runs). The access token already issued stays usable by the APIs until it expires (up to 1 hour), and a
  generation Flowith already took isn't cancelled. Beta has the Disconnect update since
  hypergpt-frontend #753; a login approved before it is unknown to the page: `logout` and `login` again.
