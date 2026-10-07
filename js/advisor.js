/* ===========================================================
   GoBuckYourself — Trade Advisor
   Reads your Sleeper roster (via LEAGUE) and recommends trades with reasons:
   team needs & surplus, sell-high / buy-low market signals, and partner fit.
   Requires app.js (GIQ, incl. weekly scoring) and league.js (LEAGUE).
   =========================================================== */

const ADVISOR = (() => {
  const POS = ['QB', 'RB', 'WR', 'TE'];

  // ---------- market signals: production & usage vs. value ----------
  /**
   * For every valued player, compare where he ranks at his position by value with where he ranks by
   * points per game (results) and by expected points per game (usage — targets, carries, air yards, red-zone looks).
   *  • buy-low:   his role or results rank well above his value, and he's been unlucky or under-valued
   *  • sell-high: his value is propped up by results his usage doesn't support (scoring above expectation)
   * `luck` = actual − expected points per game (nflverse expected-points model).
   */
  function marketSignals() {
    const all = GIQ.ranked('ALL');
    const out = new Map();
    for (const pos of POS) {
      const byValue = all.filter(p => p.pos === pos);
      const withPts = byValue.map(p => ({ p, s: GIQ.scoring(p) })).filter(x => x.s && x.s.games >= Math.min(2, x.s.through || 1) && x.s.avg != null);
      const ppgRank = new Map([...withPts].sort((a, b) => b.s.avg - a.s.avg).map((x, i) => [x.p.id, i + 1]));
      const withX = byValue.filter(p => p.outlook && p.outlook.g >= 2 && p.outlook.xfpg != null);
      const xRank = new Map([...withX].sort((a, b) => b.outlook.xfpg - a.outlook.xfpg).map((p, i) => [p.id, i + 1]));
      const relevant = pos === 'QB' || pos === 'TE' ? 18 : 40;
      byValue.forEach((p, i) => {
        const vr = i + 1, pr = ppgRank.get(p.id) || null, xr = xRank.get(p.id) || null, s = GIQ.scoring(p);
        const o = p.outlook && p.outlook.g >= 2 ? p.outlook : null;
        const luck = o ? o.luck : null;
        const gap = pr ? vr - pr : 0, xgap = xr ? vr - xr : 0;
        let buyLow = false, sellHigh = false, note = '';
        // role-based buy-low: usage ranks far above value and results lag the role
        if (xr && xgap >= 6 && xr <= relevant * 0.6 && vr <= relevant * 1.5 && luck <= -1.5) {
          buyLow = true; note = `Usage of a ${pos}${xr} (${o.xfpg.toFixed(1)} expected pts/game) but valued ${pos}${vr} — scoring ${Math.abs(luck).toFixed(1)}/game under his role`;
        } else if (pr && gap >= 6 && pr <= relevant * 0.6 && vr <= relevant * 1.5 && (luck == null || luck < 3)) {
          buyLow = true; note = `Producing ${pos}${pr} (${s.avg.toFixed(1)} ppg) but valued only ${pos}${vr}${luck != null ? ', backed by his usage' : ''}`;
        }
        // results running ahead of the role, or valued well above production
        if (o && luck >= 4 && vr <= relevant && (!xr || xr > vr)) {
          sellHigh = true; note = `Scoring ${luck.toFixed(1)} pts/game above what his usage produces (${o.fpg.toFixed(1)} vs ${o.xfpg.toFixed(1)} expected) — likely to cool off`;
        } else if (pr && gap <= -6 && vr <= relevant && (luck == null || luck > -1.5)) {
          sellHigh = true; note = `Valued ${pos}${vr} but producing like ${pos}${pr} (${s.avg.toFixed(1)} ppg)${xr && xr > vr ? ` with ${pos}${xr} usage` : ''}`;
        }
        out.set(p.id, { valueRank: vr, ppgRank: pr, xRank: xr, gap, xgap, luck, ppg: s ? s.avg : null, xfpg: o ? o.xfpg : null, buyLow, sellHigh, note });
      });
    }
    return out;
  }

  // ---------- team profiles ----------
  function profiles() {
    const pr = LEAGUE.powerRankings(), n = pr.length;
    // median starter value at each position across the league (what "startable" means here)
    const median = {};
    for (const pos of POS) {
      const vals = pr.flatMap(r => r.lineup.starters.filter(x => x.p && x.p.pos === pos).map(x => x.p.value)).sort((a, b) => a - b);
      median[pos] = vals.length ? vals[Math.floor(vals.length / 2)] : 0;
    }
    const map = new Map();
    for (const r of pr) {
      const starters = new Set(r.lineup.starters.filter(x => x.p).map(x => x.p.id));
      const needs = POS.filter(pos => r.posRank[pos] > n / 2).sort((a, b) => r.posRank[b] - r.posRank[a]);
      const strengths = POS.filter(pos => r.posRank[pos] <= Math.max(2, Math.round(n * 0.25)));
      // surplus: bench players good enough to start for a typical team
      const oneQB = !LEAGUE.data.slots.includes('SUPER_FLEX') && LEAGUE.data.slots.filter(s => s === 'QB').length === 1;
      const surplus = r.lineup.bench.filter(p => p.value >= median[p.pos] * 0.5 || (oneQB && p.pos === 'QB' && p.value >= 800));
      map.set(r.team.rosterId, { ...r, n, starters, needs, strengths, surplus, surplusPos: [...new Set(surplus.map(p => p.pos))] });
    }
    return { map, median, n };
  }

  // ---------- recommendations ----------
  function analyze() {
    const me = LEAGUE.myTeam(); if (!me) return null;
    const { map, n } = profiles();
    const mine = map.get(me.rosterId);
    const market = marketSignals();
    const ord = k => ['', '1st', '2nd', '3rd'][k] || `${k}th`;

    // sell-high on my roster, buy-low on everyone else's
    const sigStrength = m => Math.max(Math.abs(m.gap || 0), Math.abs(m.xgap || 0), Math.abs(m.luck || 0) * 2);
    const sellHigh = mine.players.map(p => ({ p, m: market.get(p.id) })).filter(x => x.m && x.m.sellHigh).sort((a, b) => sigStrength(b.m) - sigStrength(a.m)).slice(0, 4);
    const buyLow = [];
    for (const t of LEAGUE.data.teams) {
      if (t.isMe) continue;
      for (const p of map.get(t.rosterId).players) {
        const m = market.get(p.id);
        if (m && m.buyLow && (!mine.needs.length || mine.needs.includes(p.pos))) buyLow.push({ p, m, team: t });
      }
    }
    buyLow.sort((a, b) => sigStrength(b.m) - sigStrength(a.m));

    // best partners: their surplus fills my needs, my surplus fills theirs
    const partners = LEAGUE.data.teams.filter(t => !t.isMe).map(t => {
      const o = map.get(t.rosterId);
      const iGet = mine.needs.filter(pos => o.surplusPos.includes(pos) || o.strengths.includes(pos));
      const theyGet = o.needs.filter(pos => mine.surplusPos.includes(pos) || mine.strengths.includes(pos));
      return { team: t, profile: o, iGet, theyGet, fit: iGet.length * 1.2 + theyGet.length };
    }).filter(x => x.fit > 0).sort((a, b) => b.fit - a.fit).slice(0, 3);

    // candidate deals from the trade finder (fair + slight edge), then re-score with context
    const seen = new Set(), candidates = [];
    for (const edge of [0, 0.1]) for (const d of LEAGUE.findTrades({ edge, max: 80 })) {
      const k = d.team.rosterId + ':' + d.give.map(p => p.id).sort() + '>' + d.get.map(p => p.id).sort();
      if (!seen.has(k)) { seen.add(k); candidates.push(d); }
    }
    const scored = candidates.map(d => {
      const them = map.get(d.team.rosterId);
      const reasons = [];
      let s = d.myPct * 100;                                      // lineup gain, in %
      // fills my needs
      const needHits = d.get.filter(p => mine.needs.includes(p.pos));
      if (needHits.length) {
        const worst = needHits.map(p => p.pos).sort((a, b) => mine.posRank[b] - mine.posRank[a])[0];
        s += 1.5 * needHits.length * (mine.posRank[worst] / n);
        reasons.push({ kind: 'need', text: `Fills a need at ${worst}: you rank ${ord(mine.posRank[worst])} of ${n} there.` });
      }
      // spends surplus instead of starters
      const fromBench = d.give.filter(p => !mine.starters.has(p.id));
      if (fromBench.length) {
        s += 1.0 * fromBench.length;
        reasons.push({ kind: 'surplus', text: `Uses depth you're not starting: ${fromBench.map(p => p.name).join(' and ')}.` });
      } else if (d.give.some(p => mine.strengths.includes(p.pos))) {
        s += 0.5;
        const pos = d.give.find(p => mine.strengths.includes(p.pos)).pos;
        reasons.push({ kind: 'surplus', text: `Deals from strength: you're ${ord(mine.posRank[pos])} at ${pos}, so you can afford it.` });
      }
      // market timing
      for (const p of d.get) { const m = market.get(p.id); if (m && m.buyLow) { s += 0.9; reasons.push({ kind: 'market', text: `Buy low on ${p.name}: ${m.note}.` }); } }
      for (const p of d.give) { const m = market.get(p.id); if (m && m.sellHigh) { s += 0.9; reasons.push({ kind: 'market', text: `Sell high on ${p.name}: ${m.note}.` }); } }
      for (const p of d.get) { const m = market.get(p.id); if (m && m.sellHigh) s -= 0.6; }
      // why they'd say yes
      const helpsThem = d.give.filter(p => them.needs.includes(p.pos));
      if (helpsThem.length) {
        s += 0.8;
        const pos = helpsThem[0].pos;
        reasons.push({ kind: 'them', text: `${d.team.name} ranks ${ord(them.posRank[pos])} at ${pos}, so ${helpsThem[0].name} fills a hole for them.` });
      } else if (d.mutual) reasons.push({ kind: 'them', text: `It improves ${d.team.name}'s lineup too (${(d.theirPct * 100).toFixed(1)}%).` });
      if (d.mutual) s += 0.8;
      if (d.stretch) s -= 0.8;
      s += Math.max(0, d.fairPct) * 2;                              // a little credit for winning on value
      s += ({ likely: 1.0, maybe: 0.3, long: -0.8 })[d.odds];       // …but realistic offers come first
      reasons.unshift({ kind: 'lineup', text: `Your starting lineup gets ${(d.myPct * 100).toFixed(1)}% better.` });
      return { ...d, score: s, reasons };
    }).sort((a, b) => b.score - a.score);

    // top picks: at most 2 per partner, no repeated centerpiece, and never the same package offered twice
    const picks = [], perTeam = new Map(), usedGet = new Set(), usedGive = new Set();
    for (const d of scored) {
      if (picks.length >= 5) break;
      const giveKey = d.give.map(p => p.id).sort().join('+');
      if ((perTeam.get(d.team.rosterId) || 0) >= 2 || usedGive.has(giveKey) || d.get.some(p => usedGet.has(p.id))) continue;
      picks.push(d); perTeam.set(d.team.rosterId, (perTeam.get(d.team.rosterId) || 0) + 1);
      usedGive.add(giveKey); d.get.forEach(p => usedGet.add(p.id));
    }
    return { me, mine, n, needs: mine.needs, strengths: mine.strengths, surplus: mine.surplus, sellHigh, buyLow: buyLow.slice(0, 6), partners, picks, candidates: candidates.length };
  }

  return { analyze, marketSignals };
})();
