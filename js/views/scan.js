// Full-screen scorecard scanner: live camera (or photo upload) -> Gemini
// vision -> course matching -> review sheet -> saved round + photo.
import { state, saveSettings, findCourseMatch, getCourse, addRound, saveRoundPhoto, updateCourse } from '../store.js';
import { html, setHTML, uid, isoDate, isValidISO, resizeImage, blobToDataURL, similarity, fmtToPar, toInt, toNum, plural, vibrate } from '../utils.js';
import { icon, toast, openSheet, pushOverlay, closeOverlay } from '../ui.js';
import { scanScorecard, hasApiKey } from '../ai.js';
import { geocodeCourse, lastKnownPosition } from '../geo.js';
import { pickCourse } from './course-picker.js';
import { openRoundForm } from './round-form.js';
import { openSettings } from './settings.js';
import { openRoundDetail } from './round-detail.js';
import { ensureCourse } from './course-detail.js';
import { goTab } from '../router.js';
import { focusCourseOnMap } from './map.js';

const MAX_PHOTOS = 3;
const STATUS = ['Reading your scorecard…', 'Finding players and totals…', 'Checking the math…', 'Almost there…'];

let el = null;
let entry = null;
let stream = null;
let photos = [];
let active = -1;
let mode = 'starting';
let abortCtrl = null;
let statusTimer = null;
let torchOn = false;
let lastError = null;

export function openScan() {
  if (el) return;
  photos = [];
  active = -1;
  lastError = null;
  el = document.createElement('div');
  el.className = 'scan';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-label', 'Scan scorecard');
  setHTML(el, html`
    <div class="scan-stage">
      <video class="scan-video" playsinline muted autoplay></video>
      <img class="scan-photo" alt="Captured scorecard" hidden>
      <div class="scan-guide" hidden><i></i><i></i><i></i><i></i></div>
      <div class="scan-laser" hidden></div>
    </div>
    <div class="scan-top">
      <button class="icon-btn" type="button" data-act="close" aria-label="Close scanner">${icon('x')}</button>
      <div class="scan-title">Scan scorecard</div>
      <button class="icon-btn" type="button" data-act="torch" aria-label="Toggle flashlight" hidden>${icon('zap')}</button>
    </div>
    <div class="scan-middle" data-el="middle"></div>
    <div class="scan-bottom">
      <div class="scan-tray" data-el="tray"></div>
      <div class="scan-controls" data-el="controls"></div>
    </div>
    <input type="file" accept="image/*" multiple hidden data-el="file">
    <input type="file" accept="image/*" capture="environment" hidden data-el="camera">`);
  document.getElementById('scan-root').append(el);
  entry = pushOverlay(teardown);
  el.addEventListener('click', onClick);
  el.querySelector('[data-el="file"]').addEventListener('change', onFiles);
  el.querySelector('[data-el="camera"]').addEventListener('change', onFiles);
  document.addEventListener('visibilitychange', onVisibility);
  document.addEventListener('keydown', onKey);
  setMode('starting');
  startCamera();
}

export function closeScan() {
  return entry ? closeOverlay(entry) : Promise.resolve();
}

function teardown() {
  stopCamera();
  abortCtrl?.abort();
  clearInterval(statusTimer);
  document.removeEventListener('visibilitychange', onVisibility);
  document.removeEventListener('keydown', onKey);
  photos.forEach((p) => URL.revokeObjectURL(p.url));
  photos = [];
  el?.remove();
  el = null;
  entry = null;
}

/* ---------- Camera ----------------------------------------------------------- */
async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) { setMode('nocam'); return; }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } },
      audio: false,
    });
    if (!el) { stopCamera(); return; }
    const video = el.querySelector('video');
    video.srcObject = stream;
    await video.play().catch(() => {});
    const track = stream.getVideoTracks()[0];
    const caps = track?.getCapabilities?.() || {};
    el.querySelector('[data-act="torch"]').hidden = !caps.torch;
    setMode('camera');
  } catch (e) {
    console.warn('[ParMap] camera unavailable', e?.name);
    if (el) setMode('nocam', { denied: e?.name === 'NotAllowedError' });
  }
}

function stopCamera() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  torchOn = false;
  const video = el?.querySelector('video');
  if (video) video.srcObject = null;
}

