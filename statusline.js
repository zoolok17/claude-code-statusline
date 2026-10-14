#!/usr/bin/env node
'use strict';

/*
 * Claude Code — comprehensive real-time status line.
 * ---------------------------------------------------
 * Claude Code pipes a JSON payload to this command on stdin (after every
 * assistant message, after /compact, on permission-mode / vim-mode changes,
 * debounced ~300ms) and renders the single line we print to stdout as the
 * persistent bar at the bottom of the terminal. All data is LOCAL (the stdin
 * payload + the session transcript) — this script consumes NO API tokens.
 *
 * Wired up from ~/.claude/settings.json as:
 *   "statusLine": { "type": "command",
 *                   "command": "node D:/Projects/claude/claude-statusbar/statusline.js" }
 *   (forward slashes! On Windows the command may run via Git Bash, which eats
 *    backslashes and would silently blank the bar.)
 *
 * Design rules:
 *   - Every field is treated as OPTIONAL; missing data is skipped, never fatal.
 *   - We print one or two non-blank lines (a blank output or a non-zero exit
 *     blanks the bar), and the whole thing is wrapped in try/catch. Claude Code
 *     shows each printed line as its own row.
 *   - Verified on this machine: node v24.13.1, Claude Code v2.1.161, against
 *     real 200k and 1M-context transcripts.
 *
 * Line 1 (left -> right), the working facts:
 *   Model · effort/thinking/fast · project ⚡branch · ctx bar + % + tokens
 *   (+ "compact soon" past 70%) · API tokens/$cost in-use-time (elapsed) ·
 *   account · 5h%/7d% rate limits with reset times and the weekly pace
 * Line 2, reminders for talking to the model:
 *   Grice's four maxims · one rotating prompting tip
 * Set CC_STATUSLINE_ONE_LINE=1 to put line 2 at the end of line 1 instead.
 * The in-use timer is summed from the transcript across every /resume, so it
 * survives restarts (cost.total_duration_ms only covers the current run).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

// ---------------------------------------------------------------------------
// ANSI color helpers. Claude Code supports color escapes; always reset.
// ---------------------------------------------------------------------------
const NO_COLOR = !!process.env.NO_COLOR; // honor https://no-color.org
const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m', gray: '\x1b[90m',
};
const paint = (s, color) => (NO_COLOR ? `${s}` : `${color}${s}${C.reset}`);
const SEP = paint(' · ', C.gray);

// Idle/off threshold for the session "active time" timer (field 5). Any gap
// between two consecutive transcript events longer than this is treated as
// "stepped away / shut down" and is excluded from active time (it still counts
// toward the total-elapsed figure shown in parens). Tune to taste — e.g.
// 5 * 60 * 1000 for stricter, 30 * 60 * 1000 for looser.
const IDLE_GAP_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------------------
// Read the whole stdin payload (small; a synchronous read of fd 0 is reliable).
// ---------------------------------------------------------------------------
function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch (_) { return ''; }
}

// Best-effort: dump the raw payload so the exact schema this Claude Code
// version sends can be inspected (handy for debugging / extending the bar).
// Opt-in: gated behind CC_STATUSLINE_DEBUG at the call site, so a normal render
// performs no disk write.
function dumpDebug(raw) {
  try {
    fs.writeFileSync(path.join(os.homedir(), '.claude', 'statusline-last-input.json'), raw || '');
  } catch (_) { /* never let debugging break the bar */ }
}

// ---------------------------------------------------------------------------
// Context window: limit + tokens used.
// The window is NOT visible in the transcript's model string, so the limit comes
// from stdin: prefer the authoritative context_window_size (Claude Code always
// sends it), else infer it from the model id.
//
// The `[1m]` suffix is only ONE of the ways Claude Code arrives at a 1M window.
// Since the 4.6 generation most models are NATIVELY 1M and carry no marker at
// all — a real payload from this machine read `id: "claude-opus-4-8"`,
// `exceeds_200k_tokens: false`, `context_window_size: 1000000` — so the fallback
// must not read "no marker" as 200k, or it under-reports the window 5x and the
// bar screams red at a fifth of the real usage.
// ---------------------------------------------------------------------------
function resolveLimit(p) {
  const cw = p.context_window;
  if (cw && typeof cw.context_window_size === 'number' && cw.context_window_size > 0) {
    return cw.context_window_size;                                          // authoritative
  }
  const id = (p.model && p.model.id) || '';
  if (/\[1m\]/i.test(id) || p.exceeds_200k_tokens === true) return 1000000;  // explicit 1M markers
  return nativeLimit(id);
}

