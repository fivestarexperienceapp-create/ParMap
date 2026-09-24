// Stats tab: handicap estimate (hero), filter row, KPI tiles, AI insights,
// scoring trend, distribution, milestones and a per-course table.
import { state, on, applyFilters, filterChips, activeFilterCount, clearFilter, getCourse, playedCourses } from '../store.js';
import { summarize, handicapIndex, histogram, courseStats, trendPerMonth, rollingAverage, insightsPayload } from '../stats.js';
import { html, raw, esc, setHTML, fmt1, fmtToPar, fmtDate, fmtHandicap, fmtSigned, isoDate, addDays, plural } from '../utils.js';
import { icon, emptyArt, toastError } from '../ui.js';
import { trendChart, histogramChart } from '../charts.js';
import { hasApiKey, generateInsights } from '../ai.js';
import { openFilters } from './filters.js';
import { openSettings } from './settings.js';
import { openRoundDetail } from './round-detail.js';
import { openCourseDetail } from './course-detail.js';
import { openScan } from './scan.js';
import { openRoundForm } from './round-form.js';
import { loadSampleData } from '../demo.js';

const INSIGHTS_KEY = 'parmap.insights';
let root;
let visible = false;
let dirty = true;
let aiBusy = null; // AbortController while generating

export const statsView = {
  init,
  show() { visible = true; if (dirty) render(); },
  hide() { visible = false; },
  reselect() { root.scrollTo({ top: 0, behavior: 'smooth' }); },
};

function init(el) {
  root = el;
  setHTML(root, html`
    <header class="view-head">
      <h1>Stats</h1>
      <div class="head-actions"><button class="icon-btn" data-act="settings" aria-label="Settings">${icon('settings')}</button></div>
    </header>
    <div class="view-body" data-el="body"></div>`);
  root.addEventListener('click', onClick);
  on((kind) => {
    if (kind === 'data' || kind === 'filters' || kind === 'settings') {
      dirty = true;
      if (visible) render();
    }
  });
}

function dataHash(rounds) {
  const latest = rounds.reduce((m, r) => (r.updatedAt > m ? r.updatedAt : m), '');
  return `${rounds.length}|${latest}|${JSON.stringify(state.filters)}`;
}
function readInsights() {
  try { return JSON.parse(localStorage.getItem(INSIGHTS_KEY) || 'null'); } catch { return null; }
}

