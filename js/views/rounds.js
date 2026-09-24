// Rounds tab: smart search, shared filters, and a month-grouped history list.
import { state, on, applyFilters, searchRounds, filterChips, activeFilterCount, clearFilter, resetFilters, saveSettings, getCourse } from '../store.js';
import { summarize, toPar } from '../stats.js';
import { html, setHTML, debounce, fmtToPar, fmt1, fmtMonthYear, parseISO, plural, avg } from '../utils.js';
import { icon, emptyArt, actionSheet } from '../ui.js';
import { openRoundDetail } from './round-detail.js';
import { openRoundForm } from './round-form.js';
import { openFilters } from './filters.js';
import { openImporter } from './importer.js';
import { openScan } from './scan.js';
import { openSettings } from './settings.js';

const SORTS = { newest: 'Newest first', oldest: 'Oldest first', best: 'Best score', worst: 'Highest score', course: 'Course A–Z' };

let root;
let visible = false;
let dirty = true;
let query = '';

export const roundsView = {
  init,
  show() { visible = true; if (dirty) render(); },
  hide() { visible = false; },
  reselect() { root.scrollTo({ top: 0, behavior: 'smooth' }); },
};

function init(el) {
  root = el;
  setHTML(root, html`
    <header class="view-head">
      <h1>Rounds</h1>
      <div class="head-actions">
        <button class="icon-btn" data-act="import" aria-label="Import rounds" title="Import">${icon('upload')}</button>
        <button class="icon-btn" data-act="settings" aria-label="Settings" title="Settings">${icon('settings')}</button>
        <button class="btn btn-primary btn-sm" data-act="log">${icon('plus')} Log round</button>
      </div>
    </header>
    <div class="view-body">
      <div class="stack" style="gap:10px">
        <div class="searchbar" role="search">
          ${icon('search')}
          <input type="search" data-el="q" placeholder="Search course, notes, <85, 2025, june…" autocomplete="off" enterkeyhint="search" aria-label="Search rounds">
          <button class="icon-btn" data-act="clear-q" hidden aria-label="Clear search">${icon('x')}</button>
        </div>
        <div class="chip-row" data-el="chips"></div>
      </div>
      <div data-el="list" aria-live="polite"></div>
    </div>`);

  const q = root.querySelector('[data-el="q"]');
  const apply = debounce(() => { query = q.value; render(); }, 120);
  q.addEventListener('input', () => {
    root.querySelector('[data-act="clear-q"]').hidden = !q.value;
    apply();
  });
  root.addEventListener('click', onClick);
  on((kind) => {
    if (kind === 'data' || kind === 'filters' || (kind === 'settings')) {
      dirty = true;
      if (visible) render();
    }
  });
}

function sortRounds(list, mode) {
  const byCourse = (r) => (getCourse(r.courseId)?.name || '').toLowerCase();
  const out = [...list];
  if (mode === 'oldest') out.reverse();
  else if (mode === 'best') out.sort((a, b) => a.holes - b.holes || a.score - b.score);
  else if (mode === 'worst') out.sort((a, b) => a.holes - b.holes || b.score - a.score);
  else if (mode === 'course') out.sort((a, b) => byCourse(a).localeCompare(byCourse(b)) || (a.date < b.date ? 1 : -1));
  return out;
}

