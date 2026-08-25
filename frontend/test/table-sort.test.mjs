import { test } from "node:test";
import assert from "node:assert/strict";
import { ariaSort, nextSort, sortRows, sortableHeader } from "../js/table-sort.js";

/* The improvement board's two sortable columns. */
const IMPROVEMENT_COLUMNS = [
  { key: "count", value: (r) => r.count, firstDir: "desc" },
  { key: "avgImprovementPct", value: (r) => r.avgImprovementPct, firstDir: "asc" },
];

/* The board as the rename migration leaves it. */
const BOARD = [
  { name: "Enable Gzip Compression", count: 4, avgImprovementPct: -33.9 },
  { name: "Lazy-Load Components", count: 4, avgImprovementPct: -8.4 },
  { name: "Content-Hashed Immutable Assets", count: 3, avgImprovementPct: -39.9 },
  { name: "Inline Critical HTML Shell", count: 1, avgImprovementPct: -63.9 },
  { name: "Subset Syntax-Highlighter Bundle", count: 1, avgImprovementPct: -5.5 },
];

const names = (rows) => rows.map((r) => r.name);

test("the default sort is times improved, most first", () => {
  const sorted = sortRows(BOARD, IMPROVEMENT_COLUMNS, { key: "count", dir: "desc" });
  assert.deepEqual(names(sorted), [
    "Enable Gzip Compression",
    "Lazy-Load Components",
    "Content-Hashed Immutable Assets",
    "Inline Critical HTML Shell",
    "Subset Syntax-Highlighter Bundle",
  ]);
});

test("equal values keep the incoming order, which is the server's ranking", () => {
  const sorted = sortRows(BOARD, IMPROVEMENT_COLUMNS, { key: "count", dir: "desc" });
  assert.deepEqual(names(sorted).slice(0, 2), ["Enable Gzip Compression", "Lazy-Load Components"]);

  const reversedInput = [BOARD[1], BOARD[0], ...BOARD.slice(2)];
  const reversed = sortRows(reversedInput, IMPROVEMENT_COLUMNS, { key: "count", dir: "desc" });
  assert.deepEqual(names(reversed).slice(0, 2), ["Lazy-Load Components", "Enable Gzip Compression"]);
});

test("average improvement sorts biggest improvement first, since deltas are negative", () => {
  const sorted = sortRows(BOARD, IMPROVEMENT_COLUMNS, { key: "avgImprovementPct", dir: "asc" });
  assert.deepEqual(names(sorted), [
    "Inline Critical HTML Shell",
    "Content-Hashed Immutable Assets",
    "Enable Gzip Compression",
    "Lazy-Load Components",
    "Subset Syntax-Highlighter Bundle",
  ]);
});

test("a first click uses the column's own direction; clicking again flips it", () => {
  let state = { key: "count", dir: "desc" };

  state = nextSort(state, IMPROVEMENT_COLUMNS, "avgImprovementPct");
  assert.deepEqual(state, { key: "avgImprovementPct", dir: "asc" });

  state = nextSort(state, IMPROVEMENT_COLUMNS, "avgImprovementPct");
  assert.deepEqual(state, { key: "avgImprovementPct", dir: "desc" });

  state = nextSort(state, IMPROVEMENT_COLUMNS, "count");
  assert.deepEqual(state, { key: "count", dir: "desc" });

  state = nextSort(state, IMPROVEMENT_COLUMNS, "count");
  assert.deepEqual(state, { key: "count", dir: "asc" });
});

test("an unknown column leaves the sort alone", () => {
  const state = { key: "count", dir: "desc" };
  assert.deepEqual(nextSort(state, IMPROVEMENT_COLUMNS, "description"), state);
  assert.deepEqual(names(sortRows(BOARD, IMPROVEMENT_COLUMNS, { key: "nope", dir: "asc" })), names(BOARD));
});

