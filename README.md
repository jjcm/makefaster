# Makefaster

**Makefaster** is an AI skill that runs an autoresearch loop to continuously
discover, test, and implement website performance improvements — plus the
marketing site and public leaderboards it reports to.

The site is vanilla HTML/CSS/JS. No frameworks, no build step. The CLI and
server are zero-dependency Node.

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

Marketing pages only (reads the committed seed JSON):

```bash
python3 -m http.server 8000
# or: npx serve .
```

Full stack — pages + live leaderboards + submit APIs:

```bash
node server/server.mjs        # http://localhost:8787
```

Then open <http://localhost:8000> (or `:8787`).

## Pages

| Page | File |
|------|------|
| Landing | `index.html` |
| Site leaderboard | `site-leaderboard.html` |
| Improvement leaderboard | `improvement-leaderboard.html` |

## Data APIs

Real endpoints served by [`server/server.mjs`](server/README.md) — a
zero-dependency Node process with a JSON-file store seeded from `data/`:

| Endpoint | What | Wrapper |
|----------|------|---------|
| `GET /data/sites.json` | live site rows (seed: 1,248 sites × cold/warm) | `MakefasterAPI.getSites()` |
| `GET /data/improvements.json` | live ranked categories (seed: top 50) | `MakefasterAPI.getImprovements()` |
| `POST /api/submit-site` | `{ url, favicon?, name?, lcpRaw, lcpDelta, ttiRaw, ttiDelta, mode: cold\|warm }` — upserts the site's row; URL + favicon shown publicly | `MakefasterAPI.submitSite(payload)` |
| `POST /api/submit-improvements` | `{ improvements: [{ name, description?, deltaMs?, deltaPct? }] }` — anonymous; embedding-matched into categories (cosine similarity folds into the closest category or creates a new one) | `MakefasterAPI.submitImprovements(payload)` |

Deltas are percentages vs. baseline, negative = faster. Full contracts,
embedding configuration (local hashing by default, optional OpenAI-compatible
API via env key — no GPU either way), and deploy notes:
[`server/README.md`](server/README.md).

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

Regenerate the seed datasets (deterministic, seeded):

```bash
node scripts/generate-data.mjs
```

## Tests

```bash
npm test    # node --test — CLI detection/args/payloads + server API/embedding/store
```

## Easter egg: concrete backgrounds

Press **C** anywhere (outside of a text input) to cycle through five seamless
concrete background tiles (`assets/textures/concrete-0*.webp`): pale poured,
board-formed, fine grit, polished cement, and weathered slab. The selected
tile persists in `localStorage`.

## Assets

Generated via the DiffUI build API and stored locally (no remote hotlinks):

- `assets/logo.svg` — image-to-SVG of the brand-splash mark (bolt in a circular arrow)
- `assets/icons/*.svg` — text-to-SVG pictograms (research, experiment, repeat, tree, bolt, gzip)
- `assets/textures/concrete-0[1-5].webp` — five seamless 1024×1024 concrete tiles

Simple glyphs (crosshairs, plus marks, arrows, chevrons, standard UI icons) are
hand-authored inline SVG.
