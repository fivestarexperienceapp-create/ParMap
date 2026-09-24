// Courses tab: Nearby course finder (geolocation + OpenStreetMap) and the
// list of courses you've played.
import { state, on, playedCourses, saveSettings, updateCourse } from '../store.js';
import { courseStats } from '../stats.js';
import { html, raw, setHTML, fmtDistance, fmtRelative, fmt1, haversineKm, plural, debounce, sleep } from '../utils.js';
import { icon, toast, toastError, actionSheet } from '../ui.js';
import { getPosition, geoPermission, lastKnownPosition, findNearbyCourses, lastNearbyResult, directionsLinks, geocodeCourse } from '../geo.js';
import { sparkline } from '../charts.js';
import { openCourseDetail } from './course-detail.js';
import { openSettings } from './settings.js';
import { goTab } from '../router.js';

const SORTS = { rounds: 'Most played', best: 'Best score', recent: 'Recently played', name: 'A–Z', near: 'Nearest' };

let root;
let visible = false;
let dirty = true;
let seg = state.settings.coursesSeg || 'nearby';
let near = { status: 'idle', courses: [], center: null, error: null };
let query = '';
let triedAuto = false;
const byId = new Map();

export const coursesView = {
  init,
  show() {
    visible = true;
    if (seg === 'nearby' && !triedAuto) autoLocate();
    if (dirty) render();
  },
  hide() { visible = false; },
  reselect() { root.scrollTo({ top: 0, behavior: 'smooth' }); },
};

function init(el) {
  root = el;
  setHTML(root, html`
    <header class="view-head">
      <h1>Courses</h1>
      <div class="head-actions"><button class="icon-btn" data-act="settings" aria-label="Settings">${icon('settings')}</button></div>
    </header>
    <div class="view-body">
      <div class="seg seg-block" role="group" aria-label="Course list">
        <button type="button" data-seg="nearby">${icon('pin', 'i-sm')} Nearby</button>
        <button type="button" data-seg="played">${icon('flag', 'i-sm')} Played</button>
      </div>
      <div data-el="content"></div>
    </div>`);
  const prev = lastNearbyResult();
  if (prev.courses.length) near = { status: 'ready', courses: prev.courses, center: prev.center, error: null };
  root.addEventListener('click', onClick);
  root.addEventListener('input', debounce((e) => {
    if (e.target.matches('[data-el="cq"]')) { query = e.target.value; renderList(); }
  }, 120));
  on((kind) => {
    if (kind === 'data' || kind === 'settings') { dirty = true; if (visible) render(); }
  });
}

async function autoLocate() {
  triedAuto = true;
  if (near.status === 'ready') return;
  if ((await geoPermission()) === 'granted') findNearMe();
}

async function findNearMe() {
  near = { ...near, status: 'loading', error: null };
  render();
  try {
    const pos = await getPosition();
    const courses = await findNearbyCourses(pos, state.settings.nearbyRadiusKm);
    near = { status: 'ready', courses, center: pos, error: null };
  } catch (e) {
    near = { ...near, status: 'error', error: e.message };
  }
  render();
}

function radiusOptions() {
  return state.settings.units === 'km'
    ? [10, 25, 50, 80].map((km) => ({ km, label: `${km} km` }))
    : [10, 25, 50].map((mi) => ({ km: Math.round(mi * 1.609344), label: `${mi} mi` }));
}
function radiusLabel() {
  const opts = radiusOptions();
  const cur = state.settings.nearbyRadiusKm;
  return opts.reduce((b, o) => (Math.abs(o.km - cur) < Math.abs(b.km - cur) ? o : b), opts[0]).label;
}

