---
name: speedupskill
description: Use this when speeding up a web or Electron app's load or input. Concrete techniques that moved the needle in measured speed labs (DiffUI boot/LCP, bb large-paste jank) — not generic advice.
---

# Speed up a web / Electron app

**When to use:** the job is to make a web or Electron app faster to *load* or to *type into* — first content, LCP, TBT, or input latency after a large paste. Not visual polish, not ink/bleed filters, not a drive-by refactor.

**How to work:** measure a user-felt metric first, change one hypothesis per iteration, keep or revert with numbers. Experimental branch stays experimental; a keep/ditch pass (complexity vs speed vs maintainability) happens before anything is proposed for main. See the paste-prompt in `README.md`.

Numbers below are from real labs. Copy the *shape* of the fix, not the file names.

---

## Run it as a packaged loop: `npx makefaster`

This skill's loop discipline is packaged as [makefaster](https://github.com/jjcm/makefaster). Run `npx makefaster` in a site repo and it:

1. detects the agent CLIs already installed (Cursor Agent, Claude Code, Codex — it drives *your* install and never bundles a model) and asks which one should run the loop **before anything starts**;
2. imports the top improvement categories from the makefaster leaderboard (`/data/improvements.json`), or the catalog bundled with the CLI while that board is still filling up, as a checklist of likely wins — a guide of what has worked across sites, not a script to apply blindly;
3. profiles a user-felt metric (Lighthouse when available, else the lightest real measurement the machine can produce; cold + warm; median of ≥3 runs, spread = noise floor), then loops exactly as above: one hypothesis per iteration, measure, keep or revert with numbers;
4. stops after **5 consecutive attempts with no serious improvement** — serious = beats the measured noise floor and moves the north-star metric by ≥5 % or ≥20 ms, and an FCP-only win that regresses LCP does not count — then offers three things: loop more (miss counter resets), submit the site's stats to the public [site leaderboard](https://github.com/jjcm/makefaster) (URL + favicon are displayed), and/or submit anonymous improvements data (category names + deltas only, no URL) that grows the shared checklist for everyone.

