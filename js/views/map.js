// Map tab (home): played courses as score pins, nearby courses from OSM,
// search, filters, and a quick-view card with directions.
import { state, on, playedCourses, applyFilters, filterChips, activeFilterCount, clearFilter, saveSettings, getCourse } from '../store.js';
import { courseStats, summarize, performanceClass } from '../stats.js';
import { html, raw, setHTML, esc, debounce, fmtDistance, fmtRelative, fmtToPar, fmt1, haversineKm, similarity, plural } from '../utils.js';
import { icon, toast, toastError, actionSheet } from '../ui.js';
import { getPosition, geoPermission, lastKnownPosition, findNearbyCourses, searchPlaces, directionsLinks } from '../geo.js';
import { sparkline } from '../charts.js';
import { openCourseDetail } from './course-detail.js';
import { openRoundForm } from './round-form.js';
import { openFilters } from './filters.js';
import { openSettings } from './settings.js';
import { openScan } from './scan.js';
import { loadSampleData } from '../demo.js';

const LABELS = { best: 'Best score', avg: 'Average', last: 'Last score', count: 'Rounds played' };

let root, L, map;
let baseLayer = null, playedLayer = null, nearbyLayer = null, meMarker = null, meCircle = null;
let played = [];
let nearby = [];
let tempCourse = null; // a searched course shown on the map before it's played
let selectedId = null;
let visible = false;
let dirty = true;
let lastNearbyCenter = null;
let nearbyLoading = false;
const markerById = new Map();
const newIds = new Set();

export const mapView = { init, show, hide, reselect: () => map && fitToPlayed(true) };

function isDark() {
  const t = state.settings.theme;
  return t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
}

function init(el) {
  root = el;
  setHTML(root, html`
    <div class="map" data-el="map" role="region" aria-label="Map of your golf courses"></div>
    <div class="map-top">
      <div class="searchbar" role="search">
        ${icon('search')}
        <input data-el="q" type="search" placeholder="Search courses or places" autocomplete="off" enterkeyhint="search" aria-label="Search courses or places">
        <button class="icon-btn" data-act="clear" hidden aria-label="Clear search">${icon('x')}</button>
        <button class="brand-btn" data-act="settings" aria-label="Settings">${icon('settings')}</button>
      </div>
      <div class="search-results card" data-el="results" hidden></div>
      <div class="chip-row" data-el="chips"></div>
    </div>
    <button class="pill search-area" data-act="search-area" hidden>${icon('refresh')} Search this area</button>
    <div class="map-controls">
      <button class="fab" data-act="locate" aria-label="Show my location">${icon('locate')}</button>
      <button class="fab" data-act="layers" aria-label="Map style">${icon('layers')}</button>
    </div>
    <div class="map-legend" data-el="legend" hidden title="Pin colour compares your average at each course with your overall average">
      <span><i style="background:var(--perf-better)"></i>Better</span>
      <span><i style="background:var(--perf-typical)"></i>Typical</span>
      <span><i style="background:var(--perf-tougher)"></i>Tougher</span>
    </div>
    <div class="map-card" data-el="card" hidden></div>
    <div class="map-onboard card" data-el="onboard" hidden></div>`);

  root.addEventListener('click', onClick);
  const q = root.querySelector('[data-el="q"]');
  const runSearch = debounce(() => search(q.value), 280);
  q.addEventListener('input', () => {
    root.querySelector('[data-act="clear"]').hidden = !q.value;
    if (!q.value.trim()) hideResults();
    else runSearch();
  });
  q.addEventListener('focus', () => { if (q.value.trim()) search(q.value); });
  q.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); root.querySelector('.search-results .res')?.click(); }
    if (e.key === 'Escape') { q.value = ''; hideResults(); q.blur(); }
  });

  L = window.L;
  if (!L) {
    setHTML(root.querySelector('[data-el="map"]'), html`<div class="map-fallback"><div>${icon('map', 'i-lg')}<p style="margin-top:8px">The map couldn’t load. Connect to the internet once so ParMap can cache it for offline use.</p></div></div>`);
    return;
  }
  const v = state.settings.lastView;
  map = L.map(root.querySelector('[data-el="map"]'), {
    zoomControl: false,
    worldCopyJump: true,
    minZoom: 2,
    maxZoom: 20,
    zoomSnap: 0.5,
    center: v ? [v.lat, v.lng] : [39.5, -98.35],
    zoom: v ? v.zoom : 4,
  });
  map.attributionControl.setPrefix(false); // Leaflet is credited in Settings; keeps the map credit compact on phones
  playedLayer = L.layerGroup().addTo(map);
  nearbyLayer = L.layerGroup().addTo(map);
  setBaseLayer();
  map.on('zoomend', renderMarkers);
  map.on('moveend', onMoveEnd);
  map.on('click', () => { hideResults(); closeCard(); });
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => setBaseLayer());

  on((kind, detail) => {
    if (kind === 'data' || kind === 'filters') {
      if (detail?.added) {
        const r = state.rounds.find((x) => x.id === detail.added);
        if (r) newIds.add(r.courseId);
      }
      dirty = true;
      if (visible) refresh();
    }
    if (kind === 'settings') {
      if (detail && ('theme' in detail || 'baseLayer' in detail)) setBaseLayer();
      if (detail && ('markerLabel' in detail || 'showNearby' in detail || 'units' in detail)) { dirty = true; if (visible) refresh(); }
    }
  });
}

