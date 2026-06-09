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
 *   - We ALWAYS print exactly one line (a blank line or a non-zero exit blanks
 *     the bar), and the whole thing is wrapped in try/catch.
 *   - Verified on this machine: node v24.13.1, Claude Code v2.1.161, against
 *     real 200k and 1M-context transcripts.
 *
 * Fields shown (left -> right):
 *   Model · effort/thinking · project ⚡branch · ctx bar + % + tokens ·
 *   tokens/$cost +added/-removed in-use-time (elapsed) · 5h%/7d% rate limits
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

// agenttalk roster segment: a peer counts as "live" (●) when its heartbeat is
// newer than this, else "stale" (○). Heartbeats only advance on agenttalk
// activity, so this is "recently active on the bus", not "process alive".
const AGENTTALK_LIVE_MS = 2 * 60 * 1000;

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
// The 1M tier is NOT visible in the transcript's model string, so the limit
// comes from stdin: prefer the authoritative context_window_size, else infer
// from model.id "[1m]" / exceeds_200k_tokens.
// ---------------------------------------------------------------------------
function resolveLimit(p) {
  const cw = p.context_window;
  if (cw && typeof cw.context_window_size === 'number' && cw.context_window_size > 0) {
    return cw.context_window_size;
  }
  const id = (p.model && p.model.id) || '';
  return (/\[1m\]/i.test(id) || p.exceeds_200k_tokens === true) ? 1000000 : 200000;
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
function gitInfo(dir) {
  if (!dir) return '';
  const opts = { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'], timeout: 1500, windowsHide: true };
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
// agenttalk team state (https://github.com/.../agenttalk). When the project is
// part of an agenttalk team it keeps a small plain-text store at
// `<root>/.agenttalk/`; we read it DIRECTLY (no spawning the Python CLI on the
// hot path) to show the roster, this window's place in it, peer liveness, and
// our own waiting / open-thread status. Returns null when the project has no
// such store — i.e. the segment is silent for every non-agenttalk project.
// ---------------------------------------------------------------------------
function readTrim(file) { try { return fs.readFileSync(file, 'utf8').trim(); } catch (_) { return ''; } }
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; } }

function findAgenttalkDir(startDir) {
  let dir = startDir;
  for (let i = 0; i < 6 && dir; i++) { // walk up to the repo/store root
    const at = path.join(dir, '.agenttalk');
    try { if (fs.statSync(path.join(at, 'config.json')).isFile()) return at; } catch (_) {}
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  return null;
}

function agenttalkInfo(cwd) {
  if (!cwd) return null;
  const root = findAgenttalkDir(cwd);
  if (!root) return null; // not an agenttalk project -> segment omitted
  const cfg = readJson(path.join(root, 'config.json'));
  const agents = cfg && Array.isArray(cfg.agents) ? cfg.agents.filter((a) => typeof a === 'string') : [];
  if (!agents.length) return null;
  const self = process.env.AGENTTALK_SELF || 'claude'; // team convention; defaults to "claude"
  const stateDir = path.join(root, 'state');
  const now = Date.now();

  const live = {};
  for (const a of agents) {
    const hb = Date.parse(readTrim(path.join(stateDir, `${a}.heartbeat`)));
    live[a] = !Number.isNaN(hb) && now - hb <= AGENTTALK_LIVE_MS;
  }
  // Are we currently blocked in an `agenttalk wait`? (waiting file present and
  // its deadline, if any, not yet passed.)
  let waiting = false;
  const w = readJson(path.join(stateDir, `${self}.waiting`));
  if (w) {
    const dl = typeof w.deadline_epoch === 'number' ? w.deadline_epoch * 1000 : null;
    waiting = dl === null || dl > now;
  }
  // How many threads we track are still open (unresolved).
  let openThreads = 0;
  const ts = readJson(path.join(stateDir, `${self}.threadstate.json`));
  if (ts && typeof ts === 'object') {
    for (const k of Object.keys(ts)) if (ts[k] && ts[k].closed === false) openThreads++;
  }
  return { agents, self, live, waiting, openThreads };
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

  // 2) Effort + thinking + non-default output style
  const eff = p.effort && p.effort.level;          // low|medium|high|xhigh|max (xhigh == ultracode)
  const flags = [];
  if (eff) flags.push(`e:${eff}`);
  if (p.thinking && p.thinking.enabled) flags.push('think');
  if (p.output_style && p.output_style.name && p.output_style.name !== 'default') flags.push(p.output_style.name);
  if (flags.length) parts.push(paint(flags.join(' '), C.magenta));

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
  parts.push(
    `${paint(bar(pctUsed), col)} ${paint(pctUsed.toFixed(0) + '% ctx', col)} ` +
    `${paint(`(${fmtK(used)}/${fmtK(limit)})`, C.dim)}`,
  );

  // 5) API tokens used this session + their API cost + lines +/- + duration
  const seg = [];
  const stats = sessionStats(p);
  const tokTotal = stats ? stats.tokenTotal : null;
  const costUsd = (p.cost && typeof p.cost.total_cost_usd === 'number') ? p.cost.total_cost_usd : null;
  if (tokTotal !== null || costUsd !== null) {
    const nr = tokTotal !== null ? fmtTokens(tokTotal) : '?';
    const cost = costUsd !== null ? '$' + costUsd.toFixed(2) : '$?';
    seg.push(paint(`API tokens ${nr}/${cost}`, C.green)); // cumulative billed tokens / pay-as-you-go cost
  }
  if (p.cost) {
    const add = p.cost.total_lines_added || 0, del = p.cost.total_lines_removed || 0;
    if (add || del) seg.push(`${paint('+' + add, C.green)}${paint('/-' + del, C.red)}`);
  }
  const dur = sessionDurationStr(stats, p.cost); // active in-use time (+ elapsed), accumulated across resumes
  if (dur) seg.push(paint(dur, C.gray));
  if (seg.length) parts.push(seg.join(' '));

  // 5b) agenttalk team: roster + this window's place/liveness/status. Silent
  // for every project that isn't part of an agenttalk team.
  const team = agenttalkInfo(cwd);
  if (team) {
    const roster = team.agents.map((a) => {
      const isSelf = a === team.self;
      const dot = team.live[a] ? '●' : '○';
      const label = dot + (isSelf ? `${a}*` : a); // own window marked with *
      return paint(label, isSelf ? C.cyan + C.bold : team.live[a] ? C.gray : C.dim);
    }).join(paint('·', C.gray));
    let status = '';
    if (team.waiting) status += ' ' + paint('⏳', C.yellow);            // we're blocked in a wait
    if (team.openThreads > 0) status += ' ' + paint('✉' + team.openThreads, C.magenta); // open threads
    parts.push(paint('🛰', C.gray) + ' ' + roster + status);
  }

  // 6) Real server-side rate-limit windows (Pro/Max, after the first API call)
  if (p.rate_limits) {
    const win = (label, w) => {
      if (!w || typeof w.used_percentage !== 'number') return null;
      const u = Math.max(0, Math.min(100, w.used_percentage)); // fraction of the limit consumed
      const c = usageColor(u);                                 // green low -> red high (higher used = worse)
      const reset = fmtReset(w.resets_at);                     // when this window resets (local time)
      return `${label} ${paint(bar(u, 6), c)} ${paint(Math.round(u) + '%', c)}` +
             (reset ? ` ${paint('/ ' + reset, C.dim)}` : '');
    };
    const segs = [win('5h', p.rate_limits.five_hour), win('7d', p.rate_limits.seven_day)].filter(Boolean);
    if (segs.length) parts.push(paint('usage limits used', C.gray) + ' ' + segs.join(SEP));
  }

  process.stdout.write(parts.join(SEP) + '\n');
}

try { main(); }
catch (_) { process.stdout.write(paint('Claude', C.cyan) + ' ' + paint('statusline error', C.red) + '\n'); }
