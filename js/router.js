// Hash-based tab routing: deep links work on static hosting (GitHub Pages)
// without server rewrites. Tab switches replace history so the back button
// is reserved for closing sheets and overlays.
export const TABS = ['map', 'rounds', 'stats', 'courses'];
const views = new Map();
let current = null;

export function registerView(name, view) { views.set(name, view); }
export const currentTab = () => current;

export function tabFromHash() {
  const m = location.hash.match(/^#\/(\w+)/);
  return m && TABS.includes(m[1]) ? m[1] : 'map';
}

export function goTab(name) {
  if (!TABS.includes(name)) name = 'map';
  if (current === name) { views.get(name)?.reselect?.(); return; }
  const prev = current;
  current = name;
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('is-active', v.dataset.view === name));
  document.querySelectorAll('.tab[data-tab]').forEach((t) => {
    const on = t.dataset.tab === name;
    t.classList.toggle('is-active', on);
    if (on) t.setAttribute('aria-current', 'page');
    else t.removeAttribute('aria-current');
  });
  if (prev) views.get(prev)?.hide?.();
  views.get(name)?.show?.();
  const hash = `#/${name}`;
  if (location.hash !== hash) history.replaceState(history.state, '', hash);
}

export function initRouter() {
  document.getElementById('tabbar').addEventListener('click', (e) => {
    const a = e.target.closest('a[data-tab]');
    if (!a) return;
    e.preventDefault();
    goTab(a.dataset.tab);
  });
  window.addEventListener('hashchange', () => goTab(tabFromHash()));
  goTab(tabFromHash());
}
