#!/usr/bin/env node
'use strict';

/*
 * Checks the armed-loops list (line 2) across a Claude Code restart. Each case
 * writes a small transcript with timestamps relative to now (a job expires 7 days
 * after it was made, so a fixed fixture would go stale), runs statusline.js on it
 * and compares the loop labels it prints. Exits non-zero on any failure.
 *
 * Usage:  node .tests/loops-resume.test.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'statusline.js');
const HOUR = 3600 * 1000;
const ago = (h) => new Date(Date.now() - h * HOUR).toISOString();

const create = (h, id, label, { durable = false } = {}) => [
  { type: 'assistant', timestamp: ago(h), message: { content: [{ type: 'tool_use', id: `toolu_${id}`, name: 'CronCreate', input: { cron: '17 */2 * * *', recurring: true, durable, prompt: `${label}: do the thing` } }] } },
  { type: 'user', timestamp: ago(h), message: { content: [{ type: 'tool_result', tool_use_id: `toolu_${id}`, content: 'Scheduled' }] }, toolUseResult: { id, humanSchedule: 'Every 2 hours at :17', recurring: true, durable } },
];
const exit = () => [{ type: 'cost-state', sessionId: 'test', totalCostUSD: 1, totalDuration: HOUR }];
const fire = (h, id) => [{ type: 'system', subtype: 'scheduled_task_fire', content: 'Running scheduled task', timestamp: ago(h), taskId: id, cron: '17 */2 * * *', prompt: 'x' }];
const list = (h, jobs) => [
  { type: 'assistant', timestamp: ago(h), message: { content: [{ type: 'tool_use', id: `toolu_list${h}`, name: 'CronList', input: {} }] } },
  { type: 'user', timestamp: ago(h), message: { content: [{ type: 'tool_result', tool_use_id: `toolu_list${h}`, content: '' }] }, toolUseResult: { jobs: jobs.map(([id, label]) => ({ id, cron: '17 */2 * * *', humanSchedule: 'Every 2 hours at :17', prompt: `${label}: do the thing`, recurring: true, durable: false })) } },
];

const CASES = [
  {
    name: 'a session-only job made before a restart is gone unless it fires again',
    lines: [...create(50, 'aaaa0001', 'Alpha'), ...create(49, 'dddd0001', 'Durable', { durable: true }), ...exit(), ...create(2, 'bbbb0001', 'Bravo')],
    want: ['Durable', 'Bravo'],
  },
  {
    name: 'a job re-armed by the restart fires straight away and stays listed',
    lines: [...create(50, 'aaaa0002', 'Alpha'), ...exit(), ...fire(3, 'aaaa0002'), ...create(2, 'bbbb0002', 'Bravo')],
    want: ['Alpha', 'Bravo'],
  },
  {
    name: 'a CronList result replaces the list',
    lines: [...create(5, 'aaaa0003', 'Alpha'), ...create(4, 'bbbb0003', 'Bravo'), ...list(1, [['bbbb0003', 'Bravo'], ['cccc0003', 'Charlie']])],
    want: ['Bravo', 'Charlie'],
  },
];

function loopsShown(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-statusline-test-'));
  const sid = `loops-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const transcript = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(transcript, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  try {
    const payload = JSON.stringify({ model: { display_name: 'Opus' }, session_id: sid, transcript_path: transcript });
    const out = spawnSync(process.execPath, [SCRIPT], { input: payload, env: { ...process.env, NO_COLOR: '1', CC_STATUSLINE_ONE_LINE: '' }, encoding: 'utf8' }).stdout;
    const line2 = out.split('\n')[1] || '';
    if (!line2.startsWith('loops: ')) return [];
    return line2.slice('loops: '.length).split(' · ').filter((s) => / Every /.test(s)).map((s) => s.split(' Every ')[0]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(path.join(os.tmpdir(), `cc-statusline-loops-${sid}.json`), { force: true });
  }
}

let failed = 0;
for (const c of CASES) {
  const got = loopsShown(c.lines);
  const ok = got.join(',') === c.want.join(',');
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}${ok ? '' : `\n      want [${c.want.join(', ')}], got [${got.join(', ')}]`}`);
}
process.exit(failed ? 1 : 0);
