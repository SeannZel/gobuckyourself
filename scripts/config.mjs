// Tune the GoBuckYourself value algorithm here.
export default {
  numTeams: 12,
  // Relative weight of each source in the blended value once the season is underway.
  // Missing sources are dropped and the rest renormalized.
  //   fantasycalc — live trade market (real trades)          pihs — PeakedInHighSkool weekly redraft chart
  //   model       — GBY production model (projections + usage + matchups + Vegas, see scripts/model.mjs)
  //   fantasypros — expert consensus, rest-of-season
  // (ESPN is used only for bye weeks, % rostered and injury status — its preseason ADP is no longer part of the value.)
  weights: { fantasycalc: 0.35, model: 0.30, pihs: 0.20, fantasypros: 0.15 },
  // The model ramps in as games are played: `t` goes 0 → 1 between the first unplayed week `start` and `start + span`,
  // and production signals are multiplied by t (Week 1: off, Week 4 onward: full weight).
  phase: { start: 1, span: 3, preseason: [], production: ['model'] },
  // Replacement level for value-over-replacement (12 teams; QB, 2 RB, 2 WR, TE, FLEX (+ SF) plus bench depth).
  replacement: {
    '1qb': { QB: 13, RB: 30, WR: 36, TE: 13 },
    sf:    { QB: 26, RB: 30, WR: 36, TE: 13 },
  },
  // Sleeper add/drop momentum can move a value by at most this fraction (±).
  momentumCap: 0.03,
  // Sources that only provide one scoring format get these multipliers for other formats.
  scoringMult: {
    ppr:  { QB: 1.00, RB: 1.00, WR: 1.00, TE: 1.00 },
    half: { QB: 1.03, RB: 1.03, WR: 0.97, TE: 0.96 },
    std:  { QB: 1.06, RB: 1.06, WR: 0.93, TE: 0.92 },
  },
  // Only keep players valued by at least this many sources (1 = keep everyone any source knows).
  minSources: 1,
  // Cap the output list.
  maxPlayers: 300,
  tiers: [8000, 6000, 4000, 2500, 1200], // lower bounds for tiers 1..5; below last = tier 6
};
