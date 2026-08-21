# Makefaster leaderboard server

A single zero-dependency Node process (`server.mjs`) that serves the marketing
site, the live leaderboard data, and the two write APIs. It is the smallest
thing that works: no framework, no database, no build step — one file store,
seeded from the committed JSON.

```bash
node server/server.mjs
# makefaster server listening on http://localhost:8787
```

Requires Node >= 18.17 (uses global `fetch` for the optional remote embedder).

## What it serves

| route | what |
|---|---|
| `GET /` + static files | the marketing site (repo root), unchanged |
| `GET /data/sites.json` | **live** site-leaderboard rows from the store |
| `GET /data/improvements.json` | **live** improvement categories from the store (the skill imports its top-50 checklist from here) |
| `POST /api/submit-site` | one measurement run for one site |
| `POST /api/submit-improvements` | anonymous improvements (embedding-matched into categories) |
| `GET /api/health` | `{ ok, embedder, threshold }` |

The static pages fetch `data/*.json` with relative paths, so behind this
server the tables render live data; behind a dumb file server
(`python3 -m http.server`) they render the committed seeds. Either way the
marketing pages work.

## The store

On first boot the committed `data/sites.json` and `data/improvements.json`
are copied into a writable data directory — default `server/.data/`
(gitignored), override with `MAKEFASTER_DATA_DIR`. From then on the store owns
those files: every accepted POST folds in and persists atomically
(temp file + rename), so a crash can never tear the JSON. Back up the live
boards by copying that directory.

## Write API contracts

### `POST /api/submit-site`

```json
{
  "url": "example.com",
  "mode": "cold",
  "lcpRaw": 1750, "lcpDelta": -27.1,
  "ttiRaw": 3050, "ttiDelta": -21.8,
  "name": "Example",
  "favicon": "https://example.com/favicon.ico"
}
```

- `url` (required) is normalized to a bare hostname; `mode` is `cold` or
  `warm`; raw values are milliseconds; deltas are percent vs. the pre-loop
  baseline, **negative = faster**. `name`/`favicon` are optional (a
  DuckDuckGo favicon URL and a capitalized domain label are derived
  otherwise).
- Upsert semantics per `(url, mode)`: metrics are replaced by the latest run,
  the `tests` counter increments, `measuredAt` is set server-side.
- Responses: `201` created / `200` updated with `{ ok, created, row }`;
  `400 { ok: false, errors: [...] }` on invalid payloads.

### `POST /api/submit-improvements`

```json
{
  "improvements": [
    { "name": "Inline critical CSS",
      "description": "Inlined above-the-fold styles into the document head",
      "deltaMs": -260, "deltaPct": -10.8 }
  ]
}
```

- **Anonymous by design**: no URL, no site identity. Any `url` field a client
  sends is discarded before storage. Each entry needs `name` plus at least
  one delta (negative = faster); 1–50 entries per submission.
- Every entry is embedded (name + description) and compared to every current
  category by cosine similarity:
  - **similarity ≥ threshold** → that category's `count` increments and the
    deltas fold into its running averages;
  - **below threshold (novel)** → a new category is created on the
    improvement leaderboard, seeded from the submission.
  Ranks are recomputed (biggest average improvement first) and persisted, so
  the HTML tables refresh on next load.
- Response: `{ ok, results: [{ input, action: "matched"|"created", category,
  similarity }], embedder, threshold }`.

Try it locally:

```bash
curl -s localhost:8787/api/submit-improvements \
  -H 'content-type: application/json' \
  -d '{"improvements":[{"name":"Inline critical CSS","description":"Inlined above-the-fold styles","deltaMs":-260,"deltaPct":-10.8}]}'
```

## Embeddings

Two backends behind one interface (see `lib/embedding.mjs`):

- **local (default)** — a deterministic feature-hashing embedder (stemmed
  words, word bigrams, character n-grams; 4096 dims, L2-normalized). No model
  download, no GPU, no network, no key. Match threshold **0.3**, pinned by
  the paraphrase/novel separation tests.
- **remote (optional)** — any OpenAI-compatible `/v1/embeddings` endpoint:

| env var | default | meaning |
|---|---|---|
| `MAKEFASTER_EMBEDDINGS_API_KEY` (or `OPENAI_API_KEY`) | — | enables the remote backend |
| `MAKEFASTER_EMBEDDINGS_MODEL` | `text-embedding-3-small` | embedding model |
| `MAKEFASTER_EMBEDDINGS_BASE_URL` | `https://api.openai.com/v1` | any OpenAI-compatible host |
| `MAKEFASTER_MATCH_THRESHOLD` | 0.3 local / 0.55 remote | cosine fold-vs-create cutoff |

Nothing is persisted in embedding space — each request embeds the incoming
improvements *and* the current categories with the same backend, so backends
can be switched freely. If the remote API fails mid-request the server falls
back to the local embedder for that whole request (logged).

## Configuration

| env var | default | meaning |
|---|---|---|
| `PORT` | `8787` | listen port |
| `HOST` | `0.0.0.0` | bind address |
| `MAKEFASTER_DATA_DIR` | `server/.data` | writable store directory |

Plus the embeddings vars above. Requests are rate-limited (60 POSTs/min/IP),
bodies capped at 256 KB, and all responses carry permissive CORS headers so
the static site can be hosted anywhere.

## Deploying

It is one file plus `lib/` — any box with Node 18+ works:

```bash
git clone https://github.com/jjcm/makefaster && cd makefaster
MAKEFASTER_DATA_DIR=/var/lib/makefaster PORT=8787 node server/server.mjs
```

Systemd unit (the usual shape):

```ini
[Unit]
Description=makefaster leaderboard server
After=network.target

[Service]
ExecStart=/usr/bin/node /opt/makefaster/server/server.mjs
Environment=PORT=8787
Environment=MAKEFASTER_DATA_DIR=/var/lib/makefaster
Restart=on-failure
DynamicUser=yes
StateDirectory=makefaster

[Install]
WantedBy=multi-user.target
```

Put a TLS-terminating proxy (Caddy/nginx/Cloudflare) in front and point the
domain at it. The `npx makefaster` CLI submits to `https://makefaster.dev` by
default; point it elsewhere with `--api` or `MAKEFASTER_API_BASE`.

Hosting the static pages separately (e.g. GitHub Pages) also works: deploy
only this server for the APIs and set the API origin on the pages before
`js/api.js` loads:

```html
<script>window.MAKEFASTER_API_BASE = "https://api.your-host.dev";</script>
```

(the pages only read `data/*.json`; for live tables serve those two paths from
this server too, or rewrite them at the proxy).
