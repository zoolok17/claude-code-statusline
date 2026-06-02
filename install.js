#!/usr/bin/env node
'use strict';

/*
 * Installer for the Claude Code status bar.
 *
 * A status line is NOT a Claude Code plugin — plugins can only contribute the
 * `agent` and `subagentStatusLine` settings, not the top-level `statusLine`.
 * It is a settings.json feature. So "installing" means adding one block to your
 * user settings that points Claude Code at statusline.js in THIS folder.
 *
 * Usage:  node install.js          (run from anywhere; uses this script's dir)
 * Node is already required to run the status line, so this has no extra deps.
 * Pointing at the cloned repo means `git pull` updates apply automatically.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const scriptPath = path.join(__dirname, 'statusline.js').replace(/\\/g, '/'); // forward slashes: Git Bash eats backslashes
const command = `node ${scriptPath}`;
const settingsDir = path.join(os.homedir(), '.claude');
const settingsPath = path.join(settingsDir, 'settings.json');

if (!fs.existsSync(scriptPath)) {
  console.error(`✗ statusline.js not found next to the installer (${scriptPath}). Run install.js from the repo.`);
  process.exit(1);
}

try { fs.mkdirSync(settingsDir, { recursive: true }); } catch (_) {}

let settings = {};
if (fs.existsSync(settingsPath)) {
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch (e) {
    console.error(`✗ ${settingsPath} exists but is not valid JSON; fix it first, then re-run. (${e.message})`);
    process.exit(1);
  }
}

const prev = settings.statusLine && settings.statusLine.command;
settings.statusLine = { type: 'command', command };

fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');

console.log('✓ Status bar installed.');
console.log(`  settings: ${settingsPath}`);
console.log(`  command : ${command}`);
if (prev && prev !== command) console.log(`  (replaced previous statusLine command: ${prev})`);
console.log('\nNext: restart Claude Code (or start a new session) and accept the workspace-trust');
console.log('prompt if shown. The bar appears after the first assistant message.');
console.log('Uninstall: remove the "statusLine" block from the settings file above (or run /statusline delete).');
