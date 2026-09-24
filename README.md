# ParMap ⛳ Golf scores on a map

ParMap is a mobile-first Progressive Web App for golfers who track **overall round scores** (not hole-by-hole). Every course you play becomes a score pin on an interactive map. You can scan a paper scorecard with Google Gemini vision, find courses near you, and follow your scoring trend and an estimated handicap.

It is plain HTML, CSS and JavaScript (ES modules) with **no build step**, so you can push the folder to GitHub and it runs on GitHub Pages.

---

## Features

| | |
|---|---|
| **Interactive course & score map** (home screen) | Leaflet map with teardrop pins showing your best, average or last score, or rounds played, at each course. Pin colour compares a course with your own average (better / typical / tougher). Pins cluster when zoomed out. Tap a pin for a quick-view card with stats, a sparkline, directions and "Log round". Street or satellite view, dark mode, "Search this area". |
| **AI scorecard scan** | Live camera viewfinder (with torch where supported) or photo upload, up to 3 pages per card. Gemini reads players, OUT/IN/total, par, tees, rating/slope and date as structured JSON. ParMap checks the arithmetic, picks your row by name, matches the course to your history or OpenStreetMap, then shows an editable review before saving. The photo is stored with the round on the device. |
| **Round logger & importer** | Quick manual entry (course search, stepper, to-par readout, rating and slope remembered per course and tees). Import from CSV, a ParMap JSON backup, or pasted text and screenshots from other apps, parsed by Gemini. Duplicate detection, review before import, and automatic map lookup for new courses. |
| **Smart search & filters** | Search rounds by course, notes or tees, plus shortcuts: `<85`, `>=90`, `80-89`, `2025`, `june`, `9h`. Shared filters (date range presets or custom, score range, holes, course) apply to Map, Rounds and Stats together. |
| **Performance analytics** | Handicap index estimate (World Handicap System best-8-of-20 table), scoring average with recent-form delta, best rounds, average to par, trend chart with a 5-round moving average, score distribution, milestones (broke 100/90/80/70), records, and a per-course table. Every chart has a table view. |
| **AI insights** | Gemini writes a short, data-grounded analysis: headline, strengths, opportunities, goals and a tip for your next round. It is cached until your data changes. |
| **Nearby course finder** | Uses device geolocation to find golf courses from OpenStreetMap (Overpass API) within 10–50 mi / 80 km, with distance, played status and your best score. Directions deep-link to Google Maps, Apple Maps or Waze. |
| **PWA** | Installable (manifest with maskable icons and shortcuts), works offline via a service worker (app shell, Leaflet and recently viewed map tiles), and handles the Android back button for sheets. Data lives in IndexedDB, with a localStorage fallback. |

---

## Project structure

```
parmap/
├── index.html              App shell + SVG icon sprite
├── manifest.webmanifest    PWA manifest (icons, shortcuts, theme)
├── sw.js                   Service worker (offline + tile cache)
├── css/app.css             Design tokens (light/dark), layout, components
├── icons/                  App icons (SVG source + PNG sizes, maskable, favicon)
├── js/
│   ├── app.js              Bootstrap: theme, store, views, router, shortcuts
│   ├── router.js           Hash-based tabs (#/map, #/rounds, #/stats, #/courses)
│   ├── store.js            State, persistence, filters, smart search, import/export
│   ├── db.js               IndexedDB key-value store with localStorage fallback
│   ├── stats.js            Averages, handicap (WHS), trends, histograms
│   ├── ai.js               Gemini REST client: scorecard vision, history import, insights
│   ├── geo.js              Geolocation, Overpass (nearby), Photon (search), directions
│   ├── charts.js           Responsive SVG trend chart, histogram, sparkline
│   ├── ui.js               Sheets, dialogs, toasts, action sheets, overlay history
│   ├── pwa.js              Service worker registration, install prompt, updates
│   ├── demo.js             Optional sample data
│   ├── utils.js            Safe HTML templating, dates, CSV, images, geo math
│   └── views/              map, rounds, stats, courses, scan, round-form,
│                           round-detail, course-detail, course-picker,
│                           filters, settings, importer
├── .github/workflows/deploy.yml   GitHub Pages deployment
└── .nojekyll
```

