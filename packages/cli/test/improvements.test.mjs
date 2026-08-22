import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUNDLED_CHECKLIST_PATH, importChecklist } from "../lib/improvements.js";

const SAMPLE = [
  { rank: 2, name: "Tree Shaking", description: "Remove unused JavaScript", count: 10, avgImprovementMs: -300, avgImprovementPct: -20 },
  { rank: 1, name: "Gzip", description: "Enable compression", count: 20, avgImprovementMs: -400, avgImprovementPct: -25 },
];

function listen(handler) {
  const server = createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

test("imports from the live API base and sorts by rank", async () => {
  const { server, base } = await listen((req, res) => {
    assert.equal(req.url, "/data/improvements.json");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(SAMPLE));
  });
  try {
    const { categories, source } = await importChecklist({ override: null, apiBase: base, cwd: tmpdir() });
    assert.equal(source, `${base}/data/improvements.json`);
    assert.deepEqual(categories.map((c) => c.name), ["Gzip", "Tree Shaking"]);
  } finally {
    server.close();
  }
});

test("an --improvements file override wins", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mf-imp-"));
  try {
    const file = join(dir, "custom.json");
    writeFileSync(file, JSON.stringify(SAMPLE));
    const { categories, source } = await importChecklist({ override: file, apiBase: "http://127.0.0.1:1", cwd: dir });
    assert.equal(source, file);
    assert.equal(categories.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("falls back to the target repo's data/improvements.json when remotes are down", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mf-imp-"));
  try {
    mkdirSync(join(dir, "data"), { recursive: true });
    writeFileSync(join(dir, "data", "improvements.json"), JSON.stringify(SAMPLE));
    // Both remote sources point at a closed port; the local repo file wins.
    const { categories, source } = await importChecklist({
      override: null, apiBase: "http://127.0.0.1:1", cwd: dir, rawUrl: "http://127.0.0.1:1/raw.json",
    });
    assert.equal(source, join(dir, "data", "improvements.json"));
    assert.equal(categories.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("caps the checklist at the top 50 by rank", async () => {
  const big = Array.from({ length: 80 }, (_, i) => ({ rank: 80 - i, name: `Cat ${80 - i}` }));
  const dir = mkdtempSync(join(tmpdir(), "mf-imp-"));
  try {
    const file = join(dir, "big.json");
    writeFileSync(file, JSON.stringify(big));
    const { categories } = await importChecklist({ override: file, apiBase: null, cwd: dir });
    assert.equal(categories.length, 50);
    assert.equal(categories[0].name, "Cat 1");
    assert.equal(categories[49].name, "Cat 50");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The public boards start empty and only fill up with real submissions, so
// every remote source can legitimately answer `[]`. The bundled catalog is what
// keeps `npx makefaster` useful in the meantime.
test("falls back to the bundled catalog when every other source is empty", async () => {
  const { server, base } = await listen((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end("[]");
  });
  const dir = mkdtempSync(join(tmpdir(), "mf-imp-"));
  try {
    mkdirSync(join(dir, "data"), { recursive: true });
    writeFileSync(join(dir, "data", "improvements.json"), "[]");
    const { categories, source } = await importChecklist({
      override: null, apiBase: base, cwd: dir, rawUrl: `${base}/raw.json`,
    });
    assert.equal(source, "bundled fallback");
    assert.ok(categories.length > 0, "the bundled checklist must never be empty");
    assert.ok(categories.every((c) => typeof c.name === "string" && c.name.length > 0));
    assert.equal(categories[0].rank, 1);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the bundled catalog ships with the CLI and is a valid checklist", () => {
  const bundled = JSON.parse(readFileSync(BUNDLED_CHECKLIST_PATH, "utf8"));
  assert.ok(Array.isArray(bundled) && bundled.length > 0);
  assert.ok(bundled.every((row) => typeof row.name === "string" && typeof row.description === "string"));
});

test("rejects invalid checklist data with a useful error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mf-imp-"));
  try {
    const file = join(dir, "bad.json");
    writeFileSync(file, JSON.stringify({ nope: true }));
    await assert.rejects(
      importChecklist({ override: file, apiBase: null, cwd: dir }),
      /could not import the improvement checklist/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
