// FantasyPros Expert Consensus Rankings — requires an API key (https://www.fantasypros.com/api-data/).
// Set FANTASYPROS_API_KEY in your environment; the adapter is skipped otherwise.
import { getJSON, normName, POSITIONS, rankToValue, log } from '../lib.mjs';

export const id = 'fantasypros';
export const label = 'FantasyPros ECR';

const SCORING = { ppr: 'PPR', half: 'HALF', std: 'STD' };

export async function load({ season = new Date().getFullYear() } = {}) {
  const key = process.env.FANTASYPROS_API_KEY;
  const players = new Map(); // key -> { name,pos,team, values:{[scoring]:value} }
  if (!key && !process.env.GBY_FIXTURES) { log('fantasypros: no FANTASYPROS_API_KEY, skipping'); return { players, skipped: true }; }
  for (const [scoring, code] of Object.entries(SCORING)) {
    try {
      const data = await getJSON(`https://api.fantasypros.com/public/v2/json/nfl/${season}/consensus-rankings?type=draft&scoring=${code}&position=ALL`, {
        name: `fantasypros_${scoring}`, headers: { 'x-api-key': key || '' },
      });
      for (const p of data?.players || []) {
        const pos = (p.player_position_id || '').toUpperCase(); if (!POSITIONS.has(pos)) continue;
        const k = `${normName(p.player_name)}|${pos}`;
        const rec = players.get(k) || { name: p.player_name, pos, team: p.player_team_id || 'FA', values: {} };
        rec.values[scoring] = rankToValue(p.rank_ecr);
        players.set(k, rec);
      }
    } catch (e) { log(`fantasypros ${scoring} failed: ${e.message}`); }
  }
  log(`fantasypros: ${players.size} players`);
  return { players };
}
