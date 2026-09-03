// The GoBuckYourself value algorithm: blend market values (FantasyCalc), draft market (ESPN ADP),
// expert consensus (FantasyPros) and waiver momentum (Sleeper) into one 0–10,000 scale.
import config from './config.mjs';

const FORMATS = ['1qb', 'sf'];
const SCORINGS = ['ppr', 'half', 'std'];
const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 1; };
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

export function aggregate({ fc, espn, sleeper, fp }) {
  const cfg = config;
  // How much more a QB is worth in Superflex, learned from FantasyCalc so ADP/ECR sources get the same treatment.
  const qbRatios = [];
  for (const p of fc.players.values()) if (p.pos === 'QB' && p.values.sf?.ppr && p.values['1qb']?.ppr) qbRatios.push(p.values.sf.ppr / p.values['1qb'].ppr);
  const qbUplift = clamp(median(qbRatios), 1, 3);

  // Union of every player any source knows about.
  const keys = new Set([...fc.players.keys(), ...espn.players.keys(), ...fp.players.keys()]);
  const maxMomentum = Math.max(1, ...[...sleeper.momentum.values()].map(Math.abs));

  const out = [];
  for (const key of keys) {
    const a = fc.players.get(key), b = espn.players.get(key), c = fp.players.get(key);
    const base = a || b || c;
    const [, pos] = key.split('|');
    const sleeperId = a?.sleeperId || sleeper.byKey.get(key) || null;
    const meta = sleeperId ? sleeper.meta.get(sleeperId) : null;

    // Per-source value for a given format/scoring, or null when the source doesn't cover the player.
    const sourceValue = (src, format, scoring) => {
      if (src === 'fantasycalc') {
        if (!a) return null;
        const v = a.values[format]?.[scoring] ?? (a.values[format]?.ppr != null ? a.values[format].ppr * cfg.scoringMult[scoring][pos] : null);
        return v ?? null;
      }
      if (src === 'espn') {
        if (!b) return null;
        let v = b.value * cfg.scoringMult[scoring][pos];
        if (format === 'sf' && pos === 'QB') v *= qbUplift;
        return v;
      }
      if (src === 'fantasypros') {
        if (!c) return null;
        let v = c.values[scoring] ?? c.values.ppr; if (v == null) return null;
        if (format === 'sf' && pos === 'QB') v *= qbUplift;
        return v;
      }
    };

    const momentumRaw = sleeperId ? (sleeper.momentum.get(sleeperId) || 0) : 0;
    const momentum = clamp(momentumRaw / maxMomentum, -1, 1);
    const values = {}; const sources = {};
    let nSources = 0;
    for (const format of FORMATS) {
      values[format] = {};
      for (const scoring of SCORINGS) {
        let wsum = 0, vsum = 0;
        for (const [src, w] of Object.entries(cfg.weights)) {
          const v = sourceValue(src, format, scoring); if (v == null) continue;
          wsum += w; vsum += w * v;
          if (format === '1qb' && scoring === 'ppr') { sources[src] = Math.round(v); }
        }
        const blended = wsum ? vsum / wsum : 0;
        values[format][scoring] = Math.round(blended * (1 + momentum * cfg.momentumCap));
      }
    }
    nSources = Object.keys(sources).length;
    if (nSources < cfg.minSources || values['1qb'].ppr <= 0) continue;

    const svals = Object.values(sources);
    out.push({
      name: base.name, pos, team: meta?.team || a?.team || b?.team || c?.team || 'FA',
      age: meta?.age ?? a?.age ?? null, bye: espn.byes?.[meta?.team || a?.team || b?.team] ?? null,
      injury: meta?.injury || b?.injury || null,
      sleeperId, espnId: a?.espnId || b?.espnId || null,
      values, sources, nSources,
      spread: svals.length > 1 ? Math.round(Math.max(...svals) - Math.min(...svals)) : 0,
      adp: b?.adp ?? null, rosterPct: b?.rosterPct ?? a?.rosterPct ?? null,
      trend: a?.trend ?? 0, momentum: Math.round(momentum * 100) / 100,
    });
  }

  // Rescale each format/scoring so the top player sits at exactly 10,000, then rank.
  for (const format of FORMATS) for (const scoring of SCORINGS) {
    const max = Math.max(...out.map(p => p.values[format][scoring]));
    for (const p of out) p.values[format][scoring] = Math.round(p.values[format][scoring] / max * 10000);
  }
  out.sort((x, y) => y.values['1qb'].ppr - x.values['1qb'].ppr);
  const players = out.slice(0, cfg.maxPlayers).map((p, i) => ({ id: i + 1, ...p, value1qb: p.values['1qb'].ppr, valueSf: p.values.sf.ppr, tier: tierOf(p.values['1qb'].ppr) }));
  return { players, qbUplift: Math.round(qbUplift * 100) / 100 };
}

export function tierOf(v) { const i = config.tiers.findIndex(t => v >= t); return i === -1 ? config.tiers.length + 1 : i + 1; }