function onVisibility() {
  if (!el) return;
  if (document.visibilityState === 'hidden' && mode === 'camera') stopCamera();
  else if (document.visibilityState === 'visible' && mode === 'camera' && !stream) startCamera();
}
function onKey(e) {
  if (e.key === 'Escape' && el && !document.querySelector('.sheet-layer')) closeScan();
  if ((e.key === ' ' || e.key === 'Enter') && mode === 'camera' && e.target === document.body) { e.preventDefault(); capture(); }
}

async function capture() {
  const video = el?.querySelector('video');
  if (!video?.videoWidth) return;
  const c = document.createElement('canvas');
  c.width = video.videoWidth;
  c.height = video.videoHeight;
  c.getContext('2d').drawImage(video, 0, 0);
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.92));
  if (!blob) return;
  const flash = document.createElement('div');
  flash.className = 'scan-flash';
  el.append(flash);
  setTimeout(() => flash.remove(), 400);
  vibrate(15);
  addPhoto(blob);
}

function addPhoto(blob) {
  if (photos.length >= MAX_PHOTOS) { toast(`Up to ${MAX_PHOTOS} photos per scorecard`); return; }
  photos.push({ blob, url: URL.createObjectURL(blob) });
  active = photos.length - 1;
  stopCamera();
  lastError = null;
  setMode('review');
}

function onFiles(e) {
  const files = [...(e.target.files || [])].filter((f) => f.type.startsWith('image/') || /\.(heic|heif)$/i.test(f.name));
  files.slice(0, MAX_PHOTOS - photos.length).forEach(addPhoto);
  e.target.value = '';
}

/* ---------- Rendering by mode ------------------------------------------------ */
function setMode(next, opts = {}) {
  mode = next;
  if (!el) return;
  const video = el.querySelector('video');
  const img = el.querySelector('.scan-photo');
  const showPhoto = ['review', 'analyzing', 'error'].includes(mode) && active >= 0;
  video.hidden = mode !== 'camera' && mode !== 'starting';
  img.hidden = !showPhoto;
  if (showPhoto) img.src = photos[active].url;
  el.querySelector('.scan-guide').hidden = mode !== 'camera';
  el.querySelector('.scan-laser').hidden = mode !== 'analyzing';
  if (mode !== 'camera') el.querySelector('[data-act="torch"]').hidden = true;

  const keyBanner = !hasApiKey() && mode !== 'analyzing'
    ? html`<div class="scan-banner">${icon('key')}<span>Add your free Gemini API key to read scorecards automatically.</span><button class="btn btn-sm" data-act="key">Set up</button></div>`
    : '';
  const middle = el.querySelector('[data-el="middle"]');
  const controls = el.querySelector('[data-el="controls"]');

  if (mode === 'starting') {
    setHTML(middle, html`<div class="scan-hint">Starting camera…</div>`);
    setHTML(controls, '');
  } else if (mode === 'camera') {
    setHTML(middle, html`${keyBanner}<div class="scan-hint">Fit the whole scorecard inside the frame</div>`);
    setHTML(controls, html`
      <button class="scan-side" type="button" data-act="library"><span class="ico">${icon('image')}</span>Library</button>
      <button class="shutter" type="button" data-act="capture" aria-label="Take photo"></button>
      <button class="scan-side" type="button" data-act="manual"><span class="ico">${icon('edit')}</span>Type it</button>`);
  } else if (mode === 'nocam') {
    setHTML(middle, html`${keyBanner}
      <div class="scan-nocam">
        <label class="dropzone" data-el="drop" style="cursor:pointer">
          ${icon('camera')}
          <b style="color:#fff">Add a photo of your scorecard</b>
          <span style="font-size:13.5px">${opts.denied ? 'Camera access is blocked, so choose or take a photo instead.' : 'Take a photo, pick one from your library, or drop an image here.'}</span>
        </label>
        <div class="row-flex" style="justify-content:center;flex-wrap:wrap">
          <button class="btn btn-primary" type="button" data-act="native-camera">${icon('camera')} Take photo</button>
          <button class="btn btn-secondary" type="button" data-act="library">${icon('image')} Choose photo</button>
        </div>
      </div>`);
    setHTML(controls, html`<span></span><span></span><button class="scan-side" type="button" data-act="manual"><span class="ico">${icon('edit')}</span>Type it</button>`);
    wireDrop();
  } else if (mode === 'review') {
    setHTML(middle, html`${keyBanner}${lastError ? errorBox(lastError) : ''}`);
    setHTML(controls, html`
      <button class="scan-side" type="button" data-act="add-page"><span class="ico">${icon('plus')}</span>${photos.length < MAX_PHOTOS ? 'Add page' : 'Retake'}</button>
      <button class="btn btn-ai scan-analyze" type="button" data-act="analyze">${icon('sparkles')} ${lastError ? 'Try again' : 'Read card'}</button>
      <button class="scan-side" type="button" data-act="manual"><span class="ico">${icon('edit')}</span>Type it</button>`);
  } else if (mode === 'analyzing') {
    setHTML(middle, html`<div class="scan-status" role="status"><span class="spinner"></span><b data-el="status">${STATUS[0]}</b><p>Gemini is reading ${plural(photos.length, 'photo')}. This usually takes a few seconds.</p></div>`);
    setHTML(controls, html`<span></span><button class="btn btn-secondary" type="button" data-act="cancel">Cancel</button><span></span>`);
  }
  renderTray();
}

