// FantasyCalc — market values derived from real trades. Primary source.
// Docs: https://api.fantasycalc.com/values/current?isDynasty=false&numQbs=1&numTeams=12&ppr=1
import { getJSON, normName, POSITIONS, log } from '../lib.mjs';

export const id = 'fantasycalc';
export const label = 'FantasyCalc';

const COMBOS = [
  { format: '1qb', scoring: 'ppr',  numQbs: 1, ppr: 1 },
  { format: '1qb', scoring: 'half', numQbs: 1, ppr: 0.5 },
  { format: '1qb', scoring: 'std',  numQbs: 1, ppr: 0 },
  { format: 'sf',  scoring: 'ppr',  numQbs: 2, ppr: 1 },
  { format: 'sf',  scoring: 'half', numQbs: 2, ppr: 0.5 },
  { format: 'sf',  scoring: 'std',  numQbs: 2, ppr: 0 },
];

/**
 * Returns { players: Map<key, {name,pos,team,age,sleeperId,values:{[format]:{[scoring]:value}}, trend, tier, rosterPct}> }
 * key = normalized name + '|' + pos
 */
export async function load({ numTeams = 12 } = {}) {
  const players = new Map();
  for (const c of COMBOS) {
    const url = `https://api.fantasycalc.com/values/current?isDynasty=false&numQbs=${c.numQbs}&numTeams=${numTeams}&ppr=${c.ppr}`;
    let rows;
    try { rows = await getJSON(url, { name: `fantasycalc_${c.format}_${c.scoring}` }); }
    catch (e) { log(`fantasycalc ${c.format}/${c.scoring} failed: ${e.message}`); continue; }
    const max = Math.max(...rows.map(r => r.value));
    for (const r of rows) {
      const p = r.player; if (!POSITIONS.has(p.position)) continue;
      const key = `${normName(p.name)}|${p.position}`;
      const rec = players.get(key) || {
        name: p.name, pos: p.position, team: p.maybeTeam || 'FA', age: p.maybeAge ? Math.floor(p.maybeAge) : null,
        sleeperId: p.sleeperId || null, espnId: p.espnId || null, values: {}, trend: 0, tier: null, rosterPct: null, tradeFreq: null,
      };
      rec.values[c.format] ??= {};
      rec.values[c.format][c.scoring] = Math.round(r.value / max * 10000); // normalize so the top player = 10,000
      if (c.format === '1qb' && c.scoring === 'ppr') {
        rec.trend = r.trend30Day || 0; rec.tier = r.maybeTier ?? null;
        rec.rosterPct = r.maybeRosterPercent ?? null; rec.tradeFreq = r.maybeTradeFrequency ?? null;
      }
      players.set(key, rec);
    }
  }
  log(`fantasycalc: ${players.size} players`);
  return { players };
}
