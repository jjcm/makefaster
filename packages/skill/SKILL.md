---
name: makefaster
description: Autoresearch loop that makes the site in this repo measurably faster. Baseline a user-felt metric, work the improvement leaderboard in rank order one hypothesis per iteration, finish with five of your own, keep or revert with numbers, and report results for the public leaderboards. Driven by `npx makefaster`.
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
| `thinking.log` | **you**, as each step starts | one tagged line per step — the only thing the user sees while you work |

`improvements.json` is **the order you work in** (see Step 2), not a script to
apply blindly: you still judge whether each category is viable here before
spending an iteration on it, and you skip the ones that are not. Its `source`
field says where it came from. Live leaderboard rows are ranked by what actually
worked across other sites and carry `count` and average deltas. The catalog
bundled with the CLI — which is what you get while the public board is still
filling up — is ordered by rough expected impact and carries no measurements at
all.

## Reporting progress — one tagged line per step

You run hidden. The user watches a dashboard whose top panel is built from
**`.makefaster/thinking.log`** and nothing else, so that file is the only way to
tell them what is happening. Append one line as each step begins:

```
[INITIALIZING] Prepping project and installing dependencies.
[TEST] Running lighthouse tests for initial baseline
[CHECKLIST] Walking 50 imported categories in rank order.
[SKIP] Enable Gzip Compression — the CDN already compresses every text response.
[TRY] Lazy-Load Components
[RESULT] -410ms / -14.2% cold LCP — kept.
[EXTRA] 5 follow-ups chosen: worker offload, srcset rungs, DNS prefetch, JSON slimming, sprite atlas.
[DONE] Checklist finished with 6 keeps; stopping.
```

The whole vocabulary, and nothing outside it is displayed:

**`INITIALIZING`** · **`TEST`** · **`CHECKLIST`** · **`SKIP`** · **`TRY`** ·
**`RESULT`** · **`EXTRA`** · **`DONE`**

Rules, because this panel is a report and not a transcript:

- **One line, one sentence, one step.** Write it as you start the step.
- **Say what you are doing, not what tool you are using.** No tool names, no
  file paths, no command strings, no diffs, no "working", no "thinking", no
  model output. If a line would only make sense to someone watching a tool log,
  it does not belong here.
- **Do not invent tags.** A line whose tag is not in the list above is dropped
  on the floor, as is anything without a tag — that is deliberate, so a stray
  `cat` or a pasted stack trace cannot end up on the user's screen.
- Never write anything to this file that you would not be happy to have read
  aloud as the single sentence describing this moment of the run.

The dashboard adds the measured numbers itself, straight from `results.json`, so
you do not need to report them twice — but a `[RESULT]` line of your own is
welcome and is what a reader looks for.

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

## Step 2 — the loop: the checklist in order, then five of your own

**The order is not yours to choose.** Work the imported improvement leaderboard
top to bottom first, then add exactly five hypotheses of your own. The board is
ranked by how often each technique has actually worked on other sites, so
"whatever looks promising to me" is a worse opening bet than "the thing that has
worked most often", and a fixed order is also what makes one run comparable to
the next.

Profiling still matters — it decides **whether** a checklist category is viable
here and **what** your five extras should be. It just does not decide the order.

### 2a. Walk the checklist, one category per iteration

Read `.makefaster/improvements.json` and go **in rank order**, one category at a
time. For each one:

1. **Check whether it is viable in this codebase** — a few minutes of reading,
   not an iteration. Is the thing already done? Does the stack even have this
   surface? Is it plausibly on the critical path here?
2. **Not viable → skip it, and say why.** Report
   `[SKIP] <category> — <one reason>` and move to the next category. A skip
   costs no iteration and does **not** touch `missStreak`: you did not spend a
   measurement, so you did not miss. Never spend an iteration implementing
   something you already know does not apply.
3. **Viable → spend one iteration on it.** Report `[TRY] <category>`, then:
   - **Implement the smallest change that tests it.** Make it cleanly
     revertable: commit it on the working branch (or `git stash`-able state). If
     the repo is not git, snapshot the files you touch first.
   - **Re-measure exactly like the baseline** (`[TEST] …`). Same URL, same run
     count, same conditions, median again. Never compare a 1-run number to a
     3-run median.
   - **Keep or revert, by the numbers** (below).

### 2b. Then exactly five of your own