function render() {
  dirty = false;
  const n = activeFilterCount();
  const mode = state.settings.roundsSort || 'newest';
  setHTML(root.querySelector('[data-el="chips"]'), html`
    <button class="chip ${n ? 'is-on' : ''}" data-act="filters">${icon('sliders')} Filters${n ? html`<span class="count">${n}</span>` : ''}</button>
    ${filterChips().map((c) => html`<button class="chip is-on" data-act="clear-filter" data-key="${c.key}" aria-label="Remove filter ${c.label}">${c.label} ${icon('x', 'i-sm x')}</button>`)}
    <button class="chip" data-act="sort">${icon('list')} ${SORTS[mode]} ${icon('chevron-down', 'i-sm')}</button>`);

  const listEl = root.querySelector('[data-el="list"]');
  if (!state.rounds.length) {
    setHTML(listEl, html`
      <div class="empty">
        ${emptyArt()}
        <h2>No rounds yet</h2>
        <p>Snap a photo of your scorecard and Gemini reads the total for you, or log your score in a few taps.</p>
        <div class="actions">
          <button class="btn btn-primary" data-act="scan">${icon('camera')} Scan scorecard</button>
          <button class="btn btn-secondary" data-act="log">${icon('plus')} Log a round</button>
        </div>
        <button class="link-btn" data-act="import" style="margin-top:6px">Import from a CSV, backup or another app</button>
      </div>`);
    return;
  }

  const rounds = sortRounds(searchRounds(applyFilters(state.rounds), query), mode);
  if (!rounds.length) {
    setHTML(listEl, html`
      <div class="empty">
        <h2>No matching rounds</h2>
        <p>Try a different search or clear your filters.</p>
        <div class="actions">
          ${query ? html`<button class="btn btn-secondary" data-act="clear-q">Clear search</button>` : ''}
          ${n ? html`<button class="btn btn-secondary" data-act="reset-filters">Clear filters</button>` : ''}
        </div>
      </div>`);
    return;
  }

  const s = summarize(rounds);
  const pbId = summarize(state.rounds).best18?.id;
  const summary = html`<div class="group-head" style="margin-top:14px">
      <h3>${plural(rounds.length, 'round')}</h3>
      <span>${s.avg18 != null ? html`avg ${fmt1(s.avg18)} · best ${s.best18.score}` : s.avg9 != null ? html`9-hole avg ${fmt1(s.avg9)}` : ''}</span>
    </div>`;

  let body;
  if (mode === 'newest' || mode === 'oldest') {
    const groups = [];
    for (const r of rounds) {
      const key = r.date.slice(0, 7);
      if (!groups.length || groups[groups.length - 1].key !== key) groups.push({ key, rounds: [] });
      groups[groups.length - 1].rounds.push(r);
    }
    body = groups.map((g) => {
      const a18 = avg(g.rounds.filter((r) => r.holes === 18).map((r) => r.score));
      return html`
        <div class="group-head"><h3>${fmtMonthYear(g.key + '-01')}</h3><span>${plural(g.rounds.length, 'round')}${a18 != null ? html` · avg ${fmt1(a18)}` : ''}</span></div>
        <div class="list">${g.rounds.map((r) => roundRow(r, pbId))}</div>`;
    });
  } else {
    body = html`<div class="list" style="margin-top:4px">${rounds.map((r) => roundRow(r, pbId))}</div>`;
  }
  setHTML(listEl, html`${summary}${body}`);
}

export function roundRow(r, pbId) {
  const c = getCourse(r.courseId);
  const d = parseISO(r.date);
  const meta = [`${r.holes} holes`, r.tees, r.par ? `Par ${r.par}` : ''].filter(Boolean).join(' · ');
  const badges = [
    r.id === pbId ? html`<span class="badge badge--pb">${icon('trophy')} Best</span>` : '',
    r.source === 'scan' ? html`<span class="badge badge--ai">${icon('sparkles')} Scanned</span>` : '',
    r.demo ? html`<span class="badge badge--demo">Sample</span>` : '',
  ].filter(Boolean);
  return html`<button class="row" type="button" data-round="${r.id}">
      <div class="date-block" aria-hidden="true"><span class="mo">${d.toLocaleDateString(undefined, { month: 'short' })}</span><span class="dy">${d.getDate()}</span></div>
      <div class="row-main">
        <div class="row-title">${c?.name || 'Unknown course'}</div>
        <div class="row-sub">${meta}</div>
        ${badges.length ? html`<div class="row-flex" style="gap:6px;margin-top:6px">${badges}</div>` : ''}
      </div>
      <div class="row-end">
        <span class="score">${r.score}</span>
        ${r.par ? html`<span class="topar">${fmtToPar(toPar(r))}</span>` : ''}
      </div>
      <span class="sr-only">${d.toLocaleDateString()}</span>
    </button>`;
}

async function onClick(e) {
  const row = e.target.closest('[data-round]');
  if (row) { openRoundDetail(row.dataset.round); return; }
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  switch (btn.dataset.act) {
    case 'log': openRoundForm(); break;
    case 'scan': openScan(); break;
    case 'import': openImporter(); break;
    case 'settings': openSettings(); break;
    case 'filters': openFilters(); break;
    case 'clear-filter': clearFilter(btn.dataset.key); break;
    case 'reset-filters': resetFilters(); break;
    case 'clear-q': {
      const q = root.querySelector('[data-el="q"]');
      q.value = '';
      query = '';
      root.querySelector('[data-act="clear-q"]').hidden = true;
      render();
      break;
    }
    case 'sort': {
      const choice = await actionSheet({
        title: 'Sort rounds',
        actions: Object.entries(SORTS).map(([value, label]) => ({ value, label, checked: (state.settings.roundsSort || 'newest') === value })),
      });
      if (choice) saveSettings({ roundsSort: choice.value });
      break;
    }
    default: break;
  }
}