// Best-effort model -> context window, used only when stdin omits the real size.
// 1M arrived with the 4.6 generation, so only Haiku and the pre-4.6 models are
// 200k; anything newer or unrecognised is assumed 1M, since that is where the
// entire current lineup sits and context windows only ever grow. Tolerates
// provider-prefixed ids (e.g. "us.anthropic.claude-opus-5").
function nativeLimit(id) {
  if (!id) return 200000;                            // nothing to go on
  if (/haiku/i.test(id)) return 200000;              // every Haiku to date
  if (/claude-\d/i.test(id)) return 200000;          // legacy "claude-3-7-sonnet-…" naming, all 200k
  // "opus-4-8", "sonnet-5", "opus-4" — the 1-2 digit guard keeps the date suffix
  // of "claude-opus-4-20250514" from reading as minor version 20250514.
  const m = /(opus|sonnet)-(\d{1,2})(?:-(\d{1,2}))?(?!\d)/i.exec(id);
  if (m) {
    const major = Number(m[2]), minor = Number(m[3] || 0);
    return (major > 4 || (major === 4 && minor >= 6)) ? 1000000 : 200000;
  }
  return 1000000;                                    // unrecognised -> current-generation default
}

// Tokens in context = input + cache_read + cache_creation (output_tokens is the
// freshly generated reply, not prior context, so it is excluded).
function sumUsage(u) {
  if (!u) return 0;
  return (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
}

// Fallback: tail-read the transcript (active sessions can be hundreds of MB)
// and scan upward for the most recent assistant turn carrying a usage object.
function transcriptUsage(transcriptPath) {
  if (!transcriptPath) return null;
  let raw;
  try {
    const stat = fs.statSync(transcriptPath);
    const TAIL = 256 * 1024; // last 256 KB covers the final turns
    const start = Math.max(0, stat.size - TAIL);
    const len = stat.size - start;
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      raw = buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch (_) { return null; }
  const lines = raw.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch (_) { continue; } // skip partial first line
    if (obj && obj.type === 'assistant' && obj.message && obj.message.usage &&
        typeof obj.message.usage.input_tokens === 'number') {
      return obj.message.usage;
    }
  }
  return null;
}

// Prefer stdin's current_usage (same numbers, no file read), then the
// transcript tail, then the input-only used_percentage as a last resort.
function usedTokens(p, limit) {
  const cu = p.context_window && p.context_window.current_usage;
  let used = sumUsage(cu);
  if (used > 0) return used;
  used = sumUsage(transcriptUsage(p.transcript_path));
  if (used > 0) return used;
  const cw = p.context_window;
  if (cw && typeof cw.used_percentage === 'number') {
    return Math.round((cw.used_percentage / 100) * limit);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Per-session running stats, scanned INCREMENTALLY from the transcript so they
// stay correct across /resume and stay fast on huge (hundreds-of-MB)
// transcripts. Claude Code appends resumed turns to the SAME transcript file
// (same session_id), preserving the original timestamps, so the transcript —
// not the per-run cost.* fields — is the cross-resume source of truth. A tiny
// per-session cache in the temp dir remembers the byte offset + everything
// counted so far; each render reads only the newly-appended bytes. Returns:
//   tokenTotal — cumulative tokens billed this session (input + output +
//                cache_creation + cache_read across every assistant turn; this
//                is what drives the API cost, cache reads dominating). Duplicate
//                JSONL lines for one message share a message.id and are written
//                contiguously, so we dedup by skipping a line whose id equals
//                the previous counted one (matches full Set-dedup exactly).
//   activeMs   — total time the session was IN USE: the sum of gaps between
//                consecutive events, EXCLUDING any gap > IDLE_GAP_MS (the spans
//                it sat closed / you stepped away). Accumulates across every
//                resume — unlike cost.total_duration_ms, which resets each CLI
//                run and so only ever shows time since the last resume.
//   elapsedMs  — wall-clock from the first event ever to the last (off-time
//                included).
// ---------------------------------------------------------------------------
function sessionStats(p) {
  const tp = p.transcript_path;
  if (!tp) return null;
  let size;
  try { size = fs.statSync(tp).size; } catch (_) { return null; }
  const sid = String(p.session_id || path.basename(tp)).replace(/[^A-Za-z0-9._-]/g, '_');
  const cacheFile = path.join(os.tmpdir(), `cc-statusline-${sid}.json`);

  const FRESH = { v: 2, offset: 0, total: 0, lastId: null, firstTs: null, lastTs: null, activeMs: 0 };
  let cache = FRESH;
  try {
    const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    // v:2 added the timestamp/active-time fields; ignore older caches so they
    // get a one-time full rescan that rebuilds the timer instead of resuming
    // at 0 from the current byte offset (which would lose all earlier time).
    if (c && c.v === 2 && typeof c.offset === 'number' && typeof c.total === 'number') cache = c;
  } catch (_) { /* no/invalid cache -> full scan from 0 */ }
  if (cache.offset > size) cache = FRESH; // transcript shrank / rotated

  if (cache.offset < size) {
    let text = '';
    try {
      const fd = fs.openSync(tp, 'r');
      try {
        const len = size - cache.offset;
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, cache.offset);
        text = buf.toString('utf8');
      } finally { fs.closeSync(fd); }
    } catch (_) { return (cache.total || cache.firstTs !== null) ? toStats(cache) : null; }

    const lastNl = text.lastIndexOf('\n'); // only consume up to a clean line boundary
    if (lastNl >= 0) {
      const consume = text.slice(0, lastNl + 1);
      const newOffset = cache.offset + Buffer.byteLength(consume, 'utf8');
      let total = cache.total, lastId = cache.lastId;
      let firstTs = cache.firstTs, lastTs = cache.lastTs, activeMs = cache.activeMs;
      for (const line of consume.split(/\r?\n/)) {
        const s = line.trim();
        if (!s) continue;
        let o; try { o = JSON.parse(s); } catch (_) { continue; }
        // Timer: most line types (user/assistant/attachment/…) carry an ISO
        // timestamp; mode/permission/snapshot lines don't and are skipped here.
        if (o && o.timestamp) {
          const t = Date.parse(o.timestamp);
          if (!Number.isNaN(t)) {
            if (firstTs === null) firstTs = t;
            if (lastTs !== null) {
              const gap = t - lastTs;
              if (gap > 0 && gap <= IDLE_GAP_MS) activeMs += gap; // working; off/away gaps dropped
            }
            if (lastTs === null || t > lastTs) lastTs = t; // guard against out-of-order lines
          }
        }
        if (o && o.type === 'assistant' && o.message && o.message.usage &&
            typeof o.message.usage.input_tokens === 'number') {
          const id = o.message.id || o.requestId || o.uuid || '';
          if (id && id === lastId) continue; // contiguous duplicate of the same message
          const u = o.message.usage;
          total += (u.input_tokens || 0) + (u.output_tokens || 0) +
                   (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
          lastId = id;
        }
      }
      cache = { v: 2, offset: newOffset, total, lastId, firstTs, lastTs, activeMs };
      try { fs.writeFileSync(cacheFile, JSON.stringify(cache)); } catch (_) {}
    }
  }
  return toStats(cache);
}

function toStats(c) {
  return {
    tokenTotal: c.total,
    activeMs: c.activeMs || 0,
    elapsedMs: (c.firstTs !== null && c.lastTs !== null) ? Math.max(0, c.lastTs - c.firstTs) : 0,
  };
}

// ---------------------------------------------------------------------------
// Git branch + dirty flag (not in stdin). Array args = no shell injection.
// Returns '' when cwd is not a repo or git is unavailable.
// ---------------------------------------------------------------------------
// GIT_OPTIONAL_LOCKS=0: `git status` otherwise takes the repo's index.lock to write
// back refreshed stat data, and the 1500 ms timeout kills git (the REAL git.exe
// under Git Bash) -- a kill inside that window leaves an EMPTY stale index.lock
// that blocks every later commit in the repo (orbitlauncher, 2026-09-24: six in
// 14 h, reproduced). The flag only skips that optional write; output is unchanged.
function gitInfo(dir) {
  if (!dir) return '';
  const opts = { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'], timeout: 1500, windowsHide: true,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } };
  try {
    if (execFileSync('git', ['rev-parse', '--is-inside-work-tree'], opts).toString().trim() !== 'true') return '';
    let branch = '';
    try { branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], opts).toString().trim(); } catch (_) {}
    if (!branch) return '';
    let dirty = false;
    try { dirty = execFileSync('git', ['status', '--porcelain'], opts).toString().trim().length > 0; } catch (_) {}
    return dirty ? `${branch}*` : branch;
  } catch (_) { return ''; }
}

// ---------------------------------------------------------------------------
// Which Claude account this window is logged into. The stdin payload carries no
// account field, so we read Claude Code's own config file (~/.claude.json, or
// the one under CLAUDE_CONFIG_DIR) and show ONLY a short label made from the
// e-mail domain ("ximedes.com" -> "Ximedes", "gmail.com" -> "Gmail"). Never the
// full address, never anything from the credentials file. Useful when several
// subscriptions are rotated: you see which one this window is spending.
// ---------------------------------------------------------------------------
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; } }

