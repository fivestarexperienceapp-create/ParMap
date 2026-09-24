// Hand-rolled responsive SVG charts (no dependencies).
// Specs: 2px lines, 8px dots with a 2px surface ring, hairline solid grid,
// bars <= 24px with 4px rounded data ends, crosshair + tooltip on hover/touch,
// keyboard navigation, and text that never wears the series colour.
import { parseISO, fmtDate } from './utils.js';
import { rollingAverage } from './stats.js';

const NS = 'http://www.w3.org/2000/svg';

function niceStep(range, maxTicks = 4) {
  for (const s of [1, 2, 5, 10, 20, 25, 50, 100]) if (range / s <= maxTicks) return s;
  return 200;
}

function observeWidth(el, cb) {
  let last = 0, raf = 0;
  const ro = new ResizeObserver(() => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      const w = Math.round(el.clientWidth);
      if (w && w !== last) { last = w; cb(); }
    });
  });
  ro.observe(el);
  return ro;
}

function makeTip(el) {
  let tip = el.querySelector('.chart-tip');
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'chart-tip';
    tip.setAttribute('aria-hidden', 'true');
    el.append(tip);
  }
  return tip;
}

function placeTip(el, tip, x, y) {
  const w = tip.offsetWidth, h = tip.offsetHeight, W = el.clientWidth;
  let left = x + 14;
  if (left + w > W) left = x - w - 14;
  left = Math.max(0, Math.min(W - w, left));
  const top = Math.max(0, y - h - 10);
  tip.style.transform = `translate(${left}px, ${top}px)`;
}

// Build tooltip content with textContent only (labels are untrusted data).
function tipContent(tip, { date, title, rows }) {
  tip.replaceChildren();
  const d = document.createElement('div'); d.className = 'tt-date'; d.textContent = date; tip.append(d);
  if (title) { const t = document.createElement('div'); t.className = 'tt-title'; t.textContent = title; tip.append(t); }
  for (const r of rows) {
    const row = document.createElement('div'); row.className = 'tt-row';
    if (r.key) { const k = document.createElement('i'); k.className = `tt-key ${r.key === 'dot' ? 'dot' : ''}`; row.append(k); }
    const b = document.createElement('b'); b.textContent = r.value; row.append(b);
    const s = document.createElement('span'); s.textContent = r.label; row.append(s);
    tip.append(row);
  }
}