function errorBox(err) {
  const keyIssue = ['no_key', 'invalid_key', 'forbidden'].includes(err.code);
  return html`<div class="scan-error">${icon('alert')}<b>${err.title || 'Couldn’t read that card'}</b><p>${err.message}</p>
    <div class="btns">${keyIssue ? html`<button class="btn btn-sm" style="background:#ffd166;color:#2b2100" data-act="key">${icon('key')} Check API key</button>` : ''}
    <button class="btn btn-secondary btn-sm" data-act="manual">Enter it manually</button></div></div>`;
}

function renderTray() {
  const tray = el?.querySelector('[data-el="tray"]');
  if (!tray) return;
  const show = photos.length > 0 && mode !== 'analyzing';
  setHTML(tray, show ? html`${photos.map((p, i) => html`<div class="thumb ${i === active ? 'is-active' : ''}" data-thumb="${i}">
      <img src="${p.url}" alt="Page ${i + 1}">
      <button type="button" data-remove="${i}" aria-label="Remove page ${i + 1}">${icon('x')}</button></div>`)}` : '');
}

function wireDrop() {
  const drop = el.querySelector('[data-el="drop"]');
  if (!drop) return;
  drop.addEventListener('click', () => el.querySelector('[data-el="file"]').click());
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('is-over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove('is-over')));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    [...(e.dataTransfer.files || [])].filter((f) => f.type.startsWith('image/')).slice(0, MAX_PHOTOS).forEach(addPhoto);
  });
}

/* ---------- Analysis ------------------------------------------------------- */
async function analyze() {
  if (!photos.length) return;
  if (!hasApiKey()) { openSettings({ focus: 'apikey' }); return; }
  setMode('analyzing');
  abortCtrl = new AbortController();
  let i = 0;
  statusTimer = setInterval(() => {
    i = Math.min(i + 1, STATUS.length - 1);
    const s = el?.querySelector('[data-el="status"]');
    if (s) s.textContent = STATUS[i];
  }, 2300);
  try {
    const prepared = await Promise.all(photos.map((p) => resizeImage(p.blob, 2048, 0.88)));
    const result = await scanScorecard(prepared, { signal: abortCtrl.signal, playerName: state.settings.playerName });
    if (!el) return;
    if (!result.isScorecard) {
      lastError = { title: 'No scores found', message: 'Gemini couldn’t find golf scores in this photo. Get the whole card in frame, in focus and in good light, then try again.' };
      setMode('review');
      return;
    }
    clearInterval(statusTimer);
    const status = el.querySelector('[data-el="status"]');
    if (status) status.textContent = 'Matching the course…';
    const match = await matchCourse(result.course);
    const thumb = await blobToDataURL(await resizeImage(photos[0].blob, 1400, 0.72)).catch(() => null);
    if (!el) return;
    setMode('review');
    openReview(result, match, thumb);
  } catch (e) {
    if (!el) return;
    if (e.code === 'aborted' || e.name === 'AbortError') { setMode('review'); return; }
    lastError = { code: e.code, message: e.message || 'Something went wrong. Please try again.' };
    setMode('review');
  } finally {
    clearInterval(statusTimer);
    abortCtrl = null;
  }
}

