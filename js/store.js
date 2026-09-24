// App state + persistence. Views subscribe with on(); every mutation goes
// through the functions below so data is normalised, saved and broadcast.
import { kv, initDB, requestPersistence } from './db.js';
import { uid, isoDate, addDays, isValidISO, similarity, normName, haversineKm, toInt, toNum } from './utils.js';

const SETTINGS_KEY = 'parmap.settings';
const API_KEY_KEY = 'parmap.geminiKey';
const DATA_KEY = 'data';

export const DEFAULT_MODEL = 'gemini-flash-latest';

const guessUnits = () => (/^en-(US|GB|LR)|^my/i.test(navigator.language || '') ? 'mi' : 'km');

const DEFAULT_SETTINGS = {
  model: DEFAULT_MODEL,
  playerName: '',
  units: guessUnits(),
  theme: 'system',
  markerLabel: 'best',
  defaultHoles: 18,
  showNearby: true,
  baseLayer: 'map',
  nearbyRadiusKm: 40,
  roundsSort: 'newest',
  coursesSort: 'rounds',
};

export const state = {
  ready: false,
  rounds: [],
  courses: {},
  filters: loadFilters(),
  settings: loadSettings(),
};

/* ---------- Events ------------------------------------------------------- */
const listeners = new Set();
export function on(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit(kind, detail) {
  for (const fn of listeners) {
    try { fn(kind, detail); } catch (e) { console.error(e); }
  }
}

/* ---------- Normalisation ------------------------------------------------ */
export function normalizeRound(r) {
  const holes = +r.holes === 9 ? 9 : 18;
  const now = new Date().toISOString();
  return {
    id: r.id || uid(),
    courseId: r.courseId,
    date: isValidISO(r.date) ? r.date : isoDate(),
    score: toInt(r.score, 1, 400),
    holes,
    par: toInt(r.par, holes === 9 ? 24 : 50, holes === 9 ? 45 : 90),
    front9: toInt(r.front9, 9, 150),
    back9: holes === 18 ? toInt(r.back9, 9, 150) : null,
    tees: String(r.tees ?? '').trim().slice(0, 40) || null,
    rating: toNum(r.rating, 20, 90),
    slope: toInt(r.slope, 55, 155),
    notes: String(r.notes ?? '').slice(0, 2000),
    source: r.source || 'manual',
    hasPhoto: !!r.hasPhoto,
    ai: r.ai || null,
    demo: !!r.demo,
    createdAt: r.createdAt || now,
    updatedAt: r.updatedAt || r.createdAt || now,
  };
}

export function normalizeCourse(c) {
  const now = new Date().toISOString();
  return {
    id: c.id,
    name: String(c.name || 'Unnamed course').trim().slice(0, 120),
    lat: toNum(c.lat, -90, 90),
    lng: toNum(c.lng, -180, 180),
    city: c.city || '',
    region: c.region || '',
    country: c.country || '',
    address: c.address || '',
    phone: c.phone || '',
    website: c.website || '',
    par: toInt(c.par, 24, 90),
    holes: toInt(c.holes, 9, 72),
    access: c.access || '',
    source: c.source || 'manual',
    demo: !!c.demo,
    createdAt: c.createdAt || now,
    updatedAt: c.updatedAt || now,
  };
}

const byDateDesc = (a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.createdAt < b.createdAt ? 1 : -1);
function sortRounds() { state.rounds.sort(byDateDesc); }

/* ---------- Persistence -------------------------------------------------- */
let saveTimer = null;
let saving = Promise.resolve();
const channel = 'BroadcastChannel' in window ? new BroadcastChannel('parmap') : null;

function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 60);
}
export function flush() {
  clearTimeout(saveTimer);
  saveTimer = null;
  const snapshot = { v: 1, rounds: state.rounds, courses: state.courses };
  saving = saving
    .then(() => kv.set(DATA_KEY, snapshot))
    .then(() => channel?.postMessage({ type: 'data' }))
    .catch((e) => { console.error('[ParMap] save failed', e); emit('error', e); });
  return saving;
}
addEventListener('pagehide', () => { if (saveTimer) flush(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && saveTimer) flush();
});

