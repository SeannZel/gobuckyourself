// Weekly fantasy scoring from Sleeper's public stats API, for the players in our value pool.
// data/scoring.json = { season, throughWeek, updatedAt, fields: [...], weeks: { "1": { "<sleeperId>": [..fields] } } }
import fs from 'node:fs';
import { getJSON, log, FIXTURE_DIR } from './lib.mjs';

export const FIELDS = ['pts_ppr', 'pts_half_ppr', 'pts_std', 'gp', 'pass_yd', 'pass_td', 'pass_int', 'rush_att', 'rush_yd', 'rush_td', 'rec_tgt', 'rec', 'rec_yd', 'rec_td'];

export async function buildScoring(file, players) {
  if (FIXTURE_DIR) { log('scoring: skipped in fixture mode'); return null; }
  let state;
  try { state = await getJSON('https://api.sleeper.app/v1/state/nfl', { name: 'sleeper_state' }); }
  catch (e) { log(`scoring: state failed: ${e.message}`); return null; }
  const season = String(state.season);
  // completed regular-season weeks: during the regular season Sleeper's `week` is the upcoming/current week
  const through = state.season_type === 'regular' ? Math.max(0, (state.week || 1) - 1) : state.season_type === 'post' ? 18 : 0;
  const ids = new Set(players.map(p => p.sleeperId).filter(Boolean).map(String));
  let prev = {};
  try { const old = JSON.parse(fs.readFileSync(file, 'utf8')); if (old.season === season) prev = old.weeks || {}; } catch (_) {}
  const weeks = {};
  for (let w = 1; w <= through; w++) {
    try {
      const s = await getJSON(`https://api.sleeper.app/v1/stats/nfl/regular/${season}/${w}`, { name: `sleeper_stats_${w}`, timeoutMs: 60000 });
      const wk = {};
      for (const id of ids) if (s[id]) wk[id] = FIELDS.map(k => +(s[id][k] ?? 0));
      weeks[w] = wk;
    } catch (e) {
      log(`scoring: week ${w} failed (${e.message}) — keeping previous data`);
      if (prev[w]) weeks[w] = prev[w];
    }
  }
  const out = { season, throughWeek: through, updatedAt: new Date().toISOString(), fields: FIELDS, weeks };
  fs.writeFileSync(file, JSON.stringify(out));
  log(`scoring: ${season} weeks 1–${through}, ${Object.values(weeks).reduce((n, w) => n + Object.keys(w).length, 0)} player-weeks`);
  return out;
}
