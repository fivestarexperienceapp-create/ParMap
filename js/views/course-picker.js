// Course picker sheet: your courses, nearby OSM courses, worldwide search,
// or a brand-new course. Resolves with a course object (or null).
import { state, playedCourses } from '../store.js';
import { html, setHTML, debounce, similarity, fmtDistance, haversineKm, plural, uid } from '../utils.js';
import { icon, openSheet } from '../ui.js';
import { lastKnownPosition, lastNearbyResult, searchPlaces, getPosition, geoPermission, findNearbyCourses } from '../geo.js';

export function pickCourse({ initialQuery = '', title = 'Choose a course' } = {}) {
  return new Promise((resolve) => {
    let result = null;
    let items = [];
    let remote = null;
    let remoteLoading = false;
    let seq = 0;
    let nearby = lastNearbyResult().courses || [];
    let nearbyLoading = false;

    const s = openSheet({
      title,
      size: 'full',
      body: html`
        <div class="searchbar" style="position:sticky;top:0;z-index:2">
          ${icon('search')}
          <input data-el="q" type="search" placeholder="Search golf courses" value="${initialQuery}" autocomplete="off" enterkeyhint="search" aria-label="Search golf courses">
        </div>
        <div data-el="results" class="search-results" style="box-shadow:none;max-height:none;padding:6px 0 0"></div>`,
      onClose: () => resolve(result),
    });
    const input = s.body.querySelector('[data-el="q"]');
    const box = s.body.querySelector('[data-el="results"]');
    const units = state.settings.units;

    const yours = () => {
      const played = new Map(playedCourses().map((p) => [p.course.id, p]));
      return Object.values(state.courses)
        .map((c) => ({ c, p: played.get(c.id) }))
        .sort((a, b) => (b.p?.rounds[0]?.date || '').localeCompare(a.p?.rounds[0]?.date || ''));
    };
    const place = (c) => [c.city, c.region].filter(Boolean).join(', ');
    const dist = (c) => {
      const me = lastKnownPosition();
      return me && c.lat != null ? fmtDistance(haversineKm(me, c), units) : '';
    };

    function render() {
      const q = input.value.trim();
      const ql = q.toLowerCase();
      items = [];
      const row = (kind, obj, ic, titleText, sub) => {
        items.push({ kind, obj });
        return html`<button class="res" type="button" data-i="${items.length - 1}">${ic}<div class="row-main"><div class="row-title">${titleText}</div>${sub ? html`<div class="row-sub">${sub}</div>` : ''}</div></button>`;
      };
      const match = (name) => !ql || name.toLowerCase().includes(ql) || similarity(q, name) > 0.5;
      const parts = [];
      const mine = yours().filter(({ c }) => match(c.name)).slice(0, q ? 6 : 8);
      if (mine.length) {
        parts.push(html`<div class="res-kind">Your courses</div>`);
        mine.forEach(({ c, p }) => parts.push(row('course', c,
          p ? html`<span class="res-icon is-played">${Math.min(...p.rounds.map((r) => r.score))}</span>` : html`<span class="res-icon">${icon('flag')}</span>`,
          c.name, [p ? plural(p.rounds.length, 'round') : 'Saved', place(c), dist(c)].filter(Boolean).join(' · '))));
      }
      const mineIds = new Set(mine.map(({ c }) => c.id));
      const near = nearby.filter((c) => !mineIds.has(c.id) && !state.courses[c.id] && match(c.name)).slice(0, q ? 5 : 8);
      if (near.length) {
        parts.push(html`<div class="res-kind">Nearby</div>`);
        near.forEach((c) => parts.push(row('course', c, html`<span class="res-icon">${icon('pin')}</span>`, c.name, [dist(c), place(c)].filter(Boolean).join(' · '))));
      } else if (!q && !nearby.length) {
        parts.push(html`<div class="res-kind">Nearby</div>`);
        parts.push(nearbyLoading
          ? html`<div class="loading-row"><span class="spinner"></span>Finding courses near you…</div>`
          : html`<button class="res" type="button" data-act="near"><span class="res-icon">${icon('locate')}</span><div class="row-main"><div class="row-title">Show courses near me</div><div class="row-sub">Uses your location once</div></div></button>`);
      }
      if (q) {
        const known = new Set([...mineIds, ...near.map((c) => c.id)]);
        const rem = (remote || []).filter((c) => !known.has(c.id));
        if (rem.length) {
          parts.push(html`<div class="res-kind">Search results</div>`);
          rem.forEach((c) => parts.push(row('course', c, html`<span class="res-icon">${icon('flag')}</span>`, c.name, [place(c), c.country, dist(c)].filter(Boolean).join(' · '))));
        } else if (remoteLoading) {
          parts.push(html`<div class="loading-row"><span class="spinner"></span>Searching courses…</div>`);
        }
        parts.push(html`<div class="res-kind">Not listed?</div>`);
        parts.push(row('new', { id: `local:${uid()}`, name: q, source: 'manual' }, html`<span class="res-icon">${icon('plus')}</span>`, `Add “${q}” as a new course`, 'You can set its map location later'));
      }
      setHTML(box, html`${parts}`);
    }

    const runRemote = debounce(async () => {
      const q = input.value.trim();
      if (q.length < 3) { remote = null; remoteLoading = false; render(); return; }
      const my = ++seq;
      const me = lastKnownPosition();
      const view = state.settings.lastView;
      const bias = me || (view ? { lat: view.lat, lng: view.lng } : {});
      try {
        const res = await searchPlaces(q, { ...bias, golfOnly: true, limit: 8 });
        if (my === seq) remote = res;
      } catch { if (my === seq) remote = []; }
      if (my === seq) { remoteLoading = false; render(); }
    }, 320);

    input.addEventListener('input', () => {
      remoteLoading = input.value.trim().length >= 3;
      render();
      runRemote();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); box.querySelector('.res[data-i]')?.click(); }
    });

    async function loadNearby() {
      nearbyLoading = true;
      render();
      try {
        const pos = await getPosition();
        nearby = await findNearbyCourses(pos, state.settings.nearbyRadiusKm);
      } catch { /* the list just stays empty */ }
      nearbyLoading = false;
      if (s.isOpen) render();
    }

    box.addEventListener('click', (e) => {
      if (e.target.closest('[data-act="near"]')) { loadNearby(); return; }
      const btn = e.target.closest('.res[data-i]');
      if (!btn) return;
      const it = items[+btn.dataset.i];
      if (!it) return;
      const { distanceKm, isGolf, kind, extent, ...course } = it.obj;
      result = state.courses[course.id] || course;
      s.close();
    });

    render();
    if (initialQuery) { remoteLoading = true; runRemote(); }
    if (!nearby.length) geoPermission().then((p) => { if (p === 'granted' && s.isOpen) loadNearby(); });
    setTimeout(() => input.focus({ preventScroll: true }), 380);
  });
}