function accountLabel() {
  const candidates = [];
  if (process.env.CLAUDE_CONFIG_DIR) candidates.push(path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json'));
  candidates.push(path.join(os.homedir(), '.claude.json'));
  for (const file of candidates) {
    const cfg = readJson(file);
    const email = cfg && cfg.oauthAccount && cfg.oauthAccount.emailAddress;
    if (typeof email === 'string' && email.includes('@')) {
      const first = email.split('@').pop().split('.')[0] || '';
      if (first) return first.charAt(0).toUpperCase() + first.slice(1);
    }
  }
  return '';
}

// ---------------------------------------------------------------------------
// Line 2: reminders for talking to the model. Grice's cooperative maxims say
// what a good conversation partner does (enough but not too much; only what is
// true; relevant; clear). The model is trained to be exactly that partner, so
// what you leave unsaid it fills with the most typical reading. One short tip
// rotates every five minutes so it stays noticeable.
// ---------------------------------------------------------------------------
const GRICE = 'Quantity · Quality · Relation · Manner';
const TIPS = [
  'say what "done" looks like',
  'give the purpose, not just the task',
  'ask it to restate the task first',
  'ask for the opposite view',
  'name the limits and what not to touch',
  'ask what it is unsure about',
  'one decision per message',
  'invite far-off ideas when you want them',
];
const TIP_PERIOD_MS = 5 * 60 * 1000;
function currentTip(nowMs) { return TIPS[Math.floor(nowMs / TIP_PERIOD_MS) % TIPS.length]; }

// Weekly pace: how much of the 7-day allowance is used compared with how much of
// the week has passed. "faster" means the allowance would run out before the
// reset if use continues like this; "room" means there is slack. Within 5 points
// it is "even".
// ---------------------------------------------------------------------------
// Armed loops (scheduled prompts made with CronCreate). Claude Code keeps
// session-only jobs in memory, so we rebuild the list from THIS session's
// transcript: each CronCreate call (its prompt gives the label), its result (job
// id, readable schedule, durable or not) and each CronDelete. A job expires 7 days
// after it was made, so the render keeps recurring jobs younger than that. A brand-
// new session has a new transcript, so jobs of an earlier session never appear.
// One-shot jobs are left out.
// Resuming a session only sometimes re-arms its session-only jobs (both outcomes
// seen in 2.1.27x-2.1.300 transcripts), and a re-armed job fires straight away. So
// once Claude Code exits (it writes a 'cost-state' line), a session-only job counts
// again only when it fires (scheduled_task_fire names it) or CronList lists it. A
// CronList result is the whole truth and replaces the list.
// The scan has its own small cache (byte offset + jobs). On the first run it does
// not read the whole transcript (they can be gigabytes): it binary-searches the
// file for the first line of the last 7 days and scans from there, in chunks,
// parsing only lines that can matter (CRON_HINTS).
// ---------------------------------------------------------------------------
const JOB_LIFE_MS = 7 * 24 * 3600 * 1000;
const CHUNK = 8 * 1024 * 1024;
const CRON_HINTS = ['Cron', 'humanSchedule', '"jobs":[', '"cost-state"', 'scheduled_task_fire'];

function lineTimeAt(fd, size, pos) {
  // Timestamp of the first complete, timestamped line at or after byte `pos`.
  const len = Math.min(256 * 1024, size - pos);
  if (len <= 0) return null;
  const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, pos);
  const lines = buf.toString('utf8').split('\n');
  for (let i = pos === 0 ? 0 : 1; i < lines.length - 1; i++) {
    const m = lines[i].match(/"timestamp":"([^"]+)"/);
    if (m) { const t = Date.parse(m[1]); if (!Number.isNaN(t)) return t; }
  }
  return null;
}

