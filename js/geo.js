// Location, course discovery and directions.
//  - Nearby courses: OpenStreetMap via the Overpass API (leisure=golf_course)
//  - Course / place search: Photon geocoder (komoot), OSM-based, CORS-enabled
//  - Directions: Google Maps / Apple Maps / Waze universal links
import { haversineKm, fetchWithTimeout, similarity, isIOS } from './utils.js';

export class GeoError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/* ---------- Device location ---------------------------------------------- */
let lastPos = (() => {
  try { return JSON.parse(sessionStorage.getItem('parmap.pos') || 'null'); } catch { return null; }
})();
export const lastKnownPosition = () => lastPos;

export function getPosition({ timeout = 12000, maximumAge = 120000, highAccuracy = true } = {}) {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) {
      reject(new GeoError('unsupported', 'Location isn’t available on this device.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (p) => {
        lastPos = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy, at: Date.now() };
        try { sessionStorage.setItem('parmap.pos', JSON.stringify(lastPos)); } catch { /* ignore */ }
        resolve(lastPos);
      },
      (err) => {
        if (err.code === 1) reject(new GeoError('denied', 'Location access is turned off for this site. Allow it in your browser settings to see courses near you.'));
        else if (err.code === 3) reject(new GeoError('timeout', 'Finding your location took too long. Try again outdoors or search an area instead.'));
        else reject(new GeoError('unavailable', 'Your location isn’t available right now. Try again or search an area on the map.'));
      },
      { enableHighAccuracy: highAccuracy, timeout, maximumAge },
    );
  });
}

export async function geoPermission() {
  try {
    const s = await navigator.permissions.query({ name: 'geolocation' });
    return s.state; // granted | denied | prompt
  } catch { return 'unknown'; }
}

/* ---------- Normalised course objects ------------------------------------ */
const toInt = (v) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
};

function courseFromOSM(el) {
  const t = el.tags || {};
  const name = t.name || t['name:en'] || t.official_name;
  const lat = el.lat ?? el.center?.lat;
  const lng = el.lon ?? el.center?.lon;
  if (!name || lat == null || lng == null) return null;
  const street = [t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' ');
  return {
    id: `osm:${el.type[0]}${el.id}`,
    name,
    lat,
    lng,
    city: t['addr:city'] || '',
    region: t['addr:state'] || t['addr:province'] || '',
    country: t['addr:country'] || '',
    address: [street, t['addr:city']].filter(Boolean).join(', '),
    phone: t.phone || t['contact:phone'] || '',
    website: t.website || t['contact:website'] || t.url || '',
    holes: toInt(t.holes || t['golf:holes']),
    par: toInt(t.par || t['golf:par']),
    access: t.access || '',
    source: 'osm',
    tagCount: Object.keys(t).length,
  };
}

function courseFromPhoton(f) {
  const p = f.properties || {};
  const [lng, lat] = f.geometry?.coordinates || [];
  if (!p.name || lat == null) return null;
  const isGolf = p.osm_key === 'leisure' && p.osm_value === 'golf_course';
  const city = p.city || p.town || p.village || p.district || p.county || '';
  return {
    id: isGolf ? `osm:${String(p.osm_type || 'x').toLowerCase()}${p.osm_id}` : `place:${p.osm_type}${p.osm_id}`,
    name: p.name,
    lat,
    lng,
    city,
    region: p.state || '',
    country: p.country || '',
    address: [[p.housenumber, p.street].filter(Boolean).join(' '), city].filter(Boolean).join(', '),
    isGolf,
    kind: p.osm_value || '',
    extent: p.extent || null,
    source: 'photon',
  };
}

// The same club is often mapped twice (relation + way); keep the richer one.
function dedupe(list) {
  const out = [];
  for (const c of list.sort((a, b) => (b.tagCount || 0) - (a.tagCount || 0))) {
    const dup = out.find((o) => o.id === c.id || (similarity(o.name, c.name) > 0.9 && haversineKm(o, c) < 1.5));
    if (!dup) out.push(c);
  }
  return out;
}

/* ---------- Overpass: nearby golf courses -------------------------------- */
// Public Overpass instances, tried in order (fallbacks are slower but independent).
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const CACHE_PREFIX = 'parmap.nearby:';
const CACHE_TTL = 24 * 3600 * 1000;

function readCache(key) {
  try {
    const v = JSON.parse(localStorage.getItem(CACHE_PREFIX + key) || 'null');
    return v && Date.now() - v.at < CACHE_TTL ? v.courses : null;
  } catch { return null; }
}
function writeCache(key, courses) {
  try {
    localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ at: Date.now(), courses }));
    const keys = Object.keys(localStorage).filter((k) => k.startsWith(CACHE_PREFIX));
    if (keys.length > 8) {
      keys.map((k) => [k, JSON.parse(localStorage.getItem(k) || '{}').at || 0])
        .sort((a, b) => a[1] - b[1])
        .slice(0, keys.length - 8)
        .forEach(([k]) => localStorage.removeItem(k));
    }
  } catch { /* storage full: skip cache */ }
}

