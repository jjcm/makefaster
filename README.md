# Makefaster

Marketing site for **Makefaster** — an AI skill that runs an autoresearch loop to
continuously discover, test, and implement website performance improvements.

Vanilla HTML/CSS/JS. No frameworks, no build step.

## Run locally

The pages fetch local JSON, so serve the folder over HTTP (opening `index.html`
directly via `file://` will not load data):

```bash
python3 -m http.server 8000
# or: npx serve .
```

Then open <http://localhost:8000>.

## Pages

| Page | File |
|------|------|
| Landing | `index.html` |
| Site leaderboard | `site-leaderboard.html` |
| Improvement leaderboard | `improvement-leaderboard.html` |

## Easter egg: concrete backgrounds

Press **C** anywhere (outside of a text input) to cycle through five seamless
concrete background tiles (`assets/textures/concrete-0*.webp`): pale poured,
board-formed, fine grit, polished cement, and weathered slab. The selected
tile persists in `localStorage`.

## Data APIs (stubs for the upcoming skill)

The `npx makefaster` skill will read and write these. For now the reads are
static JSON and the writes are client-side stubs that queue submissions in
`localStorage` — see `js/api.js` for full payload documentation.

| Endpoint | Now | Wrapper |
|----------|-----|---------|
| `GET data/sites.json` | static JSON (1,248 sites × cold/warm rows) | `MakefasterAPI.getSites()` |
| `GET data/improvements.json` | static JSON (top 50 categories) | `MakefasterAPI.getImprovements()` |
| `POST /api/submit-site` | localStorage stub | `MakefasterAPI.submitSite(payload)` |
| `POST /api/submit-improvements` | localStorage stub | `MakefasterAPI.submitImprovements(payload)` |

Row shapes:

```js
// data/sites.json — one row per site per load mode
{ "name": "Google", "url": "google.com", "favicon": "https://…", 
  "lcpRaw": 1842, "lcpDelta": -34, "ttiRaw": 2945, "ttiDelta": -29,
  "mode": "cold", "tests": 6, "measuredAt": "2024-05-12T14:15:00Z" }

// data/improvements.json — one row per improvement category
{ "rank": 1, "name": "Gzip / Brotli Compression",
  "description": "Enable or improve text compression",
  "count": 286, "avgImprovementMs": -497, "avgImprovementPct": -28.6,
  "icon": "gzip" }
```

Regenerate the stub datasets (deterministic, seeded):

```bash
node scripts/generate-data.mjs
```

## Assets

Generated via the DiffUI build API and stored locally (no remote hotlinks):

- `assets/logo.svg` — image-to-SVG of the brand-splash mark (bolt in a circular arrow)
- `assets/icons/*.svg` — text-to-SVG pictograms (research, experiment, repeat, tree, bolt, gzip)
- `assets/textures/concrete-0[1-5].webp` — five seamless 1024×1024 concrete tiles

Simple glyphs (crosshairs, plus marks, arrows, chevrons, standard UI icons) are
hand-authored inline SVG.