function offsetForTime(fd, size, targetMs) {
  let lo = 0, hi = size;
  while (hi - lo > 1024 * 1024) {
    const mid = Math.floor((lo + hi) / 2);
    const t = lineTimeAt(fd, size, mid);
    if (t === null || t >= targetMs) hi = mid; else lo = mid;
  }
  return lo; // a little before the first line at targetMs; the scan skips the partial line
}

function cronLabel(prompt) {
  const s = String(prompt || '').replace(/\s+/g, ' ').trim();
  const cut = s.split(/[(.:]/)[0].trim();
  return (cut || s).slice(0, 24);
}

function armedLoops(p, nowMs) {
  const tp = p.transcript_path;
  if (!tp) return [];
  let size;
  try { size = fs.statSync(tp).size; } catch (_) { return []; }
  const sid = String(p.session_id || path.basename(tp)).replace(/[^A-Za-z0-9._-]/g, '_');
  const cacheFile = path.join(os.tmpdir(), `cc-statusline-loops-${sid}.json`);

  let cache = null;
  try {
    const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (c && c.v === 2 && typeof c.offset === 'number' && c.offset <= size) cache = c;
  } catch (_) {}

  if (!cache || cache.offset < size) {
    try {
      const fd = fs.openSync(tp, 'r');
      try {
        if (!cache) {
          const start = offsetForTime(fd, size, nowMs - JOB_LIFE_MS - 60 * 1000);
          cache = { v: 2, offset: start, skipFirst: start > 0, pending: {}, lists: {}, jobs: {} };
        }
        let pos = cache.offset, carry = '';
        let skip = cache.skipFirst === true;
        while (pos < size) {
          const len = Math.min(CHUNK, size - pos);
          const buf = Buffer.alloc(len);
          fs.readSync(fd, buf, 0, len, pos);
          pos += len;
          const text = carry + buf.toString('utf8');
          const lines = text.split('\n');
          carry = lines.pop(); // incomplete last line waits for the next chunk/render
          for (const line of lines) {
            if (skip) { skip = false; continue; } // partial line where the search landed
            if (!CRON_HINTS.some((h) => line.indexOf(h) >= 0)) continue;
            let o; try { o = JSON.parse(line); } catch (_) { continue; }
            if (!o) continue;
            if (o.type === 'cost-state') { // Claude Code exited
              for (const j of Object.values(cache.jobs)) if (!j.durable) j.live = false;
              continue;
            }
            if (o.subtype === 'scheduled_task_fire') {
              if (o.taskId && cache.jobs[o.taskId]) cache.jobs[o.taskId].live = true;
              continue;
            }
            const content = o.message && Array.isArray(o.message.content) ? o.message.content : [];
            if (o.type === 'assistant') {
              for (const c of content) {
                if (!c || c.type !== 'tool_use') continue;
                if (c.name === 'CronCreate' && c.input) cache.pending[c.id] = cronLabel(c.input.prompt);
                if (c.name === 'CronList') cache.lists[c.id] = true;
                if (c.name === 'CronDelete' && c.input && c.input.id) delete cache.jobs[c.input.id];
              }
            } else if (o.type === 'user' && o.toolUseResult) {
              const r = o.toolUseResult;
              const res = content.find((c) => c && c.type === 'tool_result');
              const tuid = res && res.tool_use_id;
              const created = Date.parse(o.timestamp) || nowMs;
              if (r.humanSchedule && r.id) {
                cache.jobs[r.id] = {
                  label: (tuid && cache.pending[tuid]) || '',
                  sched: String(r.humanSchedule),
                  recurring: r.recurring !== false,
                  durable: r.durable === true,
                  created,
                  live: true,
                };
                if (tuid) delete cache.pending[tuid];
              } else if (Array.isArray(r.jobs) && tuid && cache.lists[tuid]) {
                const jobs = {};
                for (const j of r.jobs) {
                  const known = cache.jobs[j.id];
                  jobs[j.id] = {
                    label: (known && known.label) || cronLabel(j.prompt),
                    sched: String(j.humanSchedule || j.cron),
                    recurring: j.recurring === true, // one-shot jobs omit it here
                    durable: j.durable === true,
                    created: known ? known.created : created, // made before the scanned stretch: best guess
                    live: true,
                  };
                }
                cache.jobs = jobs;
                delete cache.lists[tuid];
              }
            }
          }
        }
        cache.offset = size - Buffer.byteLength(carry, 'utf8');
        cache.skipFirst = false;
      } finally { fs.closeSync(fd); }
      try { fs.writeFileSync(cacheFile, JSON.stringify(cache)); } catch (_) {}
    } catch (_) { if (!cache) return []; }
  }

  return Object.entries(cache.jobs)
    .map(([id, j]) => ({ id, ...j }))
    .filter((j) => j.recurring && j.live)
    .filter((j) => j.durable || j.created + JOB_LIFE_MS > nowMs)
    .sort((a, b) => a.created - b.created);
}

function fmtLeft(ms) {
  if (ms <= 0) return 'expired';
  const h = Math.floor(ms / 3600000);
  return h >= 24 ? `${Math.floor(h / 24)}d left` : `${h}h left`;
}

const WEEK_SEC = 7 * 24 * 3600;
function weekPace(usedPct, resetsAt, nowMs) {
  if (typeof usedPct !== 'number' || typeof resetsAt !== 'number' || resetsAt <= 0) return null;
  const remaining = resetsAt - nowMs / 1000;
  if (remaining <= 0 || remaining > WEEK_SEC) return null;
  const gone = Math.max(0, Math.min(100, 100 * (1 - remaining / WEEK_SEC)));
  const diff = usedPct - gone;
  const word = diff > 5 ? 'faster' : diff < -5 ? 'room' : 'even';
  return { gone, word, diff };
}

// ---------------------------------------------------------------------------
// Formatting helpers.
// ---------------------------------------------------------------------------
const fmtK = (n) => (n >= 1000 ? (n / 1000).toFixed(n >= 100000 ? 0 : 1) + 'k' : String(n));
const fmtTokens = (n) => (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n));
const usageColor = (pctUsed) => (pctUsed >= 90 ? C.red : pctUsed >= 70 ? C.yellow : C.green);
function bar(pctUsed, w = 10) {
  const f = Math.max(0, Math.min(w, Math.round((pctUsed / 100) * w)));
  return '▓'.repeat(f) + '░'.repeat(w - f);
}
// Rate-limit reset moment (epoch seconds) -> compact local time:
// today -> "17:00", another day -> "Tue 09:00".
function fmtReset(epochSec) {
  if (typeof epochSec !== 'number' || epochSec <= 0) return '';
  const d = new Date(epochSec * 1000);
  if (isNaN(d.getTime())) return '';
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (d.toDateString() === new Date().toDateString()) return hm;
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return `${days[d.getDay()]} ${hm}`;
}
function fmtDuration(ms) {
  if (!ms || ms < 0) return '';
  const t = Math.floor(ms / 1000);
  const d = Math.floor(t / 86400), h = Math.floor((t % 86400) / 3600);
  const m = Math.floor((t % 3600) / 60), s = t % 60;
  if (d > 0) return `${d}d${h}h`;
  if (h > 0) return `${h}h${m}m`;
  if (m > 0) return `${m}m${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

// Field-5 timer: active in-use time (summed across every resume) as the main
// figure, with total elapsed (off-time included) in parens — but only when it
// is meaningfully longer, so an uninterrupted session shows a single number.
// Falls back to this run's wall-clock (cost.total_duration_ms) when there is no
// transcript to scan.
function sessionDurationStr(stats, cost) {
  if (stats && (stats.activeMs > 0 || stats.elapsedMs > 0)) {
    // Sparse session — every turn spaced beyond IDLE_GAP_MS, so active rounds to
    // ~0: lead with elapsed rather than an uninformative "0s" or, worse, the
    // per-run cost fallback that this resume-aware field exists to replace.
    if (stats.activeMs < 1000) return fmtDuration(stats.elapsedMs);
    let s = fmtDuration(stats.activeMs);
    if (stats.elapsedMs - stats.activeMs > 60000) s += ` (${fmtDuration(stats.elapsedMs)})`;
    return s;
  }
  return (cost && fmtDuration(cost.total_duration_ms)) || '';
}

// ---------------------------------------------------------------------------
// Build the line.
// ---------------------------------------------------------------------------
function main() {
  const raw = readStdin();
  if (process.env.CC_STATUSLINE_DEBUG) dumpDebug(raw); // opt-in raw-payload dump
  let p = {};
  if (raw.trim()) { try { p = JSON.parse(raw); } catch (_) { p = {}; } }

  const parts = [];

  // 1) Model
  parts.push(paint(`${(p.model && p.model.display_name) || 'Claude'}`, C.cyan + C.bold));

  // 2) Effort + thinking + fast mode + non-default output style.
  // `effort` is absent for models that don't support it (e.g. Haiku), so the
  // whole group is optional.
  const eff = p.effort && p.effort.level;          // low|medium|high|xhigh|max (xhigh == ultracode)
  const flags = [];
  if (eff) flags.push(paint(`e:${eff}`, C.magenta));
  if (p.thinking && p.thinking.enabled) flags.push(paint('think', C.magenta));
  // Fast mode (/fast, Opus 5 / 4.8) is the same model at a premium per-token
  // rate, so it is painted apart from the other flags: it silently changes what
  // the $ figure in field 5 means. Strict === true so older payloads stay quiet.
  if (p.fast_mode === true) flags.push(paint('fast', C.yellow + C.bold));
  if (p.output_style && p.output_style.name && p.output_style.name !== 'default') {
    flags.push(paint(p.output_style.name, C.magenta));
  }
  if (flags.length) parts.push(flags.join(' '));

  // 3) Project basename + git branch/dirty
  const cwd = (p.workspace && p.workspace.current_dir) || p.cwd || '';
  const proj = cwd ? path.basename(cwd) : '';
  if (proj) {
    const branch = gitInfo(cwd);
    parts.push(branch ? `${paint(proj, C.blue)} ${paint('⚡' + branch, C.gray)}` : paint(proj, C.blue));
  }

  // 4) Remaining context: colored bar + % left + tokens used / limit
  const limit = resolveLimit(p);
  const used = usedTokens(p, limit);
  const pctUsed = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  const col = usageColor(pctUsed);
  // Past 70% a long conversation gets slow and costly: a short reminder to
  // compact (or start fresh with a handover note) before it fills up.
  const hint = pctUsed >= 90 ? paint(' compact now', C.red + C.bold)
    : pctUsed >= 70 ? paint(' compact soon', C.yellow) : '';
  parts.push(
    `${paint(bar(pctUsed), col)} ${paint(pctUsed.toFixed(0) + '% ctx', col)} ` +
    `${paint(`(${fmtK(used)}/${fmtK(limit)})`, C.dim)}${hint}`,
  );

  // 5) API tokens used this session + their API cost + duration
  const seg = [];
  const stats = sessionStats(p);
  const tokTotal = stats ? stats.tokenTotal : null;
  const costUsd = (p.cost && typeof p.cost.total_cost_usd === 'number') ? p.cost.total_cost_usd : null;
  if (tokTotal !== null || costUsd !== null) {
    const nr = tokTotal !== null ? fmtTokens(tokTotal) : '?';
    const cost = costUsd !== null ? '$' + costUsd.toFixed(2) : '$?';
    seg.push(paint(`API tokens ${nr}/${cost}`, C.green)); // cumulative billed tokens / pay-as-you-go cost
  }
  const dur = sessionDurationStr(stats, p.cost); // active in-use time (+ elapsed), accumulated across resumes
  if (dur) seg.push(paint(dur, C.gray));
  if (seg.length) parts.push(seg.join(' '));

  // 6) The account this window spends (label from the e-mail domain only).
  const acct = accountLabel();
  if (acct) parts.push(paint('acct ' + acct, C.cyan));

  // 7) Real server-side rate-limit windows (Pro/Max, after the first API call),
  // each with its reset time; the 7-day window also shows the weekly pace.
  const nowMs = Date.now();
  if (p.rate_limits) {
    const win = (label, w, withPace) => {
      if (!w || typeof w.used_percentage !== 'number') return null;
      const u = Math.max(0, Math.min(100, w.used_percentage)); // fraction of the limit consumed
      const c = usageColor(u);                                 // green low -> red high (higher used = worse)
      const reset = fmtReset(w.resets_at);                     // when this window resets (local time)
      let s = `${label} ${paint(bar(u, 6), c)} ${paint(Math.round(u) + '%', c)}` +
              (reset ? ` ${paint('/ ' + reset, C.dim)}` : '');
      const pace = withPace ? weekPace(u, w.resets_at, nowMs) : null;
      if (pace) {
        const pc = pace.word === 'faster' ? (pace.diff > 15 ? C.red : C.yellow)
          : pace.word === 'room' ? C.green : C.gray;
        s += ' ' + paint(`(${Math.round(pace.gone)}% of week gone: `, C.dim) + paint(pace.word, pc) + paint(')', C.dim);
      }
      return s;
    };
    const segs = [win('5h', p.rate_limits.five_hour, false), win('7d', p.rate_limits.seven_day, true)].filter(Boolean);
    if (segs.length) parts.push(paint('usage limits used', C.gray) + ' ' + segs.join(SEP));
  }

  // Line 2: armed loops (scheduled prompts), then reminders for talking to the model.
  const loops = armedLoops(p, nowMs).map((j) => {
    const left = j.durable ? '' : fmtLeft(j.created + JOB_LIFE_MS - nowMs);
    const lc = left && !left.endsWith('d left') ? C.red : C.dim; // under a day: renew soon
    return paint(j.label || j.id, C.magenta) + ' ' + paint(j.sched, C.gray) + (left ? ' ' + paint(`(${left})`, lc) : '');
  });
  const reminders = (loops.length ? paint('loops: ', C.gray) + loops.join(SEP) + SEP : '') +
    paint('Grice: ', C.gray) + paint(GRICE, C.dim) + SEP +
    paint('tip: ', C.gray) + paint(currentTip(nowMs), C.dim);

  if (process.env.CC_STATUSLINE_ONE_LINE) {
    process.stdout.write(parts.join(SEP) + SEP + reminders + '\n');
  } else {
    process.stdout.write(parts.join(SEP) + '\n' + reminders + '\n');
  }
}

try { main(); }
catch (_) { process.stdout.write(paint('Claude', C.cyan) + ' ' + paint('statusline error', C.red) + '\n'); }