When the checklist is exhausted, pick **exactly five** hypotheses that were
**not** on the board — novel techniques, or things shaped by what you saw in
this specific codebase. Report them up front as
`[EXTRA] 5 follow-ups chosen: …`, then run them **one at a time** under the same
keep/revert rules. Your profiling evidence is what these five come from; this is
where it leads instead of following.

### Keep or revert

- A **serious improvement** means the north star improved beyond your measured
  noise floor, AND by at least **5% or 20 ms** (whichever is larger for the
  metric's scale). An FCP-only win that **regresses LCP does not count** — that
  is rearranging deck chairs.
- Kept → record the iteration with `kept: true`, classify it with
  `generic: true` or `generic: false` (see "Classifying a keep" below), and set
  `missStreak` to `0` in `state.json`.
- Anything else → **revert completely** (revert means revert — no half-kept
  experiments), record `kept: false`, and increment `missStreak`.
- Either way, report the outcome: `[RESULT] <delta> — kept` or
  `[RESULT] <delta> — reverted, below the noise floor`.

**Update `results.json` and `state.json` after every iteration.** Keep
`results.json` valid JSON at all times — the CLI parses it the moment you exit,
even if you were interrupted.

## Naming and describing an improvement — generic techniques only

**Hard rule: every `iterations[].category`, the `name` you submit with it, AND
its `description` describe a GENERIC TECHNIQUE that could apply to any site.**
The improvement leaderboard is a shared catalog of techniques, not a changelog
of your repo. Both the name and the description are published on it, so a line
that only makes sense to someone who has read your source tree is useless
there.

None of those three fields may contain:

- **product or component proper nouns** — `Mermaid`, `Playfair Display`,
  `Excalifont`, `Firebase`, `Amplitude`, `GrowthBook`, `ChatControls`,
  `AppInitPage`;
- **file or module names** — `rocket.gif`, `highlight.js/lib/common`,
  `moment-timezone`, `basic_examples`, `index.html`;
- **byte sizes, versions, counts, or measurements** — `262KB`, `4 weights`,
  `v3.2`, `28.8KB -> 11KB`, `~270 chunks`;
- **CSS class names or declarations, route paths, or API paths** —
  `display:none`, `client:load`, `/api/v1/all`;
- **process footnotes** — `(re-test after landscape change)`,
  `(same as iteration 4)`, `(second attempt)`;
- **changelog voice** — `Added…`, `Removed…`, `Switched…`, `…was fetched…`. A
  technique is written in the present tense, as an instruction to the next
  site.

Site-specific detail still belongs in `results.json` — put it in
`iterations[].notes`, which never leaves the machine and is exactly what you
want when you write the commit or PR for the change in **this** repo.

| bad (one repo) | good (generic technique) |
|---|---|
| **name** `Inline the Shared Stylesheet (re-test After Landscape Change)` | `Inline shared stylesheets` |
| **name** `Lazy-load Chat Side-pane Components` | `Lazy-load components` |
| **name** `Lazy-load Hidden 262KB Changelog Rocket.gif` | `Lazy-load unseen images` |
| **name** `Gzip-precompressed static assets` | `Precompress static assets` |
| **name** `Enable Gzip Text Compression on the Production Server` | `Enable gzip` |
| **name** `Import highlight.js/lib/common` | `Subset syntax-highlighter bundle` |
| **name** `Playfair Display 4 Weights → 1` | `Reduce font payload` |
| **name** `Remove Duplicate 1MB Basic_examples Fetch` | `Skip redundant fetches` |
| **description** `Playfair Display cut from 4 weights x 2 styles to the single 400-italic actually used; disabled preload for Playfair, Geist Mono and Noto Sans Arabic` | `Ship only the font weights and styles the page actually paints, and avoid preloading fonts that are unused on the entry route.` |
| **description** `Removed a manualChunks pin that hoisted the ~170KB-gzip mermaid-to-excalidraw chunk onto the boot critical path` | `Keep heavy optional libraries off the boot path by importing them only from the UI that needs them.` |
| **description** `AppInitPage refetched the ~1MB /api/v1/flows/basic_examples payload whenever the config query landed` | `Do not download the same payload twice during boot; reuse the in-flight or cached response.` |
| **description** `svgo (precision 1) on the boot-shell logo SVGs cut them 28.8KB->11KB, shrinking index.html 16.3KB->8.6KB gzip` | `Minify inline and static SVGs so the document and images cost fewer bytes on the critical path.` |

The test for a description: **would it still be true and useful on a site you
have never seen?** If it names your files, your libraries, or your byte counts,
it is a note, not a description.

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
   site could use it verbatim, it is not a category, it is a note.
3. Leave `category` as `null` if nothing fits and you cannot phrase a generic
   name; the server will fold the submission by similarity rather than let a
   one-off name onto the board.
4. **Reuse the checklist category's own description** when you fold into one.
   You are reporting one more site where that technique worked, not renaming it.

The server enforces this on ingest too — it strips parentheticals, file names,
byte sizes and identifiers out of submitted names, folds the `lazy-load X`
family into a small fixed set of buckets, and replaces a description that names
your repo with the catalog's own line for the technique (or drops it entirely if
it cannot). So a site-specific submission does not create a site-specific row.
Write the generic name and description yourself anyway: the normalizer is a
backstop, not a copywriter, and what it cannot rescue it throws away.