async function matchCourse(info) {
  if (!info?.name) return { course: null, how: 'none' };
  const near = lastKnownPosition();
  const local = findCourseMatch(info.name, near);
  if (local && local.score >= 0.8) return { course: local.course, how: 'yours' };
  try {
    const hit = await geocodeCourse(info, near);
    if (hit) {
      const { distanceKm, isGolf, kind, extent, ...c } = hit;
      return { course: getCourse(c.id) || c, how: getCourse(c.id) ? 'yours' : 'map' };
    }
  } catch { /* fall through to a new course */ }
  return {
    course: { id: `local:${uid()}`, name: info.name, city: info.city, region: info.region, country: info.country, lat: null, lng: null, source: 'scan' },
    how: 'new',
  };
}

function pickPlayer(players, myName) {
  if (players.length <= 1 || !myName) return 0;
  const initials = myName.split(/\s+/).map((w) => w[0]).join('').toLowerCase();
  let best = 0, bestScore = -1;
  players.forEach((p, i) => {
    const n = p.name.toLowerCase().replace(/[^a-z ]/g, '').trim();
    let sc = similarity(p.name, myName);
    if (n && (n === initials || n.replace(/\s/g, '') === initials)) sc = Math.max(sc, 0.95);
    if (n && myName.toLowerCase().split(/\s+/).some((w) => w.length > 1 && n.split(/\s+/).includes(w))) sc = Math.max(sc, 0.8);
    if (sc > bestScore) { best = i; bestScore = sc; }
  });
  return bestScore >= 0.45 ? best : 0;
}

