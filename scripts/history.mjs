// Weekly value history for player pages.
// data/history.json = { formats: [6 keys], dates: ["YYYY-MM-DD", ...], players: { key: [["YYYY-MM-DD", v0..v5], ...] } }
// key = Sleeper id when known, else "n:<normalized name>|<POS>", so a player keeps one history across weeks.
import fs from 'node:fs';
import { normName } from './lib.mjs';

export const FORMATS = ['1qb.ppr', '1qb.half', '1qb.std', 'sf.ppr', 'sf.half', 'sf.std'];
export const historyKey = p => p.sleeperId ? String(p.sleeperId) : `n:${normName(p.name)}|${p.pos}`;

export function readHistory(file) {
  try { const h = JSON.parse(fs.readFileSync(file, 'utf8')); if (h.dates && h.players) return h; } catch (_) {}
  return { formats: FORMATS, dates: [], players: {} };
}

/** Add (or replace) the snapshot for `date`. */
export function addSnapshot(h, date, players) {
  if (!h.dates.includes(date)) { h.dates.push(date); h.dates.sort(); }
  for (const k of Object.keys(h.players)) {
    h.players[k] = h.players[k].filter(pt => pt[0] !== date);
    if (!h.players[k].length) delete h.players[k];
  }
  for (const p of players) {
    const v = p.values; if (!v) continue;
    const row = [date, ...FORMATS.map(f => { const [a, b] = f.split('.'); return v[a]?.[b] ?? null; })];
    const k = historyKey(p);
    (h.players[k] ||= []).push(row);
    h.players[k].sort((a, b) => a[0].localeCompare(b[0]));
  }
  return h;
}

export function appendHistory(file, date, players) {
  const h = addSnapshot(readHistory(file), date, players);
  fs.writeFileSync(file, JSON.stringify(h));
  return h;
}