## Classifying a keep — generic technique or site-specific finding

**Every iteration you keep must say which it is: `"generic": true` or
`"generic": false`.** Reverts can leave it out. The two boards want different
things, and this field is what routes a keep to the right one:

- **generic** — a technique that belongs on the improvement leaderboard, or is
  already on it. Another site could apply it: enable gzip, lazy-load optional
  components, reduce the font payload, serve content-hashed immutable assets,
  don't block first paint on client-side auth.
- **site-specific** — a finding that could only ever matter to this product. A
  one-off bug, an architecture quirk, one named widget that is not a reusable
  technique.

The test is not "was the cause unusual", it is **"does the fix map to a
technique another site could reuse?"** A keep whose story is *"the session
spinner gated the whole homepage because of how the feature-flag client boots"*
is a site-specific **finding**, but if the fix you made is "stop blocking first
paint on client-side auth" — a technique any site can apply — then classify the
keep as **generic**. Only mark `generic: false` when there is no transferable
lesson at all.

What each classification does:

- **generic keeps are submitted to the improvement leaderboard** as categories,
  under the naming and description rules above;
- **site-specific keeps are not.** They stay in `results.json` for your writeup
  and are counted in the site row's split. Do not invent a category name for
  one — a one-off finding on the shared board is exactly the row-of-one problem
  the naming rule exists to prevent.

Then report the split over **kept iterations only** — not every hypothesis you
tried:

```
genericKeepPct      = round(generic keeps / all keeps * 100)
siteSpecificKeepPct = 100 - genericKeepPct
```

Five keeps of which four are generic is `genericKeepPct: 80`,
`siteSpecificKeepPct: 20`. Write both at the top level of `results.json`; the
CLI submits them with the site stats, and the site leaderboard shows how much of
the run was reusable technique. A run that kept nothing has no split to report.

## Naming the site — the product, not your deployment

`site.name` is the row's title on the public site leaderboard, so it is the
**product's own name**: `Dify`, `n8n`, `Uptime Kuma`, `Langflow`,
`Home Assistant`. It is not a description of the copy you measured.

Leave out every one of these:

- `(fork)`, `(self-hosted)`, `selfhosted`, `(self-hosted dashboard)`;
- the fork you ran — `jjcm branch`, `jjcm/n8n fork`;
- the screen you profiled — `dashboard`, `editor`, `studio`, `console`.

| bad | good |
|---|---|
| `Dify Studio (self-hosted)` | `Dify` |
| `n8n (self-hosted editor, jjcm/n8n fork)` | `n8n` |
| `Langflow (fork)` | `Langflow` |
| `Uptime Kuma (self-hosted dashboard)` | `Uptime Kuma` |

Two people measuring the same product must land on the same name, and the
deployment you used is already recorded — the URL is in `site.url` and the fork
is in `site.prUrl`. The server strips these qualifiers on ingest as a backstop,
so a name it does not recognize is the only way one reaches the board.

## Step 3 — the stop rule

There are two ways the run ends, and both finish the same way:

- **You got through the work** — every checklist category was tried or skipped
  and all five of your own hypotheses have been measured. Stop with
  `stoppedReason: "checklist-complete"`.
- **The miss streak fired first** — `missStreak` reached `maxMisses`
  (default **5**) consecutive *measured* attempts with no serious improvement.
  That limit applies throughout, so it can end the run part-way down the
  checklist or in the middle of the five extras. Stop with
  `stoppedReason: "miss-streak"`. (Skips are not misses; only measurements
  count.)

