# The canvas folder on this computer (Flowith Next only)

Each canvas on Flowith Next has a shared, versioned folder of files: Flo, the canvas's Claude Code / Codex cards and
the user's own agents all read and write it, and every change is a new version. `sync` keeps a directory on this
computer in step with it, so you work on the canvas's files with your own tools, and what you change goes back as a
version under your name. On flowith.io there is no canvas folder yet: `sync` says `NEXT_GEN_ONLY` and sends nothing.

Sign in to Flowith Next first, in a home of its own so the flowith.io session stays as it is:

```
FLOWITH_HOME=~/.flowith-next cw login --site next-gen.flowith.io
FLOWITH_HOME=~/.flowith-next cw use <canvas>
```

## Commands

| Need | Command |
|---|---|
| Bring the folder here, or hand back what you changed and take others' | `sync <dir>` (one round; `<dir>` is made when missing) |
| Keep it in step while you work | `sync <dir> --watch [--every 10]`: what changes here goes back about a second later, others' versions come down every `--every` seconds. Ctrl-C stops |
| See what a round would do | `sync <dir> --dry-run`: what would go back, whether there is a newer version; sends nothing |
| Say why, on the version | `--message "…"` (the folder's history shows it) |

A round hands what changed here back as one version, made on the version the directory was last in step with, then
takes the folder's latest. The answer says `from` (that version), `seq` (the one it is in step with now),
`handedBack` (files added, changed or deleted here), `took` and `removed` (files that came down or went).

## When others changed the same files

- Different files, or different lines of one text file: the folder merges them (`merged: true`); the merged file comes
  down at once.
- The same lines of one file (a real conflict): the folder keeps both. The newest stays at the path, yours goes beside
  it as `keptAs`, for example `brief (Claude Code).md`, and both come down. Compare them, keep one, delete the other and
  `sync` again; or leave it and the user picks on the canvas (Folder → Conflict).
- A file you change while a round is taking the folder's latest is never overwritten (`keptHere`): it goes back next
  round, merged with what changed meanwhile.

## What stays here

`node_modules`, `.venv`, `.git`, `__pycache__`, `.cache` and `.DS_Store` never go back (as with the canvas's own
runs). `.flowith-folder.json` is the directory's record of which canvas and version it is in step with: leave it. The
folder holds at most 5,000 files and 500 MB.

A directory is kept in step with one canvas. A directory that has files and was never synced is not merged into a
folder that has files too (`FOLDER_NOT_EMPTY`): sync into an empty directory, then copy yours in. Into an empty folder,
its files go up as the first version.
