---
name: makefaster
description: Autoresearch loop that makes the site in this repo measurably faster. Profile a user-felt metric, change one hypothesis per iteration, keep or revert with numbers, stop after too many straight misses, and report results for the public leaderboards. Driven by `npx makefaster`.
---

# The makefaster loop

You are running inside a makefaster session: the `makefaster` CLI detected the
agent CLI you are, asked the user to pick you, and handed you this repo. Your
job is to make the site in the current directory measurably faster for real
users, one disciplined experiment at a time. The discipline is the same as
jjcm/speedupskill: **measure a user-felt metric first, change one hypothesis
per iteration, keep or revert with numbers.**

## The session contract (files in `.makefaster/`)

The CLI owns this directory. Never commit it (it is already in
`.git/info/exclude`).

| file | who writes it | what it is |
|---|---|---|
| `SKILL.md` | CLI | this file |
| `improvements.json` | CLI | the imported improvement categories — your checklist |
| `state.json` | CLI creates, **you update `missStreak`** | loop limits and counters |
| `results.json` | **you**, after every iteration | the session record the CLI reads back |

`improvements.json` is a **guide of likely wins — it is not a script to apply
blindly.** Probe whether a category applies to this site before spending an
iteration on it, skip what does not apply, and trust your own profiling
evidence over the checklist when they disagree. Its `source` field says where it
came from. Live leaderboard rows are ranked by what actually worked across other
sites and carry `count` and average deltas. The catalog bundled with the CLI —
which is what you get while the public board is still filling up — is ordered by
rough expected impact and carries no measurements at all.

## Step 0 — get the site running

Work out how this site is served (README, `package.json` scripts, Makefile,
Procfile, docker-compose…). Get it running locally and identify the entry
page real users hit first. If the repo has a production build step, measure
the production build, not the dev server — dev servers lie about performance.

## Step 1 — baseline profile

Use the heaviest-hitting **real, user-felt** metric you can actually measure
on this machine, preferring:

1. **Lighthouse** if available or installable
   (`npx lighthouse <url> --output=json --quiet --chrome-flags="--headless=new"`)
   — gives FCP / LCP / TBT / TTI / Speed Index in one run.
2. Headless Chromium via **Playwright/Puppeteer** if the repo already has one
   — read `PerformanceNavigationTiming`, `largest-contentful-paint` entries,
   and long tasks yourself.
3. Last resort: **curl-level timings** (TTFB, full transfer time, total bytes
   of the entry page + critical assets). Weak, but honest — record that this
   is what you measured.

Rules:

- Measure **cold** (empty cache) and **warm** (second visit, cache primed)
  whenever the tooling allows it.
- **At least 3 runs per condition; use the median.** Record the spread — that
  spread is your **noise floor** and the keep/revert rule below depends on it.
- Pick a **north star**: LCP by default, or the closest proxy your tooling
  produces. TTI is the secondary metric. If your tool cannot produce a TTI,
  use a TBT-derived proxy or reuse the LCP value, and say so in
  `results.json.profilingTool`.
- Write the baseline into `results.json` **before touching any code**.

## Step 2 — the loop

One hypothesis per iteration, no exceptions:

1. **Pick the most promising hypothesis.** Sources, in order: your own
   profiling evidence (what is actually on the critical path?), then the
   checklist categories that plausibly apply. Payload and critical-path work
   usually beats micro-optimizations — see the impact ordering in the
   speedup skill.
2. **Implement the smallest change that tests the hypothesis.** Make it
   cleanly revertable: commit it on the working branch (or `git stash`-able
   state). If the repo is not git, snapshot the files you touch first.
3. **Re-measure exactly like the baseline.** Same URL, same run count, same
   conditions, median again. Never compare a 1-run number to a 3-run median.