/* ---------- Review & save --------------------------------------------------- */
function openReview(result, match, thumb) {
  let course = match.course;
  let how = match.how;
  const players = result.players;
  let pIdx = pickPlayer(players, state.settings.playerName);
  let holes = result.holes;
  const confLabel = { high: 'High confidence', medium: 'Double-check a few numbers', low: 'Hard to read. Please verify' }[result.confidence];

  const s = openSheet({
    title: 'Review round',
    subtitle: 'Check what Gemini read before saving',
    size: 'full',
    body: html`<form class="form" novalidate autocomplete="off">
      <div class="row-flex" style="justify-content:space-between">
        <span class="confidence ${result.confidence}"><i></i>${confLabel}</span>
        <span class="badge badge--ai">${icon('sparkles')} ${result.model}</span>
      </div>
      ${result.notes ? html`<div class="callout callout--info">${icon('info')}<div>${result.notes}</div></div>` : ''}
      <div class="field"><span class="field-label">Course</span><button type="button" class="picker-btn" data-act="pick" data-el="course"></button></div>
      ${players.length > 1 ? html`<div class="field"><span class="field-label">Which player are you?</span>
        <div class="stack" style="gap:8px" data-el="players">${players.map((p, i) => html`
          <label class="player-opt"><input type="radio" name="player" value="${i}" ${i === pIdx ? 'checked' : ''}>
            <div class="row-main"><div class="row-title">${p.name}</div><div class="row-sub">${[p.front9 != null ? `Out ${p.front9}` : '', p.back9 != null ? `In ${p.back9}` : ''].filter(Boolean).join(' · ') || `${p.holesRead} holes read`}</div></div>
            <span class="score" style="font-size:22px">${p.total}</span></label>`)}</div></div>` : ''}
      <div class="field">
        <label for="sr-score">Total score</label>
        <div class="stepper">
          <button type="button" data-step="-1" aria-label="Decrease score">${icon('minus', 'i-lg')}</button>
          <input id="sr-score" name="score" type="number" inputmode="numeric" value="${players[pIdx]?.total ?? ''}" required>
          <button type="button" data-step="1" aria-label="Increase score">${icon('plus', 'i-lg')}</button>
        </div>
        <div class="stepper-meta" data-el="topar"></div>
      </div>
      <div data-el="warn"></div>
      <div class="field-row">
        <div class="field"><label for="sr-date">Date</label><input class="input" type="date" id="sr-date" name="date" value="${result.date || isoDate()}" max="${isoDate()}"></div>
        <div class="field"><span class="field-label">Holes</span><div class="seg seg-block" data-el="holes">
          <button type="button" data-holes="18" aria-pressed="${String(holes === 18)}">18</button><button type="button" data-holes="9" aria-pressed="${String(holes === 9)}">9</button></div></div>
      </div>
      ${!result.date ? html`<p class="hint" style="margin-top:-8px">No date on the card, so today is filled in.</p>` : ''}
      <div class="field-row">
        <div class="field"><label for="sr-par">Par</label><input class="input" id="sr-par" name="par" type="number" inputmode="numeric" value="${result.par ?? course?.par ?? ''}" placeholder="${holes === 9 ? 36 : 72}"></div>
        <div class="field"><label for="sr-tees">Tees</label><input class="input" id="sr-tees" name="tees" value="${result.tees ?? ''}" placeholder="e.g. White"></div>
      </div>
      <div class="field-row">
        <div class="field"><label for="sr-rating">Course rating</label><input class="input" id="sr-rating" name="rating" type="number" step="0.1" inputmode="decimal" value="${result.rating ?? ''}" placeholder="71.8"></div>
        <div class="field"><label for="sr-slope">Slope</label><input class="input" id="sr-slope" name="slope" type="number" inputmode="numeric" value="${result.slope ?? ''}" placeholder="131"></div>
      </div>
      <div class="field-row">
        <div class="field"><label for="sr-f9">Out</label><input class="input" id="sr-f9" name="front9" type="number" inputmode="numeric" value="${players[pIdx]?.front9 ?? ''}"></div>
        <div class="field" data-el="b9"><label for="sr-b9">In</label><input class="input" id="sr-b9" name="back9" type="number" inputmode="numeric" value="${players[pIdx]?.back9 ?? ''}"></div>
      </div>
      <div class="field"><label for="sr-notes">Notes</label><textarea class="textarea" id="sr-notes" name="notes" rows="2" maxlength="2000" placeholder="Optional"></textarea></div>
      ${players.length > 1 || !state.settings.playerName ? html`<label class="check-row" style="border:0;padding:0"><input type="checkbox" data-el="remember" ${!state.settings.playerName ? 'checked' : ''}><span data-el="remember-label" style="font-size:14px"></span></label>` : ''}
      ${thumb ? html`<p class="hint">${icon('image', 'i-sm')} The scorecard photo is saved with this round on your device.</p>` : ''}
      <div class="callout callout--danger" data-el="err" hidden></div>
    </form>`,
    footer: html`<button class="btn btn-secondary" type="button" data-act="rescan">${icon('camera')} Rescan</button><button class="btn btn-primary" type="button" data-act="save">${icon('check')} Save round</button>`,
  });

  const $ = (sel) => s.body.querySelector(sel);
  const scoreEl = $('#sr-score');

  function renderCourse() {
    const btn = $('[data-el="course"]');
    const sub = !course ? 'Gemini couldn’t read the course name. Tap to choose.'
      : how === 'yours' ? 'Matched to one of your courses'
        : how === 'map' ? `Found on the map${course.city ? ` · ${course.city}` : ''}`
          : 'New course · not on the map yet (you can locate it later)';
    btn.classList.toggle('is-empty', !course);
    setHTML(btn, html`<span class="row-icon">${icon(how === 'new' ? 'plus' : 'flag')}</span>
      <div class="row-main"><div class="row-title">${course ? course.name : 'Choose a course'}</div><div class="row-sub" style="white-space:normal">${sub}</div></div>${icon('chevron-right')}`);
  }
  function renderWarnings() {
    const p = players[pIdx];
    const w = [...(p?.warnings || [])];
    setHTML($('[data-el="warn"]'), w.length ? html`<div class="callout callout--warn">${icon('alert')}<div>${w.map((x) => html`<div>${x}</div>`)}</div></div>` : '');
    const lbl = $('[data-el="remember-label"]');
    if (lbl) lbl.textContent = `This is me. Remember “${p?.name}” for future scans`;
  }
  function renderToPar() {
    const sc = toInt(scoreEl.value), par = toInt($('#sr-par').value);
    $('[data-el="topar"]').textContent = sc != null && par ? `${fmtToPar(sc - par)} to par` : '';
  }
  function setHoles(n) {
    holes = n;
    s.body.querySelectorAll('[data-holes]').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.holes === n)));
    $('[data-el="b9"]').hidden = n === 9;
    renderToPar();
  }
  function showError(msg, focusEl) {
    const err = $('[data-el="err"]');
    setHTML(err, html`${icon('alert')}<div>${msg}</div>`);
    err.hidden = false;
    focusEl?.focus?.();
    err.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  async function save() {
    const f = new FormData($('form'));
    const score = toInt(f.get('score'));
    const date = String(f.get('date') || '');
    if (!course) return showError('Choose the course you played.', $('[data-el="course"]'));
    const [lo, hi] = holes === 9 ? [18, 120] : [36, 250];
    if (score == null || score < lo || score > hi) return showError(`Enter your total for ${holes} holes (${lo}–${hi}).`, scoreEl);
    if (!isValidISO(date) || date > isoDate()) return showError('Enter the date you played.', $('#sr-date'));
    const saveBtn = s.foot.querySelector('[data-act="save"]');
    saveBtn.disabled = true;
    const c = ensureCourse(course);
    const par = toInt(f.get('par'));
    const round = addRound({
      courseId: c.id, date, holes, score, par,
      tees: f.get('tees'), rating: toNum(f.get('rating')), slope: toInt(f.get('slope')),
      front9: toInt(f.get('front9')), back9: holes === 18 ? toInt(f.get('back9')) : null,
      notes: f.get('notes'), source: 'scan',
      ai: { confidence: result.confidence, model: result.model },
    });
    if (!c.par && par && holes === 18) updateCourse(c.id, { par });
    if ($('[data-el="remember"]')?.checked && players[pIdx]) saveSettings({ playerName: players[pIdx].name }, { silent: true });
    if (thumb) await saveRoundPhoto(round.id, thumb);
    await s.close();
    await closeScan();
    const onMap = c.lat != null;
    if (onMap) {
      goTab('map');
      focusCourseOnMap(c.id, { isNew: true });
    } else {
      goTab('rounds');
      openRoundDetail(round.id);
    }
    toast(`Saved ${score} at ${c.name}`, { action: onMap ? 'Details' : undefined, onAction: () => openRoundDetail(round.id), iconName: 'sparkles' });
  }

  s.body.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.act === 'pick') {
      const picked = await pickCourse({ initialQuery: course?.name || result.course.name || '' });
      if (picked) { course = picked; how = getCourse(picked.id) ? 'yours' : picked.lat != null ? 'map' : 'new'; renderCourse(); }
    } else if (b.dataset.holes) setHoles(+b.dataset.holes);
    else if (b.dataset.step) {
      scoreEl.value = Math.max(18, (toInt(scoreEl.value) ?? players[pIdx]?.total ?? 90) + +b.dataset.step);
      renderToPar();
    }
  });
  s.body.addEventListener('change', (e) => {
    if (e.target.name === 'player') {
      pIdx = +e.target.value;
      const p = players[pIdx];
      scoreEl.value = p.total ?? '';
      $('#sr-f9').value = p.front9 ?? '';
      $('#sr-b9').value = p.back9 ?? '';
      renderWarnings();
      renderToPar();
    }
  });
  s.body.addEventListener('input', renderToPar);
  s.foot.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'save') save();
    if (act === 'rescan') {
      await s.close();
      photos.forEach((p) => URL.revokeObjectURL(p.url));
      photos = [];
      active = -1;
      setMode('starting');
      startCamera();
    }
  });

  renderCourse();
  renderWarnings();
  setHoles(holes);
}