function render() {
  dirty = false;
  root.querySelectorAll('[data-seg]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.seg === seg)));
  const content = root.querySelector('[data-el="content"]');
  if (seg === 'nearby') renderNearby(content);
  else renderPlayed(content);
}

function playedMap() {
  const m = new Map();
  for (const p of playedCourses()) m.set(p.course.id, p);
  return m;
}

function renderNearby(content) {
  byId.clear();
  const me = lastKnownPosition();
  const pm = playedMap();
  let body;
  if (near.status === 'idle') {
    body = html`<div class="card card-pad" style="margin-top:14px;text-align:center">
      <div class="row-icon" style="margin:6px auto 12px;width:52px;height:52px;border-radius:16px">${icon('pin', 'i-lg')}</div>
      <h3 style="font-size:18px">Find golf courses near you</h3>
      <p class="muted" style="margin:6px auto 16px;max-width:34ch;font-size:14.5px">Uses your location once to list courses within ${radiusLabel()}, with directions in one tap.</p>
      <button class="btn btn-primary" data-act="locate">${icon('locate')} Use my location</button>
      <p class="hint" style="margin-top:12px">Prefer not to share location? <button class="link-btn" data-act="open-map">Browse the map</button> and tap “Search this area”.</p>
    </div>`;
  } else if (near.status === 'loading') {
    body = html`<div class="loading-row" style="margin-top:20px"><span class="spinner"></span> Finding golf courses near you…</div>
      ${[1, 2, 3, 4].map(() => html`<div class="skeleton" style="height:66px;margin-top:8px"></div>`)}`;
  } else if (near.status === 'error') {
    body = html`<div class="callout callout--warn" style="margin-top:14px">${icon('alert')}<div><strong>Couldn’t load nearby courses.</strong><br>${near.error}<br><button class="btn btn-secondary btn-sm" data-act="locate">Try again</button></div></div>`;
  } else {
    const list = near.courses.map((c) => ({ ...c, distanceKm: me ? haversineKm(me, c) : c.distanceKm }));
    body = html`
      <div class="card location-bar" style="margin-top:14px">
        ${icon('pin')}
        <div class="row-main"><div class="row-title">${near.center && me && haversineKm(near.center, me) < 2 ? 'Near you' : 'Near the searched area'}</div>
          <div class="row-sub">${plural(list.length, 'golf course')} · from OpenStreetMap</div></div>
        <button class="chip" data-act="radius">${radiusLabel()} ${icon('chevron-down', 'i-sm')}</button>
        <button class="icon-btn filled" data-act="locate" aria-label="Refresh location">${icon('refresh')}</button>
      </div>
      ${!list.length ? html`<div class="empty"><h2>No courses found</h2><p>Try a larger radius, or search the map for another area.</p></div>` : html`
      <div class="list" style="margin-top:10px">
        ${list.map((c) => {
          byId.set(c.id, c);
          const p = pm.get(c.id);
          const place = [c.city, c.region].filter(Boolean).join(', ');
          return html`<div class="row">
            <button class="row-hit" type="button" data-open="${c.id}">
              <span class="row-icon ${p ? '' : ''}" style="${p ? 'font-weight:800;font-size:15px' : ''}">${p ? courseStats(p.rounds).best?.score : icon('flag')}</span>
              <div class="row-main">
                <div class="row-title">${c.name}</div>
                <div class="row-sub">${[fmtDistance(c.distanceKm, state.settings.units), place, p ? plural(p.rounds.length, 'round') : c.access === 'private' ? 'Private' : ''].filter(Boolean).join(' · ')}</div>
              </div>
            </button>
            <button class="icon-btn filled" type="button" data-act="dir" data-id="${c.id}" aria-label="Directions to ${c.name}">${icon('directions')}</button>
          </div>`;
        })}
      </div>
      <p class="hint" style="text-align:center;margin-top:14px">Course data © OpenStreetMap contributors</p>`}`;
  }
  setHTML(content, body);
}

function sortPlayed(list) {
  const mode = state.settings.coursesSort || 'rounds';
  const me = lastKnownPosition();
  const out = [...list];
  if (mode === 'best') out.sort((a, b) => (a.st.best?.score ?? 999) - (b.st.best?.score ?? 999));
  else if (mode === 'recent') out.sort((a, b) => (a.st.last.date < b.st.last.date ? 1 : -1));
  else if (mode === 'name') out.sort((a, b) => a.course.name.localeCompare(b.course.name));
  else if (mode === 'near' && me) out.sort((a, b) => (haversineKm(me, a.course) ?? 1e9) - (haversineKm(me, b.course) ?? 1e9));
  else out.sort((a, b) => b.rounds.length - a.rounds.length || (a.st.last.date < b.st.last.date ? 1 : -1));
  return out;
}

function renderPlayed(content) {
  const all = playedCourses();
  if (!all.length) {
    setHTML(content, html`<div class="empty"><h2>No courses yet</h2><p>Courses appear here once you log or scan a round.</p></div>`);
    return;
  }
  const missing = all.filter((p) => p.course.lat == null);
  setHTML(content, html`
    <div class="stack" style="gap:10px;margin-top:14px">
      <div class="searchbar" role="search">${icon('search')}<input type="search" data-el="cq" placeholder="Search your courses" value="${query}" autocomplete="off" aria-label="Search your courses"></div>
      <div class="chip-row"><button class="chip" data-act="sort">${icon('list')} ${SORTS[state.settings.coursesSort || 'rounds']} ${icon('chevron-down', 'i-sm')}</button></div>
      ${missing.length ? html`<div class="callout callout--info">${icon('pin')}<div><strong>${plural(missing.length, 'course')} ${missing.length === 1 ? 'isn’t' : 'aren’t'} on the map yet.</strong> ParMap can look ${missing.length === 1 ? 'it' : 'them'} up on OpenStreetMap.<br><button class="btn btn-secondary btn-sm" data-act="locate-missing">${icon('locate')} Find locations</button></div></div>` : ''}
    </div>
    <div class="list" data-el="plist" style="margin-top:10px"></div>`);
  renderList();
}

function renderList() {
  const box = root.querySelector('[data-el="plist"]');
  if (!box) return;
  const ql = query.trim().toLowerCase();
  const list = sortPlayed(playedCourses().map((p) => ({ ...p, st: courseStats(p.rounds) })))
    .filter((p) => !ql || `${p.course.name} ${p.course.city} ${p.course.region}`.toLowerCase().includes(ql));
  const me = lastKnownPosition();
  setHTML(box, list.length ? html`${list.map((p) => {
    const dist = me && p.course.lat != null ? fmtDistance(haversineKm(me, p.course), state.settings.units) : '';
    return html`<button class="row course-card" type="button" data-open="${p.course.id}">
      <div class="row-main">
        <div class="row-title">${p.course.name}</div>
        <div class="row-sub">${[plural(p.rounds.length, 'round'), p.st.avg != null ? `avg ${fmt1(p.st.avg)}` : '', fmtRelative(p.st.last.date), dist].filter(Boolean).join(' · ')}</div>
      </div>
      ${raw(sparkline(p.st.trend))}
      <div class="row-end"><span class="best-num">${p.st.best?.score ?? '–'}</span><span class="best-lbl">best</span></div>
    </button>`;
  })}` : html`<p class="muted" style="text-align:center;padding:20px">No courses match “${query}”.</p>`);
}

// Look up map positions for courses that were created without one
// (manual entries, CSV imports, scans that didn't match a mapped course).
export async function locateCourses(courses, { onProgress } = {}) {
  let found = 0;
  const bias = lastKnownPosition();
  for (let i = 0; i < courses.length; i++) {
    const c = courses[i];
    onProgress?.(i + 1, courses.length);
    try {
      const hit = await geocodeCourse(c, bias);
      if (hit) {
        updateCourse(c.id, { lat: hit.lat, lng: hit.lng, city: c.city || hit.city, region: c.region || hit.region, country: c.country || hit.country, address: c.address || hit.address });
        found++;
      }
    } catch { /* keep going */ }
    await sleep(220);
  }
  return found;
}

async function onClick(e) {
  const segBtn = e.target.closest('[data-seg]');
  if (segBtn) {
    seg = segBtn.dataset.seg;
    saveSettings({ coursesSeg: seg }, { silent: true });
    if (seg === 'nearby' && !triedAuto) autoLocate();
    render();
    return;
  }
  const open = e.target.closest('[data-open]');
  if (open) { openCourseDetail(open.dataset.open, { course: byId.get(open.dataset.open) }); return; }
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  switch (btn.dataset.act) {
    case 'settings': openSettings(); break;
    case 'locate': findNearMe(); break;
    case 'open-map': goTab('map'); break;
    case 'dir': {
      const c = byId.get(btn.dataset.id);
      if (c) actionSheet({ title: 'Directions', subtitle: c.name, actions: directionsLinks(c).map((l) => ({ label: l.label, href: l.url, icon: 'directions' })) });
      break;
    }
    case 'radius': {
      const choice = await actionSheet({
        title: 'Search radius',
        actions: radiusOptions().map((o) => ({ ...o, checked: o.label === radiusLabel() })),
      });
      if (choice) {
        saveSettings({ nearbyRadiusKm: choice.km }, { silent: true });
        if (near.center) {
          near = { ...near, status: 'loading' };
          render();
          try {
            near = { status: 'ready', courses: await findNearbyCourses(near.center, choice.km), center: near.center, error: null };
          } catch (err) { near = { ...near, status: 'error', error: err.message }; }
          render();
        } else render();
      }
      break;
    }
    case 'sort': {
      const choice = await actionSheet({
        title: 'Sort courses',
        actions: Object.entries(SORTS).map(([value, label]) => ({ value, label, checked: (state.settings.coursesSort || 'rounds') === value })),
      });
      if (choice) saveSettings({ coursesSort: choice.value });
      break;
    }
    case 'locate-missing': {
      const missing = playedCourses().filter((p) => p.course.lat == null).map((p) => p.course);
      btn.disabled = true;
      const found = await locateCourses(missing, { onProgress: (i, n) => { btn.textContent = `Searching ${i} of ${n}…`; } });
      toast(found ? `Placed ${plural(found, 'course')} on the map` : 'Couldn’t find those courses automatically. Open a course to set its location.', { tone: found ? 'ok' : 'error', iconName: 'pin' });
      break;
    }
    default: break;
  }
}
