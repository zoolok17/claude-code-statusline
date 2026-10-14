# Claude Code status bar

A real-time status line for Claude Code. It is **not** a skill or plugin — Claude Code
has a built-in [`statusLine`](https://code.claude.com/docs/en/statusline) feature: a
command it runs after every assistant message (and on `/compact`, permission-mode and
vim-mode changes, debounced ~300 ms) feeding it a JSON payload on **stdin**. Whatever the
command prints to **stdout** becomes the bar at the bottom of the terminal. It runs
locally and consumes **no API tokens**.

`statusline.js` reads that payload (plus the session transcript as a fallback) and renders
two lines: the working facts (model, context, cost, account, usage limits) and a second line with
the session's armed loops plus a short reminder for talking to the model (Grice's four maxims and one
rotating tip).

## What it shows

```
Opus 4.8 (1M context) · e:xhigh think · godot-mcp ⚡main* · ▓▓▓▓▓▓▓▓░░ 77% ctx (770k/1000k) compact soon · API tokens 3.5M/$8.57 13h2m (2d3h) · acct Ximedes · usage limits used 5h ▓░░░░░ 24% / 17:00 · 7d ▓▓▓▓░░ 73% / Sat 03:00 (57% of week gone: faster)
loops: COMPACT-PREP Every 2 hours at :07 (4d left) · SITREP TICK 13,43 * * * * (6d left) · Grice: Quantity · Quality · Relation · Manner · tip: say what "done" looks like
```

| Segment | Meaning | Source |
| --- | --- | --- |
| `Opus 4.8 (1M context)` | Model in use | `model.display_name` (stdin) |
| `e:xhigh think fast` | Effort level + extended thinking on + fast mode | `effort.level`, `thinking.enabled`, `fast_mode` (stdin) |
| `godot-mcp ⚡main*` | Project folder + git branch (`*` = uncommitted changes) | `workspace.current_dir` + `git` |
| `▓▓▓▓▓▓▓▓░░ 77% ctx (770k/1000k) compact soon` | Context **used** % — bar and number both rise as context fills (green→yellow→red) + tokens used / window. Past 70% a `compact soon` reminder (past 90% `compact now`): a long conversation gets slower and costlier with every turn | `context_window` (stdin) → transcript fallback |
| `API tokens 3.5M/$8.57 13h2m (2d3h)` | Total tokens billed this session (input+output+cache, deduped & summed from the transcript) `/` their equivalent pay-as-you-go **API cost** (not billed on a subscription) · **in-use time** (`elapsed` in parens) | transcript (tokens + timer) + `cost.total_cost_usd` (stdin) |
| `acct Ximedes` | Which Claude account this window spends: a short label from the account's e-mail domain only (`gmail.com` → `Gmail`), useful when you rotate subscriptions | `oauthAccount.emailAddress` in Claude Code's own `~/.claude.json` (domain only) |
| `usage limits used 5h ▓░░░░░ 24% / 17:00 · 7d ▓▓▓▓░░ 73% / Sat 03:00 (57% of week gone: faster)` | **Real** server-side rate-limit **consumption**, 5-hour & weekly windows, each with a bar (green→red as it fills) and, after the `/`, the local time the window resets (weekday shown when not today). The weekly window also shows its **pace**: how much of the week has passed, and `faster` (yellow; red when more than 15 points ahead) if the allowance is being used faster than the week passes, `room` if slower, `even` within 5 points | `rate_limits.*` (stdin) |
| line 2: `loops: SITREP TICK 13,43 * * * * (6d left) · …` | The **armed loops** of this session (recurring prompts scheduled with `/loop` or `CronCreate`): a label from the first words of the prompt, the schedule, and how long until the job expires (session-only jobs expire 7 days after they were made; under a day shows in red, time to renew) | this session's transcript (`CronCreate` / `CronList` / `CronDelete` calls and results, job fires, Claude Code exits) |
| then `Grice: Quantity · Quality · Relation · Manner · tip: …` | A reminder of Grice's four maxims of cooperative conversation (say enough but not too much; only what is true; stay relevant; be clear) and one short prompting tip that changes every five minutes | built in |