function show() {
  visible = true;
  if (!map) return;
  // The view was display:none until now; re-measure before any pan/zoom.
  map.invalidateSize({ pan: false });
  if (dirty) refresh(true);
}
function hide() {
  visible = false;
  hideResults();
}

/* ---------- Data -> markers ------------------------------------------------ */
let firstRefresh = true;
function refresh(initial = false) {
  dirty = false;
  const rounds = applyFilters(state.rounds);
  const s = summarize(rounds);
  played = playedCourses(rounds).map((p) => {
    const st = courseStats(p.rounds);
    return { ...p, stats: st, perf: performanceClass(st.avgToPar18, s.avgToPar18, st.avgScore18, s.avg18) };
  });
  renderChips();
  renderMarkers();
  root.querySelector('[data-el="legend"]').hidden = !played.some((p) => p.course.lat != null);
  if (selectedId) {
    const p = played.find((x) => x.course.id === selectedId);
    const other = nearby.find((c) => c.id === selectedId) || (tempCourse?.id === selectedId ? tempCourse : null);
    if (p) renderCard(p.course, p);
    else if (other) renderCard(other, null);
    else closeCard();
  }
  renderOnboard();
  if (firstRefresh && initial) {
    firstRefresh = false;
    firstPositioning();
  }
}

async function firstPositioning() {
  const perm = await geoPermission();
  if (perm === 'granted') {
    locate({ quiet: true, keepView: !!state.settings.lastView });
  } else if (!state.settings.lastView) {
    fitToPlayed(false);
  }
}

function fitToPlayed(animate) {
  const pts = played.filter((p) => p.course.lat != null).map((p) => [p.course.lat, p.course.lng]);
  if (!pts.length) {
    const me = lastKnownPosition();
    if (me) map.setView([me.lat, me.lng], 11, { animate });
    return;
  }
  if (pts.length === 1) map.setView(pts[0], 12, { animate });
  else map.fitBounds(pts, { padding: [70, 70], maxZoom: 13, animate });
}

function markerLabel(p) {
  switch (state.settings.markerLabel) {
    case 'avg': return p.stats.avg != null ? Math.round(p.stats.avg) : '–';
    case 'last': return p.stats.last?.score ?? '–';
    case 'count': return p.rounds.length;
    default: return p.stats.best?.score ?? '–';
  }
}

function clusterItems(items, radius) {
  const groups = [];
  for (const it of items) {
    const g = groups.find((c) => Math.abs(c.x - it.pt.x) < radius && Math.abs(c.y - it.pt.y) < radius);
    if (g) g.items.push(it);
    else groups.push({ x: it.pt.x, y: it.pt.y, items: [it] });
  }
  return groups;
}

