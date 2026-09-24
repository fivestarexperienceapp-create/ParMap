// UI primitives: icons, toasts, bottom sheets (with drag-to-dismiss and
// Android back-button support), dialogs, action sheets and a photo viewer.
import { html, esc, raw, setHTML, SafeHTML } from './utils.js';

export const icon = (name, cls = '') => raw(`<svg class="i ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`);

/* ---------- Overlay history -----------------------------------------------
   Each open overlay owns one history entry so the hardware/browser back
   button closes it instead of leaving the app. */
// Invariant: every open overlay (except ones opened while a back() is still
// in flight, which are "deferred") owns exactly one {overlay:true} history
// entry. Closing any overlay pops one entry; the browser back button closes
// the top-most overlay.
const overlays = [];
const backQueue = [];
let deferred = [];

if (history.state?.overlay) history.replaceState(null, '');

function flushDeferred() {
  const list = deferred;
  deferred = [];
  for (const e of list) if (overlays.includes(e)) history.pushState({ overlay: true }, '');
}

export function pushOverlay(closeFn, { replace = false } = {}) {
  const entry = { closeFn, closing: false, resolve: null };
  if (replace && overlays.length) {
    const prev = overlays.pop();
    prev.closing = true;
    prev.closeFn();
    const di = deferred.indexOf(prev);
    if (di >= 0) deferred[di] = entry; // inherit the pending history slot
    overlays.push(entry);
  } else {
    overlays.push(entry);
    if (backQueue.length) deferred.push(entry);
    else history.pushState({ overlay: true }, '');
  }
  return entry;
}

export function closeOverlay(entry) {
  return new Promise((resolve) => {
    const i = overlays.indexOf(entry);
    if (i < 0 || entry.closing) { resolve(); return; }
    entry.closing = true;
    const di = deferred.indexOf(entry);
    if (di >= 0) {
      deferred.splice(di, 1);
      overlays.splice(i, 1);
      entry.closeFn();
      resolve();
      return;
    }
    entry.resolve = resolve;
    backQueue.push(entry);
    history.back();
    // Safety net in case the history entry was lost (e.g. after a reload).
    setTimeout(() => {
      if (!overlays.includes(entry)) return;
      overlays.splice(overlays.indexOf(entry), 1);
      const bi = backQueue.indexOf(entry);
      if (bi >= 0) backQueue.splice(bi, 1);
      entry.closeFn();
      resolve();
      if (!backQueue.length) flushDeferred();
    }, 600);
  });
}

window.addEventListener('popstate', () => {
  let entry = backQueue.shift();
  if (!entry) {
    for (let i = overlays.length - 1; i >= 0 && !entry; i--) if (!deferred.includes(overlays[i])) entry = overlays[i];
  }
  if (entry) {
    const i = overlays.indexOf(entry);
    if (i >= 0) { overlays.splice(i, 1); entry.closeFn(); }
    entry.resolve?.();
  }
  if (!backQueue.length) flushDeferred();
});

export const overlayOpen = () => overlays.length > 0;

/* ---------- Toasts ---------------------------------------------------------- */
export function toast(message, { action, onAction, duration = 3800, tone = 'ok', iconName } = {}) {
  const root = document.getElementById('toast-root');
  while (root.children.length >= 2) root.firstElementChild.remove();
  const el = document.createElement('div');
  el.className = `toast toast--${tone}`;
  el.setAttribute('role', tone === 'error' ? 'alert' : 'status');
  setHTML(el, html`${icon(iconName || (tone === 'error' ? 'alert' : 'check'))}<span class="toast-msg">${message}</span>${action ? html`<button class="toast-action" type="button">${action}</button>` : ''}`);
  root.append(el);
  requestAnimationFrame(() => el.classList.add('show'));
  const remove = () => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 260);
  };
  const t = setTimeout(remove, duration);
  el.querySelector('.toast-action')?.addEventListener('click', () => {
    clearTimeout(t);
    remove();
    onAction?.();
  });
  return remove;
}
export const toastError = (e, fallback = 'Something went wrong.') => toast(e?.message || fallback, { tone: 'error', duration: 5200 });

/* ---------- Sheets ------------------------------------------------------------ */
let sheetSeq = 0;