async function loadData() {
  let data = null;
  try { data = await kv.get(DATA_KEY); } catch (e) { console.warn(e); }
  state.courses = {};
  for (const c of Object.values(data?.courses || {})) if (c?.id) state.courses[c.id] = normalizeCourse(c);
  state.rounds = (data?.rounds || [])
    .filter((r) => r && r.courseId && toInt(r.score) != null)
    .map(normalizeRound);
  sortRounds();
}

export async function initStore() {
  await initDB();
  await loadData();
  state.ready = true;
  channel?.addEventListener('message', async (e) => {
    if (e.data?.type === 'data') { await loadData(); emit('data'); }
  });
  emit('data');
}

/* ---------- Rounds ------------------------------------------------------- */
export const getRound = (id) => state.rounds.find((r) => r.id === id) || null;

export function addRound(input) {
  const round = normalizeRound({ ...input, id: input.id || uid(), createdAt: undefined, updatedAt: undefined });
  state.rounds.push(round);
  sortRounds();
  persist();
  emit('data', { added: round.id });
  if (state.rounds.length === 1) requestPersistence();
  return round;
}

export function updateRound(id, patch, { silent = false } = {}) {
  const i = state.rounds.findIndex((r) => r.id === id);
  if (i < 0) return null;
  state.rounds[i] = normalizeRound({ ...state.rounds[i], ...patch, id, updatedAt: new Date().toISOString() });
  sortRounds();
  persist();
  if (!silent) emit('data', { updated: id });
  return state.rounds.find((r) => r.id === id);
}

const pendingPhotoDeletes = new Map();
export function deleteRound(id) {
  const i = state.rounds.findIndex((r) => r.id === id);
  if (i < 0) return null;
  const [removed] = state.rounds.splice(i, 1);
  if (removed.hasPhoto) {
    // Keep the photo around long enough for "Undo".
    pendingPhotoDeletes.set(id, setTimeout(() => {
      kv.del('img:' + id).catch(() => {});
      pendingPhotoDeletes.delete(id);
    }, 12000));
  }
  persist();
  emit('data', { deleted: id });
  return removed;
}

export function restoreRound(round) {
  clearTimeout(pendingPhotoDeletes.get(round.id));
  pendingPhotoDeletes.delete(round.id);
  if (state.rounds.some((r) => r.id === round.id)) return;
  state.rounds.push(round);
  sortRounds();
  persist();
  emit('data', { added: round.id });
}

export async function saveRoundPhoto(roundId, dataUrl) {
  if (!kv.supportsBlobs) return false;
  try {
    await kv.set('img:' + roundId, dataUrl);
    updateRound(roundId, { hasPhoto: true }, { silent: true });
    return true;
  } catch (e) {
    console.warn('[ParMap] photo not saved', e);
    return false;
  }
}
export const getRoundPhoto = (roundId) => kv.get('img:' + roundId).catch(() => null);

/* ---------- Courses ------------------------------------------------------ */
export const getCourse = (id) => state.courses[id] || null;

// Adds a course or fills in blanks on an existing one; never overwrites
// fields the user already has (e.g. a renamed course keeps its new name).
export function upsertCourse(input) {
  const id = input.id || 'local:' + uid();
  const existing = state.courses[id];
  let merged;
  if (existing) {
    merged = { ...existing };
    for (const [k, v] of Object.entries(input)) {
      if (v != null && v !== '' && (existing[k] == null || existing[k] === '')) merged[k] = v;
    }
  } else {
    merged = { ...input, id };
  }
  state.courses[id] = normalizeCourse(merged);
  persist();
  emit('data', { course: id });
  return state.courses[id];
}

export function updateCourse(id, patch) {
  const c = state.courses[id];
  if (!c) return null;
  state.courses[id] = normalizeCourse({ ...c, ...patch, id, updatedAt: new Date().toISOString() });
  persist();
  emit('data', { course: id });
  return state.courses[id];
}

