// The GoBuckYourself production model: what a player should score for the rest of the fantasy season.
//
//  weekly points  = blend of  Sleeper's weekly projection            (forward-looking, knows depth charts & injuries)
//                   and       usage rate × matchup                  (what his actual opportunities are worth)
//  usage rate     = 65% expected points (from targets, carries, air yards, red-zone looks) + 35% actual points,
//                   so a player who has been lucky/unlucky regresses toward what his role produces
//  matchup        = Vegas implied team total for weeks with a betting line, otherwise the opponent's
//                   points allowed to that position (shrunk toward average early in the season)
//  ROS points     = Σ remaining weeks through 17, byes = 0, fantasy-playoff weeks 15–17 count 1.3×
//
// ROS points become value through points over a replacement-level starter (VORP) at each position,
// and aggregate.mjs maps that ordering onto the market's own value curve so it blends cleanly with market sources.
import config from './config.mjs';

const SCORINGS = ['ppr', 'half', 'std'];
const LAST_WEEK = 17, PLAYOFFS = [15, 16, 17];
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const r1 = x => Math.round(x * 10) / 10;

/** Per-team schedule: team -> week -> { opp, home, implied } */
function schedule(games) {
  const sch = new Map();
  const put = (t, w, v) => { if (!sch.has(t)) sch.set(t, new Map()); sch.get(t).set(w, v); };
  for (const g of games) {
    const imp = g.total != null && g.spread != null ? { home: (g.total + g.spread) / 2, away: (g.total - g.spread) / 2 } : null;
    put(g.home, g.week, { opp: g.away, home: true, implied: imp?.home ?? null, played: g.played });
    put(g.away, g.week, { opp: g.home, home: false, implied: imp?.away ?? null, played: g.played });
  }
  return sch;
}

/** Defense strength: fantasy points allowed per game to each position, as a multiplier vs league average. */
function defenseFactors(usage, sch) {
  const allowed = new Map(); // `${def}|${pos}` -> { pts, games:Set }
  for (const u of usage.values()) for (const w of u.weeks) {
    const opp = sch.get(w.team)?.get(w.week)?.opp; if (!opp) continue;
    const k = `${opp}|${u.pos}`; const a = allowed.get(k) || { pts: 0, games: new Set() };
    a.pts += w.fp; a.games.add(w.week); allowed.set(k, a);
  }
  const f = new Map();
  for (const pos of ['QB', 'RB', 'WR', 'TE']) {
    const rows = [...allowed.entries()].filter(([k]) => k.endsWith('|' + pos)).map(([k, a]) => [k, a.pts / a.games.size, a.games.size]);
    const avg = rows.reduce((s, r) => s + r[1], 0) / (rows.length || 1);
    for (const [k, ppg, n] of rows) {
      const shrink = n / (n + 4); // 4 games of "average" prior — early-season defense numbers are noisy
      f.set(k, clamp(1 + shrink * (ppg / avg - 1), 0.85, 1.15));
    }
  }
  return f;
}

/**
 * @param nfl   output of sources/nflverse.mjs
 * @param proj  output of sources/sleeperproj.mjs
 * @param meta  Map sleeperId -> { team, injury } from sources/sleeper.mjs
 * @returns { week, byKey: Map(key -> model), bySleeper: Map(sleeperId -> model), rank(format, scoring) -> [model...] }
 */
