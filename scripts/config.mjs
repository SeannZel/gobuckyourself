// Tune the GoBuckYourself value algorithm here.
export default {
  numTeams: 12,
  // Relative weight of each source in the blended value. Missing sources are dropped and the rest renormalized.
  weights: { fantasycalc: 0.40, espn: 0.25, pihs: 0.20, fantasypros: 0.15 },
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
