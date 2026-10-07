// FantasyPros Expert Consensus Rankings — requires an API key (https://www.fantasypros.com/api-data/).
// Set FANTASYPROS_API_KEY in your environment; the adapter is skipped otherwise.
// Rankings are fetched per position (the ALL list is short for rest-of-season), and each player's position rank
// is turned into value by aggregate.mjs using the trade market's own curve at that position.
import { getJSON, normName, POSITIONS, log } from '../lib.mjs';

export const id = 'fantasypros';
export const label = 'FantasyPros ECR';
// Before Week 2 use draft rankings; once games are played switch to rest-of-season (ROS) rankings.

const SCORING = { ppr: 'PPR', half: 'HALF', std: 'STD' };

export async function load({ season = new Date().getFullYear(), week = 1 } = {}) {
  const type = week >= 2 ? 'ros' : 'draft';
  const key = process.env.FANTASYPROS_API_KEY;
  const players = new Map(); // key -> { name,pos,team, ranks:{[scoring]: positionRank} }
  if (!key && !process.env.GBY_FIXTURES) { log('fantasypros: no FANTASYPROS_API_KEY, skipping'); return { players, skipped: true }; }
  const counts = {};
  for (const [scoring, code] of Object.entries(SCORING)) for (const position of POSITIONS) {
    // QB rankings don't depend on reception scoring — fetch once and reuse
    if (position === 'QB' && scoring !== 'ppr') continue;
    try {
      const data = await getJSON(`https://api.fantasypros.com/public/v2/json/nfl/${season}/consensus-rankings?type=${type}&scoring=${code}&position=${position}`, {
        name: `fantasypros_${scoring}_${position}`, headers: { 'x-api-key': key || '' },
      });
      const rows = (data?.players || []).filter(p => (p.player_position_id || '').toUpperCase() === position && p.rank_ecr != null)
        .sort((a, b) => a.rank_ecr - b.rank_ecr);
      rows.forEach((p, i) => {
        const k = `${normName(p.player_name)}|${position}`;
        const rec = players.get(k) || { name: p.player_name, pos: position, team: p.player_team_id || 'FA', ranks: {} };
        if (position === 'QB') for (const s of Object.keys(SCORING)) rec.ranks[s] = i + 1; else rec.ranks[scoring] = i + 1;
        players.set(k, rec);
      });
      counts[`${position}.${scoring}`] = rows.length;
    } catch (e) { log(`fantasypros ${position} ${scoring} failed: ${e.message}`); }
  }
  log(`fantasypros (${type}): ${players.size} players ${JSON.stringify(counts)}`);
  return { players, type };
}
