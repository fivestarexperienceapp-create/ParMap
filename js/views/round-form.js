// Log / edit round sheet. Overall score only; rating & slope unlock an
// accurate handicap estimate and are remembered per course + tees.
import { state, getCourse, addRound, updateRound, updateCourse, roundsForCourse } from '../store.js';
import { summarize } from '../stats.js';
import { html, setHTML, isoDate, isValidISO, toInt, toNum, fmtToPar } from '../utils.js';
import { icon, openSheet, toast } from '../ui.js';
import { pickCourse } from './course-picker.js';
import { ensureCourse } from './course-detail.js';
import { openRoundDetail } from './round-detail.js';
import { goTab } from '../router.js';
import { focusCourseOnMap } from './map.js';

const DEFAULT_TEES = ['Black', 'Blue', 'White', 'Gold', 'Green', 'Red'];

export function openRoundForm({ round = null, course = null, prefill = {} } = {}) {
  const editing = !!round;
  let selected = round ? getCourse(round.courseId) : course ? getCourse(course.id) || course : null;
  const v = { date: isoDate(), holes: state.settings.defaultHoles === 9 ? 9 : 18, ...prefill, ...(round || {}) };
  if (!editing && v.par == null && selected?.par) v.par = selected.par;
  const tees = [...new Set([...state.rounds.map((r) => r.tees).filter(Boolean), ...DEFAULT_TEES])].slice(0, 12);
  const hasExtra = v.rating != null || v.slope != null || v.front9 != null || v.back9 != null || !!v.notes;

  const s = openSheet({
    title: editing ? 'Edit round' : 'Log a round',
    size: 'full',
    body: html`<form class="form" novalidate autocomplete="off">
      <div class="field">
        <span class="field-label">Course</span>
        <button type="button" class="picker-btn" data-act="pick" data-el="course"></button>
      </div>
      <div class="field-row">
        <div class="field"><label for="rf-date">Date</label><input class="input" type="date" id="rf-date" name="date" value="${v.date}" max="${isoDate()}" required></div>
        <div class="field"><span class="field-label">Holes</span>
          <div class="seg seg-block" data-el="holes" role="group" aria-label="Holes played">
            <button type="button" data-holes="18" aria-pressed="${String(v.holes === 18)}">18</button>
            <button type="button" data-holes="9" aria-pressed="${String(v.holes === 9)}">9</button>
          </div>
        </div>
      </div>
      <div class="field">
        <label for="rf-score">Total score</label>
        <div class="stepper">
          <button type="button" data-step="-1" aria-label="Decrease score">${icon('minus', 'i-lg')}</button>
          <input id="rf-score" name="score" type="number" inputmode="numeric" pattern="[0-9]*" min="18" max="250" value="${v.score ?? ''}" placeholder="–" required>
          <button type="button" data-step="1" aria-label="Increase score">${icon('plus', 'i-lg')}</button>
        </div>
        <div class="stepper-meta" data-el="topar" aria-live="polite"></div>
      </div>
      <div class="field-row">
        <div class="field"><label for="rf-par">Par</label><input class="input" id="rf-par" name="par" type="number" inputmode="numeric" value="${v.par ?? ''}" placeholder="${v.holes === 9 ? 36 : 72}"></div>
        <div class="field"><label for="rf-tees">Tees</label><input class="input" id="rf-tees" name="tees" value="${v.tees ?? ''}" placeholder="e.g. White" list="rf-tee-list" maxlength="40"></div>
      </div>
      <datalist id="rf-tee-list">${tees.map((t) => html`<option value="${t}"></option>`)}</datalist>
      <details class="more" ${hasExtra ? 'open' : ''}>
        <summary>More details ${icon('chevron-down', 'i-sm')}</summary>
        <div class="form">
          <div class="field-row">
            <div class="field"><label for="rf-rating">Course rating</label><input class="input" id="rf-rating" name="rating" type="number" inputmode="decimal" step="0.1" value="${v.rating ?? ''}" placeholder="71.8"></div>
            <div class="field"><label for="rf-slope">Slope</label><input class="input" id="rf-slope" name="slope" type="number" inputmode="numeric" value="${v.slope ?? ''}" placeholder="131"></div>
          </div>
          <p class="hint">Printed on the scorecard next to each tee. Adding them makes your handicap estimate accurate.</p>
          <div class="field-row">
            <div class="field"><label for="rf-f9">Front 9 (Out)</label><input class="input" id="rf-f9" name="front9" type="number" inputmode="numeric" value="${v.front9 ?? ''}"></div>
            <div class="field" data-el="b9"><label for="rf-b9">Back 9 (In)</label><input class="input" id="rf-b9" name="back9" type="number" inputmode="numeric" value="${v.back9 ?? ''}"></div>
          </div>
          <div class="field"><label for="rf-notes">Notes</label><textarea class="textarea" id="rf-notes" name="notes" rows="3" maxlength="2000" placeholder="Weather, playing partners, what worked…">${v.notes ?? ''}</textarea></div>
        </div>
      </details>
      <div class="callout callout--danger" data-el="err" hidden></div>
    </form>`,
    footer: html`<button class="btn btn-secondary" data-act="cancel" type="button">Cancel</button>
      <button class="btn btn-primary" data-act="save" type="button">${icon('check')} ${editing ? 'Save changes' : 'Save round'}</button>`,
  });

  const form = s.body.querySelector('form');
  const $ = (sel) => form.querySelector(sel);
  const scoreEl = $('#rf-score');
  let holes = v.holes;

  function renderCourse() {
    const btn = $('[data-el="course"]');
    btn.classList.toggle('is-empty', !selected);
    const sub = selected ? [[selected.city, selected.region].filter(Boolean).join(', '), selected.lat == null ? 'not on map yet' : ''].filter(Boolean).join(' · ') : 'Search nearby or by name';
    setHTML(btn, html`<span class="row-icon">${icon('flag')}</span>
      <div class="row-main"><div class="row-title">${selected ? selected.name : 'Choose a course'}</div><div class="row-sub">${sub}</div></div>
      ${icon('chevron-right')}`);
  }

  function renderToPar() {
    const score = toInt(scoreEl.value);
    const par = toInt($('#rf-par').value);
    const out = [];
    if (score != null && par) out.push(`${fmtToPar(score - par)} to par`);
    const prev = selected ? roundsForCourse(selected.id).filter((r) => r.holes === holes && r.id !== round?.id) : [];
    if (score != null && prev.length) {
      const best = Math.min(...prev.map((r) => r.score));
      if (score < best) out.push('new course best!');
      else out.push(`course best ${best}`);
    }
    $('[data-el="topar"]').textContent = out.join(' · ');
  }

  // Fill rating/slope from your last round at this course with the same tees.
  function suggestRatings() {
    if (!selected) return;
    const tee = $('#rf-tees').value.trim().toLowerCase();
    const prev = roundsForCourse(selected.id).find((r) => r.holes === holes && r.rating != null && (!tee || (r.tees || '').toLowerCase() === tee));
    if (prev) {
      if (!$('#rf-rating').value) $('#rf-rating').value = prev.rating;
      if (!$('#rf-slope').value && prev.slope != null) $('#rf-slope').value = prev.slope;
      if (!$('#rf-tees').value && prev.tees) $('#rf-tees').value = prev.tees;
    }
    if (!$('#rf-par').value) {
      const withPar = roundsForCourse(selected.id).find((r) => r.holes === holes && r.par);
      const par = withPar?.par || (holes === 18 ? selected.par : null);
      if (par) $('#rf-par').value = par;
    }
  }

  function setHoles(n) {
    holes = n;
    form.querySelectorAll('[data-holes]').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.holes === n)));
    $('[data-el="b9"]').hidden = n === 9;
    $('#rf-par').placeholder = n === 9 ? '36' : '72';
    const par = toInt($('#rf-par').value);
    if (par && ((n === 9 && par > 45) || (n === 18 && par < 50))) $('#rf-par').value = '';
    suggestRatings();
    renderToPar();
  }

  function step(d) {
    let val = toInt(scoreEl.value);
    if (val == null) {
      const s18 = summarize(state.rounds.filter((r) => r.holes === holes));
      const par = toInt($('#rf-par').value) || (holes === 9 ? 36 : 72);
      val = Math.round((holes === 9 ? s18.avg9 : s18.avg18) ?? par + (holes === 9 ? 9 : 18));
    } else val += d;
    scoreEl.value = Math.max(holes === 9 ? 18 : 36, Math.min(250, val));
    renderToPar();
  }

  function showError(msg, focusEl) {
    const err = $('[data-el="err"]');
    setHTML(err, html`${icon('alert')}<div>${msg}</div>`);
    err.hidden = false;
    focusEl?.setAttribute('aria-invalid', 'true');
    focusEl?.focus?.();
    err.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  async function save() {
    form.querySelectorAll('[aria-invalid]').forEach((el) => el.removeAttribute('aria-invalid'));
    const f = new FormData(form);
    const score = toInt(f.get('score'));
    const date = String(f.get('date') || '');
    const par = toInt(f.get('par'));
    const rating = toNum(f.get('rating'));
    const slope = toInt(f.get('slope'));
    const front9 = toInt(f.get('front9'));
    const back9 = holes === 18 ? toInt(f.get('back9')) : null;
    if (!selected) return showError('Choose the course you played.', $('[data-el="course"]'));
    if (!isValidISO(date) || date > isoDate()) return showError('Enter the date you played (not in the future).', $('#rf-date'));
    const [lo, hi] = holes === 9 ? [18, 120] : [36, 250];
    if (score == null || score < lo || score > hi) return showError(`Enter your total score for ${holes} holes (${lo}–${hi}).`, scoreEl);
    if (par != null && (holes === 9 ? par < 24 || par > 45 : par < 50 || par > 90)) return showError(`Par for ${holes} holes should be between ${holes === 9 ? '24 and 45' : '50 and 90'}.`, $('#rf-par'));
    if (rating != null && (rating < 20 || rating > 90)) return showError('Course rating looks off. It is usually 60–78 for 18 holes.', $('#rf-rating'));
    if (slope != null && (slope < 55 || slope > 155)) return showError('Slope must be between 55 and 155.', $('#rf-slope'));
    const course = ensureCourse(selected);
    const data = {
      courseId: course.id, date, holes, score, par, rating, slope, front9, back9,
      tees: f.get('tees'), notes: f.get('notes'),
    };
    let saved;
    if (editing) saved = updateRound(round.id, data);
    else saved = addRound({ ...data, source: prefill.source || 'manual', ai: prefill.ai || null });
    if (!course.par && par && holes === 18) updateCourse(course.id, { par });
    await s.close();
    if (editing) { toast('Round updated'); return; }
    const onMap = course.lat != null;
    toast(`Saved ${score} at ${course.name}`, {
      action: onMap ? 'See on map' : 'View',
      onAction: () => {
        if (onMap) { goTab('map'); focusCourseOnMap(course.id, { isNew: true }); } else openRoundDetail(saved.id);
      },
    });
    if (onMap && state.rounds.filter((r) => !r.demo).length === 1) setTimeout(() => toast('First round logged. Your map has its first pin.', { iconName: 'flag' }), 2600);
  }

  s.body.addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.dataset.act === 'pick') {
      const picked = await pickCourse({ initialQuery: '' });
      if (picked) {
        selected = picked;
        renderCourse();
        suggestRatings();
        renderToPar();
        $('[data-el="course"]').removeAttribute('aria-invalid');
      }
    } else if (btn.dataset.holes) setHoles(+btn.dataset.holes);
    else if (btn.dataset.step) step(+btn.dataset.step);
  });
  form.addEventListener('input', (e) => {
    if (e.target.name === 'front9' || e.target.name === 'back9') {
      const a = toInt($('#rf-f9').value), b = toInt($('#rf-b9').value);
      if (a != null && b != null && holes === 18) scoreEl.value = a + b;
      if (a != null && holes === 9 && !scoreEl.value) scoreEl.value = a;
    }
    renderToPar();
  });
  $('#rf-tees').addEventListener('change', suggestRatings);
  form.addEventListener('submit', (e) => { e.preventDefault(); save(); });
  s.foot.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'cancel') s.close();
    if (act === 'save') save();
  });

  renderCourse();
  $('[data-el="b9"]').hidden = holes === 9;
  if (!editing) suggestRatings();
  renderToPar();
  if (!selected && !editing) setTimeout(() => $('[data-el="course"]').focus({ preventScroll: true }), 350);
  return s;
}
