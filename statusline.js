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
 *   $cost +added/-removed duration · 5h%/7d% rate limits
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

// ---------------------------------------------------------------------------
// Read the whole stdin payload (small; a synchronous read of fd 0 is reliable).
// ---------------------------------------------------------------------------
function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch (_) { return ''; }
}

// Best-effort: dump the raw payload so the exact schema this Claude Code
// version sends can be inspected (handy for debugging / extending the bar).
// Harmless and tiny; comment out the body to disable.
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
// Cumulative tokens billed this session = input + output + cache_creation +
// cache_read summed across every assistant turn (this is what produces the API
// cost; cache reads dominate). Duplicate JSONL lines for one message share a
// message.id and are written contiguously, so we dedup by skipping a line whose
// id equals the previous counted one (verified to match full Set-dedup exactly).
// To stay fast on huge (hundreds-of-MB) transcripts we scan INCREMENTALLY: a
// tiny per-session cache in the temp dir remembers the byte offset + running
// total already counted, and each render only reads the newly-appended bytes.
// ---------------------------------------------------------------------------
function sessionTokenTotal(p) {
  const tp = p.transcript_path;
  if (!tp) return null;
  let size;
  try { size = fs.statSync(tp).size; } catch (_) { return null; }
  const sid = String(p.session_id || path.basename(tp)).replace(/[^A-Za-z0-9._-]/g, '_');
  const cacheFile = path.join(os.tmpdir(), `cc-statusline-${sid}.json`);

  let cache = { offset: 0, total: 0, lastId: null };
  try {
    const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (c && typeof c.offset === 'number' && typeof c.total === 'number') cache = c;
  } catch (_) { /* no/invalid cache -> full scan from 0 */ }
  if (cache.offset > size) cache = { offset: 0, total: 0, lastId: null }; // transcript shrank / rotated

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
    } catch (_) { return cache.total || null; }

    const lastNl = text.lastIndexOf('\n'); // only consume up to a clean line boundary
    if (lastNl >= 0) {
      const consume = text.slice(0, lastNl + 1);
      const newOffset = cache.offset + Buffer.byteLength(consume, 'utf8');
      let total = cache.total, lastId = cache.lastId;
      for (const line of consume.split(/\r?\n/)) {
        const s = line.trim();
        if (!s) continue;
        let o; try { o = JSON.parse(s); } catch (_) { continue; }
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
      cache = { offset: newOffset, total, lastId };
      try { fs.writeFileSync(cacheFile, JSON.stringify(cache)); } catch (_) {}
    }
  }
  return cache.total;
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
// Formatting helpers.
// ---------------------------------------------------------------------------
const fmtK = (n) => (n >= 1000 ? (n / 1000).toFixed(n >= 100000 ? 0 : 1) + 'k' : String(n));
const fmtTokens = (n) => (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n));
const usageColor = (pctUsed) => (pctUsed >= 90 ? C.red : pctUsed >= 70 ? C.yellow : C.green);
function bar(pctUsed, w = 10) {
  const f = Math.max(0, Math.min(w, Math.round((pctUsed / 100) * w)));
  return '▓'.repeat(f) + '░'.repeat(w - f);
}
function fmtDuration(ms) {
  if (!ms || ms < 0) return '';
  const t = Math.floor(ms / 1000), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  if (h > 0) return `${h}h${m}m`;
  if (m > 0) return `${m}m${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

// ---------------------------------------------------------------------------
// Build the line.
// ---------------------------------------------------------------------------
function main() {
  const raw = readStdin();
  dumpDebug(raw);
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
  const tokTotal = sessionTokenTotal(p);
  const costUsd = (p.cost && typeof p.cost.total_cost_usd === 'number') ? p.cost.total_cost_usd : null;
  if (tokTotal !== null || costUsd !== null) {
    const nr = tokTotal !== null ? fmtTokens(tokTotal) : '?';
    const cost = costUsd !== null ? '$' + costUsd.toFixed(2) : '$?';
    seg.push(paint(`API tokens ${nr}/${cost}`, C.green)); // cumulative billed tokens / pay-as-you-go cost
  }
  if (p.cost) {
    const add = p.cost.total_lines_added || 0, del = p.cost.total_lines_removed || 0;
    if (add || del) seg.push(`${paint('+' + add, C.green)}${paint('/-' + del, C.red)}`);
    const dur = fmtDuration(p.cost.total_duration_ms);
    if (dur) seg.push(paint(dur, C.gray));
  }
  if (seg.length) parts.push(seg.join(' '));

  // 6) Real server-side rate-limit windows (Pro/Max, after the first API call)
  if (p.rate_limits) {
    const win = (label, w) => {
      if (!w || typeof w.used_percentage !== 'number') return null;
      const u = Math.max(0, Math.min(100, w.used_percentage)); // fraction of the limit consumed
      const c = usageColor(u);                                 // green low -> red high (higher used = worse)
      return `${label} ${paint(bar(u, 6), c)} ${paint(Math.round(u) + '%', c)}`;
    };
    const segs = [win('5h', p.rate_limits.five_hour), win('7d', p.rate_limits.seven_day)].filter(Boolean);
    if (segs.length) parts.push(paint('usage limits used', C.gray) + ' ' + segs.join(SEP));
  }

  process.stdout.write(parts.join(SEP) + '\n');
}

try { main(); }
catch (_) { process.stdout.write(paint('Claude', C.cyan) + ' ' + paint('statusline error', C.red) + '\n'); }
