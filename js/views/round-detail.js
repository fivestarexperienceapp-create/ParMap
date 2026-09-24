// Round detail sheet: score, to-par, differential, notes, scorecard photo.
import { state, on, getRound, getCourse, deleteRound, restoreRound, getRoundPhoto } from '../store.js';
import { toPar, differential } from '../stats.js';
import { html, setHTML, fmtToPar, fmtDate, fmt1 } from '../utils.js';
import { icon, openSheet, toast, confirmDialog, openViewer, actionSheet } from '../ui.js';
import { directionsLinks } from '../geo.js';
import { openRoundForm } from './round-form.js';
import { openCourseDetail } from './course-detail.js';

const SOURCE = { manual: 'Logged manually', scan: 'Scanned with AI', import: 'Imported', 'ai-import': 'Imported with AI' };

export function openRoundDetail(id) {
  if (!getRound(id)) return null;
  const sheet = openSheet({ title: '' });
  const off = on((kind) => { if (kind === 'data') render(); });
  sheet.onClose = () => off();
  let photoSrc; // undefined = not loaded yet, null = none stored

  function render() {
    const r = getRound(id);
    if (!r) { sheet.close(); return; }
    const c = getCourse(r.courseId);
    const tp = toPar(r);
    const diff = differential(r);
    sheet.setTitle(c?.name || 'Round', fmtDate(r.date, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }));
    setHTML(sheet.body, html`
      <div class="row-flex" style="align-items:flex-end;gap:14px;margin:6px 0 16px">
        <span style="font-size:64px;font-weight:800;letter-spacing:-0.04em;line-height:.9">${r.score}</span>
        <div style="padding-bottom:6px">
          ${tp != null ? html`<div style="font-size:20px;font-weight:750">${fmtToPar(tp)} <span class="muted" style="font-size:14px;font-weight:600">to par</span></div>` : ''}
          <div class="muted" style="font-size:14px">${[`${r.holes} holes`, r.tees ? `${r.tees} tees` : ''].filter(Boolean).join(' · ')}</div>
        </div>
      </div>
      <dl class="kv-grid">
        <div><dt>Par</dt><dd>${r.par ?? '–'}</dd></div>
        <div><dt>Rating / slope</dt><dd>${r.rating != null ? fmt1(r.rating) : '–'} / ${r.slope ?? '–'}</dd></div>
        <div><dt>Differential</dt><dd>${diff != null ? fmt1(diff) : '–'}${diff != null && (r.rating == null || r.slope == null) ? html` <span class="badge" title="Uses par and slope 113 because rating or slope is missing">est.</span>` : ''}</dd></div>
        <div><dt>Out / In</dt><dd>${r.front9 ?? '–'} / ${r.holes === 18 ? r.back9 ?? '–' : '–'}</dd></div>
      </dl>
      ${r.notes ? html`<div class="section-title">Notes</div><p style="white-space:pre-wrap;line-height:1.5">${r.notes}</p>` : ''}
      ${r.hasPhoto ? html`<div class="section-title">Scorecard</div><div data-el="photo"><div class="skeleton" style="height:180px"></div></div>` : ''}
      <p class="hint" style="margin-top:16px">
        ${SOURCE[r.source] || 'Logged'}${r.ai?.confidence ? ` · ${r.ai.confidence} confidence` : ''}${r.ai?.model ? ` · ${r.ai.model}` : ''}${r.demo ? ' · sample data' : ''} · added ${new Date(r.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
      </p>`);
    sheet.setFooter(html`
      <button class="btn btn-danger btn-icon-only" data-act="delete" aria-label="Delete round">${icon('trash')}</button>
      <button class="btn btn-secondary" data-act="course">${icon('flag')} Course</button>
      <button class="btn btn-primary" data-act="edit">${icon('edit')} Edit</button>`);
    if (r.hasPhoto) loadPhoto(r.id);
  }

  async function loadPhoto(rid) {
    const box = sheet.body.querySelector('[data-el="photo"]');
    if (photoSrc === undefined) photoSrc = await getRoundPhoto(rid);
    if (!box || !sheet.isOpen || !box.isConnected) return;
    if (!photoSrc) { box.innerHTML = '<p class="hint">Photo not available on this device.</p>'; return; }
    const img = document.createElement('img');
    img.className = 'photo-thumb';
    img.alt = 'Scorecard photo';
    img.src = photoSrc;
    img.addEventListener('click', () => openViewer(photoSrc));
    box.replaceChildren(img);
  }

  async function onClick(e) {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const r = getRound(id);
    if (!r) return;
    switch (btn.dataset.act) {
      case 'edit': openRoundForm({ round: r }); break;
      case 'course': {
        const c = getCourse(r.courseId);
        if (!c) return;
        const choice = await actionSheet({
          title: c.name,
          actions: [
            { value: 'open', label: 'View course', sub: 'History and stats at this course', icon: 'flag' },
            ...directionsLinks(c).map((l) => ({ label: `Directions in ${l.label}`, href: l.url, icon: 'directions' })),
          ],
        });
        if (choice?.value === 'open') openCourseDetail(c.id);
        break;
      }
      case 'delete': {
        const ok = await confirmDialog({ title: 'Delete this round?', message: `${r.score} at ${getCourse(r.courseId)?.name || 'this course'} on ${fmtDate(r.date)}.`, confirmText: 'Delete', danger: true });
        if (!ok) return;
        await sheet.close();
        const removed = deleteRound(id);
        toast('Round deleted', { action: 'Undo', onAction: () => restoreRound(removed), iconName: 'trash', duration: 6000 });
        break;
      }
      default: break;
    }
  }
  sheet.foot.addEventListener('click', onClick);
  render();
  return sheet;
}
