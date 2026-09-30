#!/usr/bin/env node
// One-off: rebuild data/history.json from every past weekly commit of data/values.json.
//   node scripts/backfill-history.mjs
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { readHistory, addSnapshot } from './history.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const git = cmd => execSync(`git ${cmd}`, { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 });
const commits = git('log --reverse --format=%H -- data/values.json').trim().split('\n').filter(Boolean);
const file = path.join(root, 'data/history.json');
let h = readHistory(file);
const byDate = new Map();   // keep the last snapshot of each day
for (const c of commits) {
  let snap; try { snap = JSON.parse(git(`show ${c}:data/values.json`)); } catch { continue; }
  const m = snap.meta || {};
  // skip builds made from test fixtures (they report FantasyPros data we never had live)
  if ((m.sources || []).some(s => s.id === 'fantasypros' && s.players > 0 && !s.skipped)) continue;
  if (!m.generatedAt || !Array.isArray(snap.players)) continue;
  byDate.set(m.generatedAt.slice(0, 10), snap.players);
}
for (const [date, players] of [...byDate].sort()) h = addSnapshot(h, date, players);
fs.writeFileSync(file, JSON.stringify(h));
console.log(`history: ${h.dates.join(', ')} · ${Object.keys(h.players).length} players`);
