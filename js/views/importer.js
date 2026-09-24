// Importer: CSV files, ParMap JSON backups, or AI-assisted import from pasted
// text / screenshots of another app's score history.
import { importRounds, importBackup } from '../store.js';
import { parseHistory, hasApiKey } from '../ai.js';
import { html, setHTML, parseCSV, parseDateFlexible, toInt, toNum, readFileText, resizeImage, fmtDate, plural, isValidISO, isoDate } from '../utils.js';
import { icon, openSheet, toast, toastError, confirmDialog, setBusy } from '../ui.js';
import { openSettings } from './settings.js';
import { locateCourses } from './courses.js';

const COLS = {
  date: ['date', 'played', 'date played', 'round date', 'played on', 'day'],
  course: ['course', 'course name', 'club', 'facility', 'golf course', 'course played', 'location'],
  score: ['score', 'total', 'gross', 'gross score', 'adjusted gross score', 'ags', 'strokes', 'total score', 'adj score', 'adjusted score', 'total strokes'],
  par: ['par', 'course par'],
  holes: ['holes', 'holes played', '# holes', 'number of holes', 'hole count'],
  tees: ['tees', 'tee', 'tee name', 'tee box', 'tees played', 'tee set'],
  rating: ['rating', 'course rating', 'cr'],
  slope: ['slope', 'slope rating', 'sr'],
  front9: ['front', 'front 9', 'front nine', 'out'],
  back9: ['back', 'back 9', 'back nine', 'in'],
  notes: ['notes', 'note', 'comments', 'comment'],
  city: ['city', 'town'],
  region: ['state', 'region', 'province'],
  lat: ['latitude', 'lat'],
  lng: ['longitude', 'lng', 'lon', 'long'],
};
const normHead = (h) => String(h).toLowerCase().replace(/[^a-z0-9# ]+/g, ' ').replace(/\s+/g, ' ').trim();

function mapColumns(header) {
  const h = header.map(normHead);
  const idx = {};
  for (const [key, names] of Object.entries(COLS)) {
    let i = h.findIndex((x) => names.includes(x));
    if (i < 0 && ['date', 'course', 'score'].includes(key)) i = h.findIndex((x) => names.some((n) => n.length > 3 && x.includes(n)));
    if (i >= 0 && !Object.values(idx).includes(i)) idx[key] = i;
  }
  return idx;
}

function rowsFromCSV(text) {
  const rows = parseCSV(text);
  if (rows.length < 2) throw new Error('That file has no data rows.');
  const idx = mapColumns(rows[0]);
  if (idx.score == null || idx.course == null) {
    throw new Error('Couldn’t find “Course” and “Score” columns. Rename your headers (Date, Course, Score, Par, Holes…) or use AI import.');
  }
  const get = (r, k) => (idx[k] != null ? String(r[idx[k]] ?? '').trim() : '');
  return rows.slice(1).map((r) => {
    const score = toInt(get(r, 'score'), 1, 400);
    const par = toInt(get(r, 'par'));
    let holes = toInt(get(r, 'holes'));
    if (holes == null) holes = (par && par <= 45) || (score && score <= 60 && !par) ? 9 : 18;
    holes = holes <= 12 ? 9 : 18;
    return {
      date: parseDateFlexible(get(r, 'date')),
      course: { name: get(r, 'course'), city: get(r, 'city'), region: get(r, 'region'), lat: toNum(get(r, 'lat'), -90, 90), lng: toNum(get(r, 'lng'), -180, 180) },
      score, holes, par,
      tees: get(r, 'tees') || null,
      rating: toNum(get(r, 'rating'), 20, 90),
      slope: toInt(get(r, 'slope'), 55, 155),
      front9: toInt(get(r, 'front9')),
      back9: toInt(get(r, 'back9')),
      notes: get(r, 'notes'),
    };
  });
}

function validate(it) {
  if (!it.course?.name) return 'Missing course';
  if (it.score == null) return 'Missing score';
  const [lo, hi] = it.holes === 9 ? [18, 120] : [36, 250];
  if (it.score < lo || it.score > hi) return `Score ${it.score} looks wrong for ${it.holes} holes`;
  if (!it.date || !isValidISO(it.date)) return 'Missing or unreadable date';
  if (it.date > isoDate()) return 'Date is in the future';
  return null;
}

export function openImporter({ mode = 'file' } = {}) {
  const s = openSheet({ title: 'Import rounds', subtitle: 'From a file, a backup or another app', size: 'full' });
  let tab = mode;
  let shots = [];
  let busy = null;
  let updateReview = null;

  function renderPick() {
    s.setTitle('Import rounds', 'From a file, a backup or another app');
    s.setFooter(null);
    setHTML(s.body, html`
      <div class="seg seg-block" style="margin:4px 0 16px">
        <button type="button" data-tab="file" aria-pressed="${String(tab === 'file')}">${icon('file', 'i-sm')} File</button>
        <button type="button" data-tab="ai" aria-pressed="${String(tab === 'ai')}">${icon('sparkles', 'i-sm')} Paste with AI</button>
      </div>
      ${tab === 'file' ? html`
        <label class="dropzone" data-el="drop" for="imp-file">
          ${icon('upload')}
          <b>Choose a CSV or ParMap backup</b>
          <span style="font-size:13.5px">or drop the file here</span>
          <input type="file" id="imp-file" accept=".csv,.json,.txt,text/csv,application/json" hidden>
        </label>
        <div class="callout" style="margin-top:14px">${icon('info')}<div>
          <strong>CSV columns ParMap understands</strong><br>
          Date, Course, Score (or Total / Gross) are required. Optional: Par, Holes, Tees, Rating, Slope, Out, In, Notes, City, State.
          Exports from ParMap, most spreadsheet logs, and many golf apps work as-is.
        </div></div>`
      : html`
        <div class="field">
          <label for="imp-text">Paste your score history</label>
          <textarea class="textarea" id="imp-text" rows="7" placeholder="Paste rows from GHIN, 18Birdies, a spreadsheet or notes, e.g.&#10;5/12/25  Pebble Beach  88&#10;Jun 2 2025 · Harding Park · 84 (Blue)">${s.body.querySelector('#imp-text')?.value || ''}</textarea>
        </div>
        <div class="row-flex" style="margin-top:10px;flex-wrap:wrap">
          <label class="btn btn-secondary btn-sm" for="imp-shot">${icon('image')} Add screenshots</label>
          <input type="file" id="imp-shot" accept="image/*" multiple hidden>
          <span class="hint">${shots.length ? plural(shots.length, 'screenshot') + ' attached' : 'Optional: up to 4 screenshots of a score list'}</span>
        </div>
        <div class="row-flex" style="margin-top:8px;gap:8px;flex-wrap:wrap">${shots.map((b, i) => html`<span class="badge">${icon('image')} Screenshot ${i + 1} <button type="button" class="link-btn" data-rm="${i}" aria-label="Remove screenshot">${icon('x', 'i-sm')}</button></span>`)}</div>
        ${!hasApiKey() ? html`<div class="callout callout--warn" style="margin-top:14px">${icon('key')}<div><strong>Needs a Gemini API key.</strong> <button class="link-btn" data-act="key">Add it in Settings</button></div></div>` : ''}
        <button class="btn btn-ai btn-block" style="margin-top:16px" data-act="ai-parse">${icon('sparkles')} Extract rounds with Gemini</button>
        <p class="hint" style="margin-top:10px">Gemini turns messy text or screenshots into rounds. You review everything before it’s saved.</p>`}`);
    if (tab === 'file') wireDrop();
  }

  function wireDrop() {
    const drop = s.body.querySelector('[data-el="drop"]');
    ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('is-over'); }));
    ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove('is-over')));
    drop.addEventListener('drop', (e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) handleFile(f); });
  }

  async function handleFile(file) {
    try {
      const text = await readFileText(file);
      if (/\.json$/i.test(file.name) || /^\s*\{/.test(text)) {
        const data = JSON.parse(text);
        const n = Array.isArray(data.rounds) ? data.rounds.length : 0;
        if (!n) throw new Error('This JSON file doesn’t contain ParMap rounds.');
        const ok = await confirmDialog({ title: 'Restore backup?', message: `Merge ${plural(n, 'round')} from ${data.exportedAt ? fmtDate(data.exportedAt.slice(0, 10)) : 'this backup'} into your data? Rounds you already have are skipped.`, confirmText: 'Merge' });
        if (!ok) return;
        const res = importBackup(data);
        await s.close();
        toast(`Restored ${plural(res.addedRounds, 'round')}${res.addedCourses ? ` and ${plural(res.addedCourses, 'course')}` : ''}`, { iconName: 'download' });
        return;
      }
      renderReview(rowsFromCSV(text), 'import');
    } catch (e) {
      toastError(e, 'That file couldn’t be read.');
    }
  }

  async function aiParse(btn) {
    const text = s.body.querySelector('#imp-text')?.value.trim() || '';
    if (!text && !shots.length) { toast('Paste some text or add a screenshot first.', { tone: 'error' }); return; }
    if (!hasApiKey()) { openSettings({ focus: 'apikey' }); return; }
    setBusy(btn, true, 'Reading with Gemini…');
    busy = new AbortController();
    try {
      const images = await Promise.all(shots.map((b) => resizeImage(b, 2000, 0.85)));
      const rounds = await parseHistory({ text, images }, { signal: busy.signal });
      if (!rounds.length) throw new Error('Gemini didn’t find any rounds in that. Try including dates, course names and scores.');
      renderReview(rounds.map((r) => ({ date: r.date, course: { name: r.courseName, city: r.city, region: r.region }, score: r.score, holes: r.holes, par: r.par, tees: r.tees, rating: r.rating, slope: r.slope })), 'ai-import');
    } catch (e) {
      if (e.code !== 'aborted') toastError(e);
      setBusy(btn, false);
    } finally { busy = null; }
  }

  function renderReview(items, source) {
    const rows = items.map((it) => ({ it, err: validate(it) }));
    const valid = rows.filter((r) => !r.err).length;
    s.setTitle('Review import', `${plural(rows.length, 'round')} found · ${valid} ready`);
    setHTML(s.body, html`
      ${valid < rows.length ? html`<div class="callout callout--warn" style="margin-bottom:10px">${icon('alert')}<div>${plural(rows.length - valid, 'row')} can’t be imported and ${rows.length - valid === 1 ? 'is' : 'are'} unchecked.</div></div>` : ''}
      <label class="check-row" style="border-bottom:1px solid var(--border)"><input type="checkbox" data-el="all" ${valid ? 'checked' : ''}><b>Select all valid rounds</b></label>
      <div data-el="rows">${rows.map((r, i) => html`
        <label class="check-row ${r.err ? 'is-invalid' : ''}">
          <input type="checkbox" data-i="${i}" ${r.err ? 'disabled' : 'checked'}>
          <div class="row-main">
            <div class="row-title">${r.it.course?.name || 'Unknown course'}</div>
            <div class="row-sub">${r.err ? html`<span style="color:var(--danger)">${r.err}</span>` : [r.it.date ? fmtDate(r.it.date) : '', `${r.it.holes} holes`, r.it.tees].filter(Boolean).join(' · ')}</div>
          </div>
          <span class="score" style="font-size:20px">${r.it.score ?? '–'}</span>
        </label>`)}</div>
      <label class="check-row" style="margin-top:12px;border:0"><input type="checkbox" data-el="locate" checked><div class="row-main"><div class="row-title">Find new courses on the map</div><div class="row-sub" style="white-space:normal">Looks up locations on OpenStreetMap so they get score pins</div></div></label>`);
    updateReview = (e) => {
      if (e?.target.matches('[data-el="all"]')) s.body.querySelectorAll('[data-i]:not(:disabled)').forEach((c) => { c.checked = e.target.checked; });
      const n = s.body.querySelectorAll('[data-i]:checked').length;
      s.foot.querySelector('[data-act="do-import"]').textContent = `Import ${plural(n, 'round')}`;
      s.foot.querySelector('[data-act="do-import"]').disabled = !n;
    };
    s.setFooter(html`<button class="btn btn-secondary" data-act="back" type="button">Back</button><button class="btn btn-primary" data-act="do-import" type="button"></button>`);
    updateReview();
    s.foot.onclick = async (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'back') { updateReview = null; s.foot.onclick = null; renderPick(); return; }
      if (act !== 'do-import') return;
      const chosen = [...s.body.querySelectorAll('[data-i]:checked')].map((c) => rows[+c.dataset.i].it);
      const locate = s.body.querySelector('[data-el="locate"]').checked;
      const res = importRounds(chosen, { source });
      await s.close();
      toast(`Imported ${plural(res.added, 'round')}${res.skipped ? ` · ${res.skipped} duplicate${res.skipped === 1 ? '' : 's'} skipped` : ''}`, { iconName: 'download' });
      const toLocate = res.createdCourses.filter((c) => c.lat == null);
      if (locate && toLocate.length) {
        const found = await locateCourses(toLocate);
        toast(`Placed ${found} of ${plural(toLocate.length, 'new course')} on the map`, { iconName: 'pin' });
      }
    };
  }

  s.body.addEventListener('click', (e) => {
    const t = e.target.closest('[data-tab]');
    if (t) { tab = t.dataset.tab; renderPick(); return; }
    const rm = e.target.closest('[data-rm]');
    if (rm) { e.preventDefault(); shots.splice(+rm.dataset.rm, 1); renderPick(); return; }
    const btn = e.target.closest('[data-act]');
    if (btn?.dataset.act === 'ai-parse') aiParse(btn);
    if (btn?.dataset.act === 'key') openSettings({ focus: 'apikey' });
  });
  s.body.addEventListener('change', (e) => {
    if (updateReview && e.target.matches('[data-i], [data-el="all"]')) { updateReview(e); return; }
    if (e.target.id === 'imp-file' && e.target.files?.[0]) handleFile(e.target.files[0]);
    if (e.target.id === 'imp-shot') {
      shots = [...shots, ...[...e.target.files].filter((f) => f.type.startsWith('image/'))].slice(0, 4);
      const text = s.body.querySelector('#imp-text')?.value;
      renderPick();
      if (text) s.body.querySelector('#imp-text').value = text;
    }
  });
  s.onClose = () => busy?.abort();
  renderPick();
  return s;
}
