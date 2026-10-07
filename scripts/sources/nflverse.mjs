// nflverse / ffverse open data — no API key.
//  • Schedule + Vegas lines:  nflverse/nfldata games.csv (spread_line, total_line for upcoming weeks, scores for played ones)
//  • Usage & expected points: ffverse/ffopportunity ep_weekly_<season>.csv — per player-week targets, carries,
//    air yards and *expected* fantasy points (what an average player would score with the same opportunities)
//  • ID crosswalk:            dynastyprocess db_playerids.csv (nflverse gsis_id -> Sleeper id)
import { getText, parseCSV, normName, POSITIONS, log, seasonOf } from '../lib.mjs';

export const id = 'nflverse';
export const label = 'nflverse usage & Vegas lines';

const URLS = {
  games: 'https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv',
  ep: s => `https://github.com/ffverse/ffopportunity/releases/download/latest-data/ep_weekly_${s}.csv`,
  ids: 'https://raw.githubusercontent.com/dynastyprocess/data/master/files/db_playerids.csv',
};
// nflverse team codes -> the codes the site (Sleeper/ESPN) uses
const TEAM = { LA: 'LAR', JAC: 'JAX', WSH: 'WAS', OAK: 'LV', SD: 'LAC', STL: 'LAR' };
export const team = t => TEAM[t] || t;
const num = x => (x === '' || x == null || x === 'NA' ? null : +x);

export async function load({ season = seasonOf() } = {}) {
  const out = { season, games: [], week: null, lastPlayed: 0, usage: new Map(), gsisToSleeper: new Map(), ok: false };

  // ---- schedule & lines ----
  try {
    const rows = parseCSV(await getText(URLS.games, { name: 'nflverse_games.csv' }));
    for (const r of rows) {
      if (+r.season !== season || r.game_type !== 'REG') continue;
      out.games.push({
        week: +r.week, home: team(r.home_team), away: team(r.away_team),
        played: r.result !== '' && r.result !== 'NA',
        homeScore: num(r.home_score), awayScore: num(r.away_score),
        spread: num(r.spread_line), total: num(r.total_line), // spread_line > 0 => home favored by that many
      });
    }
    const unplayed = out.games.filter(g => !g.played).map(g => g.week);
    out.week = unplayed.length ? Math.min(...unplayed) : 19;
    out.lastPlayed = Math.max(0, ...out.games.filter(g => g.played).map(g => g.week));
    log(`nflverse: ${out.games.length} ${season} games, current week ${out.week}, lines through week ${Math.max(0, ...out.games.filter(g => g.total != null && !g.played).map(g => g.week))}`);
  } catch (e) { log(`nflverse games failed: ${e.message}`); }

  // ---- id crosswalk ----
  try {
    for (const r of parseCSV(await getText(URLS.ids, { name: 'nflverse_ids.csv' })))
      if (r.gsis_id && r.sleeper_id && r.gsis_id !== 'NA' && r.sleeper_id !== 'NA') out.gsisToSleeper.set(r.gsis_id, r.sleeper_id);
  } catch (e) { log(`nflverse ids failed: ${e.message}`); }

  // ---- usage & expected points ----
  try {
    const rows = parseCSV(await getText(URLS.ep(season), { name: `nflverse_ep_${season}.csv` }));
    for (const r of rows) {
      if (!POSITIONS.has(r.position)) continue;
      const k = r.player_id;
      const u = out.usage.get(k) || {
        gsis: k, sleeperId: out.gsisToSleeper.get(k) || null, key: `${normName(r.full_name)}|${r.position}`,
        name: r.full_name, pos: r.position, team: team(r.posteam), weeks: [],
      };
      u.team = team(r.posteam); // latest row wins (handles mid-season trades)
      const rec = +r.receptions || 0, recX = +r.receptions_exp || 0;
      u.weeks.push({
        week: +r.week, team: team(r.posteam),
        fp: +r.total_fantasy_points || 0, xfp: +r.total_fantasy_points_exp || 0, // PPR
        rec, recX,
        tgt: +r.rec_attempt || 0, tgtTeam: +r.rec_attempt_team || 0,
        rush: +r.rush_attempt || 0, rushTeam: +r.rush_attempt_team || 0,
        pass: +r.pass_attempt || 0,
      });
      out.usage.set(k, u);
    }
    out.ok = out.usage.size > 0;
    log(`nflverse: usage for ${out.usage.size} players (${new Set(rows.map(r => r.week)).size} weeks)`);
  } catch (e) { log(`nflverse usage failed: ${e.message}`); }
  return out;
}
