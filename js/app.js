/* ===========================================================
   GoBuckYourself — shared app logic
   Requires js/players.js to be loaded first (defines PLAYERS)
   =========================================================== */

const GIQ = (() => {
  const STORAGE_KEY = 'giq-settings';

  // ---------- settings (persisted) ----------
  const defaults = { format: '1qb', scoring: 'ppr', teams: 12 };
  let settings = { ...defaults };
  try { settings = { ...defaults, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') }; } catch (_) {}

  function setSetting(key, val) {
    settings[key] = val;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch (_) {}
    document.dispatchEvent(new CustomEvent('giq:settings', { detail: settings }));
  }

  // ---------- values ----------
  // Scoring adjustments: standard leagues devalue pass-catchers slightly, half-PPR sits between.
  const scoringMult = {
    ppr:  { QB: 1.00, RB: 1.00, WR: 1.00, TE: 1.00 },
    half: { QB: 1.03, RB: 1.03, WR: 0.97, TE: 0.96 },
    std:  { QB: 1.06, RB: 1.06, WR: 0.93, TE: 0.92 },
  };

  function valueOf(p) {
    // Preferred: per-format, per-scoring values produced by scripts/build-values.mjs.
    const exact = p.values?.[settings.format]?.[settings.scoring];
    if (exact != null) return exact;
    // Fallback for the legacy flat shape.
    const base = settings.format === 'sf' ? p.valueSf : p.value1qb;
    return Math.round(base * scoringMult[settings.scoring][p.pos]);
  }

  const meta = typeof PLAYERS_META !== 'undefined' ? PLAYERS_META : null;
  function updatedLabel() {
    if (!meta?.generatedAt) return 'Sample data';
    const d = new Date(meta.generatedAt);
    return 'Updated ' + d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
  function sourcesLabel() {
    return meta ? meta.sources.filter(s => s.players).map(s => s.label).join(' · ') : 'sample values';
  }

  function ranked(pos) {
    return PLAYERS
      .filter(p => !pos || pos === 'ALL' || p.pos === pos)
      .map(p => ({ ...p, value: valueOf(p) }))
      .sort((a, b) => b.value - a.value)
      .map((p, i) => ({ ...p, rank: i + 1 }));
  }

  function injuryHtml(p) {
    if (!p.injury) return '';
    const short = { 'Questionable': 'Q', 'Doubtful': 'D', 'Out': 'OUT', 'IR': 'IR', 'PUP': 'PUP', 'Sus': 'SUS', 'NA': 'NA', 'INJURY_RESERVE': 'IR', 'QUESTIONABLE': 'Q', 'DOUBTFUL': 'D', 'OUT': 'OUT', 'SUSPENSION': 'SUS' }[p.injury] || p.injury;
    return `<span class="inj" title="${esc(p.injury)}">${esc(short)}</span>`;
  }

  function tierOf(value) {
    if (value >= 8000) return 1;
    if (value >= 6000) return 2;
    if (value >= 4000) return 3;
    if (value >= 2500) return 4;
    if (value >= 1200) return 5;
    return 6;
  }

  // ---------- trade math ----------
  // Bundling discount: in redraft the best piece decides a deal, so lesser pieces count for less.
  const BUNDLE = 0.85;
  function adjustedTotal(values) {
    const v = [...values].sort((a, b) => b - a);
    return Math.round(v.reduce((s, x, i) => s + x * (i === 0 ? 1 : BUNDLE ** i), 0));
  }

  /**
   * Find players (and two-player combos) that bring `sideValues` up to `targetTotal`.
   * Simulates adding each candidate to the side and measures the remaining gap on the
   * bundling-adjusted total, so results reflect what the calculator will actually say.
   * opts: { exclude:Set<id>, pos:'ALL'|'QB'..., q:'search', combos:boolean, limit }
   */
  function findBalancers(sideValues, targetTotal, opts = {}) {
    const { exclude = new Set(), pos = 'ALL', q = '', combos = true, limit = 8 } = opts;
    const base = adjustedTotal(sideValues);
    const gap = targetTotal - base;
    if (gap <= 0) return { gap, singles: [], pairs: [] };
    const ql = q.trim().toLowerCase();
    const pool = ranked('ALL').filter(p => !exclude.has(p.id) && (pos === 'ALL' || p.pos === pos) && (!ql || p.name.toLowerCase().includes(ql) || p.team.toLowerCase() === ql));
    const score = ids => { const t = adjustedTotal([...sideValues, ...ids.map(p => p.value)]); return { total: t, diff: t - targetTotal }; };

    const singles = pool
      .filter(p => p.value <= gap * 1.6 && p.value >= gap * 0.3)
      .map(p => ({ players: [p], ...score([p]) }))
      .sort((a, b) => Math.abs(a.diff) - Math.abs(b.diff))
      .slice(0, limit);

    let pairs = [];
    if (combos) {
      // Candidate pieces that are individually smaller than the gap, nearest first.
      const cand = pool.filter(p => p.value < gap * 1.1 && p.value >= gap * 0.12)
        .sort((a, b) => Math.abs(a.value - gap * 0.55) - Math.abs(b.value - gap * 0.55)).slice(0, 45);
      for (let i = 0; i < cand.length; i++) for (let j = i + 1; j < cand.length; j++) {
        const s = score([cand[i], cand[j]]);
        if (Math.abs(s.diff) <= gap * 0.35) pairs.push({ players: [cand[i], cand[j]], ...s });
      }
      pairs.sort((a, b) => Math.abs(a.diff) - Math.abs(b.diff));
      pairs = pairs.slice(0, limit);
    }
    return { gap, base, singles, pairs };
  }

  /**
   * Trade-block recommendations. Given players you're willing to move, suggest what to target.
   *   swaps:  1-for-1, a target worth about the same as one block player
   *   consolidate: 2-3 of your block players → one better player (true upgrade: target > your best piece)
   *   split:  one of your block players → two players that add up to it (depth)
   * Every result is scored with the same bundling-adjusted totals the trade calculator uses, and
   * `fairPct` is how far apart the two sides would be (positive = you receive more).
   * opts: { pos: Set of wanted positions (empty = any), exclude: Set<id>, tol: 0.06, limit: 8 }
   */
  function tradeBlockIdeas(block, opts = {}) {
    const { pos = new Set(), exclude = new Set(), tol = 0.06, limit = 8 } = opts;
    const blockIds = new Set(block.map(p => p.id));
    const wanted = p => !pos.size || pos.has(p.pos);
    const pool = ranked('ALL').filter(p => !blockIds.has(p.id) && !exclude.has(p.id));
    const targets = pool.filter(wanted);
    const score = (give, get) => {
      const g = adjustedTotal(give.map(p => p.value)), r = adjustedTotal(get.map(p => p.value));
      return { giveTotal: g, getTotal: r, diff: r - g, fairPct: (r - g) / Math.max(g, r) };
    };
    const byCloseness = (a, b) => Math.abs(a.fairPct) - Math.abs(b.fairPct);

    // 1-for-1 swaps: up to 3 per block player
    const swaps = [];
    for (const b of block) {
      targets.filter(t => Math.abs(t.value - b.value) <= b.value * 0.12)
        .map(t => ({ give: [b], get: [t], ...score([b], [t]) }))
        .sort(byCloseness).slice(0, 3).forEach(x => swaps.push(x));
    }
    swaps.sort(byCloseness);

    // Consolidation: every 2- and 3-player subset of the block → one target worth more than its best piece
    const subsets = [];
    for (let i = 0; i < block.length; i++) for (let j = i + 1; j < block.length; j++) {
      subsets.push([block[i], block[j]]);
      for (let k = j + 1; k < block.length; k++) subsets.push([block[i], block[j], block[k]]);
    }
    const consolidate = [];
    for (const give of subsets) {
      const g = adjustedTotal(give.map(p => p.value)), best = Math.max(...give.map(p => p.value));
      targets.filter(t => t.value > best * 1.08 && t.value >= g * (1 - tol * 1.5) && t.value <= g * (1 + tol))
        .forEach(t => consolidate.push({ give, get: [t], ...score(give, [t]) }));
    }
    // keep the tightest deal per target, prefer fewer pieces given
    const bestPer = new Map();
    for (const x of consolidate.sort((a, b) => byCloseness(a, b) || a.give.length - b.give.length)) {
      if (!bestPer.has(x.get[0].id)) bestPer.set(x.get[0].id, x);
    }
    const consolidated = [...bestPer.values()].sort((a, b) => b.getTotal - a.getTotal).slice(0, limit);

    // Split: each block player → two targets (both at wanted positions) that together match it
    const split = [];
    for (const b of block) {
      const cand = targets.filter(t => t.value < b.value * 0.8 && t.value >= b.value * 0.25)
        .sort((x, y) => Math.abs(x.value - b.value * 0.55) - Math.abs(y.value - b.value * 0.55)).slice(0, 30);
      const found = [];
      for (let i = 0; i < cand.length; i++) for (let j = i + 1; j < cand.length; j++) {
        const s = score([b], [cand[i], cand[j]]);
        if (Math.abs(s.fairPct) <= tol) found.push({ give: [b], get: [cand[i], cand[j]], ...s });
      }
      found.sort(byCloseness).slice(0, 3).forEach(x => split.push(x));
    }
    split.sort(byCloseness);

    return { swaps: swaps.slice(0, limit), consolidate: consolidated, split: split.slice(0, limit) };
  }

  /** Players within ±pct of a value (excluding ids). */
  function similarValue(value, { pct = 0.15, exclude = new Set(), pos = 'ALL', limit = 12 } = {}) {
    return ranked('ALL')
      .filter(p => !exclude.has(p.id) && (pos === 'ALL' || p.pos === pos) && Math.abs(p.value - value) <= value * pct)
      .sort((a, b) => Math.abs(a.value - value) - Math.abs(b.value - value))
      .slice(0, limit);
  }

  // ---------- helpers ----------
  const fmt = n => n.toLocaleString('en-US');
  const initials = name => name.split(' ').filter(Boolean).map(s => s[0]).slice(0, 2).join('').toUpperCase();
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function trendHtml(t) {
    if (!t) return '<span class="trend trend--flat">—</span>';
    const cls = t > 0 ? 'up' : 'down';
    const arrow = t > 0 ? '▲' : '▼';
    return `<span class="trend trend--${cls}">${arrow} ${fmt(Math.abs(t))}</span>`;
  }

  // ---------- images ----------
  // Headshots: Sleeper CDN by sleeperId, then ESPN by espnId, then initials. Logos: Sleeper, then ESPN.
  const ESPN_LOGO = { WAS: 'wsh', JAX: 'jax', LAR: 'lar', LAC: 'lac' };
  function headshotUrls(p) {
    const u = [];
    if (p.sleeperId) u.push(`https://sleepercdn.com/content/nfl/players/thumb/${p.sleeperId}.jpg`);
    if (p.espnId) u.push(`https://a.espncdn.com/i/headshots/nfl/players/full/${p.espnId}.png`);
    return u;
  }
  function logoUrls(team) {
    if (!team || team === 'FA') return [];
    const t = team.toLowerCase();
    return [`https://sleepercdn.com/images/team_logos/nfl/${t}.png`, `https://a.espncdn.com/i/teamlogos/nfl/500/${ESPN_LOGO[team] || t}.png`];
  }
  // onerror walks the data-alt list; when exhausted the <img> hides and the initials underneath show through.
  const FALLBACK = "var a=(this.dataset.alt||'').split('|').filter(Boolean);if(a.length){this.src=a.shift();this.dataset.alt=a.join('|')}else{this.style.display='none'}";
  function avatar(p) {
    const [first, ...rest] = headshotUrls(p);
    const img = first ? `<img src="${first}" data-alt="${rest.join('|')}" alt="" loading="lazy" onload="this.classList.add('ok')" onerror="${FALLBACK}">` : '';
    return `<span class="avatar avatar--${p.pos}"><span class="avatar__init">${initials(p.name)}</span>${img}</span>`;
  }
  function logo(team, size = 16) {
    const [first, ...rest] = logoUrls(team);
    if (!first) return '';
    return `<img class="logo" width="${size}" height="${size}" src="${first}" data-alt="${rest.join('|')}" alt="" loading="lazy" onload="this.classList.add('ok')" onerror="${FALLBACK}">`;
  }
  /** "DET" rendered as logo + abbreviation. */
  function teamHtml(team) { return `<span class="team">${logo(team)}${esc(team || 'FA')}</span>`; }

  function toast(msg) {
    let el = document.querySelector('.toast');
    if (!el) { el = document.createElement('div'); el.className = 'toast'; document.body.appendChild(el); }
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('show'), 1800);
  }

  // ---------- shared UI: nav + settings segmented controls ----------
  function initNav() {
    const toggle = document.querySelector('.nav__toggle');
    const links = document.querySelector('.nav__links');
    if (toggle && links) toggle.addEventListener('click', () => links.classList.toggle('open'));

    const path = location.pathname.split('/').pop() || 'index.html';
    document.querySelectorAll('.nav__links a').forEach(a => {
      if (a.getAttribute('href') === path) a.classList.add('active');
    });
  }

  function bindSegments() {
    document.querySelectorAll('[data-setting]').forEach(seg => {
      const key = seg.dataset.setting;
      const buttons = seg.querySelectorAll('button');
      const sync = () => buttons.forEach(b => b.classList.toggle('active', b.dataset.value === String(settings[key])));
      sync();
      buttons.forEach(b => b.addEventListener('click', () => { setSetting(key, b.dataset.value); }));
      document.addEventListener('giq:settings', sync);
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    initNav(); bindSegments();
    document.querySelectorAll('[data-updated]').forEach(el => el.textContent = updatedLabel());
    document.querySelectorAll('[data-sources]').forEach(el => el.textContent = sourcesLabel());
  });

  return { settings, setSetting, valueOf, ranked, tierOf, meta, adjustedTotal, findBalancers, tradeBlockIdeas, similarValue, BUNDLE, updatedLabel, sourcesLabel, fmt, initials, esc, trendHtml, avatar, logo, teamHtml, injuryHtml, toast };
})();