function render() {
  dirty = false;
  const body = root.querySelector('[data-el="body"]');
  if (!state.rounds.length) {
    setHTML(body, html`
      <div class="empty">
        ${emptyArt()}
        <h2>Your stats live here</h2>
        <p>Log a few rounds to see your handicap estimate, scoring trend, best rounds and AI insights.</p>
        <div class="actions">
          <button class="btn btn-primary" data-act="scan">${icon('camera')} Scan scorecard</button>
          <button class="btn btn-secondary" data-act="log">${icon('plus')} Log a round</button>
        </div>
        <button class="link-btn" data-act="sample" style="margin-top:6px">Explore with sample data</button>
      </div>`);
    return;
  }

  const rounds = applyFilters(state.rounds);
  const s = summarize(rounds);
  const hcp = handicapIndex(state.rounds);
  const hcpPrev = handicapIndex(state.rounds, { asOf: isoDate(addDays(new Date(), -30)) });
  const hcpDelta = hcp.value != null && hcpPrev.value != null ? Math.round((hcp.value - hcpPrev.value) * 10) / 10 : null;
  const n = activeFilterCount();

  const uses9 = !s.count18 && s.count9;
  const trendRounds = rounds.filter((r) => r.holes === (uses9 ? 9 : 18)).sort((a, b) => (a.date < b.date ? -1 : 1));
  const avgDelta = s.last5Avg != null && s.prev5Avg != null ? s.last5Avg - s.prev5Avg : null;
  const perMonth = trendPerMonth(trendRounds);
  const courses = playedCourses(rounds)
    .map((p) => ({ ...p, st: courseStats(p.rounds) }))
    .sort((a, b) => b.rounds.length - a.rounds.length);
  const bestToPar = rounds.filter((r) => r.par).reduce((b, r) => (!b || (r.score - r.par) * (18 / r.holes) < (b.score - b.par) * (18 / b.holes) ? r : b), null);

  setHTML(body, html`
    <div class="card hero-stat">
      <svg class="art" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><use href="#i-flag"/></svg>
      <span class="label">${icon('target', 'i-sm')} Handicap index <span class="badge">est.</span></span>
      <span class="value">${fmtHandicap(hcp.value)}</span>
      <span class="sub">${hcp.value != null
        ? html`From the best ${hcp.used} of your last ${plural(hcp.count, '18-hole differential')}${hcp.approx ? ' · par & slope 113 used where rating/slope are missing' : ''}.`
        : html`Log ${plural(hcp.needed, 'more 18-hole round')} to see your estimate.`}</span>
      ${hcpDelta != null && hcpDelta !== 0 ? html`<span class="delta ${hcpDelta < 0 ? 'good' : 'bad'}">${icon(hcpDelta < 0 ? 'trend-down' : 'trend-up')} ${fmtSigned(hcpDelta)} in the last 30 days</span>` : ''}
    </div>

    <div class="chip-row" style="margin:16px 0 12px">
      <button class="chip ${n ? 'is-on' : ''}" data-act="filters">${icon('sliders')} Filters${n ? html`<span class="count">${n}</span>` : ''}</button>
      ${filterChips().map((c) => html`<button class="chip is-on" data-act="clear-filter" data-key="${c.key}">${c.label} ${icon('x', 'i-sm x')}</button>`)}
      ${!n ? html`<span class="faint" style="font-size:13px;align-self:center">All rounds</span>` : ''}
    </div>

    ${!rounds.length ? html`<div class="callout">${icon('info')}<div>No rounds match these filters. <button class="link-btn" data-act="filters">Adjust filters</button></div></div>` : html`
    <div class="kpis">
      <div class="card tile">
        <span class="tile-label">Scoring average${uses9 ? ' (9)' : ''}</span>
        <span class="tile-value">${fmt1(uses9 ? s.avg9 : s.avg18)}</span>
        ${avgDelta != null ? html`<span class="delta ${avgDelta < -0.05 ? 'good' : avgDelta > 0.05 ? 'bad' : 'flat'}" title="Last 5 rounds vs the 5 before">${icon(avgDelta < 0 ? 'trend-down' : 'trend-up')} ${fmtSigned(avgDelta)} recent form</span>` : html`<span class="tile-sub">${uses9 ? '9-hole rounds' : '18-hole rounds'}</span>`}
      </div>
      <div class="card tile">
        <span class="tile-label">Best round</span>
        <span class="tile-value">${(uses9 ? s.best9 : s.best18)?.score ?? '–'}</span>
        <span class="tile-sub">${(uses9 ? s.best9 : s.best18) ? `${getCourse((uses9 ? s.best9 : s.best18).courseId)?.name || ''} · ${fmtDate((uses9 ? s.best9 : s.best18).date, { month: 'short', year: 'numeric' })}` : ''}</span>
      </div>
      <div class="card tile">
        <span class="tile-label">Rounds</span>
        <span class="tile-value">${s.count}</span>
        <span class="tile-sub">${plural(s.courses, 'course')}${s.count9 ? ` · ${s.count9} nine-hole` : ''}</span>
      </div>
      <div class="card tile">
        <span class="tile-label">Avg to par</span>
        <span class="tile-value">${fmtToPar(s.avgToPar18, 1)}</span>
        <span class="tile-sub">per 18 holes</span>
      </div>
    </div>

    <div class="card ai-card" data-el="ai" style="margin-top:12px"></div>

    <div class="card chart-card" style="margin-top:12px">
      <div class="row-flex"><div class="row-main"><div class="card-title">Scoring trend</div><div class="card-sub">${uses9 ? '9-hole' : '18-hole'} scores · lower is better</div></div></div>
      ${trendRounds.length >= 2 ? html`
        <div class="chart-legend"><span><i class="key-dot"></i>Round</span><span><i class="key-line"></i>5-round average</span></div>
        <div class="chart" data-el="trend"></div>
        <div class="chart-foot">${perMonth != null ? html`${icon(perMonth <= 0 ? 'trend-down' : 'trend-up', 'i-sm')} ${Math.abs(perMonth) < 0.1 ? 'Holding steady' : `${perMonth < 0 ? 'Improving' : 'Rising'} ${fmt1(Math.abs(perMonth))} strokes per month`}` : 'Keep logging to see your direction.'}${s.stdev18 != null && !uses9 ? ` · typical spread ±${fmt1(s.stdev18)}` : ''}</div>
        <details class="table-view"><summary>View as table</summary><div class="table-scroll"><table class="data-table">
          <thead><tr><th>Date</th><th>Course</th><th class="num">Score</th><th class="num">5-rd avg</th></tr></thead>
          <tbody>${(() => {
            const av = rollingAverage(trendRounds.map((r) => r.score), 5);
            return trendRounds.map((r, i) => ({ r, a: av[i] })).reverse().map(({ r, a }) => html`<tr data-round="${r.id}"><td>${fmtDate(r.date, { month: 'short', day: 'numeric', year: '2-digit' })}</td><td class="name">${getCourse(r.courseId)?.name || ''}</td><td class="num">${r.score}</td><td class="num">${a != null ? fmt1(a) : '–'}</td></tr>`);
          })()}</tbody></table></div></details>`
        : html`<p class="muted" style="padding:14px 0 6px;font-size:14px">Log at least two ${uses9 ? '9-hole' : '18-hole'} rounds to see your trend.</p>`}
    </div>

    ${trendRounds.length >= 3 ? html`
    <div class="card chart-card" style="margin-top:12px">
      <div class="card-title">Score distribution</div>
      <div class="card-sub">How often you shoot in each 5-stroke band</div>
      <div class="chart" data-el="dist" style="margin-top:8px"></div>
      <details class="table-view"><summary>View as table</summary><table class="data-table">
        <thead><tr><th>Scores</th><th class="num">Rounds</th><th class="num">Share</th></tr></thead>
        <tbody>${histogram(trendRounds.map((r) => r.score)).map((b) => html`<tr><td>${b.from}–${b.to}</td><td class="num">${b.count}</td><td class="num">${Math.round((b.count / trendRounds.length) * 100)}%</td></tr>`)}</tbody>
      </table></details>
    </div>` : ''}

    ${s.count18 ? html`
    <div class="card" style="margin-top:12px">
      <div class="card-head"><div class="card-title">Scoring milestones</div></div>
      <div class="card-sub" style="padding:0 16px 10px">18-hole rounds under each number</div>
      <div class="milestones">
        ${[100, 90, 80, 70].map((k) => html`<div class="milestone ${s.breaks[k] ? 'is-done' : ''}"><b>${s.breaks[k]}</b><span>Broke ${k}</span></div>`)}
      </div>
    </div>` : ''}

    <div class="card" style="margin-top:12px">
      <div class="card-head"><div class="card-title">Records</div></div>
      <div class="list-plain" style="padding:0 12px 6px">
        ${s.best18 ? recordRow('trophy', 'Lowest 18', `${s.best18.score}`, `${getCourse(s.best18.courseId)?.name || ''} · ${fmtDate(s.best18.date)}`, s.best18.id) : ''}
        ${bestToPar ? recordRow('target', 'Best vs par', fmtToPar(bestToPar.score - bestToPar.par), `${getCourse(bestToPar.courseId)?.name || ''} · ${bestToPar.holes} holes`, bestToPar.id) : ''}
        ${s.best9 ? recordRow('flag', 'Lowest 9', `${s.best9.score}`, `${getCourse(s.best9.courseId)?.name || ''} · ${fmtDate(s.best9.date)}`, s.best9.id) : ''}
        ${courses[0] ? recordRow('pin', 'Most played', `${courses[0].rounds.length}×`, courses[0].course.name, null, courses[0].course.id) : ''}
        ${s.last5Avg != null ? recordRow('clock', 'Current form', fmt1(s.last5Avg), 'Average of your last five 18-hole rounds') : ''}
      </div>
    </div>

    <div class="card" style="margin-top:12px">
      <div class="card-head"><div class="card-title">By course</div><span class="card-sub">${plural(courses.length, 'course')}</span></div>
      <div class="table-scroll" style="padding:0 10px 10px;max-height:none">
        <table class="data-table">
          <thead><tr><th>Course</th><th class="num">Rds</th><th class="num">Avg</th><th class="num">Best</th><th class="num">vs par</th></tr></thead>
          <tbody>${courses.slice(0, 15).map((c) => html`<tr data-course="${c.course.id}"><td class="name">${c.course.name}</td><td class="num">${c.rounds.length}</td><td class="num">${fmt1(c.st.avg)}</td><td class="num">${c.st.best?.score ?? '–'}</td><td class="num">${fmtToPar(c.st.avgToPar18, 1)}</td></tr>`)}</tbody>
        </table>
      </div>
    </div>`}
  `);

  const trendEl = body.querySelector('[data-el="trend"]');
  if (trendEl) {
    trendChart(trendEl, {
      points: trendRounds.map((r) => ({ id: r.id, date: r.date, value: r.score, title: getCourse(r.courseId)?.name || '', sub: r.par ? `score · ${fmtToPar(r.score - r.par)}` : 'score' })),
      onSelect: (id) => openRoundDetail(id),
      ariaLabel: `Scoring trend across ${trendRounds.length} rounds. Details are in the table below.`,
    });
  }
  const distEl = body.querySelector('[data-el="dist"]');
  if (distEl) histogramChart(distEl, { bins: histogram(trendRounds.map((r) => r.score)), ariaLabel: 'Score distribution. Details are in the table below.' });
  renderAI(rounds);
}