---

## Run it locally

Browsers only allow ES modules, service workers, the camera and geolocation over `https://` or `http://localhost`, so serve the folder rather than opening `index.html` directly. Any static server works:

```bash
python -m http.server 8080
```

```bash
npx serve .
```

Then open <http://localhost:8080> (or the port shown). In VS Code, the Live Server extension also works.

Tip: on the empty map, tap **Try sample data** to explore the app with example rounds. Remove them later in **Settings → Your data**.

---

## Connect Google Gemini (AI Studio)

1. Create a free API key at **<https://aistudio.google.com/apikey>**.
2. In ParMap open **Settings** (gear icon), paste the key under *Google AI Studio API key* and tap **Save & test**. ParMap verifies the key and loads the models available to it.
3. Pick a model. The default, **`gemini-flash-latest`**, always points at Google's newest Flash model. If the chosen model isn't available to your key, ParMap automatically falls back through `gemini-3.8-flash`, `gemini-3.6-flash` and `gemini-3.5-flash`.
4. Optionally enter **your name as you write it on scorecards** (for example "Sam" or "SR") so the scanner picks your row.

**How the key is handled.** It is stored only in this browser's `localStorage` and sent only to `generativelanguage.googleapis.com` in the `x-goog-api-key` header. There is no backend. Anyone with access to your unlocked device and browser profile could read it, so:

- In Google Cloud Console, restrict the key to **HTTP referrers** (your Pages URL, e.g. `https://<you>.github.io/*`) and to the **Generative Language API**.
- Use a dedicated key for ParMap and remove it (Settings → Remove key) on shared devices.
- On Google's free tier, prompts and images may be used to improve Google's products (see the Gemini API terms). Don't scan anything you consider sensitive.

**How a scan works:** the photo is downscaled to 2048 px JPEG → sent to Gemini with a strict JSON schema (`responseJsonSchema`) → totals are cross-checked against OUT + IN and the hole-by-hole sum → your row is picked by name → the course is matched to your own courses (fuzzy match) or looked up on OpenStreetMap → you review and edit everything before saving.

---

## Deploy to GitHub Pages

### 1. Create the repository and push

```bash
cd parmap
```

```bash
git init
```

```bash
git add .
```

```bash
git commit -m "Initial commit: ParMap PWA"
```

```bash
git branch -M main
```

```bash
git remote add origin https://github.com/<your-username>/parmap.git
```

```bash
git push -u origin main
```

(Create the empty `parmap` repository on GitHub first, or use `gh repo create parmap --public --source=. --push` with the GitHub CLI.)

### 2. Turn on Pages

**Option A: GitHub Actions (recommended).** In the repository go to **Settings → Pages → Build and deployment → Source: GitHub Actions**. The included workflow (`.github/workflows/deploy.yml`) deploys on every push to `main`; watch it under the **Actions** tab.

**Option B: Deploy from a branch.** **Settings → Pages → Source: Deploy from a branch → `main` / `(root)`**. No workflow needed (you can delete `.github/workflows`).

Your app will be live at `https://<your-username>.github.io/parmap/`. All paths are relative, so it works from a sub-path or a custom domain. GitHub Pages serves HTTPS, which the camera, geolocation and service worker require.

### 3. Install it on your phone

- **Android (Chrome):** open the site → menu → **Install app** (or use the prompt in Settings).
- **iPhone/iPad (Safari):** Share → **Add to Home Screen**.

Long-press the icon for shortcuts: *Scan a scorecard*, *Log a round*, *Courses near me*.

### Updating

The service worker is **network-first** for the app's own files, so after you push, users get the new version the next time they open the app online. When you add or rename files, add them to the `SHELL` list in `sw.js` and bump `VERSION` so the offline copy stays complete.

