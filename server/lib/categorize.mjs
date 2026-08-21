/**
 * Fold submitted improvements into the improvement-category leaderboard.
 *
 * Every incoming improvement is embedded (name + description) and compared to
 * every current category by cosine similarity:
 *
 *  - similarity >= threshold  -> increment that category's count and fold the
 *    submitted deltas into its running averages;
 *  - below threshold          -> the improvement is novel: a new category is
 *    created on the leaderboard, seeded from the submission.
 *
 * Improvements inside one submission are processed sequentially against the
 * growing category list, so two novel-but-similar entries in the same payload
 * create one category, not two.
 */

import { cosineSimilarity } from "./embedding.mjs";

const NAME_MAX = 80;
const DESCRIPTION_MAX = 160;

const SMALL_WORDS = new Set([
  "a", "an", "and", "as", "at", "by", "for", "in", "of", "on", "or", "the",
  "to", "via", "vs", "with",
]);

const ACRONYMS = new Map(Object.entries({
  css: "CSS", js: "JS", html: "HTML", http: "HTTP", http2: "HTTP/2",
  http3: "HTTP/3", api: "API", apis: "APIs", cdn: "CDN", svg: "SVG",
  dom: "DOM", ssr: "SSR", csr: "CSR", lcp: "LCP", fcp: "FCP", tti: "TTI",
  tbt: "TBT", inp: "INP", cls: "CLS", ttfb: "TTFB", quic: "QUIC",
  avif: "AVIF", webp: "WebP", json: "JSON", url: "URL", urls: "URLs",
  ui: "UI", db: "DB", sql: "SQL", spa: "SPA", pwa: "PWA", srcset: "srcset",
}));

/**
 * "inline critical css" -> "Inline Critical CSS". Words the submitter already
 * capitalized beyond the first letter (ORM, WebP, LCP) are preserved as-is.
 */
export function titleCaseCategoryName(raw) {
  const words = String(raw).trim().replace(/\s+/g, " ").split(" ");
  return words
    .map((word, i) => {
      if (/[A-Z]/.test(word.slice(1))) return word;
      const lower = word.toLowerCase();
      if (ACRONYMS.has(lower)) return ACRONYMS.get(lower);
      if (i > 0 && i < words.length - 1 && SMALL_WORDS.has(lower)) return lower;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ")
    .slice(0, NAME_MAX);
}

/**
 * The text a category or improvement is embedded from. The name is doubled so
 * name tokens outweigh description tokens.
 */
export function embeddingText({ name, description }) {
  const desc = description ? String(description) : "";
  return `${name}. ${name}. ${desc}`;
}

function roundMs(value) {
  return Math.round(value);
}

function roundPct(value) {
  return Math.round(value * 10) / 10;
}

/**
 * Running-average fold. `count` approximates the sample count for both
 * metrics; submissions that omit one delta leave that average untouched,
 * which slightly over-weights history for that metric — acceptable for a
 * leaderboard, and it avoids tracking per-metric sample counts.
 */
function foldIntoCategory(category, improvement) {
  const previousCount = category.count;
  category.count = previousCount + 1;
  if (typeof improvement.deltaMs === "number") {
    const prevAvg = typeof category.avgImprovementMs === "number" ? category.avgImprovementMs : 0;
    category.avgImprovementMs = roundMs(
      (prevAvg * previousCount + improvement.deltaMs) / (previousCount + 1),
    );
  }
  if (typeof improvement.deltaPct === "number") {
    const prevAvg = typeof category.avgImprovementPct === "number" ? category.avgImprovementPct : 0;
    category.avgImprovementPct = roundPct(
      (prevAvg * previousCount + improvement.deltaPct) / (previousCount + 1),
    );
  }
}

function createCategoryFrom(improvement) {
  return {
    rank: 0, // assigned by rerankCategories below
    name: titleCaseCategoryName(improvement.name),
    description: String(improvement.description || "").trim().slice(0, DESCRIPTION_MAX)
      || `Community-submitted: ${titleCaseCategoryName(improvement.name)}`,
    count: 1,
    avgImprovementMs: typeof improvement.deltaMs === "number" ? roundMs(improvement.deltaMs) : 0,
    avgImprovementPct: typeof improvement.deltaPct === "number" ? roundPct(improvement.deltaPct) : 0,
    icon: "default",
  };
}

/**
 * Leaderboard order: biggest average improvement first (deltas are negative,
 * so ascending pct), count breaks ties, then name for stability.
 */
export function rerankCategories(categories) {
  categories.sort((a, b) => {
    const pctA = typeof a.avgImprovementPct === "number" ? a.avgImprovementPct : 0;
    const pctB = typeof b.avgImprovementPct === "number" ? b.avgImprovementPct : 0;
    if (pctA !== pctB) return pctA - pctB;
    if (a.count !== b.count) return b.count - a.count;
    return a.name.localeCompare(b.name);
  });
  categories.forEach((category, i) => {
    category.rank = i + 1;
  });
  return categories;
}

/**
 * @param {object} args
 * @param {Array<{name: string, description?: string, deltaMs?: number, deltaPct?: number}>} args.improvements
 * @param {Array<object>} args.categories current leaderboard rows (not mutated)
 * @param {{id: string, embedMany(texts: string[]): Promise<Float64Array[]>}} args.embedder
 * @param {number} args.threshold cosine similarity at/above which we fold
 * @returns {Promise<{categories: Array<object>, results: Array<object>}>}
 */
export async function categorizeImprovements({ improvements, categories, embedder, threshold }) {
  const working = categories.map((category) => ({ ...category }));

  const texts = [
    ...working.map((category) => embeddingText(category)),
    ...improvements.map((improvement) => embeddingText(improvement)),
  ];
  const vectors = await embedder.embedMany(texts);
  const categoryVectors = vectors.slice(0, working.length);
  const improvementVectors = vectors.slice(working.length);

  const results = [];
  improvements.forEach((improvement, i) => {
    const vector = improvementVectors[i];
    let bestIndex = -1;
    let bestSimilarity = -Infinity;
    categoryVectors.forEach((categoryVector, j) => {
      const similarity = cosineSimilarity(vector, categoryVector);
      if (similarity > bestSimilarity) {
        bestSimilarity = similarity;
        bestIndex = j;
      }
    });

    if (bestIndex !== -1 && bestSimilarity >= threshold) {
      foldIntoCategory(working[bestIndex], improvement);
      results.push({
        input: improvement.name,
        action: "matched",
        category: working[bestIndex].name,
        similarity: Math.round(bestSimilarity * 1000) / 1000,
      });
    } else {
      const category = createCategoryFrom(improvement);
      working.push(category);
      categoryVectors.push(vector);
      results.push({
        input: improvement.name,
        action: "created",
        category: category.name,
        similarity: bestIndex === -1 ? 0 : Math.round(bestSimilarity * 1000) / 1000,
      });
    }
  });

  rerankCategories(working);
  return { categories: working, results };
}