function renderMarkers() {
  if (!map) return;
  playedLayer.clearLayers();
  nearbyLayer.clearLayers();
  markerById.clear();
  const zoom = map.getZoom();
  const withPt = (lat, lng) => map.latLngToLayerPoint([lat, lng]);

  const playedItems = played.filter((p) => p.course.lat != null).map((p) => ({ p, pt: withPt(p.course.lat, p.course.lng) }));
  for (const g of clusterItems(playedItems, 44)) {
    if (g.items.length === 1 || zoom >= 16) g.items.forEach((it) => addPlayedMarker(it.p));
    else addCluster(g.items.map((it) => [it.p.course.lat, it.p.course.lng]), g.items.length, false);
  }

  const playedIds = new Set(played.map((p) => p.course.id));
  const isPlayed = (c) => playedIds.has(c.id) || played.some((p) => p.course.lat != null && haversineKm(p.course, c) < 0.4 && similarity(p.course.name, c.name) > 0.6);
  const list = state.settings.showNearby ? nearby.filter((c) => !isPlayed(c)) : [];
  if (tempCourse && !isPlayed(tempCourse) && !list.some((c) => c.id === tempCourse.id)) list.push(tempCourse);
  const nearItems = list.map((c) => ({ c, pt: withPt(c.lat, c.lng) }));
  for (const g of clusterItems(nearItems, 34)) {
    if (g.items.length === 1 || zoom >= 14) g.items.forEach((it) => addNearbyMarker(it.c));
    else addCluster(g.items.map((it) => [it.c.lat, it.c.lng]), g.items.length, true);
  }
}

function addPlayedMarker(p) {
  const c = p.course;
  const classes = ['mk-wrap', selectedId === c.id ? 'is-selected' : '', newIds.has(c.id) ? 'is-new' : ''].join(' ');
  const count = p.rounds.length > 1 && state.settings.markerLabel !== 'count' ? `<span class="mk-count">${p.rounds.length}</span>` : '';
  const m = L.marker([c.lat, c.lng], {
    icon: L.divIcon({ className: classes, html: `<div class="mk mk--${p.perf}"><b>${esc(markerLabel(p))}</b></div>${count}`, iconSize: [38, 38], iconAnchor: [19, 46] }),
    title: `${c.name}: ${LABELS[state.settings.markerLabel] || 'Best score'} ${markerLabel(p)}`,
    riseOnHover: true,
    zIndexOffset: 1000 + p.rounds.length,
  });
  m.on('click', () => selectCourse(c.id));
  playedLayer.addLayer(m);
  markerById.set(c.id, m);
}

function addNearbyMarker(c) {
  const m = L.marker([c.lat, c.lng], {
    icon: L.divIcon({ className: `mk-wrap ${selectedId === c.id ? 'is-selected' : ''}`, html: `<div class="mk-near"><svg class="i"><use href="#i-flag"/></svg></div>`, iconSize: [28, 28], iconAnchor: [14, 14] }),
    title: c.name,
    riseOnHover: true,
  });
  m.on('click', () => selectCourse(c.id));
  nearbyLayer.addLayer(m);
  markerById.set(c.id, m);
}

function addCluster(latlngs, count, isNear) {
  const lat = latlngs.reduce((s, p) => s + p[0], 0) / count;
  const lng = latlngs.reduce((s, p) => s + p[1], 0) / count;
  const size = Math.min(56, 36 + count * 2);
  const m = L.marker([lat, lng], {
    icon: L.divIcon({ className: 'mk-wrap', html: `<div class="mk-cluster ${isNear ? 'is-near' : ''}">${count}</div>`, iconSize: [size, size], iconAnchor: [size / 2, size / 2] }),
    title: isNear ? `${count} nearby courses` : `${count} played courses`,
    zIndexOffset: isNear ? 0 : 900,
  });
  m.on('click', () => map.fitBounds(latlngs, { padding: [80, 80], maxZoom: 16 }));
  (isNear ? nearbyLayer : playedLayer).addLayer(m);
}

function setSelectedMarker(id) {
  for (const [cid, m] of markerById) m.getElement()?.classList.toggle('is-selected', cid === id);
}

/* ---------- Quick-view card ---------------------------------------------- */
function findCourse(id) {
  const p = played.find((x) => x.course.id === id);
  if (p) return { course: p.course, p };
  const c = nearby.find((x) => x.id === id) || (tempCourse?.id === id ? tempCourse : null) || getCourse(id);
  return c ? { course: c, p: null } : null;
}

