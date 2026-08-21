import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  localEmbed,
  cosineSimilarity,
  createEmbedder,
  DEFAULT_MATCH_THRESHOLDS,
} from "../lib/embedding.mjs";
import { embeddingText } from "../lib/categorize.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CATEGORIES = JSON.parse(readFileSync(join(ROOT, "data", "improvements.json"), "utf8"));

test("localEmbed is deterministic and L2-normalized", () => {
  const a = localEmbed("Enable Brotli compression for text assets");
  const b = localEmbed("Enable Brotli compression for text assets");
  assert.deepEqual([...a], [...b]);
  let norm = 0;
  for (const v of a) norm += v * v;
  assert.ok(Math.abs(norm - 1) < 1e-9, `expected unit norm, got ${norm}`);
});

test("cosineSimilarity: identical texts are 1, empty is orthogonal-safe", () => {
  const a = localEmbed("inline critical css");
  assert.ok(Math.abs(cosineSimilarity(a, a) - 1) < 1e-9);
  const empty = localEmbed("");
  assert.equal(cosineSimilarity(a, empty), 0);
});

test("createEmbedder picks local backend without API key and honors threshold override", () => {
  const { embedder, threshold } = createEmbedder({}, { warn() {} });
  assert.equal(embedder.kind, "local");
  assert.equal(threshold, DEFAULT_MATCH_THRESHOLDS.local);

  const { threshold: overridden } = createEmbedder({ MAKEFASTER_MATCH_THRESHOLD: "0.62" });
  assert.equal(overridden, 0.62);
});

test("createEmbedder picks remote backend when a key is present", () => {
  const { embedder, threshold } = createEmbedder({ OPENAI_API_KEY: "sk-test" });
  assert.equal(embedder.kind, "remote");
  assert.equal(threshold, DEFAULT_MATCH_THRESHOLDS.remote);
});

/**
 * The load-bearing property: real-world paraphrases of known categories score
 * above the default local threshold against their category, and genuinely
 * novel improvements score below it against every category. This test pins
 * DEFAULT_MATCH_THRESHOLDS.local. Inputs mirror what the skill actually
 * submits: a short name plus a one-line description.
 */
const PARAPHRASES = [
  { name: "Enable Brotli on text assets", description: "Enabled Brotli compression for HTML, CSS and JS responses", expect: ["Gzip / Brotli Compression", "Enable Text Compression"] },
  { name: "Compress hero images", description: "Compressed and resized the oversized hero images", expect: ["Image Optimization"] },
  { name: "Remove unused JavaScript", description: "Tree-shook the main bundle and dropped dead code", expect: ["Tree Shaking"] },
  { name: "Inline critical CSS", description: "Inlined above-the-fold styles into the document head", expect: ["Inline Critical CSS"] },
  { name: "Lazy load below-fold images", description: "Deferred offscreen images with loading=lazy", expect: ["Lazy-Load Below-Fold Images"] },
  { name: "Defer third-party scripts", description: "Analytics and chat widgets now load after interactive", expect: ["Defer Third-Party Scripts"] },
  { name: "Subset web fonts", description: "Shipped only the glyphs the pages actually use", expect: ["Font Subsetting", "Font Optimization"] },
  { name: "Serve AVIF images", description: "Switched product images from JPEG to AVIF format", expect: ["AVIF / WebP Image Formats"] },
  { name: "Preload the LCP image", description: "Added a preload hint for the largest contentful paint image", expect: ["Preload LCP Image", "Resource Preloading"] },
  { name: "Preconnect to font origin", description: "Added preconnect hints for the font CDN origin", expect: ["Preconnect To Required Origins"] },
  { name: "Enable gzip on API responses", description: "Turned on gzip text compression for JSON API responses", expect: ["Gzip / Brotli Compression", "Enable Text Compression"] },
  { name: "Split bundle by route", description: "Split the vendor bundle along navigation route boundaries", expect: ["Code Splitting By Route"] },
  { name: "Add service worker caching", description: "Cache the app shell and static assets for repeat visits", expect: ["Service Worker Caching"] },
  { name: "Immutable cache for hashed assets", description: "Set long cache lifetimes on content-hashed static assets", expect: ["Content-Hashed Immutable Assets", "Cache Header Improvements"] },
  { name: "Resize images at the CDN edge", description: "Moved image resizing and recompression to the edge", expect: ["Image CDN Transformations"] },
];

const NOVEL = [
  { name: "Rewrite ORM in Rust", description: "Rewrote the ORM data layer in Rust" },
  { name: "Upgrade database hardware", description: "Upgraded the Postgres instance to a bigger machine" },
  { name: "Buy a faster office chair", description: "Bought a faster office chair for the developers" },
  { name: "Disable debug logging", description: "Disabled verbose debug logging in production" },
  { name: "Migrate newsletter vendor", description: "Migrated the newsletter signup to a new vendor" },
  { name: "Refactor checkout state machine", description: "Refactored the checkout state machine for clarity" },
  { name: "Add dark mode", description: "Added dark mode support to the settings screen" },
];

function bestMatch(item) {
  const vector = localEmbed(embeddingText(item));
  let best = { name: null, similarity: -Infinity };
  for (const category of CATEGORIES) {
    const similarity = cosineSimilarity(vector, localEmbed(embeddingText(category)));
    if (similarity > best.similarity) best = { name: category.name, similarity };
  }
  return best;
}

test("paraphrases of known categories clear the local threshold at the right category", () => {
  for (const { expect, ...item } of PARAPHRASES) {
    const best = bestMatch(item);
    assert.ok(
      best.similarity >= DEFAULT_MATCH_THRESHOLDS.local,
      `"${item.name}" best=${best.name} sim=${best.similarity.toFixed(3)} — below threshold ${DEFAULT_MATCH_THRESHOLDS.local}`,
    );
    assert.ok(
      expect.includes(best.name),
      `"${item.name}" matched "${best.name}" (sim ${best.similarity.toFixed(3)}), expected one of: ${expect.join(", ")}`,
    );
  }
});

test("novel improvements stay below the local threshold against every category", () => {
  for (const item of NOVEL) {
    const best = bestMatch(item);
    assert.ok(
      best.similarity < DEFAULT_MATCH_THRESHOLDS.local,
      `"${item.name}" unexpectedly matched "${best.name}" at sim=${best.similarity.toFixed(3)} (threshold ${DEFAULT_MATCH_THRESHOLDS.local})`,
    );
  }
});
