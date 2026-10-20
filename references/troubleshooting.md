# Troubleshooting

## Auto-Retry

All commands automatically retry up to 2 times on WS connection failure, re-opening the browser each time.

## Error Format

Errors are returned as structured JSON to stdout (even on exit code 1):
```json
{"type":"error","actionId":null,"code":"NOT_LOGGED_IN","message":"..."}
```

## Error Codes

| Error Code | Meaning | What to do |
|------------|---------|------------|
| `NO_CREDITS` | Account has no remaining credits | **Stop immediately. Do NOT retry or switch models.** Send the user the pricing link: https://flowith.io/pricing |
| `NOT_LOGGED_IN` | Session expired or token revoked | Tell the user to log in at the browser that was opened, then retry. If the message mentions Safari (macOS), the login page can't connect from Safari: have the user open the printed login URL in Chrome, Arc, Edge or Brave (or make one their default browser), then retry |
| `BROWSER_NOT_CONNECTED` | Browser opened but didn't respond | Tell the user to ensure the Flowith tab is fully loaded |
| `TIMEOUT` | Generic timeout | Check network/browser status |
| `INVALID_SESSION` | Session file corrupted | Delete `~/.flowith/bot-session.json`, re-run |
| `LOCKED` | Another action in progress or rate limited | Wait 2s, retry |
| `Submit handler not available` | Not on a canvas page | Run `create-canvas` or `switch <id>` first |

## Model Change During Generation

`--wait` blocks the CLI. You cannot change the model mid-generation.
Workaround: submit without `--wait`, then `read-db` to check results later.

## Rate Limits

30 actions per 10 seconds (sliding window). Use `delete-many` instead of repeated `delete`.