function recordRow(ic, label, value, sub, roundId = null, courseId = null) {
  return html`<button class="row" type="button" ${roundId ? raw(`data-round="${esc(roundId)}"`) : ''} ${courseId ? raw(`data-course="${esc(courseId)}"`) : ''} ${!roundId && !courseId ? raw('disabled') : ''} style="opacity:1">
    <span class="row-icon">${icon(ic)}</span>
    <div class="row-main"><div class="row-title">${label}</div><div class="row-sub">${sub}</div></div>
    <span class="best-num">${value}</span>
  </button>`;
}

/* ---------- AI insights -------------------------------------------------- */
function renderAI(rounds) {
  const el = root.querySelector('[data-el="ai"]');
  if (!el) return;
  const head = html`<div class="ai-head"><span class="ai-icon">${icon('sparkles')}</span><div class="row-main"><h3>AI insights</h3><p>Gemini reads your round totals and trends</p></div>
    ${readInsights() && !aiBusy && hasApiKey() && rounds.length >= 3 ? html`<button class="icon-btn filled" data-act="ai-refresh" aria-label="Refresh insights" title="Refresh">${icon('refresh')}</button>` : ''}</div>`;
  if (!hasApiKey()) {
    setHTML(el, html`${head}<div class="ai-body"><p class="ai-summary">Add your free Google AI Studio key to get a personal read on your form, strengths and realistic goals.</p>
      <div><button class="btn btn-ai btn-sm" data-act="ai-key">${icon('key')} Add API key</button></div></div>`);
    return;
  }
  if (rounds.length < 3) {
    setHTML(el, html`${head}<div class="ai-body"><p class="ai-summary">Log at least 3 rounds${activeFilterCount() ? ' in this filter' : ''} to unlock insights.</p></div>`);
    return;
  }
  if (aiBusy) {
    setHTML(el, html`${head}<div class="ai-body">
      <div class="row-flex muted" style="font-size:14px"><span class="spinner"></span> Analyzing ${plural(rounds.length, 'round')}…</div>
      <div class="skeleton" style="height:22px;width:80%"></div><div class="skeleton" style="height:56px"></div><div class="skeleton" style="height:56px"></div>
      <div><button class="btn btn-secondary btn-sm" data-act="ai-cancel">Cancel</button></div></div>`);
    return;
  }
  const cached = readInsights();
  if (!cached) {
    setHTML(el, html`${head}<div class="ai-body"><p class="ai-summary">Get a quick analysis of your ${plural(rounds.length, 'round')}: what’s working, where strokes are hiding, and goals to chase next.</p>
      <div><button class="btn btn-ai btn-sm" data-act="ai-run">${icon('sparkles')} Generate insights</button></div></div>`);
    return;
  }
  const d = cached.data;
  const stale = cached.hash !== dataHash(rounds);
  const kindIcon = { strength: 'trophy', opportunity: 'target', trend: 'trend-down', course: 'flag', consistency: 'chart' };
  setHTML(el, html`${head}<div class="ai-body">
    ${stale ? html`<div class="callout callout--info">${icon('info')}<div>Your rounds or filters changed since this was generated. <button class="link-btn" data-act="ai-run">Refresh</button></div></div>` : ''}
    <div class="ai-headline">${d.headline}</div>
    <p class="ai-summary">${d.summary}</p>
    ${d.insights.map((i) => html`<div class="insight ${i.kind}"><span class="dot">${icon(kindIcon[i.kind] || 'info')}</span><div><b>${i.title}</b><p>${i.detail}</p></div></div>`)}
    ${d.goals.length ? html`<div><div class="section-title" style="margin:8px 0 2px">Goals</div>${d.goals.map((g) => html`<div class="goal">${icon('target')}<b>${g.title}${g.target ? html` <span class="badge badge--good">${g.target}</span>` : ''}</b><span>${g.why}</span></div>`)}</div>` : ''}
    ${d.nextRoundTip ? html`<div class="tip-box"><b>Next round:</b> ${d.nextRoundTip}</div>` : ''}
    <p class="faint" style="font-size:11.5px">Generated ${fmtDate(d.generatedAt.slice(0, 10))} · ${d.model} · AI can make mistakes.</p>
  </div>`);
}