export function selectCourse(id, { fly = false } = {}) {
  const found = findCourse(id);
  if (!found) return;
  selectedId = id;
  setSelectedMarker(id);
  renderCard(found.course, found.p);
  const c = found.course;
  if (!map || c.lat == null) return;
  if (fly) { map.flyTo([c.lat, c.lng], Math.max(map.getZoom(), 13), { duration: 0.8 }); return; }
  // Keep the selected pin visible above the quick-view card.
  requestAnimationFrame(() => {
    const card = root.querySelector('[data-el="card"]');
    const pt = map.latLngToContainerPoint([c.lat, c.lng]);
    const limit = map.getSize().y - card.offsetHeight - 70;
    if (pt.y > limit) map.panBy([0, pt.y - limit], { animate: true });
  });
}

function distanceText(c) {
  const me = lastKnownPosition();
  if (!me || c.lat == null) return '';
  return fmtDistance(haversineKm(me, c), state.settings.units);
}

function renderCard(c, p) {
  const card = root.querySelector('[data-el="card"]');
  const place = [c.city, c.region].filter(Boolean).join(', ');
  const meta = [place || c.address, distanceText(c)].filter(Boolean).join(' · ');
  if (p) {
    const st = p.stats;
    setHTML(card, html`
      <div class="grip"></div>
      <div class="map-card-head">
        <div class="row-main"><h3>${c.name}</h3>${meta ? html`<p>${meta}</p>` : ''}</div>
        <button class="icon-btn filled" data-act="card-close" aria-label="Close">${icon('x')}</button>
      </div>
      <div class="mini-stats">
        <div><b>${st.best?.score ?? '–'}</b><span>Best</span></div>
        <div><b>${st.avg != null ? fmt1(st.avg) : '–'}</b><span>Average</span></div>
        <div><b>${p.rounds.length}</b><span>${p.rounds.length === 1 ? 'Round' : 'Rounds'}</span></div>
        <div><b>${fmtToPar(st.avgToPar18, 1)}</b><span>To par</span></div>
      </div>
      <div class="spark-wrap">${raw(sparkline(st.trend))}<span>Last played ${fmtRelative(st.last.date)} · ${st.last.score}</span></div>
      <div class="btns">
        <button class="btn btn-secondary btn-sm" data-act="directions">${icon('directions')} Go</button>
        <button class="btn btn-secondary btn-sm" data-act="log">${icon('plus')} Log</button>
        <button class="btn btn-primary btn-sm" data-act="details">Details ${icon('chevron-right', 'i-sm')}</button>
      </div>`);
  } else {
    const facts = [c.holes ? `${c.holes} holes` : '', c.access === 'private' ? 'Private' : c.access === 'yes' || c.access === 'public' ? 'Public' : ''].filter(Boolean);
    setHTML(card, html`
      <div class="grip"></div>
      <div class="map-card-head">
        <div class="row-main"><h3>${c.name}</h3>${meta ? html`<p>${meta}</p>` : ''}</div>
        <button class="icon-btn filled" data-act="card-close" aria-label="Close">${icon('x')}</button>
      </div>
      <div class="spark-wrap" style="margin:10px 0 14px">
        <span class="badge">${icon('flag')} Not played yet</span>
        ${facts.map((f) => html`<span class="badge">${f}</span>`)}
      </div>
      <div class="btns">
        <button class="btn btn-secondary btn-sm" data-act="directions">${icon('directions')} Go</button>
        <button class="btn btn-secondary btn-sm" data-act="details">Details</button>
        <button class="btn btn-primary btn-sm" data-act="log">${icon('plus')} Log round</button>
      </div>`);
  }
  card.hidden = false;
  card.dataset.id = c.id;
  root.classList.add('card-open');
  root.style.setProperty('--card-h', `${card.offsetHeight + 4}px`);
  enableCardSwipe(card);
}

function closeCard() {
  const card = root.querySelector('[data-el="card"]');
  if (card.hidden) return;
  card.hidden = true;
  root.classList.remove('card-open');
  selectedId = null;
  setSelectedMarker(null);
}

