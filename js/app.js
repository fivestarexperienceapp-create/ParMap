// ParMap bootstrap: theme, persistence, views, routing, PWA and shortcuts.
import { initStore, state, on } from './store.js';
import { initRouter, registerView } from './router.js';
import { mapView } from './views/map.js';
import { roundsView } from './views/rounds.js';
import { statsView } from './views/stats.js';
import { coursesView } from './views/courses.js';
import { openScan } from './views/scan.js';
import { openRoundForm } from './views/round-form.js';
import { initPWA } from './pwa.js';
import { toast } from './ui.js';

function applyTheme() {
  const t = state.settings.theme;
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  const dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute('content', dark ? '#0b100d' : '#0f6b44'));
}

async function boot() {
  applyTheme();
  initPWA();
  await initStore();

  const views = { map: mapView, rounds: roundsView, stats: statsView, courses: coursesView };
  for (const [name, view] of Object.entries(views)) {
    view.init(document.getElementById(`view-${name}`));
    registerView(name, view);
  }
  initRouter();
  document.querySelector('.tab-scan').addEventListener('click', () => openScan());

  on((kind, detail) => {
    if (kind === 'settings' && detail && 'theme' in detail) applyTheme();
    if (kind === 'error') toast(detail?.message || 'Your data couldn’t be saved on this device.', { tone: 'error' });
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', applyTheme);
  window.addEventListener('offline', () => toast('You’re offline. Rounds still save on this device.', { iconName: 'info' }));
  window.addEventListener('online', () => toast('Back online', { iconName: 'check' }));

  // Home-screen shortcuts (manifest "shortcuts") land here.
  const params = new URLSearchParams(location.search);
  const action = params.get('action');
  if (params.has('action') || params.has('source')) history.replaceState(history.state, '', location.pathname + location.hash);
  if (action === 'scan') openScan();
  else if (action === 'log') openRoundForm();

  document.getElementById('app').removeAttribute('aria-busy');
}

boot().catch((err) => {
  console.error('[ParMap] failed to start', err);
  const views = document.getElementById('views');
  if (views) {
    views.innerHTML = `<div class="empty" style="padding-top:20vh"><h2>ParMap couldn’t start</h2>
      <p>${String(err?.message || err).replace(/[<>&]/g, '')}</p>
      <div class="actions"><button class="btn btn-primary" onclick="location.reload()">Reload</button></div></div>`;
  }
});