The operational loop skill lives at [`packages/skill/SKILL.md`](https://github.com/jjcm/makefaster/blob/main/packages/skill/SKILL.md) in that repo; the document you are reading is its technique catalog — read it when picking hypotheses.

### Name techniques generically

Everything in this catalog is named as a **generic technique**, and so is every row of the improvement leaderboard. When you report a kept iteration, the category name must be reusable verbatim by the next site: no product or component proper nouns, no file or module names, no byte sizes, no CSS class names, and no process footnotes like "(re-test after landscape change)". Site-specific detail goes in the description.

| bad | good |
|---|---|
| `Inline the Shared Stylesheet (re-test After Landscape Change)` | `Inline shared stylesheets` |
| `Lazy-load Chat Side-pane Components` | `Lazy-load components` |
| `Lazy-load Hidden 262KB Changelog Rocket.gif` | `Lazy-load unseen images` |
| `Import highlight.js/lib/common` | `Subset syntax-highlighter bundle` |
| `Playfair Display 4 Weights → 1` | `Reduce font payload` |

One technique, one bucket — do not create a category per component, image, or vendor. The full rule, including how it interacts with `results.json`, is in [`packages/skill/SKILL.md`](https://github.com/jjcm/makefaster/blob/main/packages/skill/SKILL.md#naming-an-improvement--generic-techniques-only).

---

## Impact: largest (boot payload and critical JS)

These were the 5–12× wins. Do them before touching images or micro-splits.

### 1. Do not wait on unused workspace data — embed what *this* route needs

DiffUI: every signed-in page sat at ~2.6 s rtt40 / ~15 s slow4g because first paint waited on `/api/me` (queued ~1 s behind module preloads on HTTP/1.1) plus live list fetches after the JS wave.

**What worked**

- Replay the real handlers and embed the responses in the shell HTML as already-resolved fetches (`/api/me`, `/api/workspaces`, first list page, folders/brands for sidebar routes, brand-detail for `/brands/{id}`, team-settings detail for `/teams/settings`).
- **Server-resolve the active workspace** the same way the client does (cookie → membership → first team) and **scope every boot payload to that workspace**. Personal-scoped embeds silently missed for team-active users; every space route fell back to live fetches until this existed.
- Deep-link pages (brand detail, team settings) must embed *their* detail payload or content lands a frame after the shell (`LATE_CONTENT`).
- Path-key drift (query string, page size, order) must degrade to a live fetch, not a wrong payload. Hard-expire the boot map (~20 s) so nothing stale is consumed.

**Attributed**

| change | where | rtt40 cold |
|---|---|---|
| embed me + workspaces + first projects page | `/app/projects` grid | 1173 → **471 ms** |
| embed folders + brands; parallelize sidebar + panel | `/app/brands` | 497 → **383 ms** (pop-in gone) |
| embed `/api/brands/{id}` | brand detail | 447 → **402 ms** (pop-in gone) |
| server-resolved workspace + embed team-settings | `/app/teams/settings` | 568 → **443 ms** (warm 218 → **95 ms**) |
| headline, all kept load work | `/app/projects` | **2642 → 367 ms** (7.2×); brands 2651 → 381; brandDetail 2879 → 398 |

**Do not:** inject every API the app has. Embed the payloads the *current route* will read in the first paint. Extra unused JSON is TTFB and `no-store` HTML weight for nothing.

### 2. Cut the critical JS graph to the first view

DiffUI statically imported 104 modules / **2651 KB** on every route (canvas, yjs, admin, settings). First paint waited on all of it. TBT before content was 54–88 ms.

**What worked**

- Static graph = browse shell only (then 28–34 modules, **147–178 KB** depending on route). Every other view is a route-gated dynamic import; idle-prefetch the rest after the first route settles.
- **Route-aware `<link rel="modulepreload">`** for the lazy subtree of the URL being served, so deep links are not a serial second wave after `app.js`. Brands/account/billing sat 150–215 ms behind projects until this existed.
- Split settings by *section* (billing must not download profile/api/usage/referral).
- Extract whales that only one route runs (`wireAdminPanel` was 52 KB / 27 % of `app.js` — admins on `/app/admin` only).
- Trim chrome that is not on the first paint (signin modal, coach steps, unused panels).

**Attributed:** lazy split 1391 → 1173 ms rtt40, TBT 94 → 0; route preloads brands 576 → 497; per-section settings account 522 → 401 / billing 569 → 464; admin extract −30…−73 ms slow4g on every route. Warm loads: **zero JS requests** once URLs are content-hashed (next item).

**Do not:** keep splitting once a function-size census says the next cluster is ~3 KB gz and the expected win is below the harness noise floor. DiffUI rejected further `app.js` splits without implementing them — high entanglement, unmeasurable gain.

### 3. Stop the warm 304 storm

Modules were `Cache-Control: no-cache`. Warm load = one revalidation per file = the entire warm cost (projects warm grid **1086 → 144 ms** after hashing, **107 → 0** JS requests).

**What worked:** inject an import map (or equivalent) mapping every module to `?v=<content-hash>`, rewrite preload/script/style URLs the same way, mark matching requests `immutable`. No build step required if the server stats files and hashes are mtime-cached. Deploy flips hashes in the next HTML response — no mixed-version window.

**Tradeoff:** cold pays the map bytes (~+17 ms). Workers/wasm left unversioned stay `no-cache` (correct, unoptimized).

---

## Impact: large (images, LCP, cache)

Do these after boot is no longer waiting on JS/API.

### 4. Serve the rung that matches the CSS slot

Production thumbs were 512 px for ~120 px tiles. Guideline preview loaded a **1600×1200 full board** into a ~550 px box. `srcset` that offered the full board as the only >512 candidate jumped to it at dpr2 (**716 ms / 600 KB**).

**What worked**

- Pipeline `thumbMaxEdge` 512 → **256** (projects LCP 724 → 580 rtt40 / 2312 → 2004 slow4g; **−45 %** cold bytes).
- 128 px `_thumb_sm` for grid tiles, **lazily materialized** at origin (no backfill). Covers keep 256. Projects LCP 580 → 520; **−238 KB**.
- Guideline preview = thumb derivative; full-res only in lightbox/download (heavy-asset LCP 732 → 552, −103 KB). Immediate or idle “upgrade to full-res” variants **measured worse** (re-fired LCP / extra bytes) — rejected.
- `srcset`/`sizes` ladder (128/256/512) for cards, refs, covers, tiles. **Cap the ladder at the slot.** Guideline at 1x stays on the 256 rung (`sizes="256px"`); dpr2 must not jump to the full board (596 ms / 497 KB after the cap).
- `sizes` is a pinned constant that **must track CSS slot width**. Reused `<img>`s must `removeAttribute("srcset")` when the URL is not a thumb, or `srcset` outranks `src` and shows a stale image.

**Do not:** `<link rel="preload">` the first N grid thumbnails. They steal connections and bandwidth from render-critical JS/CSS (projects grid 480 → **557 ms**; slow4g LCP 2444 → **4028 ms**). Reverted. `fetchpriority=high` on covers was a wash — do not keep unmeasurable behavior changes.

### 5. Immutable / success-only cache for write-once `/files/`

Write-once families (UUID-keyed generation/brand/canvas assets) can be cached. Rewritten-in-place thumbs cannot.

**What worked, after review bugs were found**

- Apply `Cache-Control` in a `ResponseWriter` wrapper at **`WriteHeader` time**, only for **2xx/3xx** (including 206/304). Never set the header before `Serve` — a Stat-vs-GET race or a transient 404/502 will otherwise cache for a year.
- Canonical rasters (`.png/.jpg/.jpeg`) → `immutable`. Parameter-dependent derivatives (quality, `thumbMaxEdge`) → `max-age=86400`, not immutable — a retune must reach returning visitors.
- 404s never get the header, so a not-yet-materialized derivative cannot cache a miss.

Lab warm wins for images can be a lie (some headless Chromes never disk-cache `Image`-destination requests). Keep this on first principles; do not claim a warm number you did not measure in production Chrome.

---

## Impact: input path (Electron / editors)

bb composer: pasting a ~1 MB minified-JS line (dense in `` ` `` / `_` / `*` / `/`) froze for seconds and left **~20 ms of pure JS per subsequent keystroke**.

### 6. Large paste: O(n) parse, no full-text rescan per keystroke

| cost at 1 MB | before | after |
|---|---|---|
| rich-text Markdown parse (paste/mount/setContent) | **2059 ms** (571 ms @ 512 KB — superlinear) | **11.6 ms** (linear 128 KB–1 MB) |
| decoration serialize + rule regex, every keystroke | ~8 ms | position-map existing decorations; full rebuild deferred ≤ 200 ms on docs > 10 k chars |
| typeahead trigger (`textBetween(0, caret)` + regex) | 2.5 ms, twice per keystroke | 256-char window before the caret |
| value-sync `JSON.stringify` ×2 per keystroke | 3.1 ms each | structural compare, reference equality |
| draft `JSON.stringify` per keystroke | 3.1 ms | moved into the already-debounced 250 ms persist |
| thread timeline React re-render per keystroke | yes (subscribed to the draft store for `addQuote` only) | non-subscribing accessor; quote writes at event time |

**What worked**

- Markdown delimiter pairing: sorted-range binary search + monotonic pointer sweeps (**linear**), output byte-identical to the quadratic version.
- Decorations on large docs: map through the edit; throttle full rebuild. Small docs stay synchronous.
- Typeahead: windowed scan; disable fake `^` at the window edge.
- Controlled-value sync: do not stringify the whole text to see if it changed.
- Draft persist was already debounced — only the serialization belonged inside that window.
- A parent view that only needs `addQuote` must not subscribe to every draft tick.

**Do not:** blame highlighting, history, or layout first without measuring. History was not on the hot path. Electron layout of a giant wrapped line is a *different* bottleneck and was left unfixed (VM could not measure it). Do not rescan the full document per keystroke for parse, decorations, or triggers. Do not serialize the draft or rerender the thread on every input.

---

## Impact: placeholders (UX, measured price)

ThumbHash is a feature, not a speedup. DiffUI paid **+11–25 ms** rtt40 / **+55–75 ms** slow4g on image routes for ~2.7 KB of hashes + 2 modules. Keep it only if “never a broken-image icon” is the product requirement.

### 7. ThumbHash: average color now, budgeted decode, encode off the GET path

**Do**

1. Paint the hash’s **average color synchronously** (`thumbHashToAverageRGBA` → `background-color`, no PNG). Skip if the img is already complete.
2. Enqueue full decodes on **one shared queue**. A **single rAF loop** drains it: up to 10 data URLs, yield if >8 ms of the frame is spent (half a 60 fps frame). Stress: 200 pending hashes → 5 frames / 89 ms, **0 long tasks**. Counterfactual: 200 decodes in one block = **42 ms** hitch on a fast VM.
3. If the real file loads first, dequeue — **never apply a data URL to a loaded img**.
4. Encode at **derivative write time** (hook the single choke point every webp writer uses). List serving is **SELECT-only** (cold-cache list TTFB 7.8 ms, zero synchronous encodes). History backfills with bounded background workers; the first response simply lacks the hash.
5. Vendor the decoder on a **tracked** path (`app/lib/…`, not `vendor/`).
6. Pin the scheduler with a regression test that **fails on burst decode** (fake frame pump + fake clock).

**Do not**

- Ship the decoder under a **gitignored `vendor/`** — clean checkout white-screened; lab numbers ran against an untracked local copy.
- Encode ThumbHash on the **cold list GET** path.
- Burst-decode on the main thread (per-image rAF that coalesces into one frame, or one synchronous loop over the grid).
- Treat this as a load-time win. It is a UX floor with a measured content-time cost. Offset it by lazy-loading the decoder if the cost is unacceptable.

---

## What not to do (lab-proven or out of scope)

| temptation | what actually happened |
|---|---|
| Preload first 8 thumbnails | Grid **slower**; slow4g LCP nearly doubled. Images tax the shell on a constrained pipe. |
| `fetchpriority=high` on covers | Wash. Reverted rather than keep an unmeasurable change. |
| Cache `/files/` errors / set headers before `WriteHeader` | 404/502 can cache for a year. Success-only, at write time. |
| `immutable` on WebP derivatives | A `thumbMaxEdge` retune never reaches returning visitors. Bounded `max-age` instead. |
| `srcset` that includes the full board | dpr2 jumps to 1600w. Cap rungs to the CSS slot. |
| Immediate or idle upgrade of a preview to full-res | Re-fired LCP and/or extra bytes. Thumb in the box, full-res in lightbox. |
| ThumbHash decoder in gitignored `vendor/` | Clean checkout white-screens. |
| Encode hashes on list GET | Synchronous decode+encode on the cold path. Write-time hook + SELECT-only serve. |
| Burst-decode placeholders | 42 ms hitch at 200 images; TBT spike on real hardware. Budgeted rAF drip. |
| Further JS splits after the whale is gone | Census: ~15 ms expected, below noise, high entanglement. Reject without implementing. |
| Quadratic markdown / full-doc regex per keystroke | 2 s paste freeze; ~20 ms JS/keystroke at 1 MB. Linear parse; windowed scans; deferred rebuilds. |
| `JSON.stringify` draft or re-render thread on every input | 3+ ms × N plus a full timeline render, every character. |
| SVG `feDisplacementMap` for ink / bleed | **Unrelated.** That is a visual/ink job, not a load or input speed lab. Do not mix it in. |
| Merge the experimental branch | Lab harnesses, TLS toys, and rejected variants do not belong on main. Keep/ditch first. |

---

## Keep / ditch (before proposing for main)

Score every kept iteration on **speed** (attributed ms), **complexity**, and **maintainability**. A byte win that does not move LCP/TBT is a candidate to ditch.

**Usually take:** workspace-scoped embedded boot payloads; import-map / content-hash immutable JS; route-aware modulepreloads of *this* route only; image ladder matching the CSS slot; success-only `/files/` cache; O(n) paste parse; dropping per-keystroke stringify/rerender.

**Usually ditch this pass (even if “kept” in the lab):** gzip at origin when the CDN already gzips; lazy view-module splits whose LCP is flat; async fonts; deferring billing JS that is not on the first paint of other routes; lab TLS listeners and harnesses; ThumbHash (UX floor, measured *cost* on FCP/LCP — keep only if broken-image flash is the product requirement).

**Take only with pinning tests:** mirrored server/client boot logic (workspace cookie, path keys, preload lists); `sizes` vs CSS; cache headers applied at `WriteHeader` on 2xx/3xx only.

---

## Sources

- DiffUI: [PR #139](https://github.com/jjcm/diffui/pull/139) (`cursor/speed-lab-autoresearch-b738`), `SPEED_LAB.md` iteration inventory. Headline load times are the pre-ThumbHash kept set; ThumbHash is a measured UX add-on (projects ends at 395 / 1455 ms with it).
- bb: [PR #1](https://github.com/jjcm/bb/pull/1) — composer jank on large minified-JS paste.
- Infrared (`kaenamiller/infrared`): **pending** — lab still running; no SPEED_LAB.md or PR at draft time.
- makefaster ([jjcm/makefaster](https://github.com/jjcm/makefaster)): the packaged `npx makefaster` loop, its operational skill, and the community leaderboards this catalog's checklist is imported from.