function enableCardSwipe(card) {
  if (card.dataset.swipe) return;
  card.dataset.swipe = '1';
  let y0 = null, dy = 0;
  card.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    y0 = e.clientY; dy = 0;
    card.setPointerCapture(e.pointerId);
  });
  card.addEventListener('pointermove', (e) => {
    if (y0 == null) return;
    dy = Math.max(0, e.clientY - y0);
    card.style.transform = `translateY(${dy}px)`;
  });
  const end = () => {
    if (y0 == null) return;
    y0 = null;
    card.style.transform = '';
    if (dy > 70) closeCard();
    else if (dy < 6) openCourseDetail(card.dataset.id);
  };
  card.addEventListener('pointerup', end);
  card.addEventListener('pointercancel', () => { y0 = null; card.style.transform = ''; });
}

/* ---------- Chips, onboarding --------------------------------------------- */
function renderChips() {
  const n = activeFilterCount();
  setHTML(root.querySelector('[data-el="chips"]'), html`
    <button class="chip ${n ? 'is-on' : ''}" data-act="filters">${icon('sliders')} Filters${n ? html`<span class="count">${n}</span>` : ''}</button>
    ${filterChips().map((c) => html`<button class="chip is-on" data-act="clear-filter" data-key="${c.key}" aria-label="Remove filter ${c.label}">${c.label} ${icon('x', 'i-sm x')}</button>`)}
    <button class="chip" data-act="label">${icon('trophy')} ${LABELS[state.settings.markerLabel] || 'Best score'} ${icon('chevron-down', 'i-sm')}</button>
    <button class="chip ${state.settings.showNearby ? 'is-on' : ''}" data-act="nearby" aria-pressed="${String(state.settings.showNearby)}">
      ${nearbyLoading ? raw('<span class="spinner" style="width:14px;height:14px;border-width:2px"></span>') : icon('flag')} Nearby courses
    </button>`);
}

function renderOnboard() {
  const el = root.querySelector('[data-el="onboard"]');
  const show = !state.rounds.length && !state.settings.onboardDismissed;
  el.hidden = !show;
  if (!show) return;
  setHTML(el, html`
    <div class="row-flex" style="align-items:flex-start">
      <div class="row-main"><h3>Your golf map</h3><p>Every course you play shows up here with your scores. Scan a scorecard or log a round to drop your first pin.</p></div>
      <button class="icon-btn filled" data-act="onboard-close" aria-label="Dismiss">${icon('x')}</button>
    </div>
    <div class="btns">
      <button class="btn btn-primary btn-sm" data-act="scan">${icon('camera')} Scan scorecard</button>
      <button class="btn btn-secondary btn-sm" data-act="log">${icon('plus')} Log round</button>
      <button class="btn btn-ghost btn-sm" data-act="sample">Try sample data</button>
    </div>`);
}

/* ---------- Location & nearby ------------------------------------------- */
async function locate({ quiet = false, keepView = false } = {}) {
  const fab = root.querySelector('[data-act="locate"]');
  fab.classList.add('is-busy');
  try {
    const pos = await getPosition();
    showMe(pos);
    if (!keepView) map.flyTo([pos.lat, pos.lng], Math.max(map.getZoom(), 11), { duration: 0.9 });
    fab.classList.add('is-on');
    if (state.settings.showNearby) loadNearby(pos, { quiet: true });
  } catch (e) {
    if (!quiet) toastError(e);
    if (!state.settings.lastView) fitToPlayed(false);
  } finally {
    fab.classList.remove('is-busy');
  }
}

