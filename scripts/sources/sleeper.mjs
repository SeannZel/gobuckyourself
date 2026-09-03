// Sleeper — player metadata (team, age, injury) and trending adds/drops as a momentum signal.
// Docs: https://docs.sleeper.com/
import { getJSON, normName, POSITIONS, log } from '../lib.mjs';

export const id = 'sleeper';
export const label = 'Sleeper trends';

export async function load({ lookbackHours = 168 } = {}) {
  const meta = new Map();   // sleeperId -> {name,pos,team,age,injury,searchRank}
  const byKey = new Map();  // normName|pos -> sleeperId
  const momentum = new Map(); // sleeperId -> adds - drops
  try {
    const dump = await getJSON('https://api.sleeper.app/v1/players/nfl', { name: 'sleeper_players', timeoutMs: 60000 });
    for (const [sid, p] of Object.entries(dump)) {
      if (!POSITIONS.has(p.position) || !p.active) continue;
      meta.set(sid, { name: p.full_name || `${p.first_name} ${p.last_name}`, pos: p.position, team: p.team || 'FA',
        age: p.age ?? null, injury: p.injury_status || null, searchRank: p.search_rank ?? null });
      byKey.set(`${normName(p.full_name || '')}|${p.position}`, sid);
    }
  } catch (e) { log(`sleeper players failed: ${e.message}`); }

  for (const kind of ['add', 'drop']) {
    try {
      const rows = await getJSON(`https://api.sleeper.app/v1/players/nfl/trending/${kind}?lookback_hours=${lookbackHours}&limit=100`, { name: `sleeper_trending_${kind}` });
      for (const r of rows) momentum.set(r.player_id, (momentum.get(r.player_id) || 0) + (kind === 'add' ? r.count : -r.count));
    } catch (e) { log(`sleeper trending ${kind} failed: ${e.message}`); }
  }
  log(`sleeper: ${meta.size} players, ${momentum.size} trending`);
  return { meta, byKey, momentum };
}