---

## Data & privacy

- Rounds and courses are stored **only on the device** (IndexedDB; falls back to localStorage in restricted browsers). Scorecard photos are stored in IndexedDB.
- **Back up** from Settings → *Export backup* (JSON, restorable via Import) or *Export spreadsheet* (CSV). Photos are not included in backups.
- ParMap asks the browser for persistent storage after your first round, so data isn't evicted under storage pressure.
- Network requests go only to: Google Gemini (AI features, your key), OpenStreetMap tiles, Esri imagery (satellite view), Overpass API (nearby courses), Photon (course search) and unpkg (Leaflet). No analytics or tracking.

## About the handicap estimate

The estimate follows the World Handicap System table: the average of the lowest differentials among your most recent 18-hole rounds (best 8 of 20, with the WHS adjustments for fewer rounds). Differential = (113 ÷ slope) × (score − course rating). Because ParMap tracks overall scores, it uses the **gross** score instead of the adjusted gross score (no net double bogey per hole), and when rating or slope is missing it falls back to par and 113 (flagged "est."). It is a guide, not an official index.

## Third-party services and usage policies

| Service | Used for | Notes |
|---|---|---|
| [OpenStreetMap tiles](https://operations.osmfoundation.org/policies/tiles/) | Street map | Free, no key; fine for personal use. For an app with many users, switch `STREET_TILES` in `js/views/map.js` to a keyed provider (e.g. MapTiler, Stadia, Thunderforest). Tiles are cached for 7 days. |
| Esri World Imagery | Satellite view | Attribution shown on the map. |
| [Overpass API](https://wiki.openstreetmap.org/wiki/Overpass_API) | Nearby golf courses | Public instances with fallbacks; results cached per area for 24 h. |
| [Photon](https://photon.komoot.io) | Course & place search | Fair-use public geocoder by komoot. |
| [Leaflet 1.9.4](https://leafletjs.com) | Map library | Loaded from unpkg with Subresource Integrity; cached by the service worker. |
| Google Gemini API | Scorecard OCR, AI import, insights | Your own key, called directly from the browser. |

Course data © OpenStreetMap contributors (ODbL).

## Customize

- **Name, colours, icons:** `manifest.webmanifest`, `<title>` and meta tags in `index.html`, and the tokens at the top of `css/app.css` (`--primary`, surfaces, and so on). Icon sources are `icons/icon.svg` and `icons/maskable.svg`.
- **Default AI model:** `DEFAULT_MODEL` in `js/store.js`; fallbacks in `js/ai.js`.
- **Map tiles:** `STREET_TILES` and `setBaseLayer()` in `js/views/map.js`.
- **Scan prompt / JSON schema:** `SCORECARD_SYSTEM` and `SCORECARD_SCHEMA` in `js/ai.js`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Blank map on first launch while offline | The map needs one online visit to cache Leaflet and tiles. |
| "Location access is turned off" | Allow location for the site in browser settings, or browse the map and tap **Search this area**. |
| Camera doesn't start | Allow camera access, and make sure you're on HTTPS or localhost. Otherwise use **Choose photo** (the native camera picker opens on phones). |
| "That API key isn't valid" / "restricted to other websites" | Re-copy the key from AI Studio, or add your Pages URL to the key's HTTP referrer restrictions. |
| "Model isn't available for this key" | Pick another model in Settings (the list comes from your key). |
| "Rate limit or quota reached" | Free-tier limits reset quickly; wait a minute, or enable billing in AI Studio. |
| "Course finder is busy" | The public Overpass servers are rate-limited; try again shortly. |

## Browser support

Current Chrome, Edge, Safari (iOS 16.4+) and Firefox. The camera torch toggle appears only where the browser exposes it (mainly Chrome on Android).

## License

Add a license of your choice (for example MIT) before publishing. Third-party data and services keep their own licenses (OpenStreetMap: ODbL; Leaflet: BSD-2-Clause).