Either way, before you exit:

1. Run one final full measurement pass (cold + warm) and write it to
   `results.final`.
2. If the kept changes are on a branch you can push, open a pull request for
   them and put its URL in `site.prUrl` (e.g.
   `https://github.com/jjcm/n8n/pull/1`). The site leaderboard links the row to
   it, so the board shows the diff behind every number instead of asking readers
   to take the percentage on faith. Do not open one if the user has not asked
   you to push anywhere.
3. Set `stoppedReason`, make sure every iteration is recorded, report
   `[DONE] <one sentence>`, and **exit your session**. The CLI takes over: it
   shows the user the end screen and asks whether to loop more (it will reset the
   counter and re-invoke you), submit site stats to the public site leaderboard,
   and/or submit anonymous improvements data.

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
    "favicon": "https://example.com/favicon.ico",
    "prUrl": "https://github.com/jjcm/example/pull/1"
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
      "description": "Inline the above-the-fold rules first paint needs and load the rest of the stylesheet asynchronously",
      "category": "Inline Critical CSS",
      "notes": "Extracted the 4.1KB of rules the hero uses out of app.css into <style> in index.html",
      "generic": true,
      "deltaMs": -260,
      "deltaPct": -10.8,
      "kept": true
    },
    {
      "n": 2,
      "name": "Stop gating first paint on the flag client",
      "description": "Render the page without waiting on the client-side flag or auth round trip",
      "category": null,
      "notes": "The session spinner blocked the homepage until the feature-flag SDK resolved",
      "generic": false,
      "deltaMs": -410,
      "deltaPct": -14.2,
      "kept": true
    },
    {
      "n": 3,
      "name": "Preload LCP image",
      "description": "Preload the image the largest contentful paint waits on",
      "category": "Preload LCP Image",
      "notes": "Added <link rel=preload> for the first 8 grid thumbnails; LCP regressed, reverted",
      "deltaMs": 150,
      "deltaPct": 6.2,
      "kept": false
    }
  ],
  "genericKeepPct": 50,
  "siteSpecificKeepPct": 50,
  "missStreak": 5,
  "stoppedReason": "miss-streak"
}
```

Field notes:

- `site.url` — bare domain of the deployed site if the user told you or the
  repo makes it obvious; otherwise leave the `site` object out and the CLI
  will ask the user before submitting.
- `site.name` — the **product's own name and nothing else**, because it is the
  row's title on the public board: `Dify`, `n8n`, `Uptime Kuma`, `Langflow`.
  See "Naming the site" below.
- `site.prUrl` — the pull request you opened for the changes this session kept,
  e.g. `https://github.com/jjcm/n8n/pull/1`. The site leaderboard links the
  row's name to it, so a reader can go from the number to the diff. Leave it
  out if there is no PR; the row simply will not be a link.
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
  name** — see "Naming and describing an improvement" above; site-specific
  names are the one thing that makes this board useless.
- `iterations[].name` — a short generic label for what you did, under the same
  naming rule as `category`.
- `iterations[].description` — one line explaining the **technique** the way the
  next site would apply it. This is published as the category's description on
  the improvement leaderboard, so the naming rule applies to it word for word:
  no product names, file paths, class names, route paths, byte sizes or
  past-tense narration.
- `iterations[].notes` — optional, and the one place site-specific detail
  belongs: the files you touched, the sizes you measured, why you reverted.
  Never submitted anywhere; it stays in `results.json` for the writeup you make
  in this repo.
- `iterations[].generic` — **required on every iteration you keep**: `true` when
  the fix is a technique another site could reuse, `false` when it is a finding
  about this product only. See "Classifying a keep" above. Only `true` keeps are
  submitted to the improvement leaderboard. Reverts can omit it.
- `iterations[].deltaMs` / `deltaPct` — measured north-star change for that
  single iteration (median vs. the previous kept state), negative = faster.
- `genericKeepPct` / `siteSpecificKeepPct` — the split above, over kept
  iterations only, as whole percents that add to 100. Submitted with the site
  stats. Leave both out when the run kept nothing.
- `missStreak` — mirror of the counter in `state.json` at exit time.
- `stoppedReason` — `"checklist-complete"` when you got through the checklist and
  your five extras, `"miss-streak"` when the limit fired first, `"user"` when
  asked to stop, or `null` while running.