export function deleteCourse(id) {
  const removedRounds = state.rounds.filter((r) => r.courseId === id);
  for (const r of removedRounds) if (r.hasPhoto) kv.del('img:' + r.id).catch(() => {});
  state.rounds = state.rounds.filter((r) => r.courseId !== id);
  delete state.courses[id];
  persist();
  emit('data', { course: id });
  return removedRounds.length;
}

export function mergeCourses(fromId, intoId) {
  const from = state.courses[fromId], into = state.courses[intoId];
  if (!from || !into || fromId === intoId) return 0;
  let moved = 0;
  for (const r of state.rounds) if (r.courseId === fromId) { r.courseId = intoId; moved++; }
  const filled = { ...into };
  for (const [k, v] of Object.entries(from)) if (v != null && v !== '' && (filled[k] == null || filled[k] === '')) filled[k] = v;
  state.courses[intoId] = normalizeCourse({ ...filled, id: intoId });
  delete state.courses[fromId];
  persist();
  emit('data', { course: intoId });
  return moved;
}

export function findCourseMatch(name, near) {
  if (!name) return null;
  let best = null, bestScore = 0;
  for (const c of Object.values(state.courses)) {
    let s = similarity(name, c.name);
    if (near?.lat != null && c.lat != null) {
      const d = haversineKm(near, c);
      if (d < 3) s += 0.08;
      else if (d > 400) s -= 0.1;
    }
    if (s > bestScore) { best = c; bestScore = s; }
  }
  return best && bestScore >= 0.78 ? { course: best, score: bestScore } : null;
}

// Courses with at least one round, each with its rounds (newest first).
export function playedCourses(rounds = state.rounds) {
  const map = new Map();
  for (const r of rounds) {
    const c = state.courses[r.courseId];
    if (!c) continue;
    let e = map.get(c.id);
    if (!e) map.set(c.id, (e = { course: c, rounds: [] }));
    e.rounds.push(r);
  }
  return [...map.values()];
}
export const roundsForCourse = (id) => state.rounds.filter((r) => r.courseId === id);

/* ---------- Filters & search -------------------------------------------- */
export function defaultFilters() {
  return { range: 'all', from: '', to: '', minScore: null, maxScore: null, holes: 'all', courseId: '' };
}
function loadFilters() {
  try { return { ...defaultFilters(), ...JSON.parse(sessionStorage.getItem('parmap.filters') || '{}') }; } catch { return defaultFilters(); }
}
export function setFilters(patch) {
  Object.assign(state.filters, patch);
  try { sessionStorage.setItem('parmap.filters', JSON.stringify(state.filters)); } catch { /* private mode */ }
  emit('filters');
}
export const resetFilters = () => setFilters(defaultFilters());

export const RANGE_LABELS = {
  all: 'All time', '30d': 'Last 30 days', '90d': 'Last 90 days', ytd: 'This year',
  '12m': 'Last 12 months', lastyear: 'Last year', custom: 'Custom range',
};
export function rangeBounds(f = state.filters) {
  const t = new Date();
  const y = t.getFullYear();
  switch (f.range) {
    case '30d': return [isoDate(addDays(t, -30)), ''];
    case '90d': return [isoDate(addDays(t, -90)), ''];
    case 'ytd': return [`${y}-01-01`, ''];
    case '12m': return [isoDate(addDays(t, -365)), ''];
    case 'lastyear': return [`${y - 1}-01-01`, `${y - 1}-12-31`];
    case 'custom': return [f.from || '', f.to || ''];
    default: return ['', ''];
  }
}
export function applyFilters(rounds, f = state.filters) {
  const [from, to] = rangeBounds(f);
  return rounds.filter((r) => (!from || r.date >= from) && (!to || r.date <= to)
    && (f.holes === 'all' || r.holes === +f.holes)
    && (f.minScore == null || r.score >= f.minScore)
    && (f.maxScore == null || r.score <= f.maxScore)
    && (!f.courseId || r.courseId === f.courseId));
}
export function activeFilterCount(f = state.filters) {
  return (f.range !== 'all') + (f.minScore != null || f.maxScore != null) + (f.holes !== 'all') + !!f.courseId;
}
export function filterChips(f = state.filters) {
  const chips = [];
  if (f.range !== 'all') {
    let label = RANGE_LABELS[f.range];
    if (f.range === 'custom') label = [f.from || '…', f.to || '…'].join(' → ');
    chips.push({ key: 'range', label });
  }
  if (f.minScore != null || f.maxScore != null) {
    chips.push({ key: 'score', label: f.minScore != null && f.maxScore != null ? `Score ${f.minScore}–${f.maxScore}` : f.minScore != null ? `Score ≥ ${f.minScore}` : `Score ≤ ${f.maxScore}` });
  }
  if (f.holes !== 'all') chips.push({ key: 'holes', label: `${f.holes} holes` });
  if (f.courseId && state.courses[f.courseId]) chips.push({ key: 'course', label: state.courses[f.courseId].name });
  return chips;
}
export function clearFilter(key) {
  const d = defaultFilters();
  if (key === 'range') setFilters({ range: d.range, from: '', to: '' });
  else if (key === 'score') setFilters({ minScore: null, maxScore: null });
  else if (key === 'holes') setFilters({ holes: 'all' });
  else if (key === 'course') setFilters({ courseId: '' });
}

