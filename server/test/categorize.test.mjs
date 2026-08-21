import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  categorizeImprovements,
  rerankCategories,
  titleCaseCategoryName,
} from "../lib/categorize.mjs";
import { createEmbedder } from "../lib/embedding.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CATEGORIES = JSON.parse(readFileSync(join(ROOT, "data", "improvements.json"), "utf8"));

function localSetup() {
  const { embedder, threshold } = createEmbedder({}, { warn() {} });
  return { embedder, threshold };
}

test("matched improvement increments count and folds averages", async () => {
  const { embedder, threshold } = localSetup();
  const before = CATEGORIES.find((c) => c.name === "Image Optimization");
  const { categories, results } = await categorizeImprovements({
    improvements: [{
      name: "Compress hero images",
      description: "Compressed and resized the oversized hero images",
      deltaMs: -600,
      deltaPct: -30,
    }],
    categories: CATEGORIES,
    embedder,
    threshold,
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].action, "matched");
  assert.equal(results[0].category, "Image Optimization");

  const after = categories.find((c) => c.name === "Image Optimization");
  assert.equal(after.count, before.count + 1);
  const expectedMs = Math.round((before.avgImprovementMs * before.count - 600) / (before.count + 1));
  const expectedPct = Math.round(((before.avgImprovementPct * before.count - 30) / (before.count + 1)) * 10) / 10;
  assert.equal(after.avgImprovementMs, expectedMs);
  assert.equal(after.avgImprovementPct, expectedPct);

  // input list must not be mutated
  assert.equal(CATEGORIES.find((c) => c.name === "Image Optimization").count, before.count);
});

test("novel improvement creates a title-cased category with count 1", async () => {
  const { embedder, threshold } = localSetup();
  const { categories, results } = await categorizeImprovements({
    improvements: [{
      name: "rewrite the ORM in rust",
      description: "Rewrote the ORM data layer in Rust",
      deltaMs: -350,
      deltaPct: -12.34,
    }],
    categories: CATEGORIES,
    embedder,
    threshold,
  });

  assert.equal(results[0].action, "created");
  assert.equal(categories.length, CATEGORIES.length + 1);
  const created = categories.find((c) => c.name === "Rewrite the ORM in Rust");
  assert.ok(created, `created category missing; got ${results[0].category}`);
  assert.equal(created.count, 1);
  assert.equal(created.avgImprovementMs, -350);
  assert.equal(created.avgImprovementPct, -12.3);
  assert.equal(created.icon, "default");
  assert.ok(created.rank >= 1);
});

test("two similar novel entries in one submission create one category, not two", async () => {
  const { embedder, threshold } = localSetup();
  const { categories, results } = await categorizeImprovements({
    improvements: [
      { name: "Precompile route manifests", description: "Precompiled the route manifest lookup table at build time", deltaMs: -80, deltaPct: -4 },
      { name: "Precompile the route manifest", description: "Route manifest lookup table now precompiled at build time", deltaMs: -60, deltaPct: -3 },
    ],
    categories: CATEGORIES,
    embedder,
    threshold,
  });

  assert.equal(results[0].action, "created");
  assert.equal(results[1].action, "matched", `second entry should fold into the first's new category, got ${JSON.stringify(results[1])}`);
  assert.equal(results[1].category, results[0].category);
  assert.equal(categories.length, CATEGORIES.length + 1);
  const created = categories.find((c) => c.name === results[0].category);
  assert.equal(created.count, 2);
  assert.equal(created.avgImprovementMs, -70);
  assert.equal(created.avgImprovementPct, -3.5);
});

test("missing deltaMs folds count and pct but leaves ms average alone", async () => {
  const { embedder, threshold } = localSetup();
  const before = CATEGORIES.find((c) => c.name === "Tree Shaking");
  const { categories } = await categorizeImprovements({
    improvements: [{
      name: "Remove unused JavaScript",
      description: "Tree-shook the main bundle and dropped dead code",
      deltaPct: -10,
    }],
    categories: CATEGORIES,
    embedder,
    threshold,
  });
  const after = categories.find((c) => c.name === "Tree Shaking");
  assert.equal(after.count, before.count + 1);
  assert.equal(after.avgImprovementMs, before.avgImprovementMs);
  assert.notEqual(after.avgImprovementPct, before.avgImprovementPct);
});

test("rerankCategories orders by avg pct (most improvement first) and reassigns ranks", () => {
  const rows = [
    { name: "B", avgImprovementPct: -5, count: 10 },
    { name: "A", avgImprovementPct: -20, count: 1 },
    { name: "C", avgImprovementPct: -5, count: 20 },
  ];
  rerankCategories(rows);
  assert.deepEqual(rows.map((r) => r.name), ["A", "C", "B"]);
  assert.deepEqual(rows.map((r) => r.rank), [1, 2, 3]);
});

test("titleCaseCategoryName handles acronyms and small words", () => {
  assert.equal(titleCaseCategoryName("inline critical css"), "Inline Critical CSS");
  assert.equal(titleCaseCategoryName("preconnect to the font origin"), "Preconnect to the Font Origin");
  assert.equal(titleCaseCategoryName("serve avif and webp images"), "Serve AVIF and WebP Images");
  assert.equal(titleCaseCategoryName("  http2   server push  "), "HTTP/2 Server Push");
});