let lastNearby = { center: null, radiusKm: 0, courses: [] };
export const lastNearbyResult = () => lastNearby;

export async function findNearbyCourses(center, radiusKm = 40, { signal } = {}) {
  const r = Math.round(Math.min(Math.max(radiusKm, 2), 100) * 1000);
  const key = `${center.lat.toFixed(2)},${center.lng.toFixed(2)},${r}`;
  let courses = readCache(key);
  if (!courses) {
    const q = `[out:json][timeout:25];nwr["leisure"="golf_course"](around:${r},${center.lat.toFixed(5)},${center.lng.toFixed(5)});out tags center;`;
    let lastErr = null;
    for (const url of OVERPASS_ENDPOINTS) {
      try {
        const res = await fetchWithTimeout(url, { method: 'POST', body: new URLSearchParams({ data: q }), signal }, 22000);
        if (!res.ok) { lastErr = new Error(`HTTP ${res.status}`); continue; }
        const json = await res.json();
        courses = dedupe((json.elements || []).map(courseFromOSM).filter(Boolean)).map(({ tagCount, ...c }) => c);
        writeCache(key, courses);
        break;
      } catch (e) {
        if (signal?.aborted) throw e;
        lastErr = e;
      }
    }
    if (!courses) {
      console.warn('[ParMap] Overpass failed', lastErr);
      throw new GeoError('busy', navigator.onLine
        ? 'The course finder is busy right now. Please try again in a minute.'
        : 'You’re offline. Nearby courses need an internet connection.');
    }
  }
  const withDist = courses
    .map((c) => ({ ...c, distanceKm: haversineKm(center, c) }))
    .filter((c) => c.distanceKm <= r / 1000 + 0.5)
    .sort((a, b) => a.distanceKm - b.distanceKm);
  lastNearby = { center, radiusKm, courses: withDist };
  return withDist;
}

/* ---------- Photon: search courses & places ------------------------------ */
export async function searchPlaces(query, { lat, lng, golfOnly = true, limit = 8, signal } = {}) {
  const u = new URL('https://photon.komoot.io/api/');
  u.searchParams.set('q', query);
  u.searchParams.set('limit', String(limit));
  if (golfOnly) u.searchParams.set('osm_tag', 'leisure:golf_course');
  if (lat != null && lng != null) {
    u.searchParams.set('lat', lat.toFixed(3));
    u.searchParams.set('lon', lng.toFixed(3));
  }
  const res = await fetchWithTimeout(u, { signal }, 12000);
  if (!res.ok) throw new GeoError('search', 'Search is unavailable right now.');
  const json = await res.json();
  return (json.features || []).map(courseFromPhoton).filter(Boolean);
}

// Best-effort lookup of a course's map location from its name + town.
export async function geocodeCourse({ name, city, region }, bias = null, { signal } = {}) {
  if (!name) return null;
  const opts = { ...(bias || {}), golfOnly: true, limit: 6, signal };
  let results = [];
  try { results = await searchPlaces([name, city].filter(Boolean).join(' '), opts); } catch { /* try again below */ }
  if (!results.length && city) {
    try { results = await searchPlaces(name, opts); } catch { /* none */ }
  }
  let best = null, bestScore = 0;
  for (const r of results) {
    let s = similarity(name, r.name);
    if (city && r.city && r.city.toLowerCase() === city.toLowerCase()) s += 0.12;
    if (region && r.region && r.region.toLowerCase().startsWith(region.toLowerCase().slice(0, 4))) s += 0.05;
    if (s > bestScore) { best = r; bestScore = s; }
  }
  return bestScore >= 0.55 ? best : null;
}

/* ---------- Directions deep links ---------------------------------------- */
export function directionsLinks(c) {
  const hasCoords = c.lat != null && c.lng != null;
  const dest = hasCoords ? `${c.lat},${c.lng}` : [c.name, c.address, c.city, c.region].filter(Boolean).join(', ');
  const q = encodeURIComponent(c.name || 'Golf course');
  const links = [
    { id: 'google', label: 'Google Maps', url: `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dest)}` },
    { id: 'apple', label: 'Apple Maps', url: hasCoords ? `https://maps.apple.com/?daddr=${c.lat},${c.lng}&q=${q}` : `https://maps.apple.com/?daddr=${encodeURIComponent(dest)}` },
    { id: 'waze', label: 'Waze', url: hasCoords ? `https://waze.com/ul?ll=${c.lat},${c.lng}&navigate=yes` : `https://waze.com/ul?q=${encodeURIComponent(dest)}&navigate=yes` },
  ];
  if (isIOS()) links.unshift(links.splice(1, 1)[0]);
  return links;
}