const FULL_MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
function monthFromToken(tok) {
  const full = FULL_MONTHS.indexOf(tok);
  if (full >= 0) return full + 1;
  const abbr = FULL_MONTHS.findIndex((m) => m.slice(0, 3) === tok);
  if (abbr >= 0) return abbr + 1;
  return tok === 'sept' ? 9 : null;
}
const fold = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

// "Smart" search: free text plus shortcuts like <85, >=90, 80-89, 2025, june, 9h.
export function parseQuery(q) {
  const out = { terms: [], min: null, max: null, year: null, month: null, holes: null };
  for (const tok of fold(q).trim().split(/\s+/).filter(Boolean)) {
    let m;
    if ((m = tok.match(/^(<=?|>=?)(\d{2,3})$/))) {
      const n = +m[2];
      if (m[1][0] === '<') out.max = m[1] === '<' ? n - 1 : n;
      else out.min = m[1] === '>' ? n + 1 : n;
    } else if ((m = tok.match(/^(\d{2,3})-(\d{2,3})$/))) {
      out.min = Math.min(+m[1], +m[2]);
      out.max = Math.max(+m[1], +m[2]);
    } else if (/^(19|20)\d{2}$/.test(tok)) out.year = tok;
    else if (/^(9|18)(h|holes?)$/.test(tok)) out.holes = parseInt(tok, 10);
    else if (monthFromToken(tok)) out.month = monthFromToken(tok);
    else out.terms.push(tok);
  }
  return out;
}
export function searchRounds(rounds, q) {
  const p = parseQuery(q);
  if (!p.terms.length && p.min == null && p.max == null && !p.year && !p.month && !p.holes) return rounds;
  return rounds.filter((r) => {
    if (p.min != null && r.score < p.min) return false;
    if (p.max != null && r.score > p.max) return false;
    if (p.year && !r.date.startsWith(p.year)) return false;
    if (p.month && +r.date.slice(5, 7) !== p.month) return false;
    if (p.holes && r.holes !== p.holes) return false;
    if (!p.terms.length) return true;
    const c = state.courses[r.courseId];
    const hay = fold(`${c?.name} ${c?.city} ${c?.region} ${r.tees || ''} ${r.notes || ''} ${r.score}`);
    return p.terms.every((t) => hay.includes(t));
  });
}