export function openSheet({ title = '', subtitle = '', body = '', footer = null, size = 'auto', className = '', onClose, replace = false, dismissible = true, headerExtra = '' } = {}) {
  const root = document.getElementById('sheet-root');
  const id = `sheet-${++sheetSeq}`;
  const layer = document.createElement('div');
  layer.className = `sheet-layer ${className}`;
  setHTML(layer, html`
    <div class="sheet-backdrop"></div>
    <section class="sheet sheet--${size}" role="dialog" aria-modal="true" aria-labelledby="${id}-t" tabindex="-1">
      <header class="sheet-head">
        <div class="sheet-grip"></div>
        <div class="sheet-titles">
          <h2 class="sheet-title" id="${id}-t"></h2>
          <p class="sheet-sub" hidden></p>
        </div>
        ${raw(String(headerExtra))}
        ${dismissible ? html`<button class="icon-btn filled sheet-close" type="button" aria-label="Close">${icon('x')}</button>` : ''}
      </header>
      <div class="sheet-body"></div>
      <footer class="sheet-foot" hidden></footer>
    </section>`);
  const sheet = layer.querySelector('.sheet');
  const bodyEl = layer.querySelector('.sheet-body');
  const footEl = layer.querySelector('.sheet-foot');
  const titleEl = layer.querySelector('.sheet-title');
  const subEl = layer.querySelector('.sheet-sub');
  const prevFocus = document.activeElement;
  let closed = false;

  const ctl = {
    el: layer,
    sheet,
    body: bodyEl,
    foot: footEl,
    setTitle(t, sub) {
      titleEl.textContent = t || '';
      if (sub !== undefined) { subEl.textContent = sub || ''; subEl.hidden = !sub; }
    },
    setBody(content) { renderInto(bodyEl, content); },
    setFooter(content) {
      if (content == null || content === '') { footEl.hidden = true; footEl.innerHTML = ''; layer.classList.add('no-foot'); return; }
      renderInto(footEl, content);
      footEl.hidden = false;
      layer.classList.remove('no-foot');
    },
    close() { return closeOverlay(entry); },
    get isOpen() { return !closed; },
    onClose,
  };

  function teardown() {
    if (closed) return;
    closed = true;
    layer.classList.remove('open');
    document.removeEventListener('keydown', onKey);
    setTimeout(() => layer.remove(), 320);
    try { prevFocus?.focus?.({ preventScroll: true }); } catch { /* element gone */ }
    ctl.onClose?.();
  }
  const entry = pushOverlay(teardown, { replace });

  ctl.setTitle(title, subtitle);
  ctl.setBody(body);
  ctl.setFooter(footer);
  root.append(layer);
  void layer.offsetHeight; // commit the closed state so the open transition runs
  layer.classList.add('open');
  setTimeout(() => {
    if (!sheet.contains(document.activeElement)) sheet.focus({ preventScroll: true });
  }, 60);

  if (dismissible) {
    layer.querySelector('.sheet-backdrop').addEventListener('click', () => ctl.close());
    layer.querySelector('.sheet-close').addEventListener('click', () => ctl.close());
    enableDragToDismiss(sheet, layer.querySelector('.sheet-head'), () => ctl.close());
  }
  function onKey(e) {
    if (e.key === 'Escape' && dismissible && overlays[overlays.length - 1] === entry) { e.preventDefault(); ctl.close(); }
  }
  document.addEventListener('keydown', onKey);
  return ctl;
}

function renderInto(el, content) {
  if (content instanceof Node) { el.replaceChildren(content); return; }
  if (content instanceof SafeHTML) { el.innerHTML = content.s; return; }
  el.textContent = content == null ? '' : String(content);
}

