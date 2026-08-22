# Makefaster

**Makefaster** is an AI skill that runs an autoresearch loop to continuously
discover, test, and implement website performance improvements — plus the
marketing site and public leaderboards it reports to.

The site is vanilla HTML/CSS/JS — a single-page app built from Web Components,
no frameworks and no build step. The server is Go + MariaDB. The
`npx makefaster` CLI is zero-dependency Node.

```text
run.sh              start the server: cd backend && go run ./cmd/server
backend/            the Go server — APIs, migrations, static SPA hosting
frontend/           the SPA: index.html, css/, js/ (one component per file)
data/               the seed leaderboards, loaded into MariaDB on first boot
packages/cli/       the npx makefaster CLI
packages/skill/     the loop skill the CLI hands to your agent
```

## `npx makefaster`

Run it inside a site repo:

```bash
npx makefaster            # or: npx github:jjcm/makefaster
```

What happens:

1. **Detects the agent CLIs you already have** — Cursor Agent
   (`cursor-agent`/`agent`), Claude Code (`claude`), Codex (`codex`) — via
   PATH, well-known install locations (`~/.local/bin`, `~/.claude/local`,
   `~/.cursor/bin`, Homebrew…), and explicit env overrides
   (`CURSOR_AGENT_EXECUTABLE`, `CLAUDE_CODE_EXECUTABLE` /
   `BB_CLAUDE_CODE_EXECUTABLE`, `CODEX_EXECUTABLE`). makefaster never bundles
   or downloads a model; it drives your existing install. If none are found
   it prints the real installers and exits.