/* ---------- Import / export ---------------------------------------------- */
// items: [{ date, score, holes, par, tees, rating, slope, notes, course: { id?, name, city, lat, lng } }]
export function importRounds(items, { source = 'import' } = {}) {
  let added = 0, skipped = 0;
  const createdCourses = [];
  const byName = new Map();
  for (const it of items) {
    let course = it.course?.id ? state.courses[it.course.id] : null;
    if (!course && it.course?.id && it.course?.name) {
      course = normalizeCourse({ ...it.course, source: it.course.source || source });
      state.courses[course.id] = course;
      createdCourses.push(course);
    }
    if (!course && it.course?.name) {
      const key = normName(it.course.name) || it.course.name.toLowerCase();
      course = byName.get(key) || findCourseMatch(it.course.name)?.course || null;
      if (!course) {
        course = normalizeCourse({ ...it.course, id: 'local:' + uid(), source });
        state.courses[course.id] = course;
        createdCourses.push(course);
      }
      byName.set(key, course);
    }
    const score = toInt(it.score, 1, 400);
    if (!course || score == null) { skipped++; continue; }
    const date = isValidISO(it.date) ? it.date : isoDate();
    if (state.rounds.some((r) => r.courseId === course.id && r.date === date && r.score === score)) { skipped++; continue; }
    state.rounds.push(normalizeRound({ ...it, date, score, courseId: course.id, source, id: uid() }));
    added++;
  }
  sortRounds();
  persist();
  emit('data');
  if (added) requestPersistence();
  return { added, skipped, createdCourses };
}

export function exportBackup() {
  return {
    app: 'ParMap',
    schema: 1,
    exportedAt: new Date().toISOString(),
    rounds: state.rounds,
    courses: Object.values(state.courses),
  };
}

export function importBackup(data, { replace = false } = {}) {
  if (!data || !Array.isArray(data.rounds)) throw new Error("This file isn't a ParMap backup.");
  const courses = Array.isArray(data.courses) ? data.courses : Object.values(data.courses || {});
  if (replace) { state.rounds = []; state.courses = {}; }
  let addedRounds = 0, addedCourses = 0;
  for (const c of courses) {
    if (!c?.id || state.courses[c.id]) continue;
    state.courses[c.id] = normalizeCourse(c);
    addedCourses++;
  }
  const ids = new Set(state.rounds.map((r) => r.id));
  for (const r of data.rounds) {
    if (!r?.id || ids.has(r.id) || !state.courses[r.courseId] || toInt(r.score) == null) continue;
    state.rounds.push(normalizeRound({ ...r, hasPhoto: false }));
    ids.add(r.id);
    addedRounds++;
  }
  sortRounds();
  persist();
  emit('data');
  return { addedRounds, addedCourses };
}

export async function clearAllData() {
  const keys = await kv.keys().catch(() => []);
  await Promise.all(keys.filter((k) => String(k).startsWith('img:')).map((k) => kv.del(k).catch(() => {})));
  state.rounds = [];
  state.courses = {};
  persist();
  emit('data');
}

export const hasDemoData = () => state.rounds.some((r) => r.demo);
export function removeDemoData() {
  state.rounds = state.rounds.filter((r) => !r.demo);
  const used = new Set(state.rounds.map((r) => r.courseId));
  for (const [id, c] of Object.entries(state.courses)) {
    if (!c.demo) continue;
    if (used.has(id)) c.demo = false; // a real round was logged here, so keep the course
    else delete state.courses[id];
  }
  persist();
  emit('data');
}
export function addDemoData({ rounds, courses }) {
  for (const c of courses) if (!state.courses[c.id]) state.courses[c.id] = normalizeCourse({ ...c, demo: true });
  for (const r of rounds) state.rounds.push(normalizeRound({ ...r, demo: true }));
  sortRounds();
  persist();
  emit('data');
}

/* ---------- Settings & API key ------------------------------------------ */
export function loadSettings() {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; } catch { return { ...DEFAULT_SETTINGS }; }
}
export function saveSettings(patch, { silent = false } = {}) {
  Object.assign(state.settings, patch);
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings)); } catch { /* quota / private mode */ }
  if (!silent) emit('settings', patch);
}
export function getApiKey() {
  try { return localStorage.getItem(API_KEY_KEY) || ''; } catch { return ''; }
}
export function setApiKey(key) {
  try {
    if (key) localStorage.setItem(API_KEY_KEY, key.trim());
    else localStorage.removeItem(API_KEY_KEY);
  } catch { /* storage unavailable */ }
  emit('settings', { apiKey: true });
}
