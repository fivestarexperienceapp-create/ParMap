// Shared helpers: DOM, safe HTML templating, dates, numbers, text matching,
// CSV, files, images and geo math. No app state lives here.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function uid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return 'id-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

/* ---------- Safe HTML templating ---------------------------------------- */
// Every interpolated value is escaped unless it is already SafeHTML, so
// course names from OSM, AI output or CSV files can never inject markup.
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

export class SafeHTML {
  constructor(s) { this.s = s; }
  toString() { return this.s; }
}
export const raw = (s) => new SafeHTML(String(s));

function renderVal(v) {
  if (v == null || v === false || v === true) return '';
  if (v instanceof SafeHTML) return v.s;
  if (Array.isArray(v)) return v.map(renderVal).join('');
  return esc(v);
}
export function html(strings, ...vals) {
  let out = strings[0];
  for (let i = 0; i < vals.length; i++) out += renderVal(vals[i]) + strings[i + 1];
  return new SafeHTML(out);
}
export function setHTML(el, content) {
  el.innerHTML = content instanceof SafeHTML ? content.s : renderVal(content);
  return el;
}
export function fragment(content) {
  const t = document.createElement('template');
  t.innerHTML = String(content);
  return t.content;
}

/* ---------- Dates -------------------------------------------------------- */
export const pad2 = (n) => String(n).padStart(2, '0');
export function isoDate(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
export function parseISO(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}
export function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}
export function isValidISO(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '')) return false;
  const d = parseISO(s);
  return isoDate(d) === s && d.getFullYear() >= 1950 && d.getFullYear() <= 2100;
}
export function fmtDate(iso, opts = { month: 'short', day: 'numeric', year: 'numeric' }) {
  if (!iso) return '';
  return parseISO(iso).toLocaleDateString(undefined, opts);
}
export const fmtDateShort = (iso) => fmtDate(iso, { month: 'short', day: 'numeric' });
export const fmtMonthYear = (iso) => fmtDate(iso, { month: 'long', year: 'numeric' });
export function daysAgo(iso) {
  const ms = new Date().setHours(0, 0, 0, 0) - parseISO(iso).getTime();
  return Math.round(ms / 86400000);
}
export function fmtRelative(iso) {
  const d = daysAgo(iso);
  if (d === 0) return 'Today';
  if (d === 1) return 'Yesterday';
  if (d > 1 && d < 7) return `${d} days ago`;
  if (d >= 7 && d < 30) return `${Math.round(d / 7)} wk ago`;
  const sameYear = parseISO(iso).getFullYear() === new Date().getFullYear();
  return fmtDate(iso, sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', year: 'numeric' });
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
export const monthIndex = (word) => MONTHS.indexOf(String(word).slice(0, 3).toLowerCase());
const preferDMY = () => !/^en-(US|PH)|^en$/i.test(navigator.language || 'en-US');

// Accepts ISO, US/EU numeric dates, "Sep 12, 2025", "12 Sep 2025" and Excel
// serial numbers. Returns YYYY-MM-DD or null.
export function parseDateFlexible(input, { dmy = preferDMY() } = {}) {
  if (input == null) return null;
  const s = String(input).trim();
  if (!s) return null;
  const mk = (y, m, d) => {
    if (y < 100) y += y < 70 ? 2000 : 1900;
    const iso = `${y}-${pad2(m)}-${pad2(d)}`;
    return isValidISO(iso) ? iso : null;
  };
  let m;
  if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/))) return mk(+m[1], +m[2], +m[3]);
  if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})\b/))) {
    let a = +m[1], b = +m[2];
    const y = +m[3];
    const dotted = s.includes('.');
    if (a > 12) return mk(y, b, a);
    if (b > 12) return mk(y, a, b);
    return dmy || dotted ? mk(y, b, a) : mk(y, a, b);
  }
  if ((m = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{2,4})/))) {
    const mi = monthIndex(m[1]);
    if (mi >= 0) return mk(+m[3], mi + 1, +m[2]);
  }
  if ((m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{2,4})/))) {
    const mi = monthIndex(m[2]);
    if (mi >= 0) return mk(+m[3], mi + 1, +m[1]);
  }
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const serial = Math.floor(+s);
    if (serial > 20000 && serial < 80000) {
      const d = new Date(Date.UTC(1899, 11, 30) + serial * 86400000);
      return mk(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
    }
  }
  const t = Date.parse(s);
  if (!Number.isNaN(t)) {
    const d = new Date(t);
    return mk(d.getFullYear(), d.getMonth() + 1, d.getDate());
  }
  return null;
}

/* ---------- Numbers ------------------------------------------------------ */
export const MINUS = '−';
// digits = 1 for averages so columns align (+20.0); omit for single rounds (+13).
export function fmtToPar(n, digits = null) {
  if (n == null || !Number.isFinite(n)) return '–';
  const r = Math.round(n * 10) / 10;
  if (r === 0) return 'E';
  const body = digits != null ? Math.abs(r).toFixed(digits) : Number.isInteger(r) ? String(Math.abs(r)) : Math.abs(r).toFixed(1);
  return (r > 0 ? '+' : MINUS) + body;
}
export function fmt1(n) {
  return n == null || !Number.isFinite(n) ? '–' : n.toFixed(1);
}
export function fmtSigned(n, digits = 1) {
  if (n == null || !Number.isFinite(n)) return '–';
  const v = Math.abs(n).toFixed(digits);
  return n > 0 ? `+${v}` : n < 0 ? `${MINUS}${v}` : v;
}
export function fmtHandicap(v) {
  if (v == null) return '–';
  return v < 0 ? `+${Math.abs(v).toFixed(1)}` : v.toFixed(1);
}
export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
export const sum = (a) => a.reduce((s, x) => s + x, 0);
export const avg = (a) => (a.length ? sum(a) / a.length : null);
export function median(a) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
export function stdev(a) {
  if (a.length < 2) return null;
  const m = avg(a);
  return Math.sqrt(sum(a.map((x) => (x - m) ** 2)) / (a.length - 1));
}
export function toInt(v, min = -Infinity, max = Infinity) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[^\d.-]/g, ''));
  if (!Number.isFinite(n)) return null;
  const r = Math.round(n);
  return r >= min && r <= max ? r : null;
}
export function toNum(v, min = -Infinity, max = Infinity) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}
export const plural = (n, word, pluralWord = word + 's') => `${n} ${n === 1 ? word : pluralWord}`;

