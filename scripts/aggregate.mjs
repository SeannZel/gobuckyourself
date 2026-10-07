// The GoBuckYourself value algorithm: blend the live trade market (FantasyCalc), the PIHS redraft chart,
// expert rest-of-season consensus (FantasyPros) and our production model (projections + usage + matchups + Vegas),
// nudged by waiver momentum (Sleeper), into one 0–10,000 scale. ESPN supplies only byes, % rostered and injuries.
import config from './config.mjs';
import { vorpOrder } from './model.mjs';

const FORMATS = ['1qb', 'sf'];
const SCORINGS = ['ppr', 'half', 'std'];
const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 1; };
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

/** Source weights for the current week: preseason sources fade out, production sources fade in. */
export function phaseWeights(week, cfg = config) {
  const { start, span, preseason, production } = cfg.phase;
  const t = clamp(((week ?? start) - start) / span, 0, 1);
  const w = {};
  for (const [k, v] of Object.entries(cfg.weights)) w[k] = Math.round(v * (preseason.includes(k) ? 1 - t : production.includes(k) ? t : 1) * 1000) / 1000;
  return { weights: w, t };
}

export function aggregate({ fc, espn, sleeper, fp, pihs = { players: new Map() }, model = null }) {
  const cfg = config;
  const { weights } = phaseWeights(model?.week, cfg);
  // How much more a QB is worth in Superflex, learned from FantasyCalc so the expert and chart sources get the same treatment.
  const qbRatios = [];
  for (const p of fc.players.values()) if (p.pos === 'QB' && p.values.sf?.ppr && p.values['1qb']?.ppr) qbRatios.push(p.values.sf.ppr / p.values['1qb'].ppr);
  const qbUplift = clamp(median(qbRatios), 1, 3);

  // Union of every player any source knows about.
  const keys = new Set([...fc.players.keys(), ...fp.players.keys(), ...pihs.players.keys()]);
  // The model can surface breakout players no market source has caught up on yet (needs projection + 2 games of usage).
  if (model?.ok && weights.model) {
    const known = new Set([...keys].map(k => String(fc.players.get(k)?.sleeperId || sleeper.byKey.get(k) || '')));
    for (const r of model.all) if (r.key && r.outlook.src === 'blend' && r.outlook.g >= 2 && !keys.has(r.key) && !known.has(String(r.sleeperId))) keys.add(r.key);
  }
  const modelFor = (key, sid) => (sid && model?.bySleeper.get(String(sid))) || model?.byKey.get(key) || null;
  const maxMomentum = Math.max(1, ...[...sleeper.momentum.values()].map(Math.abs));

  // Trade-market value curves by position (FantasyCalc), used to place rank-only sources on the value scale.
  const curves = new Map();
  const posCurve = (pos, format, scoring) => {
    const k = `${pos}|${format}|${scoring}`;
    if (!curves.has(k)) curves.set(k, [...fc.players.values()].filter(p => p.pos === pos)
      .map(p => p.values[format]?.[scoring] ?? (p.values[format]?.ppr != null ? p.values[format].ppr * cfg.scoringMult[scoring][pos] : null))
      .filter(v => v > 0).sort((x, y) => y - x));
    return curves.get(k);
  };

  const pihsDates = pihs.dates || {};
  const pihsNewest = fmt => Object.entries(pihsDates).filter(([k]) => k.startsWith(fmt + '.')).map(([, v]) => v).sort().pop() || null;

  const out = [];
  for (const key of keys) {
    const a = fc.players.get(key), b = espn.players.get(key), c = fp.players.get(key), d = pihs.players.get(key);
    const [, pos] = key.split('|');
    const sleeperId0 = a?.sleeperId || sleeper.byKey.get(key) || null;
    const m = model?.ok ? modelFor(key, sleeperId0) : null;
    const base = a || b || c || d || m;
    const sleeperId = sleeperId0 || m?.sleeperId || null;
    const meta = sleeperId ? sleeper.meta.get(sleeperId) : null;

    // Per-source value for a given format/scoring, or null when the source doesn't cover the player.
    const sourceValue = (src, format, scoring) => {
      if (src === 'fantasycalc') {
        if (!a) return null;
        const v = a.values[format]?.[scoring] ?? (a.values[format]?.ppr != null ? a.values[format].ppr * cfg.scoringMult[scoring][pos] : null);
        return v ?? null;
      }
      if (src === 'fantasypros') {
        // expert position rank -> the trade market's value for that rank at that position (e.g. WR12 -> 12th-best WR value)
        const r = c?.ranks?.[scoring] ?? c?.ranks?.ppr; if (r == null) return null;
        const curve = posCurve(pos, format, scoring); if (!curve.length) return null;
        return r <= curve.length ? curve[r - 1] : curve[curve.length - 1] * Math.pow(0.95, r - curve.length);
      }
      if (src === 'pihs') {
        if (!d) return null;
        // Charts come in specific formats (e.g. 1QB PPR one week, Superflex standard the next).
        // Prefer the exact format if that chart is recent; otherwise use the freshest chart and convert.
        const mult = cfg.scoringMult;
        const convScoring = (v, from) => v / mult[from][pos] * mult[scoring][pos];
        const fromChart = (fmt) => {
          const f = d.values[fmt]; if (!f) return null;
          const from = f[scoring] != null ? scoring : ['ppr', 'half', 'std'].find(s => f[s] != null);
          if (!from) return null;
          let v = convScoring(f[from], from);
          if (fmt !== format && pos === 'QB') v = format === 'sf' ? v * qbUplift : v / qbUplift;
          return { v, date: pihsNewest(fmt) };
        };
        const exact = fromChart(format), other = fromChart(format === 'sf' ? '1qb' : 'sf');
        const age = x => x?.date ? (Date.now() - new Date(x.date + 'T00:00:00Z')) / 864e5 : 0;
        if (exact && (age(exact) <= 10 || !other)) return exact.v;
        return (other || exact)?.v ?? null;
      }
    };

    const momentumRaw = sleeperId ? (sleeper.momentum.get(sleeperId) || 0) : 0;
    const momentum = clamp(momentumRaw / maxMomentum, -1, 1);
    // market blend (everything except the model) per format/scoring; the model is mapped onto this curve below
    const market = {}; const parts = {};
    for (const format of FORMATS) {
      market[format] = {}; parts[format] = {};
      for (const scoring of SCORINGS) {
        let wsum = 0, vsum = 0; const ps = {};
        for (const [src, w] of Object.entries(weights)) {
          if (src === 'model' || !w) continue;
          const v = sourceValue(src, format, scoring); if (v == null) continue;
          wsum += w; vsum += w * v; ps[src] = v;
        }
        market[format][scoring] = wsum ? vsum / wsum : null; parts[format][scoring] = { wsum, vsum, ps };
      }
    }

    out.push({ _key: key, _m: m, _parts: parts, _market: market, _momentum: momentum,
      name: base.name, pos, team: meta?.team || a?.team || m?.team || b?.team || c?.team || d?.team || 'FA',
      age: meta?.age ?? a?.age ?? d?.age ?? null, bye: espn.byes?.[meta?.team || a?.team || m?.team || b?.team] ?? null,
      injury: meta?.injury || b?.injury || null,
      sleeperId, espnId: a?.espnId || b?.espnId || null,
      rosterPct: b?.rosterPct ?? a?.rosterPct ?? null,
      trend: a?.trend ?? 0, momentum: Math.round(momentum * 100) / 100,
      ...(m ? { outlook: m.outlook } : {}),
    });
  }

  // ---- model value: rank by points over replacement, then read the value off the market's own curve ----
  // (the #1 model player gets the market's #1 value, #20 gets the market's #20 value, …) so it blends on the same scale.
  const modelVal = new Map(); // player -> {format: {scoring: v}}
  if (model?.ok && weights.model) for (const format of FORMATS) for (const scoring of SCORINGS) {
    const curve = out.map(p => p._market[format][scoring]).filter(v => v != null && v > 0).sort((x, y) => y - x);
    if (!curve.length) continue;
    const byRec = new Map(out.filter(p => p._m).map(p => [p._m, p]));
    let i = 0;
    for (const { rec } of vorpOrder(model, format, scoring)) {
      const p = byRec.get(rec); if (!p) { i++; continue; } // unmatched players still occupy their rank
      const v = i < curve.length ? curve[i] : curve[curve.length - 1] * Math.pow(0.97, i - curve.length + 1);
      const mv = modelVal.get(p) || {}; (mv[format] ||= {})[scoring] = v; modelVal.set(p, mv); i++;
    }
  }

  const marketWeight = Object.entries(weights).filter(([k]) => k !== 'model').reduce((a, [, w]) => a + w, 0);
  const floors = {};
  for (const format of FORMATS) { floors[format] = {}; for (const scoring of SCORINGS) {
    const vals = out.map(p => p._market[format][scoring]).filter(v => v > 0).sort((x, y) => y - x);
    floors[format][scoring] = vals[Math.min(vals.length - 1, cfg.maxPlayers - 1)] || 0;
  } }
  const final = [];
  for (const p of out) {
    const values = {}, sources = {};
    for (const format of FORMATS) {
      values[format] = {};
      for (const scoring of SCORINGS) {
        let { wsum, vsum, ps } = p._parts[format][scoring];
        let mv = modelVal.get(p)?.[format]?.[scoring];
        if (mv != null) {
          if (wsum) {
            // the model can move a player, but not single-handedly overrule the market: keep it within ½×–2× of it
            const mk = vsum / wsum; mv = clamp(mv, mk * 0.5, mk * 2);
          } else {
            // nobody in the market has priced this player yet (waiver breakout): blend with the bottom of the market curve
            const floor = floors[format][scoring], w = 0.5 * marketWeight;
            wsum += w; vsum += w * floor;
          }
          wsum += weights.model; vsum += weights.model * mv;
        }
        const blended = wsum ? vsum / wsum : 0;
        values[format][scoring] = Math.round(blended * (1 + p._momentum * cfg.momentumCap));
        if (format === '1qb' && scoring === 'ppr') {
          for (const [k, v] of Object.entries(ps)) sources[k] = Math.round(v);
          if (mv != null) sources.model = Math.round(mv);
        }
      }
    }
    const nSources = Object.keys(sources).length;
    if (nSources < cfg.minSources || values['1qb'].ppr <= 0) continue;
    const svals = Object.values(sources);
    const { _key, _m, _parts, _market, _momentum, ...rest } = p;
    final.push({ ...rest, values, sources, nSources, spread: svals.length > 1 ? Math.round(Math.max(...svals) - Math.min(...svals)) : 0 });
  }
  out.length = 0; out.push(...final);

  // Rescale each format/scoring so the top player sits at exactly 10,000, then rank.
  for (const format of FORMATS) for (const scoring of SCORINGS) {
    const max = Math.max(...out.map(p => p.values[format][scoring]));
    for (const p of out) p.values[format][scoring] = Math.round(p.values[format][scoring] / max * 10000);
  }
  out.sort((x, y) => y.values['1qb'].ppr - x.values['1qb'].ppr);
  const players = out.slice(0, cfg.maxPlayers).map((p, i) => ({ id: i + 1, ...p, value1qb: p.values['1qb'].ppr, valueSf: p.values.sf.ppr, tier: tierOf(p.values['1qb'].ppr) }));
  return { players, qbUplift: Math.round(qbUplift * 100) / 100, weights };
}

export function tierOf(v) { const i = config.tiers.findIndex(t => v >= t); return i === -1 ? config.tiers.length + 1 : i + 1; }