/* ---------- Score trend: dots per round + rolling-average line ------------ */
// points: [{ id, date, value, title }] sorted oldest -> newest
export function trendChart(el, { points, window = 5, height = 220, onSelect, ariaLabel = 'Score trend' }) {
  el.classList.add('chart');
  el.tabIndex = 0;
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', ariaLabel);
  let geo = null, active = -1, lastTouchIdx = -1;

  function render() {
    const W = Math.max(240, el.clientWidth || 320);
    const H = height;
    const m = { l: 34, r: 42, t: 22, b: 26 };
    const n = points.length;
    const ts = points.map((p) => parseISO(p.date).getTime());
    const vals = points.map((p) => p.value);
    const avgs = rollingAverage(vals, window);
    let x0 = Math.min(...ts), x1 = Math.max(...ts);
    if (x1 - x0 < 86400000 * 6) { x0 -= 86400000 * 10; x1 += 86400000 * 10; }
    const all = vals.concat(avgs.filter((v) => v != null));
    let y0 = Math.min(...all), y1 = Math.max(...all);
    const step = niceStep(Math.max(4, y1 - y0 + 4), 4);
    y0 = Math.floor((y0 - 1) / step) * step;
    y1 = Math.ceil((y1 + 1) / step) * step;
    const sx = (t) => m.l + ((t - x0) / (x1 - x0)) * (W - m.l - m.r);
    const sy = (v) => m.t + ((y1 - v) / (y1 - y0)) * (H - m.t - m.b);

    let s = '';
    for (let v = y0; v <= y1 + 0.001; v += step) {
      const y = Math.round(sy(v)) + 0.5;
      s += `<line class="viz-grid" x1="${m.l}" x2="${W - m.r}" y1="${y}" y2="${y}"/>`;
      s += `<text class="viz-tick" x="${m.l - 8}" y="${y + 4}" text-anchor="end">${v}</text>`;
    }
    const tickCount = Math.max(2, Math.min(5, Math.floor((W - m.l - m.r) / 90)));
    const longSpan = x1 - x0 > 86400000 * 300;
    for (let i = 0; i < tickCount; i++) {
      const t = x0 + ((x1 - x0) * i) / (tickCount - 1);
      const d = new Date(t);
      const label = longSpan ? d.toLocaleDateString(undefined, { month: 'short', year: '2-digit' }) : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      const anchor = i === 0 ? 'start' : i === tickCount - 1 ? 'end' : 'middle';
      s += `<text class="viz-tick" x="${sx(t)}" y="${H - 6}" text-anchor="${anchor}">${label}</text>`;
    }
    s += `<line class="viz-axis" x1="${m.l}" x2="${W - m.r}" y1="${H - m.b + 0.5}" y2="${H - m.b + 0.5}"/>`;

    // Rolling average line (the story) drawn above dots for emphasis.
    let d = '', started = false, lastPt = null;
    avgs.forEach((v, i) => {
      if (v == null) return;
      const x = sx(ts[i]).toFixed(1), y = sy(v).toFixed(1);
      d += `${started ? 'L' : 'M'}${x},${y}`;
      started = true;
      lastPt = { x: +x, y: +y, v };
    });
    let bestIdx = 0;
    vals.forEach((v, i) => { if (v < vals[bestIdx]) bestIdx = i; });
    points.forEach((p, i) => {
      s += `<circle class="${i === bestIdx ? 'viz-dot-accent' : 'viz-dot'}" data-i="${i}" cx="${sx(ts[i]).toFixed(1)}" cy="${sy(p.value).toFixed(1)}" r="4"/>`;
    });
    if (d) s += `<path class="viz-line" d="${d}"/>`;
    // Selective direct labels: the personal best and the latest average.
    const bxRaw = sx(ts[bestIdx]);
    const leftSide = bxRaw > W - m.r - 70;
    s += `<text class="viz-label-strong" x="${bxRaw + (leftSide ? -10 : 10)}" y="${sy(vals[bestIdx]) + 4}" text-anchor="${leftSide ? 'end' : 'start'}">Best ${vals[bestIdx]}</text>`;
    if (lastPt) s += `<text class="viz-label" x="${lastPt.x + 8}" y="${lastPt.y + 4}">${lastPt.v.toFixed(1)}</text>`;
    s += `<line class="viz-cross" x1="0" x2="0" y1="${m.t - 6}" y2="${H - m.b}" visibility="hidden"/>`;

    el.querySelector('svg')?.remove();
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('width', W);
    svg.setAttribute('height', H);
    svg.innerHTML = s;
    el.prepend(svg);
    geo = { svg, sx, sy, ts, avgs, W, n };
    makeTip(el);
    if (active >= 0) setActive(Math.min(active, n - 1));
  }

  function setActive(i) {
    if (!geo || i < 0) return;
    active = i;
    const { svg, sx, sy, ts, avgs } = geo;
    const p = points[i];
    const x = sx(ts[i]);
    const cross = svg.querySelector('.viz-cross');
    cross.setAttribute('x1', x); cross.setAttribute('x2', x); cross.setAttribute('visibility', 'visible');
    svg.querySelectorAll('circle.is-active').forEach((c) => c.classList.remove('is-active'));
    svg.querySelector(`circle[data-i="${i}"]`)?.classList.add('is-active');
    const tip = makeTip(el);
    tipContent(tip, {
      date: fmtDate(p.date),
      title: p.title,
      rows: [
        { key: 'dot', value: String(p.value), label: p.sub || 'score' },
        ...(avgs[i] != null ? [{ key: 'line', value: avgs[i].toFixed(1), label: `${window}-round avg` }] : []),
      ],
    });
    tip.classList.add('show');
    placeTip(el, tip, x, sy(p.value));
  }
  function hide() {
    if (!geo) return;
    geo.svg.querySelector('.viz-cross')?.setAttribute('visibility', 'hidden');
    geo.svg.querySelectorAll('circle.is-active').forEach((c) => c.classList.remove('is-active'));
    el.querySelector('.chart-tip')?.classList.remove('show');
    active = -1;
  }
  function nearest(clientX) {
    const rect = geo.svg.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * geo.W;
    let best = 0, bd = Infinity;
    geo.ts.forEach((t, i) => { const dd = Math.abs(geo.sx(t) - x); if (dd <= bd) { bd = dd; best = i; } });
    return best;
  }
  el.addEventListener('pointermove', (e) => { if (geo) setActive(nearest(e.clientX)); });
  el.addEventListener('pointerdown', (e) => { if (geo) setActive(nearest(e.clientX)); });
  el.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') hide(); });
  el.addEventListener('click', (e) => {
    if (!geo || !onSelect) return;
    const i = nearest(e.clientX);
    if (e.pointerType === 'mouse' || lastTouchIdx === i) onSelect(points[i].id);
    lastTouchIdx = i;
  });
  el.addEventListener('keydown', (e) => {
    if (!points.length) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const next = active < 0 ? points.length - 1 : active + (e.key === 'ArrowRight' ? 1 : -1);
      setActive(Math.max(0, Math.min(points.length - 1, next)));
    } else if (e.key === 'Enter' && active >= 0 && onSelect) onSelect(points[active].id);
    else if (e.key === 'Escape') hide();
  });
  el.addEventListener('blur', hide);
  render();
  observeWidth(el, render);
}

