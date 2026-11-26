# Live browser

Show the canvas beside the chat for user-facing work as soon as you know the target. The agent works the
same with no canvas open; the browser is for the user to watch and react.

## With Flowith's MCP tools

1. `open_canvas` (or `create_canvas` for a new one) gives `url` and `handoffUrl`. `handoffUrl` opens
   Flowith already signed in as the user, on that canvas, laid out for a narrow side pane (no app
   sidebar or Flo rail). It works once, within two minutes.
2. Open `handoffUrl` in the host's own browser beside the chat (Codex: the in-app browser `iab`;
   Antigravity, Cursor and Claude: their browser pane). Reuse the tab that already shows this canvas;
   open a new one only if none does. Keep that tab for the whole task.
3. Check that the tab shows the canvas, not a sign-in page or "link expired". Expired or used: call
   `open_canvas` again for a fresh link. Signed in as someone else: the page asks which account to use;
   let the user choose.
4. Share `url` (the plain canvas link) in the chat, never `handoffUrl`.

If the host has no browser beside the chat, give the user `url`.

## With the CLI

1. Take `browserHandoff.url` from `cw new "Title" --json` or `cw open --handoff --canvas <ref|url> --json`.
   For an existing canvas, this resolves it and leaves the active canvas alone. Use the returned URL in
   `--canvas` on each command. A handoff contains the regular canvas URL and a preferred browser mode.
2. Discover the host's browser controls. In Codex, use the in-app browser named `iab`. List its tabs and
   reuse the tab on the same origin and canvas path. Show the browser with its `visibility` capability
   if available. If no tab matches, open one visible tab (with
   `cua.createBrowserTab("iab", url, { visible: true })` when the host exposes `cua`). Keep that tab for
   the whole task. Use `markDeliverable()` when available to keep the canvas open for review after the turn.
3. Check that the URL still points to the requested canvas and the UI shows the editor or the empty
   canvas. A guest landing page, loading screen, or access prompt means the canvas has yet to load.
   When sign-in is required, have the user sign in to Flowith in that tab, then navigate the same tab
   to the returned canvas URL. Use `markHandoff()` when available if the tab needs to stay open for the
   user to sign in. If the signed-in user still lacks access, report the gate. You can
   continue authorized direct CLI commands while the browser is unavailable. Tell the user which work
   was completed and whether the live canvas was verified.

If the host has no usable embedded browser, share the canvas URL. For a requested live session in a
desktop host without an embedded browser, `cw open --canvas <url>` can launch the system browser.

## Sign-in and canvas controls

The CLI login and the browser's Flowith sign-in are separate. A signed-in browser with canvas access
can show live cards. Commands such as `selection`, `focus` and `tidy` also need the canvas open in the
browser profile that approved the current CLI session.

For first-time setup in an embedded browser, or to connect that browser when those commands are needed,
run `cw login --no-open` in the background. Read the approval URL and short code from stderr while
the command waits. Open that exact URL in the visible host browser and have the user enter the code
and click **Allow**. Keep approval details within the current user session. When approval completes,
return to the target canvas in the same browser profile. A headless task can use any valid CLI session
for the target site without opening a browser.

Use `focus` at a review point to show specific cards. It changes the selection, so leave it alone
while the user is editing. If a control times out, inspect the open canvas before repeating it.