async function runInsights() {
  const rounds = applyFilters(state.rounds);
  aiBusy = new AbortController();
  renderAI(rounds);
  try {
    const data = await generateInsights(insightsPayload(rounds, state.courses, state.settings.units), { signal: aiBusy.signal });
    try { localStorage.setItem(INSIGHTS_KEY, JSON.stringify({ hash: dataHash(rounds), data })); } catch { /* ignore */ }
  } catch (e) {
    if (e.code !== 'aborted') {
      if (['no_key', 'invalid_key', 'forbidden'].includes(e.code)) openSettings({ focus: 'apikey' });
      toastError(e);
    }
  } finally {
    aiBusy = null;
    if (visible) renderAI(applyFilters(state.rounds));
  }
}

async function onClick(e) {
  const r = e.target.closest('[data-round]');
  if (r && !e.target.closest('[data-act]')) { openRoundDetail(r.dataset.round); return; }
  const c = e.target.closest('[data-course]');
  if (c) { openCourseDetail(c.dataset.course); return; }
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  switch (btn.dataset.act) {
    case 'settings': openSettings(); break;
    case 'filters': openFilters(); break;
    case 'clear-filter': clearFilter(btn.dataset.key); break;
    case 'scan': openScan(); break;
    case 'log': openRoundForm(); break;
    case 'sample': loadSampleData(); break;
    case 'ai-key': openSettings({ focus: 'apikey' }); break;
    case 'ai-run': case 'ai-refresh': runInsights(); break;
    case 'ai-cancel': aiBusy?.abort(); break;
    default: break;
  }
}
