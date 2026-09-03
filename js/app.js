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

  function avatar(p) {
    return `<span class="avatar avatar--${p.pos}">${initials(p.name)}</span>`;
  }

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

  return { settings, setSetting, valueOf, ranked, tierOf, meta, adjustedTotal, findBalancers, similarValue, BUNDLE, updatedLabel, sourcesLabel, fmt, initials, esc, trendHtml, avatar, injuryHtml, toast };
})();
