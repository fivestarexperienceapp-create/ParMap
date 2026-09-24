// Shared filter sheet. Filters apply live to the Map, Rounds and Stats tabs.
import { state, on, setFilters, resetFilters, applyFilters, playedCourses, RANGE_LABELS } from '../store.js';
import { html, setHTML, toInt, debounce, plural, isoDate } from '../utils.js';
import { openSheet } from '../ui.js';

const SCORE_PRESETS = [
  { label: 'Under 80', min: null, max: 79 },
  { label: '80s', min: 80, max: 89 },
  { label: '90s', min: 90, max: 99 },
  { label: '100+', min: 100, max: null },
];

export function openFilters() {
  const f = state.filters;
  const courses = playedCourses().map((p) => p.course).sort((a, b) => a.name.localeCompare(b.name));
  const s = openSheet({
    title: 'Filters',
    subtitle: 'Applies to the map, rounds and stats',
    body: html`
      <div class="section-title" style="margin-top:6px">Date range</div>
      <div class="chip-row" style="flex-wrap:wrap" data-el="ranges">
        ${Object.entries(RANGE_LABELS).map(([k, label]) => html`<button type="button" class="chip" data-range="${k}">${label}</button>`)}
      </div>
      <div class="field-row" data-el="custom" style="margin-top:10px" hidden>
        <div class="field"><label for="fl-from">From</label><input class="input" type="date" id="fl-from" value="${f.from}" max="${isoDate()}"></div>
        <div class="field"><label for="fl-to">To</label><input class="input" type="date" id="fl-to" value="${f.to}" max="${isoDate()}"></div>
      </div>

      <div class="section-title">Score</div>
      <div class="chip-row" style="flex-wrap:wrap" data-el="presets">
        ${SCORE_PRESETS.map((p, i) => html`<button type="button" class="chip" data-preset="${i}">${p.label}</button>`)}
      </div>
      <div class="field-row" style="margin-top:10px">
        <div class="field"><label for="fl-min">Min score</label><input class="input" id="fl-min" type="number" inputmode="numeric" value="${f.minScore ?? ''}" placeholder="Any"></div>
        <div class="field"><label for="fl-max">Max score</label><input class="input" id="fl-max" type="number" inputmode="numeric" value="${f.maxScore ?? ''}" placeholder="Any"></div>
      </div>

      <div class="section-title">Holes</div>
      <div class="seg seg-block" data-el="holes" role="group" aria-label="Holes">
        <button type="button" data-holes="all">All</button><button type="button" data-holes="18">18 holes</button><button type="button" data-holes="9">9 holes</button>
      </div>

      <div class="section-title">Course</div>
      <select class="select" id="fl-course" aria-label="Course">
        <option value="">All courses</option>
        ${courses.map((c) => html`<option value="${c.id}">${c.name}</option>`)}
      </select>`,
    footer: html`<button class="btn btn-secondary" data-act="reset" type="button">Reset</button><button class="btn btn-primary" data-act="done" type="button"></button>`,
  });

  const $ = (sel) => s.body.querySelector(sel);
  $('#fl-course').value = f.courseId || '';

  function sync() {
    const cur = state.filters;
    s.body.querySelectorAll('[data-range]').forEach((b) => b.classList.toggle('is-on', b.dataset.range === cur.range));
    $('[data-el="custom"]').hidden = cur.range !== 'custom';
    s.body.querySelectorAll('[data-preset]').forEach((b) => {
      const p = SCORE_PRESETS[+b.dataset.preset];
      b.classList.toggle('is-on', p.min === cur.minScore && p.max === cur.maxScore);
    });
    s.body.querySelectorAll('[data-holes]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.holes === String(cur.holes))));
    if (document.activeElement !== $('#fl-min')) $('#fl-min').value = cur.minScore ?? '';
    if (document.activeElement !== $('#fl-max')) $('#fl-max').value = cur.maxScore ?? '';
    if ($('#fl-course').value !== (cur.courseId || '')) $('#fl-course').value = cur.courseId || '';
    const n = applyFilters(state.rounds).length;
    s.foot.querySelector('[data-act="done"]').textContent = `Show ${plural(n, 'round')}`;
  }

  s.body.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.range) {
      const patch = { range: b.dataset.range };
      if (b.dataset.range === 'custom' && !state.filters.from) patch.from = `${new Date().getFullYear()}-01-01`;
      setFilters(patch);
    } else if (b.dataset.preset) {
      const p = SCORE_PRESETS[+b.dataset.preset];
      const active = p.min === state.filters.minScore && p.max === state.filters.maxScore;
      setFilters(active ? { minScore: null, maxScore: null } : { minScore: p.min, maxScore: p.max });
    } else if (b.dataset.holes) setFilters({ holes: b.dataset.holes === 'all' ? 'all' : +b.dataset.holes });
  });
  const scoreInput = debounce(() => {
    let min = toInt($('#fl-min').value, 1, 400), max = toInt($('#fl-max').value, 1, 400);
    if (min != null && max != null && min > max) [min, max] = [max, min];
    setFilters({ minScore: min, maxScore: max });
  }, 300);
  $('#fl-min').addEventListener('input', scoreInput);
  $('#fl-max').addEventListener('input', scoreInput);
  $('#fl-from').addEventListener('change', (e) => setFilters({ from: e.target.value }));
  $('#fl-to').addEventListener('change', (e) => setFilters({ to: e.target.value }));
  $('#fl-course').addEventListener('change', (e) => setFilters({ courseId: e.target.value }));
  s.foot.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'reset') resetFilters();
    if (act === 'done') s.close();
  });
  const off = on((kind) => { if (kind === 'filters' || kind === 'data') sync(); });
  s.onClose = () => off();
  sync();
  return s;
}
