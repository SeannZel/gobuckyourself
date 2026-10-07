// Sleeper weekly projections (the numbers the Sleeper app shows) for every remaining week of the fantasy season.
// Undocumented but public endpoint used by the Sleeper app; best-effort — the model falls back to usage data without it.
import { getJSON, log } from '../lib.mjs';

export const id = 'sleeperproj';
export const label = 'Sleeper projections';

const POS_Q = ['QB', 'RB', 'WR', 'TE'].map(p => `position[]=${p}`).join('&');

/** @returns {{ weeks: Map<number, Map<sleeperId, {ppr,half,std}>> }} */
export async function load({ season, fromWeek, toWeek = 17 } = {}) {
  const weeks = new Map();
  if (!season || !fromWeek || fromWeek > toWeek) return { weeks };
  const jobs = [];
  for (let w = fromWeek; w <= toWeek; w++) jobs.push((async () => {
    try {
      const rows = await getJSON(`https://api.sleeper.app/projections/nfl/${season}/${w}?season_type=regular&${POS_Q}`, { name: `sleeper_proj_${w}`, timeoutMs: 45000 });
      const m = new Map();
      for (const r of Array.isArray(rows) ? rows : []) {
        const s = r.stats || {};
        if (s.pts_ppr == null && s.pts_std == null) continue;
        m.set(String(r.player_id), { ppr: +(s.pts_ppr ?? 0), half: +(s.pts_half_ppr ?? s.pts_ppr ?? 0), std: +(s.pts_std ?? 0) });
      }
      if (m.size) weeks.set(w, m);
    } catch (e) { log(`sleeper projections week ${w} failed: ${e.message}`); }
  })());
  await Promise.all(jobs);
  log(`sleeper projections: ${weeks.size} weeks (${fromWeek}–${toWeek}), ${Math.max(0, ...[...weeks.values()].map(m => m.size))} players`);
  return { weeks };
}