export function buildModel({ nfl, proj, meta }) {
  const week = nfl.week ?? 1;
  const res = { week, byKey: new Map(), bySleeper: new Map(), ok: false, projWeeks: proj.weeks.size, usagePlayers: nfl.usage.size };
  if (week > LAST_WEEK || (!nfl.usage.size && !proj.weeks.size)) return res;
  const sch = schedule(nfl.games);
  const defF = defenseFactors(nfl.usage, sch);

  // league-average implied total per week (for Vegas multipliers)
  const avgImplied = new Map();
  for (const [, wk] of sch) for (const [w, g] of wk) if (g.implied != null) {
    const a = avgImplied.get(w) || [0, 0]; a[0] += g.implied; a[1]++; avgImplied.set(w, a);
  }
  const matchup = (team, pos, w) => {
    const g = sch.get(team)?.get(w); if (!g) return { bye: true, f: 0 };
    if (g.implied != null && avgImplied.get(w)) {
      const [s, n] = avgImplied.get(w);
      return { g, f: clamp(1 + 0.6 * (g.implied / (s / n) - 1), 0.8, 1.2), vegas: true };
    }
    return { g, f: defF.get(`${g.opp}|${pos}`) ?? 1 };
  };

  // Everyone we can model: players with usage, plus anyone Sleeper projects.
  const people = new Map(); // id -> { sleeperId, key, name, pos, team, usage }
  for (const u of nfl.usage.values()) {
    const latest = u.weeks.reduce((a, b) => (b.week > a.week ? b : a));
    const sid = u.sleeperId;
    const team = (sid && meta.get(sid)?.team) || latest.team;
    people.set(sid ? 's' + sid : 'k' + u.key, { sleeperId: sid, key: u.key, name: u.name, pos: u.pos, team, usage: u });
  }
  const projIds = new Set(); for (const m of proj.weeks.values()) for (const id of m.keys()) projIds.add(id);
  for (const sid of projIds) {
    if (people.has('s' + sid)) continue;
    const m = meta.get(sid); if (!m || !m.team || m.team === 'FA') continue;
    people.set('s' + sid, { sleeperId: sid, key: m.key, name: m.name, pos: m.pos, team: m.team, usage: null });
  }

  const weeks = []; for (let w = week; w <= LAST_WEEK; w++) weeks.push(w);
  const all = [];
  for (const p of people.values()) {
    const u = p.usage, inj = (p.sleeperId && meta.get(p.sleeperId)?.injury) || null;
    // usage rate (per game), weighting the last 3 games 1.5×
    let rate = null, ol = null;
    if (u && u.weeks.length) {
      const last = Math.max(...u.weeks.map(w => w.week));
      let W = 0; const acc = { xppr: 0, fppr: 0, xrec: 0, rec: 0 };
      for (const w of u.weeks) { const k = w.week > last - 3 ? 1.5 : 1; W += k; acc.xppr += k * w.xfp; acc.fppr += k * w.fp; acc.xrec += k * w.recX; acc.rec += k * w.rec; }
      const per = x => x / W;
      const x = { ppr: per(acc.xppr), half: per(acc.xppr - 0.5 * acc.xrec), std: per(acc.xppr - acc.xrec) };
      const f = { ppr: per(acc.fppr), half: per(acc.fppr - 0.5 * acc.rec), std: per(acc.fppr - acc.rec) };
      rate = Object.fromEntries(SCORINGS.map(s => [s, 0.65 * x[s] + 0.35 * f[s]]));
      const g = u.weeks.length, sum = k => u.weeks.reduce((s, w) => s + w[k], 0);
      ol = {
        g, fpg: r1(sum('fp') / g), xfpg: r1(sum('xfp') / g), luck: r1((sum('fp') - sum('xfp')) / g),
        tgtShare: sum('tgtTeam') ? Math.round(sum('tgt') / sum('tgtTeam') * 100) : null,
        rushShare: sum('rushTeam') ? Math.round(sum('rush') / sum('rushTeam') * 100) : null,
      };
    }
    const inProj = p.sleeperId && projIds.has(String(p.sleeperId));
    if (!rate && !inProj) continue;
    const g = u ? u.weeks.length : 0;
    const wUsage = !rate ? 0 : !inProj ? 1 : 0.45 * Math.min(1, g / 3); // trust usage more as games accumulate
    const ros = { ppr: 0, half: 0, std: 0 }, plain = { ppr: 0 }; let games = 0;
    let next = null; const facs = [], playoffFacs = [];
    for (const w of weeks) {
      const m = matchup(p.team, p.pos, w);
      if (m.bye) continue;
      if (!next) next = { wk: w, opp: m.g.opp, home: m.g.home, implied: m.g.implied != null ? r1(m.g.implied) : null };
      facs.push(m.f); if (PLAYOFFS.includes(w)) playoffFacs.push(m.f);
      // availability from injury designation (Sleeper projections already handle this for their part)
      let avail = 1;
      if (inj) {
        const s = inj.toLowerCase();
        if (/^(ir|pup|nfi|sus|cov)/.test(s)) avail = w < week + 4 ? 0 : 1;
        else if (s === 'out') avail = w === week ? 0 : 1;
        else if (s === 'doubtful') avail = w === week ? 0.25 : 1;
        else if (s === 'questionable') avail = w === week ? 0.85 : 1;
      }
      const pw = proj.weeks.get(w)?.get(String(p.sleeperId));
      const k = PLAYOFFS.includes(w) ? 1.3 : 1;
      for (const s of SCORINGS) {
        const us = rate ? rate[s] * m.f * avail : 0;
        const pr = pw ? pw[s] : null;
        const pts = pr == null ? (rate ? us : 0) : (1 - wUsage) * pr + wUsage * us;
        ros[s] += k * pts; if (s === 'ppr') plain.ppr += pts;
      }
      games++;
    }
    const avgF = facs.length ? facs.reduce((a, b) => a + b, 0) / facs.length : 1;
    const avgP = playoffFacs.length ? playoffFacs.reduce((a, b) => a + b, 0) / playoffFacs.length : null;
    const rec = {
      sleeperId: p.sleeperId, key: p.key, name: p.name, pos: p.pos, team: p.team, ros, avgF, avgP,
      outlook: { ...(ol || {}), ros: Math.round(plain.ppr), rosG: games, ppg: games ? r1(plain.ppr / games) : 0, next, src: inProj ? (rate ? 'blend' : 'proj') : 'usage' },
    };
    all.push(rec);
  }

  // schedule-ease ranks per position (1 = easiest remaining schedule), from team-level factors
  for (const pos of ['QB', 'RB', 'WR', 'TE']) {
    const teams = new Map();
    for (const r of all.filter(r => r.pos === pos)) if (sch.has(r.team) && !teams.has(r.team)) teams.set(r.team, [r.avgF, r.avgP]);
    const byRos = [...teams.entries()].sort((a, b) => b[1][0] - a[1][0]).map(([t]) => t);
    const byPo = [...teams.entries()].filter(([, v]) => v[1] != null).sort((a, b) => b[1][1] - a[1][1]).map(([t]) => t);
    for (const r of all.filter(r => r.pos === pos)) {
      if (!teams.has(r.team)) continue; // free agents / unknown team codes get no schedule rank
      r.outlook.sos = byRos.indexOf(r.team) + 1; r.outlook.sosN = byRos.length;
      r.outlook.playoffSos = byPo.includes(r.team) ? byPo.indexOf(r.team) + 1 : null;
    }
  }
  for (const r of all) { if (r.sleeperId) res.bySleeper.set(String(r.sleeperId), r); if (r.key) res.byKey.set(r.key, r); }
  res.all = all; res.ok = all.length > 0;
  return res;
}

/** Players ordered by value over replacement for a format/scoring: [{ rec, vorp }] best first. */
export function vorpOrder(model, format, scoring) {
  const repl = config.replacement[format];
  const out = [];
  for (const pos of ['QB', 'RB', 'WR', 'TE']) {
    const rows = model.all.filter(r => r.pos === pos).sort((a, b) => b.ros[scoring] - a.ros[scoring]);
    const base = rows[Math.min(rows.length - 1, repl[pos] - 1)]?.ros[scoring] ?? 0;
    for (const r of rows) out.push({ rec: r, vorp: r.ros[scoring] - base });
  }
  return out.sort((a, b) => b.vorp - a.vorp);
}
