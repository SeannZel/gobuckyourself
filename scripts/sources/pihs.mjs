// PeakedInHighSkool trade value charts (Patreon Google Sheet, link-viewable).
// Configure with PIHS_SHEETS — a JSON map of "<format>.<scoring>" → sheet URL (edit URL with gid, or export URL):
//   PIHS_SHEETS='{"1qb.ppr":"https://docs.google.com/spreadsheets/d/<id>/edit?gid=<gid>","1qb.half":"...","1qb.std":"...","sf.ppr":"..."}'
// Any format/scoring not listed is filled from the closest listed one by the aggregator's fallback logic.
import fs from 'node:fs';
import path from 'node:path';
import { FIXTURE_DIR, normName, POSITIONS, log } from '../lib.mjs';

export const id = 'pihs';
export const label = 'PeakedInHighSkool';

const POS_HEAD = { 'wide receiver': 'WR', 'running back': 'RB', 'tight end': 'TE', 'quarterback': 'QB' };

function exportUrl(u) {
  const m = u.match(/\/spreadsheets\/d\/([\w-]+)/); if (!m) return u;
  const gid = (u.match(/[?#&]gid=(\d+)/) || [])[1] || '0';
  return `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv&gid=${gid}`;
}

// Minimal CSV parser (handles quotes, commas, CRLF).
function parseCSV(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/** Parse one chart tab into [{name,pos,team,age,value,trend,posRank}] */
export function parseChart(csvText) {
  const rows = parseCSV(csvText).map(r => r.map(c => c.trim()));
  // 1. find the position header row + which column each block starts in
  let blocks = [];
  for (const r of rows) {
    const found = [];
    r.forEach((c, i) => { const p = POS_HEAD[c.toLowerCase()]; if (p) found.push({ pos: p, headerCol: i }); });
    if (found.length >= 3) { blocks = found; break; }
  }
  if (!blocks.length) throw new Error('could not find position headers (Wide Receiver / Running Back / ...)');
  // 2. the "Player" cell under each header marks the name column; "Trade Value" marks the value column
  let valueCol = -1;
  for (const r of rows) {
    r.forEach((c, i) => { if (/^trade\s*value$/i.test(c.replace(/\s+/g, ' '))) valueCol = i; });
    if (valueCol >= 0) break;
  }
  if (valueCol < 0) valueCol = rows.find(r => r.some(c => /^\d{1,3}(\.\d)?$/.test(c)))?.findIndex(c => /^\d{1,3}(\.\d)?$/.test(c)) ?? 1;
  const playerRow = rows.find(r => r.filter(c => /^player$/i.test(c)).length >= 3);
  for (const b of blocks) {
    let col = -1;
    if (playerRow) { for (let i = b.headerCol - 2; i <= b.headerCol + 4; i++) if (/^player$/i.test(playerRow[i] || '')) { col = i; break; } }
    b.nameCol = col >= 0 ? col : b.headerCol - 1;
  }
  // 3. walk rows: a player = name cell followed (next row, same column) by "<POS><rank>"
  const out = [];
  const val = s => { const n = parseFloat(String(s).replace(/[^\d.\-]/g, '')); return Number.isFinite(n) ? n : null; };
  for (let i = 0; i < rows.length - 1; i++) {
    for (const b of blocks) {
      const name = rows[i][b.nameCol]; const below = rows[i + 1] || [];
      const rk = (below[b.nameCol] || '').toUpperCase();
      if (!name || !/^[A-Z]{2}\d/.test(rk) || !rk.startsWith(b.pos)) continue;
      const value = val(rows[i + 1][valueCol]) ?? val(rows[i][valueCol]);
      if (value == null) continue;
      out.push({
        name, pos: b.pos, team: (below[b.nameCol + 1] || 'FA').toUpperCase(), age: val(below[b.nameCol + 2]),
        trend: val(below[b.nameCol + 3]) ?? 0, posRank: rk, value,
      });
    }
  }
  return out;
}

/** Manual charts: CSV with name,pos,value (any scale). '# updated=YYYY-MM-DD' comment marks the chart date. */
function loadManual(players) {
  const dir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../data/manual');
  if (!fs.existsSync(dir)) return;
  for (const file of fs.readdirSync(dir)) {
    const m = file.match(/^pihs_(1qb|sf)_(ppr|half|std)\.csv$/); if (!m) continue;
    const [, format, scoring] = m;
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    const updated = (text.match(/#\s*updated=(\d{4}-\d{2}-\d{2})/) || [])[1];
    if (updated) {
      const days = (Date.now() - new Date(updated + 'T00:00:00Z')) / 864e5;
      if (days > 10) log(`pihs manual ${file}: chart is ${Math.round(days)} days old — consider updating it`);
    }
    const rows = parseCSV(text.split('\n').filter(l => !l.startsWith('#')).join('\n')).filter(r => r.length >= 3 && r[0] && r[0] !== 'name');
    const vals = rows.map(r => parseFloat(r[2])).filter(Number.isFinite);
    const max = Math.max(...vals);
    for (const [name, pos, v] of rows) {
      const P = pos.trim().toUpperCase(), value = parseFloat(v);
      if (!POSITIONS.has(P) || !Number.isFinite(value)) continue;
      const k = `${normName(name)}|${P}`;
      const rec = players.get(k) || { name: name.trim(), pos: P, team: null, age: null, values: {} };
      rec.values[format] ??= {};
      rec.values[format][scoring] = Math.round(value / max * 10000);
      players.set(k, rec);
    }
    log(`pihs manual ${format}.${scoring}: ${rows.length} players${updated ? ` (chart ${updated})` : ''}`);
  }
}

export async function load() {
  const players = new Map(); // key -> { name,pos,team, values:{[format]:{[scoring]:value}} }
  let sheets = {};
  try { sheets = JSON.parse(process.env.PIHS_SHEETS || '{}'); } catch { log('pihs: PIHS_SHEETS is not valid JSON'); }
  if (FIXTURE_DIR) sheets = { '1qb.ppr': 'fixture', 'sf.ppr': 'fixture' };
  if (!Object.keys(sheets).length) {
    // No live sheet configured: fall back to hand-entered charts in data/manual/pihs_<format>_<scoring>.csv
    loadManual(players);
    if (!players.size) { log('pihs: no PIHS_SHEETS and no manual charts, skipping'); return { players, skipped: true }; }
    return { players };
  }

  for (const [key, url] of Object.entries(sheets)) {
    const [format, scoring] = key.split('.');
    let text;
    try {
      if (FIXTURE_DIR) text = fs.readFileSync(path.join(FIXTURE_DIR, `pihs_${format}_${scoring}.csv`), 'utf8');
      else {
        const res = await fetch(exportUrl(url), { headers: { 'user-agent': 'GoBuckYourself/1.0' } });
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        text = await res.text();
        if (/<html/i.test(text.slice(0, 200))) throw new Error('got HTML instead of CSV — is the sheet link-viewable?');
      }
      const rows = parseChart(text);
      const max = Math.max(...rows.map(r => r.value));
      for (const r of rows) {
        if (!POSITIONS.has(r.pos)) continue;
        const k = `${normName(r.name)}|${r.pos}`;
        const rec = players.get(k) || { name: r.name, pos: r.pos, team: r.team, age: r.age, values: {} };
        rec.values[format] ??= {};
        rec.values[format][scoring] = Math.round(r.value / max * 10000);
        players.set(k, rec);
      }
      log(`pihs ${key}: ${rows.length} players`);
    } catch (e) { log(`pihs ${key} failed: ${e.message}`); }
  }
  return { players };
}
