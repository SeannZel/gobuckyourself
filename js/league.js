/* ===========================================================
   GoBuckYourself — Sleeper league sync + lineup-aware trade math
   Requires js/players.js and js/app.js (GIQ) to be loaded first.
   Talks to Sleeper's public API directly from the browser (no login needed).
   =========================================================== */

const LEAGUE = (() => {
  const API = 'https://api.sleeper.app/v1';
  const KEY = 'gby-league';           // { leagueId, rosterId, username }
  const CACHE_MIN = 10;                // minutes to reuse API responses within a session
  const BENCH_WEIGHT = 0.2;            // how much depth counts relative to starters
  const BENCH_DEPTH = 4;               // how many bench players count toward depth

  // Which player positions can fill each Sleeper lineup slot. Slots not listed (K, DEF, IDP, BN) are ignored.
  const SLOT_ELIGIBLE = {
    QB: ['QB'], RB: ['RB'], WR: ['WR'], TE: ['TE'],
    FLEX: ['RB', 'WR', 'TE'], WRRB_FLEX: ['WR', 'RB'], REC_FLEX: ['WR', 'TE'],
    SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'],
  };
  const SLOT_ORDER = ['QB', 'RB', 'WR', 'TE', 'REC_FLEX', 'WRRB_FLEX', 'FLEX', 'SUPER_FLEX']; // most → least restrictive
  const SLOT_LABEL = { FLEX: 'FLEX', WRRB_FLEX: 'W/R', REC_FLEX: 'W/T', SUPER_FLEX: 'SF' };

  let cfg = {};
  try { cfg = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (_) {}
  let data = null;       // loaded league snapshot
  let loading = null;

  function save() { try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch (_) {} }

  async function get(path) {
    const ck = 'gby-sl:' + path;
    try {
      const hit = JSON.parse(sessionStorage.getItem(ck) || 'null');
      if (hit && Date.now() - hit.t < CACHE_MIN * 60e3) return hit.v;
    } catch (_) {}
    const res = await fetch(API + path);
    if (!res.ok) throw new Error(`Sleeper ${res.status} for ${path}`);
    const v = await res.json();
    try { sessionStorage.setItem(ck, JSON.stringify({ t: Date.now(), v })); } catch (_) {}
    return v;
  }
  function clearCache() {
    try { Object.keys(sessionStorage).filter(k => k.startsWith('gby-sl:')).forEach(k => sessionStorage.removeItem(k)); } catch (_) {}
  }

  // ---------- connect flow ----------
  async function season() {
    try { const s = await get('/state/nfl'); return s.league_season || s.season || String(new Date().getFullYear()); }
    catch (_) { return String(new Date().getFullYear()); }
  }
  /** Username → { user, leagues[] } for the current season. */
  async function findLeagues(username) {
    const user = await get(`/user/${encodeURIComponent(username.trim())}`);
    if (!user || !user.user_id) throw new Error(`No Sleeper user named "${username}"`);
    const leagues = (await get(`/user/${user.user_id}/leagues/nfl/${await season()}`)) || [];
    return { user, leagues: leagues.filter(l => l.sport === 'nfl' || !l.sport) };
  }
  function connect({ leagueId, rosterId = null, username = cfg.username }) {
    cfg = { leagueId: String(leagueId), rosterId: rosterId == null ? null : Number(rosterId), username };
    save(); data = null; loading = null;
  }
  function setMyTeam(rosterId) { cfg.rosterId = Number(rosterId); save(); if (data) markMe(); emit(); }
  function disconnect() { cfg = {}; save(); data = null; loading = null; clearCache(); emit(); }
  const configured = () => !!cfg.leagueId;

  // ---------- load ----------
  function load(force = false) {
    if (!cfg.leagueId) return Promise.resolve(null);
    if (force) { clearCache(); data = null; loading = null; }
    if (data) return Promise.resolve(data);
    if (loading) return loading;
    loading = (async () => {
      const id = cfg.leagueId;
      const [league, rosters, users] = await Promise.all([get(`/league/${id}`), get(`/league/${id}/rosters`), get(`/league/${id}/users`)]);
      if (!league) throw new Error('League not found');
      const userById = Object.fromEntries((users || []).map(u => [u.user_id, u]));
      const slots = (league.roster_positions || []).filter(s => SLOT_ELIGIBLE[s]);
      const teams = (rosters || []).map(r => {
        const u = userById[r.owner_id] || {};
        const s = r.settings || {};
        return {
          rosterId: r.roster_id, ownerId: r.owner_id,
          name: (u.metadata && u.metadata.team_name) || u.display_name || `Team ${r.roster_id}`,
          owner: u.display_name || '', avatar: u.avatar ? `https://sleepercdn.com/avatars/thumbs/${u.avatar}` : null,
          wins: s.wins || 0, losses: s.losses || 0, ties: s.ties || 0,
          fpts: (s.fpts || 0) + (s.fpts_decimal || 0) / 100,
          sids: (r.players || []).map(String), reserve: new Set((r.reserve || []).map(String)),
        };
      });
      const sc = league.scoring_settings || {};
      data = {
        id, name: league.name, season: league.season, avatar: league.avatar ? `https://sleepercdn.com/avatars/thumbs/${league.avatar}` : null,
        slots, teams, size: teams.length,
        detected: {
          format: (league.roster_positions || []).includes('SUPER_FLEX') || (league.roster_positions || []).filter(p => p === 'QB').length > 1 ? 'sf' : '1qb',
          scoring: sc.rec >= 0.75 ? 'ppr' : sc.rec >= 0.25 ? 'half' : 'std',
        },
      };
      markMe();
      return data;
    })().catch(e => { loading = null; throw e; });
    return loading;
  }
  function markMe() {
    if (!data) return;
    if (cfg.rosterId == null && cfg.username) {
      // guess from the username the user connected with
      const t = data.teams.find(t => (t.owner || '').toLowerCase() === cfg.username.toLowerCase());
      if (t) { cfg.rosterId = t.rosterId; save(); }
    }
    data.teams.forEach(t => { t.isMe = t.rosterId === cfg.rosterId; });
  }
  const emit = () => document.dispatchEvent(new CustomEvent('giq:league', { detail: data }));

  // ---------- players on rosters ----------
  /** sleeperId → current ranked player (with .value for the active settings) */
  function valueMap() {
    const m = new Map();
    for (const p of GIQ.ranked('ALL')) if (p.sleeperId) m.set(String(p.sleeperId), p);
    return m;
  }
  const myTeam = () => data && data.teams.find(t => t.isMe) || null;
  const team = rosterId => data && data.teams.find(t => t.rosterId === Number(rosterId)) || null;

  /** Valued players on a team (sorted by value). Unvalued/K/DEF are counted but excluded. */
  function roster(t, vm = valueMap()) {
    const players = t.sids.map(s => vm.get(s)).filter(Boolean).sort((a, b) => b.value - a.value);
    return { players, unvalued: t.sids.length - players.length };
  }
  /** Which team rosters a given site player (by our player object). */
  function teamOfPlayer(p) {
    if (!data || !p || !p.sleeperId) return null;
    const sid = String(p.sleeperId);
    return data.teams.find(t => t.sids.includes(sid)) || null;
  }
  /** If every player in the list is on one roster, that team; else null. */
  function teamOfAll(players) {
    if (!players.length) return null;
    const ts = players.map(teamOfPlayer);
    return ts[0] && ts.every(t => t && t.rosterId === ts[0].rosterId) ? ts[0] : null;
  }

  // ---------- lineup optimizer ----------
  /** Fill the league's starting slots with the best available players (greedy, most-restrictive slot first). */
  function lineup(players, slots = data ? data.slots : ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX']) {
    const pool = [...players].sort((a, b) => b.value - a.value);
    const used = new Set(); const starters = [];
    const ordered = [...slots].sort((a, b) => SLOT_ORDER.indexOf(a) - SLOT_ORDER.indexOf(b));
    for (const slot of ordered) {
      const pick = pool.find(p => !used.has(p.id) && SLOT_ELIGIBLE[slot].includes(p.pos));
      if (pick) { used.add(pick.id); starters.push({ slot, label: SLOT_LABEL[slot] || slot, p: pick }); }
      else starters.push({ slot, label: SLOT_LABEL[slot] || slot, p: null });
    }
    const bench = pool.filter(p => !used.has(p.id));
    const starterValue = starters.reduce((s, x) => s + (x.p ? x.p.value : 0), 0);
    const benchValue = bench.slice(0, BENCH_DEPTH).reduce((s, p) => s + p.value, 0);
    // present starters in the league's slot order
    const byOrder = []; const left = [...starters];
    for (const s of slots) { const i = left.findIndex(x => x.slot === s); byOrder.push(left.splice(i, 1)[0]); }
    return { starters: byOrder, bench, starterValue, benchValue, score: starterValue + BENCH_WEIGHT * benchValue };
  }

  /** How a trade changes one team: `give` leaves, `get` arrives. */
  function tradeImpact(t, give, get, vm = valueMap()) {
    const cur = roster(t, vm).players;
    const giveIds = new Set(give.map(p => p.id));
    const after = cur.filter(p => !giveIds.has(p.id)).concat(get.filter(p => !cur.some(c => c.id === p.id)));
    const b = lineup(cur), a = lineup(after);
    const bStart = new Set(b.starters.filter(x => x.p).map(x => x.p.id));
    const aStart = new Set(a.starters.filter(x => x.p).map(x => x.p.id));
    return {
      team: t, before: b, after: a,
      delta: a.score - b.score, starterDelta: a.starterValue - b.starterValue,
      pct: b.score ? (a.score - b.score) / b.score : 0,
      startersIn: a.starters.filter(x => x.p && !bStart.has(x.p.id)),
      startersOut: b.starters.filter(x => x.p && !aStart.has(x.p.id)),
    };
  }

  // ---------- power rankings ----------
  function powerRankings() {
    if (!data) return [];
    const vm = valueMap();
    return data.teams.map(t => {
      const { players, unvalued } = roster(t, vm);
      const lu = lineup(players);
      const byPos = { QB: 0, RB: 0, WR: 0, TE: 0 };
      lu.starters.forEach(x => { if (x.p) byPos[x.p.pos] += x.p.value; });
      return { team: t, players, unvalued, lineup: lu, byPos, score: lu.score };
    }).sort((a, b) => b.score - a.score).map((r, i, all) => {
      r.rank = i + 1;
      r.posRank = {};
      for (const pos of ['QB', 'RB', 'WR', 'TE']) r.posRank[pos] = 1 + all.filter(o => o.byPos[pos] > r.byPos[pos]).length;
      return r;
    });
  }

  // ---------- trade finder ----------
  /**
   * Scan every other roster for deals that raise my lineup score without hurting theirs (much),
   * and are roughly fair on value. Shapes: 1-for-1, 2-for-1 (consolidate), 1-for-2 (depth), 2-for-2.
   * opts: { offerOnly: Set<id> (my players I'm willing to move), wantPos: Set<pos> (every player I get must be one of these),
   *         givePos: Set<pos> (every player I send must be one of these), mustStart: every player I get must start for me,
   *         edge: value edge I'm looking for (0 = fair, 0.2 = I receive ~20% more), perTeam, max }
   * Value window: fair = ±10%; with an edge e, e-6% … e+10%.
   * Runs a strict pass; if that finds fewer than 10 deals, a looser "close call" pass tops the list up.
   * Returns an array of deals with a `.stats` property: { teams, strict, stretch }.
   */
  const PASSES = {
    strict:  { minMine: 0.005, theirFloor: -0.005, widen: 0,    perTeam: 4 },
    stretch: { minMine: 0.002, theirFloor: -0.015, widen: 0.05, perTeam: 2 },
  };
  function findTrades(opts = {}) {
    const me = myTeam(); if (!me) return Object.assign([], { stats: { teams: 0, strict: 0, stretch: 0 } });
    const { offerOnly = null, wantPos = new Set(), givePos = new Set(), mustStart = false, edge = 0, max = 24, partner = null, perTeam = null } = opts;
    const vm = valueMap();
    const mine = roster(me, vm).players;
    const myBase = lineup(mine);
    const myPool = mine.filter(p => p.value >= 250 && (!offerOnly || !offerOnly.size || offerOnly.has(p.id)) && (!givePos.size || givePos.has(p.pos))).slice(0, 20);
    const others = data.teams.filter(t => !t.isMe && (partner == null || t.rosterId === +partner)).map(t => {
      const theirs = roster(t, vm).players;
      // every piece I receive must match the positions I asked for
      return { t, theirs, base: lineup(theirs), pool: theirs.filter(p => p.value >= 250 && (!wantPos.size || wantPos.has(p.pos))).slice(0, 20) };
    });
    const pairs = arr => { const o = []; for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) o.push([arr[i], arr[j]]); return o; };
    const myPairs = pairs(myPool.slice(0, 12));
    const key = d => d.team.rosterId + ':' + d.give.map(p => p.id).sort().join('+') + '>' + d.get.map(p => p.id).sort().join('+');

    function scan(pass, taken) {
      const P = PASSES[pass];
      const lo = (edge === 0 ? -0.10 : edge - 0.06) - P.widen, hi = (edge === 0 ? 0.10 : edge + 0.10) + P.widen;
      const out = [];
      for (const { t, theirs, base: theirBase, pool } of others) {
        const found = [];
        const tryDeal = (give, get) => {
          const gv = GIQ.adjustedTotal(give.map(p => p.value)), rv = GIQ.adjustedTotal(get.map(p => p.value));
          const fair = (rv - gv) / Math.max(gv, rv);
          if (fair < lo || fair > hi) return;
          const giveIds = new Set(give.map(p => p.id)), getIds = new Set(get.map(p => p.id));
          const meAfter = lineup(mine.filter(p => !giveIds.has(p.id)).concat(get));
          const myGain = meAfter.score - myBase.score;
          if (myGain < myBase.score * P.minMine) return;
          if (mustStart) {   // skip deals where something I receive would just sit on my bench
            const starters = new Set(meAfter.starters.filter(x => x.p).map(x => x.p.id));
            if (!get.every(p => starters.has(p.id))) return;
          }
          const themAfter = lineup(theirs.filter(p => !getIds.has(p.id)).concat(give));
          const theirGain = themAfter.score - theirBase.score;
          if (theirGain < theirBase.score * P.theirFloor) return;
          const mutual = theirGain > theirBase.score * 0.001;
          const d = {
            team: t, give, get, fairPct: fair, myGain, theirGain, stretch: pass === 'stretch',
            myPct: myGain / myBase.score, theirPct: theirGain / theirBase.score, mutual,
            // deals that help both sides get accepted, so they rank first
            rank: myGain / myBase.score + 0.75 * Math.max(0, theirGain) / theirBase.score + (mutual ? 0.03 : 0)
              + (edge > 0 ? 0.15 * fair : 0) - (give.length + get.length - 2) * 0.002,   // slight preference for simpler deals
            // how likely the other manager says yes: needs a lineup reason, and gets harder as the value gap grows
            odds: mutual && fair <= 0.10 ? 'likely' : fair <= 0.22 && theirGain > -theirBase.score * 0.003 ? 'maybe' : 'long',
          };
          if (!taken.has(key(d))) found.push(d);
        };
        const theirPairs = pairs(pool.slice(0, 12));
        for (const a of myPool) for (const b of pool) tryDeal([a], [b]);            // 1-for-1
        for (const g of myPairs) for (const b of pool) tryDeal(g, [b]);             // 2-for-1: consolidate
        for (const a of myPool) for (const g of theirPairs) tryDeal([a], g);        // 1-for-2: depth
        const my10 = myPairs.filter(g => myPool.indexOf(g[1]) < 10), their10 = theirPairs.filter(g => pool.indexOf(g[1]) < 10);
        for (const g of my10) for (const h of their10) tryDeal(g, h);               // 2-for-2
        // best few per team, no repeated target
        const seen = new Set();
        found.sort((x, y) => y.rank - x.rank).forEach(d => {
          const k = d.get.map(p => p.id).sort().join('+');
          if (seen.has(k) || seen.size >= (perTeam || P.perTeam)) return; seen.add(k); out.push(d);
        });
      }
      return out;
    }

    const strict = scan('strict', new Set());
    let stretch = [];
    if (strict.length < 10) stretch = scan('stretch', new Set(strict.map(key)));
    // spread the list across leaguemates: each team's best deal first, then their second-best, and so on
    const diversify = list => {
      const byTeam = new Map();
      list.sort((x, y) => y.rank - x.rank).forEach(d => { if (!byTeam.has(d.team.rosterId)) byTeam.set(d.team.rosterId, []); byTeam.get(d.team.rosterId).push(d); });
      const out = [];
      for (let round = 0; out.length < list.length; round++) {
        const tier = [...byTeam.values()].map(ds => ds[round]).filter(Boolean).sort((x, y) => y.rank - x.rank);
        if (!tier.length) break; out.push(...tier);
      }
      return out;
    };
    const all = diversify(strict).concat(diversify(stretch)).slice(0, max);
    return Object.assign(all, { stats: {
      teams: new Set(all.map(d => d.team.rosterId)).size,
      strict: all.filter(d => !d.stretch).length, stretch: all.filter(d => d.stretch).length,
    } });
  }

  return {
    get config() { return { ...cfg }; }, get data() { return data; },
    configured, findLeagues, connect, setMyTeam, disconnect, load, emit,
    myTeam, team, roster, valueMap, teamOfPlayer, teamOfAll, lineup, tradeImpact, powerRankings, findTrades,
    SLOT_LABEL,
  };
})();
