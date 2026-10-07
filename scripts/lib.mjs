// Shared helpers for the value pipeline.
import fs from 'node:fs';
import path from 'node:path';

export const FIXTURE_DIR = process.env.GBY_FIXTURES ? path.resolve(process.env.GBY_FIXTURES) : null;

/** fetch JSON with a timeout; in fixture mode, read scripts/fixtures/<name>.json instead. */
export async function getJSON(url, { name, headers = {}, timeoutMs = 20000 } = {}) {
  if (FIXTURE_DIR) {
    const file = path.join(FIXTURE_DIR, `${name}.json`);
    if (!fs.existsSync(file)) throw new Error(`fixture missing: ${file}`);
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { 'user-agent': 'GoBuckYourself/1.0 (+values build)', ...headers }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
    return await res.json();
  } finally { clearTimeout(t); }
}

/** "Amon-Ra St. Brown Jr." -> "amonra st brown" — used to match players across sources. */
export function normName(name = '') {
  return name.toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, '')
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export const POSITIONS = new Set(['QB', 'RB', 'WR', 'TE']);

/** Map a rank/ADP-style number (1 = best) onto the 0–10,000 value scale. */
export function rankToValue(rank, { top = 10000, floor = 150, k = 34 } = {}) {
  return Math.round(floor + (top - floor) * Math.exp(-(rank - 1) / k));
}

export function log(...a) { console.error('[values]', ...a); }

/** fetch text (CSV etc.); in fixture mode read scripts/fixtures/<name> instead. */
export async function getText(url, { name, timeoutMs = 60000 } = {}) {
  if (FIXTURE_DIR) {
    const file = path.join(FIXTURE_DIR, name);
    if (!fs.existsSync(file)) throw new Error(`fixture missing: ${file}`);
    return fs.readFileSync(file, 'utf8');
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { 'user-agent': 'GoBuckYourself/1.0 (+values build)' }, signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
    return await res.text();
  } finally { clearTimeout(t); }
}

/** Minimal RFC-4180 CSV parser -> array of objects keyed by the header row. */
export function parseCSV(text) {
  const rows = []; let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = ''; if (row.length > 1 || row[0] !== '') rows.push(row); row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const [head, ...body] = rows;
  return body.map(r => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

/** The NFL season a date belongs to (Jan–Feb games count toward the previous year's season). */
export const seasonOf = (d = new Date()) => d.getUTCMonth() < 2 ? d.getUTCFullYear() - 1 : d.getUTCFullYear();