/* ---------- Timing ------------------------------------------------------- */
export function debounce(fn, ms) {
  let t;
  const d = (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  d.cancel = () => clearTimeout(t);
  return d;
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function fetchWithTimeout(url, opts = {}, ms = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  const outer = opts.signal;
  const onAbort = () => ctrl.abort();
  outer?.addEventListener('abort', onAbort);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
    outer?.removeEventListener('abort', onAbort);
  }
}

/* ---------- Course-name matching ---------------------------------------- */
const STOP = new Set(['the', 'golf', 'club', 'course', 'courses', 'country', 'cc', 'gc', 'g', 'c', 'and', 'links', 'resort',
  'at', 'of', 'golfclub', 'golfcourse', 'municipal', 'muni', 'public', 'gl', 'gcc', 'lodge', 'spa', 'inc', 'llc']);
export function normName(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w))
    .join(' ');
}
function bigrams(s) {
  const m = new Map();
  const t = ` ${s} `;
  for (let i = 0; i < t.length - 1; i++) {
    const g = t.slice(i, i + 2);
    m.set(g, (m.get(g) || 0) + 1);
  }
  return m;
}
// Dice coefficient on character bigrams of the normalised names (0..1).
export function similarity(a, b) {
  const x = normName(a), y = normName(b);
  if (!x || !y) return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase() ? 1 : 0;
  if (x === y) return 1;
  const A = bigrams(x), B = bigrams(y);
  let inter = 0, total = 0;
  for (const [g, c] of A) { total += c; if (B.has(g)) inter += Math.min(c, B.get(g)); }
  for (const c of B.values()) total += c;
  let score = (2 * inter) / total;
  if ((x.includes(y) || y.includes(x)) && Math.min(x.length, y.length) >= 5) score = Math.max(score, 0.86);
  return score;
}

/* ---------- CSV ---------------------------------------------------------- */
export function parseCSV(text) {
  text = String(text).replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  const delim = [',', ';', '\t', '|']
    .map((d) => [d, firstLine.split(d).length])
    .sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}
export function toCSV(rows) {
  const cell = (v) => {
    if (v == null) return '';
    let s = String(v);
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s; // spreadsheet formula injection guard
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(cell).join(',')).join('\r\n');
}

/* ---------- Files -------------------------------------------------------- */
export function downloadFile(filename, content, type = 'application/octet-stream') {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
// On phones the share sheet is the natural "save to Files / send" path.
export async function shareOrDownload(filename, content, type) {
  const coarse = matchMedia('(pointer: coarse)').matches;
  try {
    const file = new File([content], filename, { type });
    if (coarse && navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: filename });
      return 'shared';
    }
  } catch (e) {
    if (e?.name === 'AbortError') return 'cancelled';
  }
  downloadFile(filename, content, type);
  return 'downloaded';
}
export const readFileText = (file) => file.text ? file.text() : new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(r.result);
  r.onerror = () => rej(r.error);
  r.readAsText(file);
});

/* ---------- Images ------------------------------------------------------- */
async function loadImageSource(blob) {
  if ('createImageBitmap' in window) {
    try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); } catch { /* fall back */ }
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That image could not be read. Try a JPG or PNG photo.')); };
    img.src = url;
  });
}
export async function resizeImage(blob, maxDim = 2048, quality = 0.86) {
  const src = await loadImageSource(blob);
  const w0 = src.width || src.naturalWidth;
  const h0 = src.height || src.naturalHeight;
  const scale = Math.min(1, maxDim / Math.max(w0, h0));
  const w = Math.max(1, Math.round(w0 * scale));
  const h = Math.max(1, Math.round(h0 * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, w, h);
  src.close?.();
  const out = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', quality));
  if (!out) throw new Error('Could not process the image.');
  return out;
}
export const blobToDataURL = (blob) => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(r.result);
  r.onerror = () => rej(r.error);
  r.readAsDataURL(blob);
});
export async function blobToBase64(blob) {
  const d = await blobToDataURL(blob);
  return d.slice(d.indexOf(',') + 1);
}

/* ---------- Geo ---------------------------------------------------------- */
export function haversineKm(a, b) {
  if (!a || !b || a.lat == null || b.lat == null) return null;
  const R = 6371, rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}
export function fmtDistance(km, units = 'mi') {
  if (km == null) return '';
  if (units === 'km') return km < 1 ? `${Math.round(km * 1000)} m` : `${km < 10 ? km.toFixed(1) : Math.round(km)} km`;
  const mi = km * 0.621371;
  return mi < 0.1 ? `${Math.round(mi * 5280)} ft` : `${mi < 10 ? mi.toFixed(1) : Math.round(mi)} mi`;
}

/* ---------- Platform ----------------------------------------------------- */
export const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
export function vibrate(ms = 10) {
  try { navigator.vibrate?.(ms); } catch { /* unsupported */ }
}
