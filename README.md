# GoBuckYourself — Fantasy Football Rankings & Trade Calculator

A static, dependency-free site inspired by fantasycalc.com, with its own **aggregated value algorithm** that blends several data sources into one 0–10,000 scale.

```
index.html              Home: hero, top players by position, weekly movers
finder.html             Comparables: pick a target player (and optionally your offer) → players and 2-player packages that close the gap
rankings.html           Sortable/searchable rankings with position filters, tiers, source agreement, CSV export
trade-calculator.html   Two-sided trade calculator with fairness meter, balancing suggestions, shareable URLs
about.html              Methodology
css/styles.css          Design system (dark theme, responsive)
js/app.js               Shared logic: settings (1QB/Superflex, scoring), value lookup, helpers
js/players.js           GENERATED player data (do not edit by hand)
data/values.json        GENERATED full output incl. per-source breakdown and metadata
scripts/                The value pipeline (see below)
.github/workflows/      Weekly auto-refresh
```

No build step for the site itself — open `index.html` or serve the folder (`npm run serve`).

## The value pipeline

```
npm run build:values            # fetch live sources → js/players.js + data/values.json
npm run build:values:offline    # same, but from scripts/fixtures (no network) — handy for testing
```

Requires Node 18+. The script is resilient: any source that fails is logged and skipped, and if *no* source returns data the existing `players.js` is left untouched (exit code 1).

### Sources

| Source | What it provides | Weight | Auth |
|---|---|---|---|
| **FantasyCalc** `api.fantasycalc.com/values/current` | Trade-market values for 1QB/SF × PPR/half/std, 30-day trend, tiers | 50% | none |
| **ESPN Fantasy** `lm-api-reads.fantasy.espn.com` | ADP, % rostered, injury status, team bye weeks | 30% | none (undocumented public endpoint) |
| **FantasyPros** `api.fantasypros.com` | Expert consensus rankings per scoring format | 20% | `FANTASYPROS_API_KEY` env var — skipped if unset |
| **Sleeper** `api.sleeper.app` | Player metadata (team, age, injury) + weekly trending adds/drops | ±3% momentum | none |

### The algorithm (`scripts/aggregate.mjs`)

1. Each source's numbers are normalized to 0–10,000. FantasyCalc values are scaled so its top player = 10,000; ADP and ECR ranks go through an exponential curve (`rankToValue` in `lib.mjs`) that mirrors the shape of trade values.
2. For every format (1QB, Superflex) × scoring (PPR, half, standard), the available sources are averaged using the weights in `scripts/config.mjs`. Missing sources are dropped and the remaining weights renormalized.
3. Superflex QB uplift is *learned* from FantasyCalc's own SF/1QB ratio for quarterbacks and applied to the ADP and ECR legs.
4. Sleeper net adds/drops are scaled to ±1 and applied as at most a ±3% multiplier.
5. Each format/scoring pool is rescaled so the top player is exactly 10,000; tiers and ranks follow.

Per-player output includes `sources` (each source's 1QB-PPR value), `nSources`, and `spread` (max − min across sources), which the rankings page surfaces as **agree / mixed / split**.

Tune weights, momentum cap, tier cutoffs, and scoring multipliers in `scripts/config.mjs`. Add a source by dropping a new adapter in `scripts/sources/` that returns a `Map<"normalizedname|POS", {...}>` and wiring it into `aggregate.mjs`.

### Weekly refresh

`.github/workflows/update-values.yml` runs every Tuesday morning (and on demand via *Actions → Run workflow*), rebuilds the data, and commits it if anything changed. Add `FANTASYPROS_API_KEY` under *Settings → Secrets → Actions* to enable the FantasyPros leg.

## Access code gate

`middleware.js` (Vercel Edge Middleware) redirects every request to `/gate` until the visitor enters the code. Set **`ACCESS_CODE`** in Vercel → Project → Settings → Environment Variables and redeploy. Leave it unset to make the site public. A correct code sets a 90-day HttpOnly cookie; `/api/gate/logout` clears it.

## Deploying (GitHub + Vercel)

1. Push this folder to a GitHub repo.
2. In Vercel: **Add New → Project → Import** the repo. Framework preset: **Other**. Leave build command and output directory empty (it's plain static files). Deploy.
3. Every commit to `main` redeploys automatically — including the weekly commits from the value-refresh workflow, so the live site refreshes itself.
4. Optional: add `FANTASYPROS_API_KEY` in GitHub → Settings → Secrets → Actions to enable the FantasyPros source.

`vercel.json` enables clean URLs (`/rankings` works as well as `/rankings.html`) and sets a 1-hour cache on the data files so a refresh shows up promptly.

## Disclaimer

Values are for entertainment. The ESPN endpoint is unofficial and may change; the adapter fails soft if it does.