function enableDragToDismiss(sheet, handle, onDismiss) {
  let startY = 0, dy = 0, t0 = 0, dragging = false, pid = null;
  handle.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button, a, input, select, textarea')) return;
    if (matchMedia('(min-width: 600px)').matches && e.pointerType === 'mouse') return;
    dragging = true; pid = e.pointerId; startY = e.clientY; dy = 0; t0 = performance.now();
    sheet.classList.add('is-dragging');
    handle.setPointerCapture(pid);
  });
  handle.addEventListener('pointermove', (e) => {
    if (!dragging || e.pointerId !== pid) return;
    dy = Math.max(0, e.clientY - startY);
    sheet.style.transform = `translateY(${dy}px)`;
  });
  const end = (e) => {
    if (!dragging || e.pointerId !== pid) return;
    dragging = false;
    sheet.classList.remove('is-dragging');
    const v = dy / Math.max(1, performance.now() - t0);
    sheet.style.transform = '';
    if (dy > 110 || (v > 0.6 && dy > 30)) onDismiss();
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}

/* ---------- Dialogs & action sheets ----------------------------------------- */
export function confirmDialog({ title, message = '', confirmText = 'Confirm', cancelText = 'Cancel', danger = false }) {
  return new Promise((resolve) => {
    let result = false;
    const s = openSheet({
      title,
      size: 'dialog',
      body: html`<p class="muted" style="font-size:15px;line-height:1.5">${message}</p>`,
      footer: html`<button class="btn btn-secondary" data-act="cancel" type="button">${cancelText}</button>
        <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-act="ok" type="button">${confirmText}</button>`,
      onClose: () => resolve(result),
    });
    s.foot.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!act) return;
      result = act === 'ok';
      s.close();
    });
  });
}

// actions: [{ label, sub, icon, danger, checked, value, href }]
export function actionSheet({ title, subtitle = '', actions }) {
  return new Promise((resolve) => {
    let chosen = null;
    const s = openSheet({
      title,
      subtitle,
      body: html`<div class="action-list">${actions.map((a, i) => a.href
        ? html`<a class="action-item ${a.danger ? 'danger' : ''}" href="${a.href}" target="_blank" rel="noopener" data-i="${i}">${a.icon ? icon(a.icon) : ''}<span>${a.label}${a.sub ? html`<span class="sub">${a.sub}</span>` : ''}</span>${icon('external', 'i-sm check')}</a>`
        : html`<button class="action-item ${a.danger ? 'danger' : ''}" type="button" data-i="${i}">${a.icon ? icon(a.icon) : ''}<span>${a.label}${a.sub ? html`<span class="sub">${a.sub}</span>` : ''}</span>${a.checked ? icon('check', 'check') : ''}</button>`)}</div>`,
      onClose: () => resolve(chosen),
    });
    s.body.addEventListener('click', (e) => {
      const item = e.target.closest('[data-i]');
      if (!item) return;
      chosen = actions[+item.dataset.i];
      if (chosen.href) { setTimeout(() => s.close(), 50); return; }
      s.close();
    });
  });
}

/* ---------- Photo viewer ---------------------------------------------------- */
export function openViewer(src, alt = 'Scorecard photo') {
  const el = document.createElement('div');
  el.className = 'viewer';
  setHTML(el, html`<img src="${src}" alt="${alt}"><button class="icon-btn" type="button" aria-label="Close">${icon('x')}</button>`);
  const entry = pushOverlay(() => el.remove());
  el.addEventListener('click', () => closeOverlay(entry));
  document.body.append(el);
}

/* ---------- Misc ------------------------------------------------------------ */
export function setBusy(btn, busy, label) {
  if (!btn) return;
  if (busy) {
    btn.dataset.label = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner" aria-hidden="true"></span>${label ? esc(label) : ''}`;
  } else {
    btn.disabled = false;
    if (btn.dataset.label != null) btn.innerHTML = btn.dataset.label;
  }
}

export function emptyArt() {
  return raw(`<svg class="empty-art" viewBox="0 0 132 104" aria-hidden="true">
    <ellipse cx="66" cy="88" rx="58" ry="12" fill="var(--primary-soft)"/>
    <ellipse cx="80" cy="88" rx="7" ry="2.6" fill="var(--primary)" opacity=".55"/>
    <path d="M58 88V20" stroke="var(--text-3)" stroke-width="3" stroke-linecap="round"/>
    <path d="M59 21l30 11-30 12z" fill="var(--accent)"/>
    <circle cx="96" cy="80" r="6" fill="var(--surface)" stroke="var(--border-strong)" stroke-width="1.5"/>
  </svg>`);
}