4. **Keep or revert, by the numbers:**
   - A **serious improvement** means the north star improved beyond your
     measured noise floor, AND by at least **5% or 20 ms** (whichever is
     larger for the metric's scale). An FCP-only win that **regresses LCP
     does not count** — that is rearranging deck chairs.
   - Kept → record the iteration with `kept: true` and set
     `missStreak` to `0` in `state.json`.
   - Anything else → **revert completely** (revert means revert — no
     half-kept experiments), record `kept: false`, and increment
     `missStreak`.
5. **Update `results.json` and `state.json` after every iteration.** Keep
   `results.json` valid JSON at all times — the CLI parses it the moment you
   exit, even if you were interrupted.

## Naming an improvement — generic techniques only

**Hard rule: every `iterations[].category` (and the `name` you submit with it)
is the name of a GENERIC TECHNIQUE that could apply to any site.** The
improvement leaderboard is a shared catalog of techniques, not a changelog of
your repo. A name that only makes sense to someone who has read your source
tree is a bad name.

A category name must never contain:

- **product or component proper nouns** — `Mermaid`, `Firebase`, `Amplitude`,
  `ChatControls`, `AppInitPage`;
- **file or module names** — `rocket.gif`, `highlight.js/lib/common`,
  `moment-timezone`, `basic_examples`;
- **byte sizes, versions, or counts** — `262KB`, `4 weights`, `v3.2`;
- **CSS class names, route paths, or API paths**;
- **process footnotes** — `(re-test after landscape change)`,
  `(same as iteration 4)`, `(second attempt)`.

Put every one of those in the **description** instead. The description is
where the site-specific detail belongs; the **name must be reusable by the
next site.**

| bad (site-specific) | good (generic technique) |
|---|---|
| `Inline the Shared Stylesheet (re-test After Landscape Change)` | `Inline shared stylesheets` |
| `Lazy-load Chat Side-pane Components` | `Lazy-load components` |
| `Lazy-load Hidden 262KB Changelog Rocket.gif` | `Lazy-load unseen images` |
| `Gzip-precompressed static assets` | `Precompress static assets` |
| `Enable Gzip Text Compression on the Production Server` | `Enable gzip` |
| `Import highlight.js/lib/common` | `Subset syntax-highlighter bundle` (or fold into `Reduce unused JS`) |
| `Playfair Display 4 Weights → 1` | `Reduce font payload` |
| `Remove Duplicate 1MB Basic_examples Fetch` | `Skip redundant fetches` |

Do **not** invent a category per component type. `Lazy-load Chat Side-pane
Components`, `Lazy-load the Settings Modal`, and `Lazy-load the JSON Editor`
are all one technique: **`Lazy-load components`**. The same goes for images,
third-party SDKs, analytics, and data fetches — one bucket each, not one row
per widget.

When writing `results.json`:

1. **Prefer an existing checklist category name** from
   `.makefaster/improvements.json` whenever one fits. Reuse is the point: it is
   what makes `count` on the public board mean anything.
2. **Only invent a new category when the technique is genuinely novel** — and
   even then the name must still be generic. If you cannot phrase it so another
   site could use it verbatim, it is not a category, it is a description.
3. Leave `category` as `null` if nothing fits and you cannot phrase a generic
   name; the server will fold the submission by similarity rather than let a
   one-off name onto the board.

The server enforces this on ingest too — it strips parentheticals, file names,
byte sizes, and identifiers out of submitted names, and folds the `lazy-load X`
family into a small fixed set of buckets — so a site-specific name does not
create a site-specific row. Write the generic name yourself anyway; the
normalizer is a backstop, not a naming service.

## Step 3 — the stop rule

When `missStreak` reaches `maxMisses` (default **5**) consecutive attempts
with no serious improvement:

1. Run one final full measurement pass (cold + warm) and write it to
   `results.final`.
2. Set `stoppedReason: "miss-streak"`, make sure every iteration is recorded,
   and **exit your session**. The CLI takes over: it shows the user the end
   screen and asks whether to loop more (it will reset the counter and
   re-invoke you), submit site stats to the public site leaderboard, and/or
   submit anonymous improvements data.

Also stop (with `stoppedReason: "user"`) whenever the user asks you to.

## Discipline (distilled from jjcm/speedupskill)

- Measure first. A change you cannot measure is a change you revert.
- One change per iteration — entangled changes teach nothing.
- Numbers decide, not vibes. "It should be faster" is not a keep.
- Do not merge lab harnesses, profiling scripts, or rejected experiments into
  the site. Keep them in `.makefaster/` or delete them.
- Reject known traps: preloading grid thumbnails, `fetchpriority` washes,
  caching error responses, `srcset` rungs bigger than the CSS slot, and the
  rest of the "what not to do" table in the speedup skill.
- Copy the *shape* of known wins, not the file names. The full measured
  technique catalog lives at `skill/SKILL.md` in
  [jjcm/makefaster](https://github.com/jjcm/makefaster) (canonical copy,
  mirrored from [jjcm/speedupskill](https://github.com/jjcm/speedupskill)).
  Read it when picking hypotheses for load-time work.

## `results.json` schema

Keep this file valid and current after every iteration. All times are
milliseconds. Deltas are negative when the site got faster.

```json
{
  "version": 1,
  "site": {
    "url": "example.com",
    "name": "Example",
    "favicon": "https://example.com/favicon.ico"
  },
  "northStar": "lcp",
  "profilingTool": "lighthouse 12.x, median of 3 runs, headless Chrome",
  "noiseFloor": { "lcpMs": 40, "ttiMs": 60 },
  "baseline": {
    "cold": { "lcpMs": 2400, "ttiMs": 3900, "fcpMs": 1400, "tbtMs": 310, "cls": 0.08, "score": 72 },
    "warm": { "lcpMs": 1100, "ttiMs": 1700, "fcpMs": 600, "tbtMs": 120 }
  },
  "final": {
    "cold": { "lcpMs": 1750, "ttiMs": 3050, "fcpMs": 1150, "tbtMs": 190, "cls": 0.03, "score": 91 },
    "warm": { "lcpMs": 780, "ttiMs": 1240, "fcpMs": 420, "tbtMs": 70 }
  },
  "iterations": [
    {
      "n": 1,
      "name": "Inline critical CSS",
      "description": "Inlined above-the-fold styles into the document head",
      "category": "Inline Critical CSS",
      "deltaMs": -260,
      "deltaPct": -10.8,
      "kept": true
    },
    {
      "n": 2,
      "name": "Preload first 8 thumbnails",
      "description": "Preload hints for the first grid images",
      "category": "Resource Preloading",
      "deltaMs": 150,
      "deltaPct": 6.2,
      "kept": false
    }
  ],
  "missStreak": 5,
  "stoppedReason": "miss-streak"
}
```

Field notes:

- `site.url` — bare domain of the deployed site if the user told you or the
  repo makes it obvious; otherwise leave the `site` object out and the CLI
  will ask the user before submitting.
- `site.favicon` — a favicon URL if the site has one (`<link rel="icon">` or
  `/favicon.ico`); it is shown next to the URL on the site leaderboard.
- `baseline` / `final` — medians per mode. Include the modes you measured;
  `lcpMs` and `ttiMs` are required per included mode (they feed the site
  leaderboard), `fcpMs` / `tbtMs` / `cls` / `score` (0-100 performance score)
  are welcome extras — the CLI's live dashboard shows a row per metric you
  supply and omits the rest. `final` for a mode is the last full measurement
  pass, re-run after the last kept change.
- `iterations[].category` — the checklist category name this corresponds to,
  or `null` when it is genuinely novel (the server will embed the name +
  description and either fold it into the closest category or create a new
  one on the improvement leaderboard). It must be a **generic technique
  name** — see "Naming an improvement" above; site-specific names are the one
  thing that makes this board useless.
- `iterations[].name` — a short generic label for what you did, under the same
  naming rule as `category`. Everything site-specific goes in `description`.
- `iterations[].deltaMs` / `deltaPct` — measured north-star change for that
  single iteration (median vs. the previous kept state), negative = faster.
- `missStreak` — mirror of the counter in `state.json` at exit time.
- `stoppedReason` — `"miss-streak"`, `"user"`, or `null` while running.
