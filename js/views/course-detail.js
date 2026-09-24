// Course detail sheet: stats, trend and history at one course, plus
// directions, contact links, location fixing, edit, merge and delete.
import { state, on, getCourse, roundsForCourse, updateCourse, deleteCourse, mergeCourses, playedCourses, upsertCourse } from '../store.js';
import { courseStats } from '../stats.js';
import { html, setHTML, fmt1, fmtToPar, fmtDate, fmtDistance, haversineKm, plural, similarity } from '../utils.js';
import { icon, openSheet, toast, toastError, actionSheet, confirmDialog, setBusy } from '../ui.js';
import { lastKnownPosition, getPosition, directionsLinks, geocodeCourse } from '../geo.js';
import { trendChart } from '../charts.js';
import { roundRow } from './rounds.js';
import { openRoundDetail } from './round-detail.js';
import { openRoundForm } from './round-form.js';
import { goTab } from '../router.js';
import { focusCourseOnMap } from './map.js';

export function openCourseDetail(id, { course: fallback = null } = {}) {
  let course = getCourse(id) || fallback;
  if (!course) return null;
  const sheet = openSheet({ title: course.name, size: 'full' });
  const off = on((kind) => { if (kind === 'data') render(); });
  sheet.onClose = () => off();

  function render() {
    const stored = getCourse(id);
    if (!stored && !fallback) { sheet.close(); return; }
    course = stored || fallback;
    const rounds = roundsForCourse(id);
    const st = rounds.length ? courseStats(rounds) : null;
    const me = lastKnownPosition();
    const dist = me && course.lat != null ? fmtDistance(haversineKm(me, course), state.settings.units) : '';
    sheet.setTitle(course.name, [[course.city, course.region].filter(Boolean).join(', '), dist].filter(Boolean).join(' · '));
    const website = course.website && /^https?:\/\//i.test(course.website) ? course.website : course.website ? `https://${course.website}` : '';
    const pbId = rounds.length ? courseStats(rounds).best?.id : null;
    setHTML(sheet.body, html`
      <div class="action-row" style="margin:6px 0 16px">
        <button class="action-tile" data-act="directions">${icon('directions')}Directions</button>
        <button class="action-tile" data-act="log">${icon('plus')}Log round</button>
        ${course.lat != null ? html`<button class="action-tile" data-act="map">${icon('map')}On map</button>` : ''}
        ${website ? html`<a class="action-tile" href="${website}" target="_blank" rel="noopener">${icon('globe')}Website</a>` : ''}
        ${course.phone ? html`<a class="action-tile" href="tel:${course.phone.replace(/[^\d+]/g, '')}">${icon('phone')}Call</a>` : ''}
      </div>

      ${course.lat == null ? html`<div class="callout callout--warn" style="margin-bottom:14px">${icon('pin')}<div><strong>This course isn’t on the map yet.</strong><br>Find it on OpenStreetMap, or use your current location if you’re at the course.
        <div class="row-flex" style="flex-wrap:wrap"><button class="btn btn-secondary btn-sm" data-act="find-loc">${icon('search')} Find location</button><button class="btn btn-secondary btn-sm" data-act="here">${icon('locate')} I’m here</button></div></div></div>` : ''}

      ${st ? html`
        <dl class="kv-grid" style="margin:0 0 14px">
          <div><dt>Best</dt><dd>${st.best?.score ?? '–'}</dd></div>
          <div><dt>Average${st.holes === 9 ? ' (9)' : ''}</dt><dd>${fmt1(st.avg)}</dd></div>
          <div><dt>Rounds</dt><dd>${rounds.length}</dd></div>
          <div><dt>Avg to par (per 18)</dt><dd>${fmtToPar(st.avgToPar18, 1)}</dd></div>
          <div><dt>Last played</dt><dd>${fmtDate(st.last.date)}</dd></div>
          <div><dt>First played</dt><dd>${fmtDate(rounds[rounds.length - 1].date)}</dd></div>
        </dl>
        ${rounds.filter((r) => r.holes === st.holes).length >= 2 ? html`<div class="card chart-card" style="margin-bottom:14px">
          <div class="card-title">Your scores here</div>
          <div class="chart-legend"><span><i class="key-dot"></i>Round</span><span><i class="key-line"></i>3-round average</span></div>
          <div class="chart" data-el="trend"></div>
        </div>` : ''}
        <div class="section-title" style="margin-top:4px">History</div>
        <div class="list">${rounds.map((r) => roundRow(r, pbId))}</div>`
      : html`<div class="callout" style="margin-bottom:14px">${icon('flag')}<div><strong>No rounds here yet.</strong> Log a round and this course gets a score pin on your map.</div></div>`}

      <div class="section-title">Course info</div>
      <div class="card card-pad" style="display:grid;gap:8px;font-size:14.5px">
        ${course.address ? html`<div class="row-flex">${icon('pin', 'i-sm')}<span>${course.address}</span></div>` : ''}
        ${course.holes ? html`<div class="row-flex">${icon('flag', 'i-sm')}<span>${course.holes} holes${course.par ? ` · par ${course.par}` : ''}</span></div>` : course.par ? html`<div class="row-flex">${icon('flag', 'i-sm')}<span>Par ${course.par}</span></div>` : ''}
        ${course.access ? html`<div class="row-flex">${icon('key', 'i-sm')}<span>Access: ${course.access}</span></div>` : ''}
        ${course.phone ? html`<div class="row-flex">${icon('phone', 'i-sm')}<span>${course.phone}</span></div>` : ''}
        ${course.lat != null ? html`<div class="row-flex faint">${icon('locate', 'i-sm')}<span class="tnum">${course.lat.toFixed(5)}, ${course.lng.toFixed(5)}</span></div>` : ''}
        <div class="hint">${String(course.id).startsWith('osm:') ? 'Course data © OpenStreetMap contributors (ODbL).' : course.demo ? 'Sample course.' : 'Added by you.'}</div>
      </div>`);

    sheet.setFooter(stored ? html`
      <button class="btn btn-secondary btn-icon-only" data-act="more" aria-label="More actions">${icon('more')}</button>
      <button class="btn btn-secondary" data-act="edit">${icon('edit')} Edit</button>
      <button class="btn btn-primary" data-act="log">${icon('plus')} Log round</button>` : html`
      <button class="btn btn-primary" data-act="log">${icon('plus')} Log a round here</button>`);

    const trendEl = sheet.body.querySelector('[data-el="trend"]');
    if (trendEl) {
      const pts = [...rounds].filter((r) => r.holes === st.holes).reverse();
      trendChart(trendEl, {
        points: pts.map((r) => ({ id: r.id, date: r.date, value: r.score, title: fmtDate(r.date), sub: r.par ? `score · ${fmtToPar(r.score - r.par)}` : 'score' })),
        window: 3,
        height: 180,
        onSelect: (rid) => openRoundDetail(rid),
        ariaLabel: `Your scores at ${course.name}. The history list below has every round.`,
      });
    }
  }

  async function onClick(e) {
    const row = e.target.closest('[data-round]');
    if (row) { openRoundDetail(row.dataset.round); return; }
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    switch (btn.dataset.act) {
      case 'directions':
        actionSheet({ title: 'Directions', subtitle: course.name, actions: directionsLinks(course).map((l) => ({ label: l.label, href: l.url, icon: 'directions' })) });
        break;
      case 'log': openRoundForm({ course }); break;
      case 'map':
        await sheet.close();
        goTab('map');
        focusCourseOnMap(course.id);
        break;
      case 'find-loc': {
        setBusy(btn, true, 'Searching…');
        try {
          const hit = await geocodeCourse(course, lastKnownPosition());
          if (hit) {
            updateCourse(id, { lat: hit.lat, lng: hit.lng, city: course.city || hit.city, region: course.region || hit.region, address: course.address || hit.address });
            toast(`Found ${hit.name}${hit.city ? ` in ${hit.city}` : ''}`, { iconName: 'pin' });
          } else {
            toast('No match on the map. If you’re at the course, tap “I’m here”.', { tone: 'error' });
            setBusy(btn, false);
          }
        } catch (err) { toastError(err); setBusy(btn, false); }
        break;
      }
      case 'here': {
        setBusy(btn, true, 'Locating…');
        try {
          const pos = await getPosition({ highAccuracy: true });
          updateCourse(id, { lat: pos.lat, lng: pos.lng });
          toast('Course location set to where you are', { iconName: 'pin' });
        } catch (err) { toastError(err); setBusy(btn, false); }
        break;
      }
      case 'edit': editCourse(course); break;
      case 'more': {
        const n = roundsForCourse(id).length;
        const choice = await actionSheet({
          title: course.name,
          actions: [
            { value: 'merge', label: 'Merge with another course', sub: 'Combine duplicates into one', icon: 'merge' },
            { value: 'delete', label: 'Delete course', sub: n ? `Also deletes ${plural(n, 'round')}` : 'No rounds recorded', icon: 'trash', danger: true },
          ],
        });
        if (choice?.value === 'merge') mergeFlow(course);
        if (choice?.value === 'delete') {
          const ok = await confirmDialog({ title: 'Delete course?', message: n ? `This removes ${course.name} and its ${plural(n, 'round')}. This can’t be undone.` : `Remove ${course.name}?`, confirmText: 'Delete', danger: true });
          if (ok) {
            await sheet.close();
            deleteCourse(id);
            toast('Course deleted', { iconName: 'trash' });
          }
        }
        break;
      }
      default: break;
    }
  }
  sheet.body.addEventListener('click', onClick);
  sheet.foot.addEventListener('click', onClick);
  render();
  return sheet;
}

