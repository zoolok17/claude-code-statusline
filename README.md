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
Opus 4.8 (1M context) · e:xhigh think · godot-mcp ⚡main* · ▓▓░░░░░░░░ 21% ctx (206k/1000k) · API tokens 3.5M/$8.57 +156/-23 13h2m (2d3h) · usage limits used 5h ▓░░░░░ 24% / 17:00 · 7d ▓▓░░░░ 41% / Tue 09:00
```

| Segment | Meaning | Source |
| --- | --- | --- |
| `Opus 4.8 (1M context)` | Model in use | `model.display_name` (stdin) |
| `e:xhigh think` | Effort level + extended thinking on | `effort.level`, `thinking.enabled` (stdin) |
| `godot-mcp ⚡main*` | Project folder + git branch (`*` = uncommitted changes) | `workspace.current_dir` + `git` |
| `▓▓░░░░░░░░ 21% ctx (206k/1000k)` | Context **used** % — bar and number both rise as context fills (green→yellow→red) + tokens used / window | `context_window` (stdin) → transcript fallback |
| `API tokens 3.5M/$8.57 +156/-23 13h2m (2d3h)` | Total tokens billed this session (input+output+cache, deduped & summed from the transcript) `/` their equivalent pay-as-you-go **API cost** (not billed on a subscription) · lines added/removed by edits · **in-use time** (`elapsed` in parens) | transcript (tokens + timer) + `cost.total_cost_usd` (stdin) |
| `usage limits used 5h ▓░░░░░ 24% / 17:00 · 7d ▓▓░░░░ 41% / Tue 09:00` | **Real** server-side rate-limit **consumption**, 5-hour & weekly windows, each with a bar (green→red as it fills) and, after the `/`, the local time the window resets (weekday shown when not today) | `rate_limits.*` (stdin) |
| `🛰 claude-reviewer (reviewer) @reviewers/9 ✉2` | **[agenttalk](https://github.com/zoolok17/agenttalk) identity** — *only* in a project with a `.agenttalk/` store: **this window's own agent** — name (`AGENTTALK_SELF`), role, and the group(s) + total roster size it belongs to (`@group/N`), plus `⏳` (blocked in a `wait`) / `✉N` (open threads). Shows `?/N` when identity is unset in a multi-agent roster | `.agenttalk/` store (local files) |

Non-`default` output styles also appear (next to the effort flags). The agenttalk segment is
shown only inside an agenttalk team project; every other project never sees it.

## Install

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

After installing, restart Claude Code (or start a new session). Accept the workspace-trust prompt
if shown — without it you get `statusline skipped · restart to fix`. The status line is also
disabled if `disableAllHooks: true`. It's a **global** bar (user settings), so it appears in every
session, not just one project.

> **Prefer to configure it by hand?** Add the block below to `~/.claude/settings.json` yourself,
> using **forward slashes** in the path — on Windows the command may run through Git Bash, which
> eats backslashes and would silently blank the bar:
>
> ```json
> "statusLine": {
>   "type": "command",
>   "command": "node /absolute/path/to/claude-code-statusline/statusline.js"
> }
> ```

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
- **In-use timer** — the duration (`13h2m (2d3h)`) is **not** `cost.total_duration_ms`: that field
  only covers the current CLI run, so it resets to near-zero every time you `/resume` an old session.
  Instead the timer is reconstructed from the transcript, which Claude Code appends to across resumes
  (same `session_id`, original timestamps preserved). The main figure is **active in-use time** — the
  sum of gaps between consecutive events, *excluding* any gap longer than `IDLE_GAP_MS` (default 15 min)
  so the hours it sat closed don't count. The parenthesised figure is **total elapsed** (first event →
  last, off-time included), shown only when it is meaningfully longer. Tune `IDLE_GAP_MS` near the top
  of `statusline.js`; if there is no transcript to scan it falls back to `cost.total_duration_ms`.
- **Daily / burn-rate cost** — not provided by Claude Code. If you want it, switch the
  command to [`ccusage`](https://github.com/ryoppippi/ccusage):
  `npx -y ccusage@latest statusline --cost-source cc --visual-burn-rate emoji-text`
  (its 5h-block and weekly figures are *local token-count estimates*, not the official
  limits). `npm i -g ccusage` first to avoid the per-render download.
- **1M context** — the 200k-vs-1M window is detected from stdin (`context_window_size`,
  `model.id` `[1m]` marker, or `exceeds_200k_tokens`); the transcript's model string lacks
  the marker, so the limit is never derived from it.
- **agenttalk identity** — read straight from the project's `.agenttalk/config.json` (no `agenttalk`
  CLI is spawned), so it costs nothing off-team and just appears on-team. It shows **only this
  window's own agent** — name from `AGENTTALK_SELF`, role and group(s) from the store's `roles` and
  `groups` maps, and the total roster size after the `/` (`@group/N`, or `@-/N` when you're in no
  group). **Set `AGENTTALK_SELF` in each window** (as agenttalk itself requires); when several agents
  share a project and a window has no `AGENTTALK_SELF`, it can't be identified, so it shows `?/N`
  rather than mislabel itself (a lone-agent roster is unambiguous). `⏳` = blocked in a `wait`,
  `✉N` = open threads. The reverse link also matters: agenttalk's `capacity` reads
  `~/.claude/statusline-last-input.json`, so a Claude worker who wants teammates to see its usage
  snapshot must run with `CC_STATUSLINE_DEBUG=1` (see *Customize*).

## Customize

Edit `statusline.js` — changes take effect on the next interaction. The order, colors, and
which segments appear are all in `main()`. Set the `NO_COLOR` env var to disable ANSI
colors. Add `"refreshInterval": 5` (seconds) inside the `statusLine` block if you want the
bar to also tick on a timer while idle (e.g. for a clock or live burn rate).

Set `CC_STATUSLINE_DEBUG=1` to dump each run's raw stdin payload to
`~/.claude/statusline-last-input.json` — inspect it to see exactly which fields your Claude
Code version sends, then extend the bar. (Off by default, so a normal render writes nothing.)

## Tests

`.tests/*.json` are sample payloads. Run them through the script:

```powershell
$env:NO_COLOR=1
Get-Content .tests/a-full-1m.json -Raw | node statusline.js
```

Covered: full 1M payload, minimal payload, empty stdin, real-transcript fallback, and the
`used_percentage` fallback path. `f-resume-timer.json` exercises the cross-resume timer — it
points at the committed `.tests/sample-transcript.jsonl` (a tiny session with an overnight gap)
and should print `… +42/-7 5m00s (1d1h)`: 5 minutes of actual work spread across a calendar day.
Run it from the repo root so the relative `transcript_path` resolves.