test("rows with no value for the column sort last in either direction", () => {
  const partial = [
    { name: "measured", count: 2 },
    { name: "missing", count: null },
    { name: "also measured", count: 9 },
  ];
  const columns = [{ key: "count", value: (r) => r.count, firstDir: "desc" }];
  assert.deepEqual(names(sortRows(partial, columns, { key: "count", dir: "desc" })), [
    "also measured",
    "measured",
    "missing",
  ]);
  assert.deepEqual(names(sortRows(partial, columns, { key: "count", dir: "asc" })), [
    "measured",
    "also measured",
    "missing",
  ]);
});

test("aria-sort marks only the active column", () => {
  const state = { key: "count", dir: "desc" };
  assert.equal(ariaSort(state, "count"), "descending");
  assert.equal(ariaSort({ key: "count", dir: "asc" }, "count"), "ascending");
  assert.equal(ariaSort(state, "avgImprovementPct"), "none");
});

test("the header carries aria-sort, the sort key, and a unit when given", () => {
  const active = sortableHeader({ key: "count", dir: "desc" }, "count", "Times Improved");
  assert.match(active, /aria-sort="descending"/);
  assert.match(active, /data-sort-key="count"/);
  assert.match(active, /class="th-sort is-active"/);
  assert.match(active, /Times Improved/);

  const inactive = sortableHeader({ key: "count", dir: "desc" }, "lcpRaw", "LCP After", "ms");
  assert.match(inactive, /aria-sort="none"/);
  assert.match(inactive, /<span class="unit">ms<\/span>/);
  assert.doesNotMatch(inactive, /is-active/);
});

/* The site board's six sortable columns: both ends of each metric, plus the
   improvement between them. */
const SITE_COLUMNS = [
  { key: "lcpBefore", value: (r) => r.lcpBefore, firstDir: "asc" },
  { key: "lcpRaw", value: (r) => r.lcpRaw, firstDir: "asc" },
  { key: "lcpDelta", value: (r) => r.lcpDelta, firstDir: "asc" },
  { key: "ttiBefore", value: (r) => r.ttiBefore, firstDir: "asc" },
  { key: "ttiRaw", value: (r) => r.ttiRaw, firstDir: "asc" },
  { key: "ttiDelta", value: (r) => r.ttiDelta, firstDir: "asc" },
];

const SITES = [
  { name: "Excalidraw", lcpBefore: 6678, lcpRaw: 1202, lcpDelta: -82, ttiBefore: 6723, ttiRaw: 5325, ttiDelta: -20.8 },
  { name: "Langflow", lcpBefore: 11685, lcpRaw: 2594, lcpDelta: -77.8, ttiBefore: 11685, ttiRaw: 2594, ttiDelta: -77.8 },
  { name: "prompts.chat", lcpBefore: 5642, lcpRaw: 4418, lcpDelta: -21.7, ttiBefore: 9578, ttiRaw: 8601, ttiDelta: -10.2 },
];

test("before and after sort independently on the site board", () => {
  assert.deepEqual(names(sortRows(SITES, SITE_COLUMNS, { key: "lcpRaw", dir: "asc" })), [
    "Excalidraw",
    "Langflow",
    "prompts.chat",
  ]);
  assert.deepEqual(names(sortRows(SITES, SITE_COLUMNS, { key: "lcpBefore", dir: "asc" })), [
    "prompts.chat",
    "Excalidraw",
    "Langflow",
  ]);
  assert.deepEqual(names(sortRows(SITES, SITE_COLUMNS, { key: "ttiRaw", dir: "desc" })), [
    "prompts.chat",
    "Excalidraw",
    "Langflow",
  ]);
});

test("the site board's default sort is the biggest LCP improvement first", () => {
  assert.deepEqual(names(sortRows(SITES, SITE_COLUMNS, { key: "lcpDelta", dir: "asc" })), [
    "Excalidraw",
    "Langflow",
    "prompts.chat",
  ]);
});