function showMe(pos) {
  if (!map) return;
  if (!meMarker) {
    meMarker = L.marker([pos.lat, pos.lng], { icon: L.divIcon({ className: 'mk-wrap', html: '<div class="me-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), keyboard: false, interactive: false, zIndexOffset: 2000 }).addTo(map);
    meCircle = L.circle([pos.lat, pos.lng], { radius: pos.accuracy || 30, color: '#2a78d6', weight: 1, opacity: 0.4, fillOpacity: 0.08, interactive: false }).addTo(map);
  } else {
    meMarker.setLatLng([pos.lat, pos.lng]);
    meCircle.setLatLng([pos.lat, pos.lng]).setRadius(pos.accuracy || 30);
  }
}

function visibleRadiusKm() {
  const b = map.getBounds();
  const c = map.getCenter();
  return Math.min(80, Math.max(5, haversineKm({ lat: c.lat, lng: c.lng }, { lat: b.getNorth(), lng: b.getEast() }) * 0.9));
}

async function loadNearby(center, { quiet = false, radiusKm = state.settings.nearbyRadiusKm } = {}) {
  if (nearbyLoading) return;
  nearbyLoading = true;
  renderChips();
  root.querySelector('[data-act="search-area"]').hidden = true;
  try {
    nearby = await findNearbyCourses(center, radiusKm);
    lastNearbyCenter = { ...center, radiusKm };
    renderMarkers();
    if (!quiet) toast(nearby.length ? `Found ${plural(nearby.length, 'golf course')} in this area` : 'No golf courses found here. Try zooming out.', { iconName: 'flag' });
  } catch (e) {
    toastError(e);
  } finally {
    nearbyLoading = false;
    renderChips();
  }
}

function onMoveEnd() {
  const c = map.getCenter();
  saveSettings({ lastView: { lat: +c.lat.toFixed(5), lng: +c.lng.toFixed(5), zoom: map.getZoom() } }, { silent: true });
  const pill = root.querySelector('[data-act="search-area"]');
  if (!state.settings.showNearby || nearbyLoading || map.getZoom() < 8) { pill.hidden = true; return; }
  if (!lastNearbyCenter) { pill.hidden = false; return; }
  const moved = haversineKm(lastNearbyCenter, { lat: c.lat, lng: c.lng });
  pill.hidden = moved < lastNearbyCenter.radiusKm * 0.45;
}

/* ---------- Search --------------------------------------------------------- */
let searchSeq = 0;
async function search(raw) {
  const q = raw.trim();
  if (!q) { hideResults(); return; }
  const seq = ++searchSeq;
  const ql = q.toLowerCase();
  const localPlayed = played
    .map((p) => ({ p, s: p.course.name.toLowerCase().includes(ql) ? 1 : similarity(q, p.course.name) }))
    .filter((x) => x.s > 0.45).sort((a, b) => b.s - a.s).slice(0, 5).map((x) => x.p);
  const localNear = nearby
    .filter((c) => !localPlayed.some((p) => p.course.id === c.id))
    .map((c) => ({ c, s: c.name.toLowerCase().includes(ql) ? 1 : similarity(q, c.name) }))
    .filter((x) => x.s > 0.5).sort((a, b) => b.s - a.s).slice(0, 4).map((x) => x.c);
  renderResults({ localPlayed, localNear, remoteGolf: null, places: null, loading: q.length >= 3 });
  if (q.length < 3) return;
  const center = map ? map.getCenter() : null;
  const bias = center ? { lat: center.lat, lng: center.lng } : {};
  const [golf, places] = await Promise.all([
    searchPlaces(q, { ...bias, golfOnly: true, limit: 6 }).catch(() => []),
    searchPlaces(q, { ...bias, golfOnly: false, limit: 4 }).catch(() => []),
  ]);
  if (seq !== searchSeq) return;
  const known = new Set([...localPlayed.map((p) => p.course.id), ...localNear.map((c) => c.id)]);
  renderResults({
    localPlayed,
    localNear,
    remoteGolf: golf.filter((c) => !known.has(c.id)),
    places: places.filter((c) => !c.isGolf),
    loading: false,
  });
}

let resultItems = [];
function renderResults({ localPlayed, localNear, remoteGolf, places, loading }) {
  const box = root.querySelector('[data-el="results"]');
  resultItems = [];
  const item = (kind, obj, iconHtml, title, sub) => {
    resultItems.push({ kind, obj });
    return html`<button class="res" type="button" data-i="${resultItems.length - 1}">${iconHtml}<div class="row-main"><div class="row-title">${title}</div>${sub ? html`<div class="row-sub">${sub}</div>` : ''}</div></button>`;
  };
  const place = (c) => [c.city, c.region, c.country].filter(Boolean).slice(0, 2).join(', ');
  const parts = [];
  if (localPlayed.length) {
    parts.push(html`<div class="res-kind">Your courses</div>`);
    localPlayed.forEach((p) => parts.push(item('played', p, html`<span class="res-icon is-played">${p.stats.best?.score ?? '–'}</span>`, p.course.name, `${plural(p.rounds.length, 'round')} · ${place(p.course) || 'No location'}`)));
  }
  if (localNear.length) {
    parts.push(html`<div class="res-kind">Nearby</div>`);
    localNear.forEach((c) => parts.push(item('course', c, html`<span class="res-icon">${icon('flag')}</span>`, c.name, [place(c), distanceText(c)].filter(Boolean).join(' · '))));
  }
  if (remoteGolf?.length) {
    parts.push(html`<div class="res-kind">Golf courses</div>`);
    remoteGolf.forEach((c) => parts.push(item('course', c, html`<span class="res-icon">${icon('flag')}</span>`, c.name, place(c))));
  }
  if (places?.length) {
    parts.push(html`<div class="res-kind">Places</div>`);
    places.forEach((c) => parts.push(item('place', c, html`<span class="res-icon">${icon('pin')}</span>`, c.name, place(c))));
  }
  if (loading) parts.push(html`<div class="loading-row"><span class="spinner"></span>Searching…</div>`);
  if (!parts.length) parts.push(html`<div class="search-empty">No matches yet. Keep typing to search the map.</div>`);
  setHTML(box, html`${parts}`);
  box.hidden = false;
}

function hideResults() {
  const box = root?.querySelector('[data-el="results"]');
  if (box) box.hidden = true;
}

function pickResult(i) {
  const r = resultItems[i];
  if (!r || !map) return;
  hideResults();
  root.querySelector('[data-el="q"]').blur();
  if (r.kind === 'played') {
    selectCourse(r.obj.course.id, { fly: true });
  } else if (r.kind === 'course') {
    if (!nearby.some((c) => c.id === r.obj.id)) tempCourse = r.obj;
    renderMarkers();
    map.flyTo([r.obj.lat, r.obj.lng], 14, { duration: 0.8 });
    selectCourse(r.obj.id);
  } else if (r.kind === 'place') {
    const ext = r.obj.extent;
    if (ext) map.flyToBounds([[ext[3], ext[0]], [ext[1], ext[2]]], { maxZoom: 13, duration: 0.8 });
    else map.flyTo([r.obj.lat, r.obj.lng], 12, { duration: 0.8 });
    if (state.settings.showNearby) map.once('moveend', () => loadNearby({ lat: r.obj.lat, lng: r.obj.lng }, { radiusKm: 30 }));
  }
}

/* ---------- Public helpers -------------------------------------------------- */
export function focusCourseOnMap(courseId, { isNew = false } = {}) {
  if (isNew) newIds.add(courseId);
  dirty = true;
  if (visible) refresh();
  const c = getCourse(courseId);
  if (!map || !c || c.lat == null) return false;
  setTimeout(() => {
    map.invalidateSize({ pan: false });
    const zoom = Math.max(map.getZoom() || 0, 13);
    try { map.flyTo([c.lat, c.lng], zoom, { duration: 1 }); } catch { map.setView([c.lat, c.lng], zoom); }
    selectCourse(courseId);
  }, 250);
  return true;
}

/* ---------- Events ---------------------------------------------------------- */
async function onClick(e) {
  const res = e.target.closest('.res');
  if (res) { pickResult(+res.dataset.i); return; }
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  const cardId = root.querySelector('[data-el="card"]').dataset.id;
  switch (act) {
    case 'settings': openSettings(); break;
    case 'clear': {
      const q = root.querySelector('[data-el="q"]');
      q.value = '';
      btn.hidden = true;
      hideResults();
      q.focus();
      break;
    }
    case 'filters': openFilters(); break;
    case 'clear-filter': clearFilter(btn.dataset.key); break;
    case 'label': {
      const choice = await actionSheet({
        title: 'Pin label',
        subtitle: 'What each course pin shows',
        actions: Object.entries(LABELS).map(([value, label]) => ({ value, label, checked: state.settings.markerLabel === value })),
      });
      if (choice) saveSettings({ markerLabel: choice.value });
      break;
    }
    case 'nearby': {
      const on = !state.settings.showNearby;
      saveSettings({ showNearby: on });
      if (on && map) {
        const me = lastKnownPosition();
        const c = map.getCenter();
        if (me && map.getBounds().contains([me.lat, me.lng])) loadNearby(me);
        else if (map.getZoom() >= 8) loadNearby({ lat: c.lat, lng: c.lng }, { radiusKm: visibleRadiusKm() });
        else toast('Zoom in on an area or tap the location button to see nearby courses.', { iconName: 'flag' });
      } else root.querySelector('[data-act="search-area"]').hidden = true;
      break;
    }
    case 'search-area': {
      const c = map.getCenter();
      loadNearby({ lat: c.lat, lng: c.lng }, { radiusKm: visibleRadiusKm() });
      break;
    }
    case 'locate': locate(); break;
    case 'layers': {
      const choice = await actionSheet({
        title: 'Map style',
        actions: [
          { value: 'map', label: 'Map', sub: 'Streets and labels', icon: 'map', checked: state.settings.baseLayer !== 'satellite' },
          { value: 'satellite', label: 'Satellite', sub: 'See fairways and greens', icon: 'globe', checked: state.settings.baseLayer === 'satellite' },
        ],
      });
      if (choice) saveSettings({ baseLayer: choice.value });
      break;
    }
    case 'card-close': closeCard(); break;
    case 'details': openCourseDetail(cardId, { course: findCourse(cardId)?.course }); break;
    case 'log': {
      const c = cardId ? findCourse(cardId)?.course : null;
      openRoundForm({ course: c || null });
      break;
    }
    case 'directions': {
      const c = findCourse(cardId)?.course;
      if (c) actionSheet({ title: 'Directions', subtitle: c.name, actions: directionsLinks(c).map((l) => ({ label: l.label, href: l.url, icon: 'directions' })) });
      break;
    }
    case 'scan': openScan(); break;
    case 'sample': {
      loadSampleData();
      saveSettings({ onboardDismissed: true }, { silent: true });
      toast('Sample rounds added. Remove them any time in Settings.', { iconName: 'sparkles' });
      setTimeout(() => fitToPlayed(true), 150);
      break;
    }
    case 'onboard-close': saveSettings({ onboardDismissed: true }, { silent: true }); renderOnboard(); break;
    default: break;
  }
}

/* ---------- Base layers ------------------------------------------------------
   Street map: OpenStreetMap's standard tiles (free, no key; follow the tile
   usage policy and swap STREET_TILES for a keyed provider if you distribute
   the app widely). Dark mode inverts the street tiles with a CSS filter.
   Satellite: Esri World Imagery. */
const STREET_TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

function setBaseLayer() {
  if (!map) return;
  if (baseLayer) map.removeLayer(baseLayer);
  const osm = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';
  const satellite = state.settings.baseLayer === 'satellite';
  root.classList.toggle('map-dark', !satellite && isDark());
  if (satellite) {
    baseLayer = L.layerGroup([
      L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        maxZoom: 20, maxNativeZoom: 19, crossOrigin: 'anonymous',
        attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics',
      }),
      L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', {
        maxZoom: 20, maxNativeZoom: 19, crossOrigin: 'anonymous',
      }),
    ]);
  } else {
    baseLayer = L.tileLayer(STREET_TILES, {
      maxZoom: 20, maxNativeZoom: 19, crossOrigin: 'anonymous', className: 'tiles-street',
      attribution: `${osm} contributors`,
    });
  }
  // Public tile servers occasionally drop a request; retry a failed tile twice.
  const layers = baseLayer.getLayers ? baseLayer.getLayers() : [baseLayer];
  layers.forEach((layer) => layer.on('tileerror', ({ tile }) => {
    const tries = +(tile.dataset.retry || 0);
    if (tries >= 2 || !navigator.onLine) return;
    tile.dataset.retry = String(tries + 1);
    const src = tile.src;
    setTimeout(() => { tile.src = src; }, 700 * (tries + 1));
  }));
  baseLayer.addTo(map);
}