Non-`default` output styles also appear (next to the effort flags). `fast` shows up there only
while `/fast` is on, in yellow rather than the usual magenta: it is the same model at a premium
per-token rate, so the `$` figure further along the bar is not comparable to a standard-speed
session. The effort flag itself is absent on models that have no effort setting (Haiku).

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
- **Context window** — the size comes from stdin's `context_window_size`, which Claude Code
  always sends; the transcript's model string carries no window information, so the limit is
  never derived from it. Only if that field is missing does the bar fall back to inferring the
  window: `[1m]` in `model.id` or `exceeds_200k_tokens` mean 1M, otherwise it reads the model
  family and version. **Note that `[1m]` is only one of the routes to a 1M window** — since the
  4.6 generation most models are *natively* 1M and carry no marker at all (a real payload here
  read `claude-opus-4-8`, `exceeds_200k_tokens: false`, `context_window_size: 1000000`), so the
  fallback treats Haiku and pre-4.6 models as 200k and everything newer or unrecognised as 1M.
- **Account label** — read from Claude Code's own `~/.claude.json` (or the one under
  `CLAUDE_CONFIG_DIR`): only the domain of `oauthAccount.emailAddress` becomes the label, so the full
  address is never shown and the credentials file is never read. The label is what the window was
  logged into when Claude Code last wrote that file; after `/login` with another account it changes
  on the next refresh.
- **Weekly pace** — compares the 7-day percentage with how much of the 7 days before `resets_at` has
  passed; it assumes the window is exactly seven days long, so treat it as a guide, not a forecast.
- **The tip rotates on refresh** — the status line runs after each message; add `"refreshInterval"`
  (see *Customize*) if you want the tip to change while the window is idle.
- **Armed loops** — Claude Code keeps session-only scheduled jobs in memory and writes no state file, so
  the list is rebuilt from this session's transcript: every `CronCreate` call and result, minus every
  `CronDelete`, minus jobs older than seven days (when they expire). A `CronList` result shows exactly
  what is armed, so it replaces the list. One-shot jobs are left out. Resuming a session after Claude
  Code exits only sometimes re-arms its session-only jobs, and a re-armed job fires straight away; so
  after an exit, a session-only job made earlier is listed again only once it fires or `CronList` shows
  it (durable jobs survive restarts and stay). The exit is read from the record Claude Code writes to
  the transcript when it quits; if a process ever ends without writing it, its jobs stay listed until
  the next `CronList`. A new session has a new transcript and starts empty. The scan keeps its own byte-offset cache in the temp folder, and on the first run it
  binary-searches the transcript for the last seven days instead of reading all of it (a long session's
  transcript can be gigabytes): about a second once, then only the new lines.
- **agenttalk capacity snapshots** — agenttalk's `capacity` command reads
  `~/.claude/statusline-last-input.json`, so a Claude worker whose usage teammates should see must
  run with `CC_STATUSLINE_DEBUG=1` (see *Customize*). The status line no longer shows agenttalk team
  identities; that segment was for copying messages between agents by hand.

## Customize

Edit `statusline.js` — changes take effect on the next interaction. The order, colors, and
which segments appear are all in `main()`. Set the `NO_COLOR` env var to disable ANSI
colors. Set `CC_STATUSLINE_ONE_LINE=1` to put the reminders at the end of line 1 instead of on their own
line. Add `"refreshInterval": 5` (seconds) inside the `statusLine` block if you want the
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
`used_percentage` fallback path. `g-native-1m-fast.json` covers a natively-1M model with no
`[1m]` marker and no `context_window_size`, plus fast mode — it should print
`Opus 5 · e:xhigh think fast · opus5-fast · ▓▓▓░░░░░░░ 30% ctx (300k/1000k)` (a 200k denominator
there would mean the window inference regressed). `f-resume-timer.json` exercises the cross-resume timer — it
points at the committed `.tests/sample-transcript.jsonl` (a tiny session with an overnight gap)
and should print `… +42/-7 5m00s (1d1h)`: 5 minutes of actual work spread across a calendar day.
Run it from the repo root so the relative `transcript_path` resolves.

`node .tests/loops-resume.test.js` checks the armed-loops list across a restart. It writes small
transcripts dated relative to now (jobs expire after seven days, so a fixed file would go stale), runs
the script on each and prints `PASS`/`FAIL` per case; the exit code is 1 if any case fails.
