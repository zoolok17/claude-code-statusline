# Claude Code status bar

A real-time status line for Claude Code. It is **not** a skill or plugin — Claude Code
has a built-in [`statusLine`](https://code.claude.com/docs/en/statusline) feature: a
command it runs after every assistant message (and on `/compact`, permission-mode and
vim-mode changes, debounced ~300 ms) feeding it a JSON payload on **stdin**. Whatever the
command prints to **stdout** becomes the bar at the bottom of the terminal. It runs
locally and consumes **no API tokens**.

`statusline.js` reads that payload (plus the session transcript as a fallback) and renders
one line.

## What it shows

```
Opus 4.8 (1M context) · e:xhigh think · godot-mcp ⚡main* · ▓▓░░░░░░░░ 21% ctx (206k/1000k) · API tokens 3.5M/$8.57 +156/-23 2m05s · usage limits used 5h ▓░░░░░ 24% · 7d ▓▓░░░░ 41%
```

| Segment | Meaning | Source |
| --- | --- | --- |
| `Opus 4.8 (1M context)` | Model in use | `model.display_name` (stdin) |
| `e:xhigh think` | Effort level + extended thinking on | `effort.level`, `thinking.enabled` (stdin) |
| `godot-mcp ⚡main*` | Project folder + git branch (`*` = uncommitted changes) | `workspace.current_dir` + `git` |
| `▓▓░░░░░░░░ 21% ctx (206k/1000k)` | Context **used** % — bar and number both rise as context fills (green→yellow→red) + tokens used / window | `context_window` (stdin) → transcript fallback |
| `API tokens 3.5M/$8.57 +156/-23 2m05s` | Total tokens billed this session (input+output+cache, deduped & summed from the transcript) `/` their equivalent pay-as-you-go **API cost** (not billed on a subscription) · lines added/removed by edits · wall-clock | transcript (tokens) + `cost.total_cost_usd` (stdin) |
| `usage limits used 5h ▓░░░░░ 24% · 7d ▓▓░░░░ 41%` | **Real** server-side rate-limit **consumption**, 5-hour & weekly windows, each with a bar (green→red as it fills) | `rate_limits.*` (stdin) |

Non-`default` output styles also appear (next to the effort flags).

## Install (already done on this machine)

`~/.claude/settings.json` was given:

```json
"statusLine": {
  "type": "command",
  "command": "node D:/Projects/claude/claude-statusbar/statusline.js"
}
```

> Use **forward slashes** in the path. On Windows the command may be run through Git Bash,
> which eats backslashes and would silently blank the bar.

Restart Claude Code (or start a new session). Accept the workspace-trust prompt if shown —
without trust you get `statusline skipped · restart to fix`. The status line is also
disabled if `disableAllHooks: true`.

This is a **global** bar (user settings), so it appears in every session, not just this
project. To make it independent of this folder, copy `statusline.js` to
`~/.claude/statusline.js` and point the command there instead.

## Install on another machine / share it

It is **not** a Claude Code plugin. Plugins can only contribute the `agent` and
`subagentStatusLine` settings — *not* the top-level `statusLine` — so a status line can't be
registered by a plugin; it's a `settings.json` feature. The portable form is this repo plus a
one-command installer:

```bash
git clone https://github.com/zoolok17/claude-code-statusline.git
cd claude-code-statusline
node install.js          # or: ./install.ps1 (Windows) · ./install.sh (macOS/Linux)
# then restart Claude Code
```

`install.js` writes the `statusLine` block into `~/.claude/settings.json`, pointing at
`statusline.js` in the cloned folder (so `git pull` updates apply automatically). It merges into
existing settings without touching your other keys, and reports if it replaced a previous status
line. Requires Node (already needed to run the bar). Uninstall by deleting the `statusLine` block
or running `/statusline delete`.

## Honest caveats

- **Effort** — `ultracode` is not a distinct level; it reports as `xhigh` and is
  indistinguishable from a plain `xhigh` session via stdin (the friendly name is never in
  the payload).
- **5h / weekly limits** — these are the genuine server-side percentages (the same data
  `/usage` shows), but they are **Pro/Max only** and appear **only after the first API
  response** of a session; each window can be intermittently absent. When missing, the
  `lim …` segment is silently omitted. There is **no** local file with this data.
- **API tokens / cost** — `cost.total_cost_usd` is Claude Code's own client-side estimate, not a
  billed amount. The token count is the **cumulative** total billed across the session (input +
  output + cache-creation + cache-read), summed from the transcript and deduped by message id. It is
  far larger than the context window (e.g. 4.3M vs 162k) because cached context is re-read and
  re-billed on **every turn** — that's exactly what drives the cost. It's computed incrementally (a
  small per-session cache in the temp dir scans only newly-appended transcript bytes), so it stays
  fast even on multi-hundred-MB transcripts.
- **Daily / burn-rate cost** — not provided by Claude Code. If you want it, switch the
  command to [`ccusage`](https://github.com/ryoppippi/ccusage):
  `npx -y ccusage@latest statusline --cost-source cc --visual-burn-rate emoji-text`
  (its 5h-block and weekly figures are *local token-count estimates*, not the official
  limits). `npm i -g ccusage` first to avoid the per-render download.
- **1M context** — the 200k-vs-1M window is detected from stdin (`context_window_size`,
  `model.id` `[1m]` marker, or `exceeds_200k_tokens`); the transcript's model string lacks
  the marker, so the limit is never derived from it.

## Customize

Edit `statusline.js` — changes take effect on the next interaction. The order, colors, and
which segments appear are all in `main()`. Set the `NO_COLOR` env var to disable ANSI
colors. Add `"refreshInterval": 5` (seconds) inside the `statusLine` block if you want the
bar to also tick on a timer while idle (e.g. for a clock or live burn rate).

Each run writes the raw stdin payload to `~/.claude/statusline-last-input.json` — inspect
it to see exactly which fields your Claude Code version sends, then extend the bar. (Delete
the `dumpDebug` call body to turn this off.)

## Tests

`.tests/*.json` are sample payloads. Run them through the script:

```powershell
$env:NO_COLOR=1
Get-Content .tests/a-full-1m.json -Raw | node statusline.js
```

Covered: full 1M payload, minimal payload, empty stdin, real-transcript fallback, and the
`used_percentage` fallback path.
