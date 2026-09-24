// Settings sheet: Gemini API key + model, player profile, display, data
// import/export, and install/update.
import { state, on, saveSettings, getApiKey, setApiKey, exportBackup, clearAllData, hasDemoData, removeDemoData, DEFAULT_MODEL } from '../store.js';
import { kv, storageEstimate } from '../db.js';
import { listModels } from '../ai.js';
import { toPar, differential } from '../stats.js';
import { html, setHTML, toCSV, shareOrDownload, isoDate, plural } from '../utils.js';
import { icon, openSheet, toast, toastError, confirmDialog, setBusy } from '../ui.js';
import { openImporter } from './importer.js';
import { loadSampleData } from '../demo.js';
import { installState, promptInstall, checkForUpdate, APP_VERSION, onInstallChange } from '../pwa.js';

const MODELS_KEY = 'parmap.models';
const DEFAULT_MODELS = [
  { id: 'gemini-flash-latest', label: 'Gemini Flash (latest)' },
  { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
  { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash' },
  { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash' },
  { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite' },
  { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro (preview)' },
];

function cachedModels() {
  try { return JSON.parse(localStorage.getItem(MODELS_KEY) || 'null') || DEFAULT_MODELS; } catch { return DEFAULT_MODELS; }
}

let openSheetCtl = null;

export function openSettings({ focus = null } = {}) {
  if (openSheetCtl?.isOpen) { if (focus) focusField(openSheetCtl, focus); return openSheetCtl; }
  const s = openSheet({ title: 'Settings', size: 'full' });
  openSheetCtl = s;
  let showKey = false;

  function render() {
    const key = getApiKey();
    const models = cachedModels();
    const model = state.settings.model || DEFAULT_MODEL;
    if (!models.some((m) => m.id === model)) models.unshift({ id: model, label: model });
    const inst = installState();
    setHTML(s.body, html`
      <div class="section-title" style="margin-top:4px">AI scorecard scanning</div>
      <section class="card card-pad">
        <div class="row-flex">
          <span class="row-icon" style="background:linear-gradient(120deg,#2a78d6,#7b5cf0 55%,#d0509a);color:#fff">${icon('sparkles')}</span>
          <div class="row-main"><div class="row-title">Google Gemini</div><div class="row-sub">Reads scorecards and writes insights</div></div>
          <span class="badge ${key ? 'badge--good' : ''}">${key ? html`${icon('check')} Key saved` : 'No key'}</span>
        </div>
        <div class="field" style="margin-top:14px">
          <label for="st-key">Google AI Studio API key</label>
          <div class="input-wrap">
            <input class="input" id="st-key" type="${showKey ? 'text' : 'password'}" autocomplete="off" spellcheck="false" autocapitalize="off" placeholder="Paste your key (starts with AIza…)" value="${key}">
            <button class="icon-btn" type="button" data-act="toggle-key" aria-label="${showKey ? 'Hide key' : 'Show key'}">${icon(showKey ? 'eye-off' : 'eye')}</button>
          </div>
          <p class="hint">Get a free key at <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a>. It’s stored only in this browser’s local storage and sent only to Google’s Gemini API.</p>
        </div>
        <div class="row-flex" style="margin-top:12px;flex-wrap:wrap">
          <button class="btn btn-primary btn-sm" type="button" data-act="save-key">${icon('key')} Save &amp; test</button>
          ${key ? html`<button class="btn btn-ghost btn-sm" type="button" data-act="remove-key">Remove key</button>` : ''}
        </div>
        <div data-el="key-status" aria-live="polite" style="margin-top:10px"></div>
        <div class="field" style="margin-top:8px">
          <label for="st-model">Model</label>
          <select class="select" id="st-model">${models.map((m) => html`<option value="${m.id}" ${m.id === model ? 'selected' : ''}>${m.label}${m.label !== m.id ? ` (${m.id})` : ''}</option>`)}</select>
          <p class="hint">“Flash (latest)” tracks Google’s newest Flash model. If a model isn’t available for your key, ParMap falls back automatically.</p>
        </div>
      </section>

      <div class="section-title">You</div>
      <section class="card card-pad" style="padding-top:4px;padding-bottom:4px">
        <div class="settings-row">
          <div class="row-main"><label class="row-title" for="st-name">Your name on scorecards</label><div class="row-sub">Helps AI pick your row when a card has several players</div>
            <input class="input" id="st-name" style="margin-top:8px" value="${state.settings.playerName}" placeholder="e.g. Sam R. or SR" maxlength="40" autocomplete="nickname"></div>
        </div>
        <div class="settings-row">
          <div class="row-main"><div class="row-title">Default round length</div></div>
          <div class="seg" data-group="defaultHoles"><button type="button" data-val="18" aria-pressed="${String(state.settings.defaultHoles !== 9)}">18</button><button type="button" data-val="9" aria-pressed="${String(state.settings.defaultHoles === 9)}">9</button></div>
        </div>
      </section>

      <div class="section-title">Display</div>
      <section class="card card-pad" style="padding-top:4px;padding-bottom:4px">
        <div class="settings-row">
          <div class="row-main"><div class="row-title">Appearance</div></div>
          <div class="seg" data-group="theme">${['system', 'light', 'dark'].map((t) => html`<button type="button" data-val="${t}" aria-pressed="${String(state.settings.theme === t)}">${t[0].toUpperCase() + t.slice(1)}</button>`)}</div>
        </div>
        <div class="settings-row">
          <div class="row-main"><div class="row-title">Distance</div></div>
          <div class="seg" data-group="units"><button type="button" data-val="mi" aria-pressed="${String(state.settings.units === 'mi')}">Miles</button><button type="button" data-val="km" aria-pressed="${String(state.settings.units === 'km')}">Km</button></div>
        </div>
        <div class="settings-row">
          <div class="row-main"><label class="row-title" for="st-label">Map pins show</label></div>
          <select class="select" id="st-label" style="width:auto;min-width:150px">
            ${[['best', 'Best score'], ['avg', 'Average'], ['last', 'Last score'], ['count', 'Rounds played']].map(([v, l]) => html`<option value="${v}" ${state.settings.markerLabel === v ? 'selected' : ''}>${l}</option>`)}
          </select>
        </div>
      </section>

      <div class="section-title">Your data</div>
      <section class="card" style="overflow:hidden">
        <div class="list-plain" style="padding:0 12px">
          ${actionRow('import', 'upload', 'Import rounds', 'CSV, ParMap backup, or paste from another app with AI')}
          ${actionRow('export-json', 'download', 'Export backup', 'Everything in a JSON file you can restore later')}
          ${actionRow('export-csv', 'file', 'Export spreadsheet', 'All rounds as CSV (Excel, Google Sheets)')}
          ${hasDemoData() ? actionRow('remove-demo', 'trash', 'Remove sample data', 'Keeps your real rounds') : actionRow('load-demo', 'sparkles', 'Load sample data', 'Explore the app with example rounds')}
          ${actionRow('wipe', 'trash', 'Delete all data', 'Removes every round, course and photo on this device', true)}
        </div>
      </section>
      <p class="hint" data-el="storage" style="margin:8px 4px 0"></p>

      <div class="section-title">App</div>
      <section class="card" style="overflow:hidden">
        <div class="list-plain" style="padding:0 12px">
          ${inst === 'available' ? actionRow('install', 'phone-app', 'Install ParMap', 'Add to your home screen and use it offline') : ''}
          ${inst === 'ios' ? html`<div class="row"><span class="row-icon">${icon('phone-app')}</span><div class="row-main"><div class="row-title">Install on iPhone or iPad</div><div class="row-sub" style="white-space:normal">In Safari tap Share ${icon('share', 'i-sm')} then “Add to Home Screen”.</div></div></div>` : ''}
          ${inst === 'installed' ? html`<div class="row"><span class="row-icon">${icon('check')}</span><div class="row-main"><div class="row-title">Installed</div><div class="row-sub">Running as an app</div></div></div>` : ''}
          ${actionRow('update', 'refresh', 'Check for updates', `Version ${APP_VERSION}`)}
        </div>
      </section>
      <p class="hint" style="margin:14px 4px 4px;line-height:1.6">
        Map data © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors · Imagery © Esri · Course search by Photon (komoot) and the Overpass API · Maps by Leaflet · AI by Google Gemini.
        Your rounds stay on this device unless you export them.
      </p>`);
    showStorage();
  }

  function actionRow(act, ic, title, sub, danger = false) {
    return html`<button class="row" type="button" data-act="${act}">
      <span class="row-icon" style="${danger ? 'background:var(--danger-soft);color:var(--danger)' : ''}">${icon(ic)}</span>
      <div class="row-main"><div class="row-title" style="${danger ? 'color:var(--danger)' : ''}">${title}</div><div class="row-sub" style="white-space:normal">${sub}</div></div>
      ${icon('chevron-right', 'faint')}
    </button>`;
  }

  async function showStorage() {
    const el = s.body.querySelector('[data-el="storage"]');
    const est = await storageEstimate();
    if (!el) return;
    const mb = est?.usage != null ? ` · ${(est.usage / 1048576).toFixed(1)} MB used` : '';
    el.textContent = `${plural(state.rounds.length, 'round')} · ${plural(Object.keys(state.courses).length, 'course')} · stored in ${kv.backend === 'indexeddb' ? 'IndexedDB' : kv.backend === 'localstorage' ? 'local storage' : 'memory only (not saved)'}${mb}`;
  }

  function keyStatus(kind, text) {
    const el = s.body.querySelector('[data-el="key-status"]');
    if (!el) return;
    const cls = { ok: 'callout--good', err: 'callout--danger', info: 'callout--info' }[kind];
    setHTML(el, text ? html`<div class="callout ${cls}">${icon(kind === 'ok' ? 'check' : kind === 'err' ? 'alert' : 'info')}<div>${text}</div></div>` : '');
  }

  async function saveKey(btn) {
    const input = s.body.querySelector('#st-key');
    const key = input.value.trim();
    if (!key) { keyStatus('err', 'Paste your API key first.'); input.focus(); return; }
    setBusy(btn, true, 'Testing…');
    try {
      const models = await listModels(key);
      setApiKey(key);
      if (models.length) localStorage.setItem(MODELS_KEY, JSON.stringify(models.slice(0, 40)));
      render();
      keyStatus('ok', `Connected. ${plural(models.length, 'Gemini model')} available to your key.`);
      toast('Gemini API key saved', { iconName: 'key' });
    } catch (e) {
      if (e.code === 'network' || e.code === 'timeout') {
        setApiKey(key);
        render();
        keyStatus('info', 'Key saved, but it couldn’t be verified because you appear to be offline.');
      } else {
        setBusy(btn, false);
        keyStatus('err', e.code === 'invalid_key'
          ? 'Google rejected this key. Copy it again from AI Studio and make sure nothing is cut off.'
          : e.message);
      }
    }
  }

  function exportCSV() {
    const header = ['Date', 'Course', 'City', 'Region', 'Holes', 'Score', 'Par', 'To Par', 'Tees', 'Rating', 'Slope', 'Differential', 'Front 9', 'Back 9', 'Notes', 'Source', 'Latitude', 'Longitude'];
    const rows = state.rounds.map((r) => {
      const c = state.courses[r.courseId] || {};
      return [r.date, c.name, c.city, c.region, r.holes, r.score, r.par, toPar(r), r.tees, r.rating, r.slope, differential(r), r.front9, r.back9, r.notes, r.source, c.lat, c.lng];
    });
    return shareOrDownload(`parmap-rounds-${isoDate()}.csv`, toCSV([header, ...rows]), 'text/csv');
  }

  s.body.addEventListener('click', async (e) => {
    const segBtn = e.target.closest('[data-group] [data-val]');
    if (segBtn) {
      const group = segBtn.closest('[data-group]').dataset.group;
      const raw = segBtn.dataset.val;
      saveSettings({ [group]: group === 'defaultHoles' ? +raw : raw });
      segBtn.parentElement.querySelectorAll('[data-val]').forEach((b) => b.setAttribute('aria-pressed', String(b === segBtn)));
      return;
    }
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    switch (btn.dataset.act) {
      case 'toggle-key': {
        const val = s.body.querySelector('#st-key').value;
        showKey = !showKey;
        render();
        s.body.querySelector('#st-key').value = val;
        break;
      }
      case 'save-key': saveKey(btn); break;
      case 'remove-key': {
        const ok = await confirmDialog({ title: 'Remove API key?', message: 'AI scanning and insights will stop working until you add a key again.', confirmText: 'Remove', danger: true });
        if (ok) { setApiKey(''); render(); toast('API key removed'); }
        break;
      }
      case 'import': openImporter(); break;
      case 'export-json': {
        if (!state.rounds.length) { toast('No rounds to export yet.'); break; }
        await shareOrDownload(`parmap-backup-${isoDate()}.json`, JSON.stringify(exportBackup(), null, 1), 'application/json');
        break;
      }
      case 'export-csv': {
        if (!state.rounds.length) { toast('No rounds to export yet.'); break; }
        await exportCSV();
        break;
      }
      case 'load-demo': loadSampleData(); render(); toast('Sample rounds added', { iconName: 'sparkles' }); break;
      case 'remove-demo': removeDemoData(); render(); toast('Sample data removed'); break;
      case 'wipe': {
        const ok = await confirmDialog({ title: 'Delete all data?', message: `This permanently deletes ${plural(state.rounds.length, 'round')}, their courses and scorecard photos from this device. Export a backup first if you might want them.`, confirmText: 'Delete everything', danger: true });
        if (!ok) break;
        await clearAllData();
        try { localStorage.removeItem('parmap.insights'); } catch { /* ignore */ }
        render();
        toast('All data deleted', { iconName: 'trash' });
        break;
      }
      case 'install': if (await promptInstall()) toast('ParMap installed'); render(); break;
      case 'update': {
        setBusy(btn, true);
        try {
          const found = await checkForUpdate();
          toast(found ? 'Update downloading. It applies next time you open ParMap.' : 'You’re on the latest version.');
        } catch { toast('Couldn’t check for updates right now.', { tone: 'error' }); }
        setBusy(btn, false);
        break;
      }
      default: break;
    }
  });
  s.body.addEventListener('change', (e) => {
    if (e.target.id === 'st-model') { saveSettings({ model: e.target.value }); toast(`Model set to ${e.target.value}`); }
    if (e.target.id === 'st-name') saveSettings({ playerName: e.target.value.trim() });
    if (e.target.id === 'st-label') saveSettings({ markerLabel: e.target.value });
  });
  s.body.addEventListener('keydown', (e) => {
    if (e.target.id === 'st-key' && e.key === 'Enter') { e.preventDefault(); saveKey(s.body.querySelector('[data-act="save-key"]')); }
  });
  const offInstall = onInstallChange(render);
  const off = on((kind) => { if (kind === 'data') showStorage(); });
  s.onClose = () => { off(); offInstall(); openSheetCtl = null; };
  render();
  if (focus) focusField(s, focus);
  return s;
}

function focusField(s, focus) {
  if (focus !== 'apikey') return;
  setTimeout(() => {
    const input = s.body.querySelector('#st-key');
    input?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    input?.focus({ preventScroll: true });
  }, 380);
}
