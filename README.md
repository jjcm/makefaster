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
                    (empty — the public boards carry real submissions only)
packages/cli/       the npx makefaster CLI
packages/skill/     the loop skill the CLI hands to your agent
```

## `npx makefaster`

Run it inside a site repo:

```bash
npx makefaster            # or: npx github:jjcm/makefaster
```

What happens:

1. **Finds the agent CLIs you already have.** Detected via PATH, well-known
   install locations (`~/.local/bin`, `~/.claude/local`, `~/.cursor/bin`,
   Homebrew…) and explicit env overrides (`CURSOR_AGENT_EXECUTABLE`,
   `CLAUDE_CODE_EXECUTABLE` / `BB_CLAUDE_CODE_EXECUTABLE`, `CODEX_EXECUTABLE`):
   Cursor Agent (`cursor-agent`/`agent`), Claude Code (`claude`), Codex
   (`codex`). makefaster never bundles, downloads, or hosts a model — with none
   of the three installed there is nothing to run the loop with, and it says so
   with the install commands rather than starting.
2. **Asks you to pick** — only the CLIs that were actually found, and before
   anything runs.
3. **Asks you to pick a model** — five per provider, ranked by intelligence
   (see [Model picker](#model-picker)). `--model <id>` skips the picker.
4. **Reuses the sign-in you already have.** makefaster never runs a `login`,
   opens a browser, prints a device code, or injects an API key; a signed-out
   install fails with the CLI's own auth error and makefaster reports it in one
   line pointing at the native `login` command.
5. **Imports the improvement checklist** — up to the top 50 categories from the
   live leaderboard, falling back to the technique catalog bundled at
   [`packages/cli/data/improvements.json`](packages/cli/data/improvements.json)
   while the public board is still filling up. Either way that ranked list is
   the order the loop works in, and **its length is the length of the run** (see
   [The run is N + up to 5](#the-run-is-n--up-to-5)).
6. **Runs the agent CLI hidden** with the loop skill
   ([`packages/skill/SKILL.md`](packages/skill/SKILL.md)): profile a
   user-felt metric (Lighthouse if available; cold + warm; median of ≥3 runs),
   then walk the whole imported checklist in rank order — one category per
   iteration, skipping only what plainly does not apply — and finish with up to
   five hypotheses of the agent's own. Measure each one, keep it if it beats the
   noise floor, revert otherwise. The other product's interface never draws and never
   prompts you (see [The native CLI stays hidden](#the-native-cli-stays-hidden));
   makefaster shows [its own dashboard](#the-dashboard) instead.
7. **Stops when the whole checklist has been walked and the extras are done** —
   not at five runs, and not because several attempts in a row missed — then
   leaves the dashboard and shows the end screen with its
   questions:
   - **Loop more?** — another round: whatever is left of the checklist first,
     then more extras.
   - **Submit stats to the Site leaderboard?** — your URL and favicon are
     displayed publicly with the measured LCP/TTI improvements, and the row
     links to the pull request the run was opened as when there is one.
   - **Submit anonymous improvements data?** — no URL; category names,
     descriptions, and deltas only. Novel improvements become new categories
     on the improvement leaderboard.
   - **Submit this session's chain of thought?** — a separate decision, asked
     once the two above have been answered and defaulting to no. The agent's own
     reasoning text, kept privately to post-train a small model on how the loop
     reasons; never published anywhere. See
     [Chains of thought](#chains-of-thought).

```text
Usage: npx makefaster [dir] [options]
  --cli <cursor|claude|codex>   Skip the picker and use this agent (it has to
                                be installed on this machine)
  --model <id>                  Skip the model picker
  --url <example.com>           Site URL for the leaderboard submission
  --api <base>                  Leaderboard API base (default https://makefaster.dev)
  --improvements <path|url>     Override the checklist source
  --extras <n>                  Hypotheses of its own the agent may add after
                                the checklist (default 5, and it may use fewer)
  --no-tui                      Plain progress lines instead of the dashboard
```

Session state lives in `.makefaster/` in the target repo (auto-excluded from
git via `.git/info/exclude`): `SKILL.md` and `improvements.json` are what the
CLI hands the agent, `state.json` records the chosen provider, model and the run
plan (`checklistCount`, `extrasBudget`, `plannedRuns`), and the agent writes back
`results.json` (the record the CLI reads) and `thinking.log` (one tagged line per
step, which is what the dashboard shows).

### The run is N + up to 5

A session is **every category on the live improvement board, plus up to five
hypotheses the agent picks itself.** `N` is whatever
[makefaster.dev/data/improvements.json](https://makefaster.dev/data/improvements.json)
is carrying when the checklist is imported — 24 categories today, so 29 runs —
and nothing in the CLI caps it. An empty board means `N` is 0 and the run is just
the extras.

What that rules out, because it is what the loop used to do:

- **it does not stop at five runs.** Five is the extras budget, not the size of
  the session;
- **it does not stop on a miss streak.** `--max-misses` is gone. Stopping after
  five consecutive measurements with no serious improvement sounds like
  discipline and behaves like starvation: the board is ranked by what worked on
  *other* sites, so the first few categories on any given site are often
  "already done here" or "no effect here", and the run ended five measurements
  into a fifty-category list. A revert costs an iteration and nothing else;
- **it does not let the agent cut the walk short** to get to its own ideas. The
  extras come after the checklist, not instead of the dull end of it.

A `[SKIP]` is still free and still expected — a category that plainly does not
apply to this stack costs no measurement, gets no row in `results.json` and no
timing bar. Skips are a judgement about the site, not a shortcut.

The keep/revert rules are unchanged: LCP is the north star, a keep has to beat
the measured noise floor **and** move it by ≥5% or ≥20 ms, an FCP-only win that
regresses LCP does not count, and `results.json` is rewritten with real numbers
after every measurement.

## The dashboard

While the agent works, makefaster owns the screen: an alternate-screen TUI with
no dependencies — raw ANSI, three panels, repainted from
`.makefaster/results.json` and `.makefaster/thinking.log`.

![The makefaster dashboard](docs/dashboard.png)

- **AGENT THINKING** — a timestamped line per step of the loop, each one a
  single tagged sentence: `INITIALIZING`, `TEST`, `CHECKLIST`, `SKIP`, `TRY`,
  `RESULT`, `EXTRA`, `DONE`. The agent writes them to `.makefaster/thinking.log`
  as each step begins (the contract is in `packages/skill/SKILL.md`), and
  `TRY`/`RESULT` lines are also derived from `results.json` so the numbers are
  measurements rather than narration. The hidden agent's protocol stream feeds
  this panel **nothing**: it is a tool-call transcript — `working`,
  `Read File`, `approved bash` — which says the agent is busy without ever
  saying what it is doing, and it buried the two lines a reader wanted. It is
  still consumed as the child's heartbeat.
- **AUTORESEARCH / WEBSITE SPEED** — where the loop is (`LOOP 003 OF 029` plus
  the experiment running now), then one table: a row per metric the session
  measured (`lcpMs`, `tbtMs`, `fcpMs`, `ttiMs`, plus `cls` and `score` when the
  agent records them) as candidate, baseline and Δ. Rows for metrics you did not
  measure are left out rather than shown empty. The candidate is `results.final`
  once the last measurement pass has been written, and until then it is the state
  the kept iterations have walked the site to — so a keep moves the column the
  moment it is recorded.
- **RUN TIMINGS** — one bar per run on the north-star metric, with a star on the
  best run and a footer carrying the rolling average, the improvement against
  baseline, and the run count. Every measured
  iteration is a bar, kept or reverted: a miss was profiled just as carefully,
  and only kept ones move the running value. An iteration can report either the
  absolute value the run landed on or the `deltaMs` it moved, and one that
  reports neither is a row the agent has not filled in yet — so it gets no bar
  rather than a guessed one. Skips are not runs and never appear.

`q` or Ctrl-C stops the round and restores the terminal; a resize re-renders.
The dashboard needs a TTY on both stdin and stdout — when output is piped, or
with `--no-tui` or `MAKEFASTER_NO_TUI=1`, makefaster prints a plain progress
line instead.

## The native CLI stays hidden

makefaster drives your agent CLI the way [bb](https://github.com/get-bb/bb)'s
provider bridges do: as a **non-TTY protocol child**, not as a terminal
application and not as a print-mode wrapper where a protocol exists. stdio is
always piped and never `stdio: "inherit"`; stdin is a pipe makefaster writes
protocol frames into, never your terminal — attaching it is what otherwise makes
these CLIs decide a human is present and start asking for login, workspace
trust, and per-tool permission.

| Agent | How makefaster drives it |
|---|---|
| Cursor Agent | `cursor-agent --model <id> acp` — Agent Client Protocol over stdio |
| Claude Code | `@anthropic-ai/claude-agent-sdk` `query()`, which owns the CLI pipe itself; print mode is the zero-dependency fallback |
| Codex | `codex app-server` — JSON-RPC; the model rides `thread/start` |

`--model` is a *global* Cursor option, so it precedes the `acp` subcommand.
Cursor has no permission flag at all — `--force`, `--yolo` and `--always-approve`
belong to other agents — and neither does the app-server. So **makefaster answers
the child's permission requests itself**: ACP `session/request_permission`,
Claude's `canUseTool`, and Codex's three `requestApproval` methods. Without that
a hidden child would block forever on a question with no UI to ask it in.

Claude Code is the one provider where a protocol client is a dependency rather
than a subprocess, so the Agent SDK is an optional peer: if it resolves,
makefaster uses it with bb's options — `pathToClaudeCodeExecutable`,
`settingSources: ["user","project","local"]` so `~/.claude` OAuth and settings
load, `permissionMode: "bypassPermissions"` plus
`allowDangerouslySkipPermissions`, and the prompt as an async iterable. If it
does not resolve, the fallback is print mode over piped stdio with the same
setting sources and permission mode, and the prompt written to stdin as a
stream-json frame rather than placed on argv.

Two details worth knowing: Claude Code refuses to skip permissions as root and
exits before the session starts, so as root makefaster sends
`--permission-mode acceptEdits` and leans on the tool-approval callback instead;
and Codex's `--full-auto` was removed from the CLI, which is part of why the
app-server — where the posture is `approvalPolicy: "never"` with a
`workspaceWrite` sandbox — is the path rather than `codex exec`.

### Credentials are reused, never supplied

makefaster never runs a `login` subcommand, never opens a browser, and never
prints a device code. It also **never injects an API key**: `ANTHROPIC_API_KEY`,
`CURSOR_API_KEY` and `OPENAI_API_KEY` are not set by makefaster, because an
injected key fights the OAuth credentials the CLI already stored and can itself
cause prompts. The child inherits your environment untouched and finds
`~/.claude`, `~/.cursor` and `CODEX_HOME`/`~/.codex` exactly as the native CLI
does. A key *you* set stays yours; makefaster only refuses to add one.

A signed-out install therefore fails with an auth-required error from the child
(or from the model-list probe, which needs the same account). That is the
expected signal: makefaster reports it in one line naming the native `login`
command and stops.

## Model picker

After you pick a provider, makefaster offers up to five models ranked by
intelligence. The ranking is the CursorBench 3.2 snapshot (captured 2026-07-16)
that [`jjcm/bb-plugin-autorouter`](https://github.com/jjcm/bb-plugin-autorouter/blob/main/benchmarks.ts)
carries as `CURSOR_BENCHMARKS`, reduced to the best score per model family.

The three CLIs do not share an id namespace, so the catalog does not either:

| | Cursor | Claude Code | Codex |
|---|---|---|---|
| 1 | `claude-fable-5-thinking-medium` — 70.5 | `claude-fable-5` — 70.5 | `gpt-5.6-sol` — 67.2 |
| 2 | `gpt-5.6-sol-medium` — 67.2 | `claude-opus-4-8[1m]` — 62.3 | `gpt-5.6-terra` — 64.9 |
| 3 | `gpt-5.6-terra-medium` — 64.9 | `claude-sonnet-5` — 61.5 | `gpt-5.6-luna` — 61.1 |
| 4 | `claude-opus-4-8-thinking-medium` — 62.3 | `claude-opus-5[1m]` — unranked | `gpt-5.5` — 58.4 |
| 5 | `claude-sonnet-5-thinking-medium` — 61.5 | `claude-opus-4-7[1m]` — unranked | *live list only* |

Cursor ids are **variants**: family plus reasoning effort plus an optional
`-fast` twin, and bb's primaries pin medium. Claude Code ids carry **no effort
suffix** — reasoning is a separate field — and a bracketed context parameter such
as `[1m]` is part of the id. Codex ids are plain families.

The score ranks the model *family*, not the exact variant, because that is what
the snapshot supports: it scores family-by-effort pairs and this keeps each
family's best. The picker says so rather than printing an effort next to an id
that pins a different one.

Where makefaster can ask the CLI what the account can actually run, it does, and
reconciles: `cursor-agent --list-models` for Cursor and `model/list` on the
app-server for Codex. Ids the CLI does not list are dropped, so an account
without Fable access is not offered Fable. Claude Code needs no probe — bb's
curated catalog is already exactly the five rows its own catalog filters to.

Only four OpenAI families are scored, so Codex shows four unless a live list
supplies a fifth. Families the snapshot does not score — Opus 5 and Grok 4.6 are
both newer than it — are offered but sort after every scored model and say they
are absent from the snapshot, rather than being given an invented number. The
catalog lives in [`packages/cli/lib/models.js`](packages/cli/lib/models.js).

`--model` also accepts an id that is not in this table and passes it straight
through, so a model released after this snapshot still works.

### There is no hosted option any more

makefaster used to offer a model of its own — `stealth/ox-alpha` or
`z-ai/glm-5.2:free`, served through `makefaster.dev` on the server's OpenRouter
credential — as a fourth provider, listed first and pre-selected because it was
the one row that needed nothing installed. Neither model is a free model any
more, so that row could only fail on its first completion, and it is gone:
`--cli makefaster` (and the `openrouter` / `hosted` aliases) now stops with a
line saying so rather than quietly running on a CLI you did not choose. What is
left is what the picker was always meant to be — the agent CLIs you already have.

## Skills

| file | what |
|---|---|
| [`packages/skill/SKILL.md`](packages/skill/SKILL.md) | the **operational loop** the CLI hands to your agent: profiling rules, one-hypothesis iterations, the keep/revert bar, the "whole checklist plus up to five extras" stop rule, and the `results.json` contract |
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

The committed `data/` seed is empty, so a fresh database gives you empty boards.
To browse the SPA with a full one, generate a synthetic pair and point `SEED_DIR`
at it:

```bash
node scripts/generate-data.mjs --out-dir /tmp/makefaster-demo
SEED_DIR=/tmp/makefaster-demo ./run.sh
```

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
| `SEED_DIR` | `../data` | seed JSON, read only into empty tables; the committed default is empty |
| `FRONTEND_DIR` | `../frontend` | SPA static root |
| `MAKEFASTER_FAVICON_DIR` | `/var/lib/makefaster/favicons` | where downloaded site favicons are stored; outside the repo, `off` to serve none (see [Site favicons](#site-favicons)) |
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
committed seed files. Both boards are built from real submissions only, so they
start empty and grow as loops report results:

| Endpoint | What | Wrapper |
|----------|------|---------|
| `GET /data/sites.json` | live site rows, one per site per load mode | `MakefasterAPI.getSites()` |
| `GET /data/improvements.json` | live ranked categories | `MakefasterAPI.getImprovements()` |
| `GET /favicons/<site>-<id>.png` | one site's favicon, downloaded from its own origin once and normalized — the only image URL the board loads (see [Site favicons](#site-favicons)) | — |
| `GET /api/health` | `{ ok, embedder, threshold }` | — |
| `POST /api/submit-site` | `{ url, favicon?, name?, prUrl?, genericKeepPct?, siteSpecificKeepPct?, tips?, lcpBefore?, lcpRaw, lcpDelta, ttiBefore?, ttiRaw, ttiDelta, mode: cold\|warm }` — upserts the site's row; URL + favicon shown publicly, `name` reduced to the product's own name, `prUrl` (or `pr`) linked from it. `tips` is up to 10 `{ text, about? }` notes to the catalog maintainers (280/80 chars, clamped): stored privately, acknowledged only as a count, never served by any endpoint | `MakefasterAPI.submitSite(payload)` |
| `POST /api/submit-improvements` | `{ improvements: [{ name, description?, deltaMs?, deltaPct? }] }` — anonymous; names and descriptions are normalized to generic techniques and embedding-matched into categories | `MakefasterAPI.submitImprovements(payload)` |
| `POST /api/submit-trace` | `{ thinking: [{ text }], results?, runId?, product?, prUrl?, agent?, model?, round?, startedAt?, submittedAt?, resultsSubmitted? }` — one run's chain of thought. Stored privately (see [Chains of thought](#chains-of-thought)); there is no GET counterpart and nothing it holds appears on a board or in `/data/*.json` | — |
| `POST /api/openrouter/v1/chat/completions` | OpenAI-compatible chat completions proxied to OpenRouter under the server's own credential. Nothing in this repo calls it any more — see [The hosted model proxy](#the-hosted-model-proxy) | — |

Unknown paths under `/api/` answer `404` rather than the SPA shell, so a route
nobody wrote cannot become one the static fallback answers.

Each metric has both ends of the run: `lcpRaw`/`ttiRaw` are the measurement
after the last kept change, `lcpBefore`/`ttiBefore` the pre-loop baseline, and
the deltas the percentage between them, negative = faster. The two `*Before`
fields are optional — a client that omits them has the baseline recovered from
the delta (`before = after / (1 + delta/100)`).

A row's name is the **product's**, not the deployment's: submitted names have
described one person's copy of the product — `Dify Studio (self-hosted)`,
`n8n (self-hosted editor, jjcm/n8n fork)`, `Langflow (fork)` — so ingest strips
parentheticals, fork and self-hosted qualifiers, jjcm references, and a trailing
UI-surface word (`dashboard`, `editor`, `studio`), leaving `Dify`, `n8n` and
`Langflow`. Matching is whole-word, so `Forkify` and `Editorial` are untouched.
The rule is documented for submitters in `packages/skill/SKILL.md`.

`prUrl` is the pull request the run's kept changes were opened as. The site
leaderboard links the row's name to it, so the board can show the diff behind a
percentage; a row without one is plain text and the key is left off the JSON.

`genericKeepPct` / `siteSpecificKeepPct` say how the run's kept changes divided
between techniques any site could reuse and findings that could only ever have
mattered to that product — both are real speedups, but only the first belongs on
the improvement board, and the CLI submits only those as categories. The two are
complementary, so sending either one is enough; both zero (or both omitted)
means no split was reported, and the board then shows none rather than a
0%. Rows submitted before the fields existed are left blank: the split is not
recoverable from what was stored.

`POST /api/submit-site` answers `201` when it created the row and `200` when it
folded a new run into an existing one, both as `{ ok, created, row }`; invalid
payloads come back as `400 { ok: false, errors: [...] }`. Writes are serialized,
POSTs are rate limited to 60/minute/IP, bodies are capped at 256 KB, and every
response carries permissive CORS so the SPA can be hosted anywhere.

### Site favicons

The board used to point `<img src>` straight at `row.favicon`, which is a URL on
somebody else's server — and plenty of them refuse an image request that comes
from a page on another domain. Hotlink protection, a cross-origin 403, a
redirect to an HTML error page: the row showed a broken image where an icon
belonged.

So the server keeps its own copy
([`backend/internal/favicon`](backend/internal/favicon)):

- **downloaded once**, on ingest (`POST /api/submit-site` knows the URL first)
  or on the first board render that needs it, from the submitted or derived
  favicon URL;
- **normalized** to one size and one format — a **64px square PNG**, fitted and
  centred on transparency so a wide icon is not stretched, which is exactly what
  the board's 28px `.favicon-box` draws at 26px on a 2x display. ICO (including
  the bare Windows bitmaps inside it), PNG, JPEG and GIF are read; an SVG or
  WebP favicon is not, and falls back;
- **stored under `MAKEFASTER_FAVICON_DIR`**, outside the repo and outside
  `FRONTEND_DIR`, so a git pull cannot clobber the cache and the static handler
  cannot serve whatever else lands in it;
- **served from `/favicons/<site>-<digest of the source URL>.png`** with a
  day-long `max-age`. Same origin as the board, so no CORS and no referrer
  policy is involved; the digest in the name is what makes a row that starts
  pointing at a different icon get a different path rather than a stale file.

Nothing waits on a download. `GET /data/sites.json` starts the ones it needs and
answers at the speed of the database, so an origin's slow CDN cannot slow the
board down; the row carries the served path as `faviconPath` alongside the
original `favicon`, and until the file lands — or when the fetch fails outright
— the board draws the site's initial, which is what a row with no favicon has
always done. A failed URL is left alone for ten minutes rather than retried on
every render, and a stored icon is refreshed in the background after two weeks
while the old one keeps being served.

Two things this deliberately does not do: it does not fetch a URL that is not
absolute `http(s)`, and it **does not connect to a non-public address**. The
favicon URL arrives through a public write endpoint, so a server that would
fetch `http://169.254.169.254/…` on request is an SSRF hole; the check runs on
the resolved address, which is what makes it survive a hostname that points at
loopback and a redirect chain that ends there.

`MAKEFASTER_FAVICON_DIR=off` turns the whole thing off: no route, no
`faviconPath`, letters on the board. It never falls back to hotlinking.

### The hosted model proxy

`POST /api/openrouter/v1/chat/completions` is what the CLI's `makefaster`
provider used to run on: the server held `OPENROUTER_API_KEY`, the CLI held a
URL, and chat completions were forwarded on its behalf so that a machine with
none of the three agent CLIs installed could still run the loop. **The
credential never leaves the box** — it is in no response body, no error string
and no log line, and responses are scrubbed on the way out as a backstop.

That provider is gone (see
[There is no hosted option any more](#there-is-no-hosted-option-any-more)), so
nothing in this repo calls the endpoint. It is still served, and it is still the
one endpoint here that spends money per request, so it is still deliberately
narrow ([`backend/internal/inference`](backend/internal/inference)) — and a
deployment with no `OPENROUTER_API_KEY` set simply never turns it on:

- the **model must be on the server's allowlist** — `stealth/ox-alpha` or
  `z-ai/glm-5.2:free`, and nothing else: an id that is not on the list is
  answered `400` naming the two that are, rather than substituted, and a request
  that names no model gets the default. That is what keeps this a two-model
  proxy instead of an arbitrary-model one;
- **`max_tokens` is clamped** (8192) and **streaming is refused**, so one request
  cannot run away;
- a request with **no messages is rejected** before it costs anything, as is any
  `api_key`/`authorization` field a client tries to smuggle upstream;
- it is **rate limited per IP on its own budget** (30/minute), separate from the
  leaderboard writes, and the 429 says why;
- with **no credential configured it answers 503** with the fix, rather than
  failing obscurely — and `GET /api/health` reports
  `inference: { available, model, models }` so a client can see what a
  deployment serves without spending a request to find out.

Set the key at deploy time; there is none in this repo, and the tests use an
`httptest` upstream and a placeholder string.

### Chains of thought

`POST /api/submit-trace` collects the one thing the loop produces that neither
board can hold: **how the agent reasoned**. A curated set of those traces is
what a small model can be post-trained on — the checklist walk, the hypothesis
that did not survive the measurement, the skip and the reason for it.

It is a **separate question in the CLI**, asked after the results question has
been answered and defaulting to no:

```text
  2. Submit stats to the Site leaderboard?          [y/N]
  3. Submit anonymous improvements data?            [y/N]

  4. Submit this session's chain of thought?        [y/N]   ← its own decision
```

The two are not bundled. Uploading results and declining the trace is a normal
answer, declining the results and sending the trace is a normal answer, and
both and neither are too — the trace records which happened
(`resultsSubmitted`), because a training set should know whether the run it is
reading also went on a board. Nothing is ever auto-uploaded: the prompt defaults
to no and takes an explicit yes.

**What the CLI sends.** The reasoning text and nothing else. All three providers
stream reasoning, and makefaster otherwise collapses every bit of it into
the word `thinking` on the way to the progress line, so
[`packages/cli/lib/thinkingTrace.js`](packages/cli/lib/thinkingTrace.js) reads
the field each one documents as reasoning — an ACP `agent_thought_chunk`, a
Claude `thinking` block, a Codex `reasoning` item — and appends it to
`.makefaster/thinking-trace.jsonl`. Streamed chunks
coalesce into blocks; the first event that is not a thought closes one. Nothing
reads the file during the run, it is ignored by git along with the rest of
`.makefaster/`, and it can be read before answering — the prompt names it.

`.makefaster/thinking.log` is **not** this file and has not changed: it is the
agent's own one-line-per-step report, it is the only thing the dashboard shows,
and it stays user-facing.

The payload also carries the distilled `results.json` — the iteration list with
its keep/revert verdicts, plus both ends of the run — and the metadata that
lines a trace up with the run that produced it: product name, `prUrl`, agent and
model, round, timestamps. It carries no diff: the loop's changes are in the pull
request the site row already links to, and shipping a user's source under a
question about reasoning would be answering a question they were not asked.

**Where it goes.** One JSON document per run under `MAKEFASTER_TRACE_DIR`
(`/var/lib/makefaster/traces` by default), as
`<yyyy-mm>/<run id>.json`, in a `0700` directory as a `0600` file — outside the
repo and outside `FRONTEND_DIR`, because the one thing that must never happen to
a trace is being served as a static asset. The `traces` table is the index
beside it (counts and metadata, not content) so a year of collection is still
queryable. A run that submits twice replaces its own document rather than adding
a second copy.

Nothing serves any of it. There is no `GET`, no board, no `/data/*.json` field,
and it is not where the CLI's imported checklist comes from — that is
`GET /data/improvements.json` and only that. Setting `MAKEFASTER_TRACE_DIR=off`
collects nothing, and a deployment with no directory answers `503` naming the
setting.

**What cannot get in.** Everything stored is whitelisted rather than filtered:
`thinking` is read for text, and `results` is re-read field by field, so an
iteration's `notes` — where the skill puts everything specific to one repo —
stays on the submitter's disk. A payload that carries a tool transcript, a build
log or a `tool_result` block (`messages`, `toolResults`, `stdout`, a block whose
`type` names a tool…) is **refused with the reason** rather than quietly
stripped: a trace that silently is not what it claims would be worse than no
trace. And the caps mean a `yarn build` log cannot arrive as reasoning either —
400 blocks, 8k characters each, 200k in total, 200 iterations, a 96 KB diff,
behind a 512 KB body wall. Whatever had to be clamped comes back in the
response.

#### Backfilling already-packed runs

Speed Lab has runs on disk already, and those do not need to go through the TUI
to get onto the box. `makefaster-traces` imports them directly:

```bash
cd backend && go build -o /usr/local/bin/makefaster-traces ./cmd/traces

makefaster-traces import --dir /srv/backfill/2026-08     # a directory of runs
makefaster-traces import --tar /srv/backfill/runs.tar.gz # or a tar/tar.gz
makefaster-traces import --dir ./runs --dry-run          # validate, write nothing
makefaster-traces list --limit 20                        # the private index
```

One directory per run, in the layout an export already writes:

```text
<run>/
  meta.json        required — { runId?, product?, prUrl?, agent?, model?,
                               round?, startedAt?, submittedAt?,
                               resultsSubmitted? }
  thinking.jsonl   required — one {"text": "…"} per line, in order
                              (a bare JSON string per line also reads)
  results.json     optional — the run's results.json
  diff.patch       optional — the unified patch, truncated to the size cap
```

A `--tar` is a tar of the same tree; the first path segment of each entry is the
run, so both `tar -cf runs.tar run-*/` and a tar with a wrapping directory
import the same way. A run with no `runId` in its `meta.json` is named after its
directory, so re-importing the same export is one trace rather than two, and a
run already stored is skipped unless `--replace` — an interrupted backfill is
safe to run again.

Imports go through the same `internal/trace` value the endpoint produces, so an
imported trace and a submitted one are indistinguishable once stored: same
whitelisting, same caps, same refusal to accept tool output in place of
thinking. `list` reads the index on the box; it is deliberately not an HTTP
endpoint and deliberately not something the CLI can reach.

### Embeddings

`POST /api/submit-improvements` first reduces each submitted name to a **generic
technique name**, then matches it. The board is a catalog of techniques, so a
name that only describes one repo — `Lazy-load Hidden 262KB Changelog
Rocket.gif` — would become a permanent row of one. Normalization strips
parentheticals, byte sizes and file names, folds the `lazy-load <one widget>`
family into five buckets (components, unseen images, third-party SDKs,
analytics, data fetches), and maps other known families onto their technique
name. A name that already matches a category on the board wins over any rule.
The rule is documented for submitters in `packages/skill/SKILL.md`.

The **description** a row shows goes through the same treatment, because a
technique name over one repo's changelog — `Reduce Font Payload` / "Playfair
Display cut from 4 weights x 2 styles…" — tells the next site nothing it can
act on. A submitted description is read for the things that can only mean one
repo (module and file names, route paths, CSS declarations, byte sizes and other
measurements, known product nouns, past-tense changelog voice) and, if any turn
up, replaced: with the catalog's own line for the technique when the board names
one, otherwise with the submission minus those tokens, otherwise with a
placeholder. A fold keeps the row's existing description — a fold is one more
site reporting the same technique, not a re-titling — and only upgrades it when
the row still carries a site-specific one.

The normalized name then decides the fold: a category whose name carries the
same significant word stems folds without consulting the embedder, and anything
else is embedded (name doubled, then the description) and compared to every
current category by cosine similarity — at or above the threshold it folds into
that category's running averages, below it becomes a new category. Entries in
one payload are processed in order against the growing list, so two similar
novel entries create one category.

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
// site leaderboard — one row per site per load mode.
// prUrl is the pull request the run was opened as, and is absent when the row
// has none — the board links the site name to it when it is there. The two keep
// percentages are absent together when the run reported no split.
// favicon is the icon at its own origin; faviconPath is this server's
// normalized copy of it, and the only one the board loads.
{ "name": "Example", "url": "example.com", "favicon": "https://…",
  "faviconPath": "/favicons/example.com-9f2c1b7d04.png",
  "prUrl": "https://github.com/jjcm/example/pull/1",
  "genericKeepPct": 80, "siteSpecificKeepPct": 20,
  "lcpBefore": 2791, "lcpRaw": 1842, "lcpDelta": -34,
  "ttiBefore": 4148, "ttiRaw": 2945, "ttiDelta": -29,
  "mode": "cold", "tests": 6, "measuredAt": "2024-05-12T14:15:00.000Z" }

// improvement leaderboard — one row per improvement category
{ "rank": 1, "name": "Gzip / Brotli Compression",
  "description": "Enable or improve text compression",
  "count": 286, "avgImprovementMs": -497, "avgImprovementPct": -28.6,
  "icon": "gzip" }
```

`rank` is **times improved, descending** — how often a technique has worked
across sites, which is what makes it worth trying next. Ties break on the
biggest average improvement, then the name. Both boards let you re-sort in the
browser: the improvement board on times improved and average improvement, the
site board on either end of LCP and TTI plus the improvement between them.

`measuredAt` is always ISO-8601 with milliseconds, in UTC.

Seed files only matter on a fresh database — once the tables hold rows the
server never reads them again. Back up the live boards with `mysqldump`.

`scripts/generate-data.mjs` builds a synthetic pair of files in these shapes
(deterministic, seeded) for filling a local database. It requires an explicit
`--out-dir` and refuses to write into `data/`, so a regeneration cannot put
invented sites back on the public boards.

## Deploying

One Go binary plus the `frontend/` directory and a MariaDB:

```bash
cd backend && go build -o /usr/local/bin/makefaster-server ./cmd/server
```

Migrations run on start, so a deploy is build, replace, restart. The process
needs `MARIADB_DSN`, `FRONTEND_DIR`, and `MIGRATIONS_DIR` pointing at the
shipped copies of `frontend/` and `backend/internal/db/migrations/`. If it is to
collect [chains of thought](#chains-of-thought) it also needs write access to
`MAKEFASTER_TRACE_DIR` — somewhere private, outside `FRONTEND_DIR`, and it is
not backed up by anything that publishes. `MAKEFASTER_FAVICON_DIR` wants write
access too, for the opposite reason: those bytes are public
([site favicons](#site-favicons)), and they only need to live somewhere a
deploy will not overwrite. Put a
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
npm test                                    # CLI: detection, args, payloads,
                                            # protocol children, catalog, dashboard,
                                            # the end screen's questions
cd backend && go test ./...                 # server, embedder, categorization,
                                            # traces, favicons
```

The favicon suite serves its own origin with `httptest` and never touches the
internet: an unfetchable URL, an origin that refuses the request, an origin that
answers 200 with an HTML page, a successful convert down to the served pixels, a
second request that is a file read rather than a second download, a stale file
served while it refreshes behind the request, eight concurrent viewers sharing
one download, and the private-address guard refusing a loopback origin.

The CLI suite spawns real protocol children — a stub agent speaking ACP and one
speaking the codex app-server dialect — and asserts on the frames they receive,
so the argv, the handshake, and the permission answers are proven rather than
described. It needs no network, no database, and no signed-in agent CLI.

The end screen's questions are a test rather than a promise: that the chain of
thought is asked **after** the results question and not bundled with it, that
its prompt defaults to no, that declining it posts nothing at all, that
declining the results and accepting it still submits, and that the payload is
thinking text plus the iteration list with no `notes` and nothing resembling a
tool transcript. The trace capture is tested per provider stream — a reasoning
chunk is captured, a tool call and plain assistant prose are not — along with
the coalescing and the caps.


The MariaDB-backed server tests skip unless a throwaway schema is named, so
`go test ./...` passes on a machine with no database. To run them:

```bash
cd backend
MAKEFASTER_TEST_MARIADB_DSN='root:root@tcp(127.0.0.1:3306)/makefaster_test?parseTime=true' \
  go test ./...
```

They drop the tables and re-migrate, so the schema is created from scratch every
run. Coverage: seed-from-file against a one-site, one-category fixture in
`backend/internal/http/testdata/seed/`; a fresh migrate against the committed
(empty) seed leaving both endpoints serving `[]`; `201` then `200` on a repeated
submission; the board surviving a process restart; the health payload;
static/SPA fallback and legacy redirects; CORS; and the body cap. They also run
the two board migrations against the live rows they were written for: the
generic-name rename (00002) and the generic-description backfill (00004), the
latter both forwards and rolled back.

The trace tests are the other half of the privacy claim. Both public documents
are captured byte for byte before a trace is submitted and compared after, so a
trace cannot change what the boards serve even in a field nobody thought to look
at; the reasoning is then searched for by hand in both. The rest covers what has
no route (`GET /api/submit-trace`, `/api/traces`, the document path — all `404`,
none of them the SPA shell), the refusals (five shapes of tool transcript, each
answered `400` with nothing written), the caps and the `413`, that a
resubmission replaces rather than duplicates, that documents land `0600` in a
`0700` directory, that a client-supplied run id cannot escape it
(`../../etc/passwd`), and that the backfill importer reads both a directory and
a tar — refusing tool output there too.

The categorization and embedding tests need a realistic board to match against,
so they read `backend/testdata/categories.json` — a frozen 50-row fixture that
is test-only and never served. `backend/testdata/category_descriptions.json` is
the other half: the description every live row carried before migration 00004
and the technique blurb that replaced it, which is what keeps the migration, the
ingest catalog, and the rollback in agreement. The embedding tests pin the local match threshold
and the exact similarity scores the Node implementation produced against it, so
the fold-vs-create boundary cannot drift.

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