2. **Asks you to pick** among the CLIs actually found — before anything runs.
3. **Imports the top-50 improvement categories** from the live leaderboard
   (falling back to this repo's `data/improvements.json`) as a checklist of
   likely wins — a guide, not a script.
4. **Hands your repo to the agent** with the loop skill
   ([`packages/skill/SKILL.md`](packages/skill/SKILL.md)): profile a
   user-felt metric (Lighthouse if available; cold + warm; median of ≥3 runs),
   then one hypothesis per iteration — measure, keep if it beats the noise
   floor, revert otherwise.
5. **Stops after 5 consecutive misses** (no serious improvement: ≥5% or
   ≥20 ms on the north-star metric, and FCP-only wins that regress LCP don't
   count), then shows the end screen with three questions:
   - **Loop more?** — resets the miss counter and continues.
   - **Submit stats to the Site leaderboard?** — your URL and favicon are
     displayed publicly with the measured LCP/TTI improvements.
   - **Submit anonymous improvements data?** — no URL; category names,
     descriptions, and deltas only. Novel improvements become new categories
     on the improvement leaderboard.

```text
Usage: npx makefaster [dir] [options]
  --cli <cursor|claude|codex>   Skip the picker
  --url <example.com>           Site URL for the leaderboard submission
  --api <base>                  Leaderboard API base (default https://makefaster.dev)
  --improvements <path|url>     Override the checklist source
  --max-misses <n>              Stop after n straight misses (default 5)
```

Session state lives in `.makefaster/` in the target repo (auto-excluded from
git via `.git/info/exclude`).

## Skills

| file | what |
|---|---|
| [`packages/skill/SKILL.md`](packages/skill/SKILL.md) | the **operational loop** the CLI hands to your agent: profiling rules, one-hypothesis iterations, the keep/revert bar, the 5-miss stop rule, and the `results.json` contract |
| [`skill/SKILL.md`](skill/SKILL.md) | the **canonical technique catalog** — the updated [jjcm/speedupskill](https://github.com/jjcm/speedupskill) `SKILL.md` (measured wins, traps, keep/ditch discipline). Canonical here because a PR to that repo could not be opened from this environment; see [`skill/README.md`](skill/README.md) |

## Run locally

You need Go 1.22+ and a MariaDB on `127.0.0.1:3306`. If you have Docker, the
compose file is the whole setup:

```bash
cp env.example .env       # every value is already the default
docker compose up -d      # MariaDB, plus the throwaway test schema
./run.sh                  # http://localhost:8787
```

`run.sh` is `cd backend && exec go run ./cmd/server`. On start the server
applies the goose migrations, seeds the leaderboards from `data/` if the tables
are empty, and serves the SPA plus both APIs from the one process. Restarting
after a schema change is the whole deploy story — there is no separate migrate
step.

Without Docker, point `MARIADB_DSN` at any MariaDB or MySQL and create the
schema first:

```bash
mariadb -e 'CREATE DATABASE makefaster CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci'
```

### Configuration

Every variable has a working default, so an empty `.env` boots. See
[`env.example`](env.example) for the annotated list.

| env var | default | meaning |
|---|---|---|
| `PORT` | `8787` | listen port |
| `HOST` | `0.0.0.0` | bind address |
| `MARIADB_DSN` | `root:root@tcp(127.0.0.1:3306)/makefaster?parseTime=true` | database; `parseTime=true` is required |
| `MIGRATIONS_DIR` | `./internal/db/migrations` | goose migrations, applied on start |
| `SEED_DIR` | `../data` | seed JSON, read only into empty tables |
| `FRONTEND_DIR` | `../frontend` | SPA static root |
| `MAKEFASTER_EMBEDDINGS_API_KEY` / `OPENAI_API_KEY` | — | switches the embedder from local to a remote OpenAI-compatible endpoint |
| `MAKEFASTER_EMBEDDINGS_MODEL` | `text-embedding-3-small` | remote embedding model |
| `MAKEFASTER_EMBEDDINGS_BASE_URL` | `https://api.openai.com/v1` | any OpenAI-compatible host |
| `MAKEFASTER_MATCH_THRESHOLD` | 0.3 local / 0.55 remote | cosine fold-vs-create cutoff |

## The SPA

One shell, three History API routes, no build step: plain ES modules and
`customElements.define()`, one component per file in `frontend/js/`.

| Route | Component |
|------|------|
| `/` | `<landing-page>` |
| `/site-leaderboard` | `<site-leaderboard-page>` |
| `/improvement-leaderboard` | `<improvement-leaderboard-page>` |

`<site-header>`, `<geo-row>` and `<spec-footer>` are the pieces all three pages
share. Every component renders into **light DOM**, not a shadow root, so the
single `css/style.css` keeps styling its markup — which is why the host
elements are declared `display: block`. The old `*.html` URLs 301 to their
route, and unknown app paths are served the shell so a hard refresh works.

## Data APIs

Served by the Go process, reading the live MariaDB tables rather than the
committed seed files:

| Endpoint | What | Wrapper |
|----------|------|---------|
| `GET /data/sites.json` | live site rows (seed: 1,248 sites × cold/warm) | `MakefasterAPI.getSites()` |
| `GET /data/improvements.json` | live ranked categories (seed: top 50) | `MakefasterAPI.getImprovements()` |
| `GET /api/health` | `{ ok, embedder, threshold }` | — |
| `POST /api/submit-site` | `{ url, favicon?, name?, lcpRaw, lcpDelta, ttiRaw, ttiDelta, mode: cold\|warm }` — upserts the site's row; URL + favicon shown publicly | `MakefasterAPI.submitSite(payload)` |
| `POST /api/submit-improvements` | `{ improvements: [{ name, description?, deltaMs?, deltaPct? }] }` — anonymous; embedding-matched into categories (cosine similarity folds into the closest category or creates a new one) | `MakefasterAPI.submitImprovements(payload)` |

Deltas are percentages vs. baseline, negative = faster. `POST /api/submit-site`
answers `201` when it created the row and `200` when it folded a new run into an
existing one, both as `{ ok, created, row }`; invalid payloads come back as
`400 { ok: false, errors: [...] }`. Writes are serialized, POSTs are rate
limited to 60/minute/IP, bodies are capped at 256 KB, and every response
carries permissive CORS so the SPA can be hosted anywhere.

### Embeddings

`POST /api/submit-improvements` embeds each entry (name doubled, then the
description) and compares it to every current category by cosine similarity: at
or above the threshold it folds into that category's running averages, below it
becomes a new category. Entries in one payload are processed in order against
the growing list, so two similar novel entries create one category.

Two backends, picked by whether an API key is set:

- **local (default)** — a deterministic feature-hashing embedder: stemmed word
  unigrams and bigrams plus character 3/4-grams, signed and hashed into 4096
  L2-normalized dimensions. No model download, no GPU, no network, no key.
  Threshold **0.3**, pinned by the paraphrase/novel separation test.
- **remote (optional)** — any OpenAI-compatible `/v1/embeddings` endpoint.
  Threshold **0.55**. A failure falls the whole request back to local, so every
  comparison stays inside one embedding space.

Nothing is persisted in embedding space: the categories are re-embedded on each
request, so the backend can be switched at any time.

Row shapes:

```js
// data/sites.json — one row per site per load mode
{ "name": "Google", "url": "google.com", "favicon": "https://…",
  "lcpRaw": 1842, "lcpDelta": -34, "ttiRaw": 2945, "ttiDelta": -29,
  "mode": "cold", "tests": 6, "measuredAt": "2024-05-12T14:15:00.000Z" }

// data/improvements.json — one row per improvement category
{ "rank": 1, "name": "Gzip / Brotli Compression",
  "description": "Enable or improve text compression",
  "count": 286, "avgImprovementMs": -497, "avgImprovementPct": -28.6,
  "icon": "gzip" }
```

`measuredAt` is always ISO-8601 with milliseconds, in UTC.

Regenerate the seed datasets (deterministic, seeded):

```bash
node scripts/generate-data.mjs
```

These files only matter on a fresh database — once the tables hold rows the
server never reads them again. Back up the live boards with `mysqldump`.

## Deploying

One Go binary plus the `frontend/` directory and a MariaDB:

```bash
cd backend && go build -o /usr/local/bin/makefaster-server ./cmd/server
```

Migrations run on start, so a deploy is build, replace, restart. The process
needs `MARIADB_DSN`, `FRONTEND_DIR`, and `MIGRATIONS_DIR` pointing at the
shipped copies of `frontend/` and `backend/internal/db/migrations/`. Put a
TLS-terminating proxy (Caddy/nginx/Cloudflare) in front and point the domain at
it — the `npx makefaster` CLI submits to `https://makefaster.dev` by default,
and elsewhere with `--api` or `MAKEFASTER_API_BASE`.

Hosting the SPA separately (a static CDN plus a deployed API) also works: set
the API origin before the app module loads, and route `/data/*.json` to the
server too so the boards stay live.

```html
<script>window.MAKEFASTER_API_BASE = "https://api.your-host.dev";</script>
```

## Tests

```bash
npm test                                    # CLI detection, args, payload builders
cd backend && go test ./...                 # server, embedder, categorization
```

The MariaDB-backed server tests skip unless a throwaway schema is named, so
`go test ./...` passes on a machine with no database. To run them:

```bash
cd backend
MAKEFASTER_TEST_MARIADB_DSN='root:root@tcp(127.0.0.1:3306)/makefaster_test?parseTime=true' \
  go test ./...
```

They drop the tables and re-migrate, so the schema is created from scratch every
run. Coverage: the seeded 50-category board after a fresh migrate, `201` then
`200` on a repeated submission, the board surviving a process restart, the health
payload, static/SPA fallback and legacy redirects, CORS, and the body cap. The
embedding tests pin the local match threshold and the exact similarity scores
the Node implementation produced, so the fold-vs-create boundary cannot drift.

## Easter egg: concrete backgrounds

Press **C** anywhere (outside of a text input) to cycle through five seamless
concrete background tiles (`frontend/assets/textures/concrete-0*.webp`): pale poured,
board-formed, fine grit, polished cement, and weathered slab. The selected
tile persists in `localStorage`.

## Assets

Generated via the DiffUI build API and stored locally (no remote hotlinks):

- `frontend/assets/logo.svg` — image-to-SVG of the brand-splash mark (bolt in a circular arrow)
- `frontend/assets/icons/*.svg` — text-to-SVG pictograms (research, experiment, repeat, tree, bolt, gzip)
- `frontend/assets/textures/concrete-0[1-5].webp` — five seamless 1024×1024 concrete tiles

Simple glyphs (crosshairs, plus marks, arrows, chevrons, standard UI icons) are
hand-authored inline SVG.