/* ---------- Histogram (score distribution) -------------------------------- */
// bins: [{ from, to, count }]
export function histogramChart(el, { bins, height = 180, ariaLabel = 'Score distribution' }) {
  el.classList.add('chart');
  el.tabIndex = 0;
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', ariaLabel);
  const total = bins.reduce((a, b) => a + b.count, 0);
  let geo = null, active = -1;

  function render() {
    const W = Math.max(240, el.clientWidth || 320);
    const H = height;
    const m = { l: 6, r: 6, t: 22, b: 26 };
    const slot = (W - m.l - m.r) / bins.length;
    const bw = Math.min(24, slot - 6);
    const maxC = Math.max(1, ...bins.map((b) => b.count));
    const base = H - m.b;
    const sy = (c) => base - (c / maxC) * (H - m.t - m.b);
    const wide = slot >= 46;
    let s = '';
    bins.forEach((b, i) => {
      const cx = m.l + slot * i + slot / 2;
      const x = cx - bw / 2;
      if (b.count > 0) {
        const y = sy(b.count), h = base - y, r = Math.min(4, h / 2, bw / 2);
        s += `<path class="viz-bar" data-i="${i}" d="M${x},${base}V${y + r}Q${x},${y} ${x + r},${y}H${x + bw - r}Q${x + bw},${y} ${x + bw},${y + r}V${base}Z"/>`;
        s += `<text class="viz-label" x="${cx}" y="${y - 6}" text-anchor="middle">${b.count}</text>`;
      }
      if (wide || i % 2 === 0) s += `<text class="viz-tick" x="${cx}" y="${H - 7}" text-anchor="middle">${wide ? `${b.from}–${b.to}` : b.from}</text>`;
      s += `<rect class="viz-hit" data-i="${i}" x="${m.l + slot * i}" y="${m.t - 16}" width="${slot}" height="${H - m.t - m.b + 16}"/>`;
    });
    s += `<line class="viz-axis" x1="${m.l}" x2="${W - m.r}" y1="${base + 0.5}" y2="${base + 0.5}"/>`;
    el.querySelector('svg')?.remove();
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('width', W);
    svg.setAttribute('height', H);
    svg.innerHTML = s;
    el.prepend(svg);
    geo = { svg, slot, m, sy };
    makeTip(el);
  }

  function setActive(i) {
    if (!geo || i < 0 || i >= bins.length) return;
    active = i;
    const b = bins[i];
    geo.svg.querySelectorAll('.viz-bar').forEach((p) => p.classList.toggle('is-dim', +p.dataset.i !== i));
    const tip = makeTip(el);
    tipContent(tip, {
      date: `Scores ${b.from}–${b.to}`,
      rows: [{ value: String(b.count), label: `${b.count === 1 ? 'round' : 'rounds'} · ${total ? Math.round((b.count / total) * 100) : 0}%` }],
    });
    tip.classList.add('show');
    const cx = geo.m.l + geo.slot * i + geo.slot / 2;
    placeTip(el, tip, cx, geo.sy(b.count));
  }
  function hide() {
    geo?.svg.querySelectorAll('.viz-bar').forEach((p) => p.classList.remove('is-dim'));
    el.querySelector('.chart-tip')?.classList.remove('show');
    active = -1;
  }
  el.addEventListener('pointermove', (e) => {
    const i = e.target.closest?.('[data-i]')?.dataset.i;
    if (i != null) setActive(+i);
  });
  el.addEventListener('pointerdown', (e) => {
    const i = e.target.closest?.('[data-i]')?.dataset.i;
    if (i != null) setActive(+i);
  });
  el.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') hide(); });
  el.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      setActive(Math.max(0, Math.min(bins.length - 1, (active < 0 ? 0 : active + (e.key === 'ArrowRight' ? 1 : -1)))));
    } else if (e.key === 'Escape') hide();
  });
  el.addEventListener('blur', hide);
  render();
  observeWidth(el, render);
}

/* ---------- Sparkline ------------------------------------------------------- */
export function sparkline(values, { width = 72, height = 26 } = {}) {
  if (!values || values.length < 2) return '';
  const lo = Math.min(...values), hi = Math.max(...values);
  const span = Math.max(1, hi - lo);
  const px = (i) => 3 + (i / (values.length - 1)) * (width - 6);
  const py = (v) => 3 + ((hi - v) / span) * (height - 6);
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${px(i).toFixed(1)},${py(v).toFixed(1)}`).join('');
  const last = values.length - 1;
  return `<svg class="spark" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" aria-hidden="true"><path d="${d}"/><circle cx="${px(last).toFixed(1)}" cy="${py(values[last]).toFixed(1)}" r="3"/></svg>`;
}
