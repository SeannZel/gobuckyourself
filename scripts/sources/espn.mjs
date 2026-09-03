// ESPN Fantasy — public (unauthenticated) player info: ADP and % rostered, plus team bye weeks.
// Endpoint is undocumented but long-lived; treated as best-effort.
import { getJSON, normName, POSITIONS, rankToValue, log } from '../lib.mjs';

export const id = 'espn';
export const label = 'ESPN ADP';

const POS_BY_ID = { 1: 'QB', 2: 'RB', 3: 'WR', 4: 'TE' };
const TEAM_BY_ID = { 1:'ATL',2:'BUF',3:'CHI',4:'CIN',5:'CLE',6:'DAL',7:'DEN',8:'DET',9:'GB',10:'TEN',11:'IND',12:'KC',13:'LV',14:'LAR',15:'MIA',16:'MIN',17:'NE',18:'NO',19:'NYG',20:'NYJ',21:'PHI',22:'ARI',23:'PIT',24:'LAC',25:'SF',26:'SEA',27:'TB',28:'WAS',29:'CAR',30:'JAX',33:'BAL',34:'HOU' };

export async function load({ season = new Date().getFullYear(), limit = 400 } = {}) {
  const base = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}`;
  const filter = { players: { limit, sortPercOwned: { sortAsc: false, sortPriority: 1 }, filterSlotIds: { value: [0, 2, 4, 6] } } };
  const players = new Map();
  let byes = {};
  try {
    const sched = await getJSON(`${base}?view=proTeamSchedules_wl`, { name: 'espn_schedules' });
    for (const t of sched?.settings?.proTeams || []) if (TEAM_BY_ID[t.id] && t.byeWeek) byes[TEAM_BY_ID[t.id]] = t.byeWeek;
  } catch (e) { log(`espn byes failed: ${e.message}`); }

  try {
    const data = await getJSON(`${base}/segments/0/leaguedefaults/3?view=kona_player_info`, {
      name: 'espn_players', headers: { 'x-fantasy-filter': JSON.stringify(filter) },
    });
    for (const row of data?.players || []) {
      const p = row.player || row; const pos = POS_BY_ID[p.defaultPositionId]; if (!pos) continue;
      const adp = p.ownership?.averageDraftPosition; if (!adp) continue;
      const key = `${normName(p.fullName)}|${pos}`;
      // ADP -> value. ADP is a draft-position curve, so use the shared rank curve (top pick = 10,000).
      players.set(key, {
        name: p.fullName, pos, team: TEAM_BY_ID[p.proTeamId] || 'FA', espnId: String(p.id),
        adp, rosterPct: Math.round(p.ownership?.percentOwned ?? 0) / 100, injury: p.injuryStatus && p.injuryStatus !== 'ACTIVE' ? p.injuryStatus : null,
        value: rankToValue(adp),
      });
    }
  } catch (e) { log(`espn players failed: ${e.message}`); }
  log(`espn: ${players.size} players, ${Object.keys(byes).length} bye weeks`);
  return { players, byes };
}