/* ---------- Events ------------------------------------------------------------ */
async function onClick(e) {
  const thumb = e.target.closest('[data-thumb]');
  const remove = e.target.closest('[data-remove]');
  if (remove) {
    const i = +remove.dataset.remove;
    URL.revokeObjectURL(photos[i].url);
    photos.splice(i, 1);
    active = Math.min(active, photos.length - 1);
    lastError = null;
    if (!photos.length) { setMode('starting'); startCamera(); } else setMode('review');
    return;
  }
  if (thumb) { active = +thumb.dataset.thumb; setMode(mode); return; }
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  switch (btn.dataset.act) {
    case 'close': closeScan(); break;
    case 'capture': capture(); break;
    case 'library': el.querySelector('[data-el="file"]').click(); break;
    case 'native-camera': el.querySelector('[data-el="camera"]').click(); break;
    case 'torch': {
      const track = stream?.getVideoTracks()[0];
      if (!track) break;
      torchOn = !torchOn;
      try { await track.applyConstraints({ advanced: [{ torch: torchOn }] }); } catch { torchOn = false; }
      btn.classList.toggle('is-on', torchOn);
      break;
    }
    case 'add-page':
      if (photos.length >= MAX_PHOTOS) {
        URL.revokeObjectURL(photos[active].url);
        photos.splice(active, 1);
        active = photos.length - 1;
      }
      setMode('starting');
      startCamera();
      break;
    case 'analyze': analyze(); break;
    case 'cancel': abortCtrl?.abort(); break;
    case 'key': openSettings({ focus: 'apikey' }); break;
    case 'manual': {
      await closeScan();
      openRoundForm();
      break;
    }
    default: break;
  }
}