function editCourse(course) {
  const s = openSheet({
    title: 'Edit course',
    size: 'auto',
    body: html`<form class="form" novalidate>
      <div class="field"><label for="ec-name">Name</label><input class="input" id="ec-name" name="name" value="${course.name}" required maxlength="120"></div>
      <div class="field-row">
        <div class="field"><label for="ec-city">City</label><input class="input" id="ec-city" name="city" value="${course.city}"></div>
        <div class="field"><label for="ec-region">State / region</label><input class="input" id="ec-region" name="region" value="${course.region}"></div>
      </div>
      <div class="field-row">
        <div class="field"><label for="ec-par">Default par</label><input class="input" id="ec-par" name="par" type="number" inputmode="numeric" value="${course.par ?? ''}" placeholder="72"></div>
        <div class="field"><label for="ec-holes">Holes</label><input class="input" id="ec-holes" name="holes" type="number" inputmode="numeric" value="${course.holes ?? ''}" placeholder="18"></div>
      </div>
    </form>`,
    footer: html`<button class="btn btn-secondary" data-act="cancel">Cancel</button><button class="btn btn-primary" data-act="save">Save</button>`,
  });
  s.foot.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'cancel') s.close();
    if (act === 'save') {
      const f = new FormData(s.body.querySelector('form'));
      const name = String(f.get('name') || '').trim();
      if (!name) { s.body.querySelector('#ec-name').setAttribute('aria-invalid', 'true'); return; }
      updateCourse(course.id, { name, city: f.get('city'), region: f.get('region'), par: f.get('par'), holes: f.get('holes') });
      s.close();
      toast('Course updated');
    }
  });
}

async function mergeFlow(course) {
  const others = playedCourses()
    .filter((p) => p.course.id !== course.id)
    .map((p) => ({ p, s: similarity(course.name, p.course.name) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, 8);
  if (!others.length) { toast('There are no other courses to merge with.'); return; }
  const choice = await actionSheet({
    title: 'Merge into…',
    subtitle: `Rounds at ${course.name} move to the course you pick`,
    actions: others.map(({ p }) => ({ value: p.course.id, label: p.course.name, sub: plural(p.rounds.length, 'round'), icon: 'flag' })),
  });
  if (!choice) return;
  const target = getCourse(choice.value);
  const ok = await confirmDialog({ title: 'Merge courses?', message: `All rounds at “${course.name}” will move to “${target.name}”, and “${course.name}” will be removed.`, confirmText: 'Merge' });
  if (!ok) return;
  const moved = mergeCourses(course.id, target.id);
  toast(`Moved ${plural(moved, 'round')} to ${target.name}`, { iconName: 'merge' });
  openCourseDetail(target.id);
}

// Used by forms when a picked course (OSM / search result) must exist locally.
export const ensureCourse = (course) => getCourse(course.id) || upsertCourse(course);
