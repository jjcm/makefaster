/**
 * Text embeddings for improvement-category matching.
 *
 * Two backends behind one interface:
 *
 *  - local  — a deterministic feature-hashing embedder (signed hashed words,
 *             word bigrams, and character n-grams, L2-normalized). No model
 *             download, no GPU, no network. Good enough to match short
 *             "what I sped up" blurbs against category names + descriptions.
 *  - remote — any OpenAI-compatible /v1/embeddings endpoint, enabled by
 *             setting MAKEFASTER_EMBEDDINGS_API_KEY (or OPENAI_API_KEY).
 *             Model defaults to text-embedding-3-small; override with
 *             MAKEFASTER_EMBEDDINGS_MODEL / MAKEFASTER_EMBEDDINGS_BASE_URL.
 *
 * Nothing is persisted in embedding space: every request embeds the incoming
 * improvements AND the current categories with the same backend, so the two
 * backends can never be compared against each other's vectors. If the remote
 * backend fails mid-request we fall back to local for the whole request.
 */

// Short texts carry few word features, so hash collisions are the noise
// floor; 4096 dims keeps random cross-text collisions negligible while a
// 50-category board still fits in ~1.6 MB of vectors.
const LOCAL_DIMS = 4096;
const REMOTE_TIMEOUT_MS = 10_000;
const DEFAULT_REMOTE_MODEL = "text-embedding-3-small";
const DEFAULT_REMOTE_BASE_URL = "https://api.openai.com/v1";

/**
 * Cosine-similarity thresholds above which an incoming improvement is folded
 * into an existing category instead of creating a new one. The local value is
 * pinned by the paraphrase/novel separation tests in embedding.test.mjs.
 */
export const DEFAULT_MATCH_THRESHOLDS = { local: 0.3, remote: 0.55 };

/**
 * Words so generic in performance-speak that they match everything. They are
 * dropped before hashing so "Improve image loading speed" is matched on
 * image/loading, not on improve/speed.
 */
const STOPWORDS = new Set([
  "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "by", "at",
  "from", "into", "via", "the", "our", "your", "their", "its", "is", "are",
  "was", "were", "be", "been", "it", "this", "that", "these", "those", "as",
  "we", "you", "i", "using", "use", "used", "uses", "make", "makes", "made",
  "making", "improve", "improved", "improves", "improvement", "improvements",
  "optimize", "optimized", "optimizes", "optimization", "optimizations",
  "reduce", "reduced", "reduces", "reducing", "better", "faster", "fast",
  "slow", "slower", "speed", "speedup", "site", "sites", "website",
  "websites", "page", "pages", "web", "app", "apps", "perf", "performance",
  "now", "all", "more", "less", "new", "old", "time", "times",
]);

function fnv1a(str, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Very light suffix stemming so plural/verb forms hash to the same word
 * feature (fonts/font, caching/cache/cached, subsetting/subset, images/image)
 * without dragging in a stemming dependency. Char n-grams still bridge the
 * forms this misses (compression/compress).
 */
function stem(token) {
  let t = token;
  if (t.length > 5 && t.endsWith("ing")) t = t.slice(0, -3);
  else if (t.length > 4 && t.endsWith("ies")) t = `${t.slice(0, -3)}y`;
  else if (t.length > 4 && t.endsWith("ed")) t = t.slice(0, -2);
  else if (t.length > 4 && t.endsWith("es")) t = t.slice(0, -2);
  else if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss")) t = t.slice(0, -1);
  if (t.length > 3 && t[t.length - 1] === t[t.length - 2]) t = t.slice(0, -1); // subsett -> subset
  if (t.length > 4 && t.endsWith("e")) t = t.slice(0, -1); // cache/caching -> cach
  return t;
}

function tokenize(text) {
  const raw = String(text).toLowerCase().match(/[a-z0-9]+/g) || [];
  return raw.filter((t) => t.length >= 2 && !STOPWORDS.has(t)).map(stem);
}

function addFeature(vector, feature, weight) {
  const index = fnv1a(feature, 0x811c9dc5) % LOCAL_DIMS;
  const sign = fnv1a(feature, 0x9747b28c) & 1 ? 1 : -1;
  vector[index] += sign * weight;
}

/**
 * Deterministic local embedding: signed feature hashing over word unigrams,
 * word bigrams, and per-token character 3/4-grams (word-boundary marked so
 * "compress"/"compression" overlap without random cross-word grams).
 */
export function localEmbed(text) {
  const vector = new Float64Array(LOCAL_DIMS);
  const tokens = tokenize(text);

  for (const token of tokens) {
    addFeature(vector, `w:${token}`, 2.0);
    // Char n-grams only bridge morphology the stemmer misses, so they carry
    // little weight — heavier grams let unrelated texts collide.
    const padded = `^${token}$`;
    for (let n = 3; n <= 4; n++) {
      for (let i = 0; i + n <= padded.length; i++) {
        addFeature(vector, `c${n}:${padded.slice(i, i + n)}`, n === 3 ? 0.35 : 0.5);
      }
    }
  }
  for (let i = 0; i + 1 < tokens.length; i++) {
    addFeature(vector, `b:${tokens[i]}_${tokens[i + 1]}`, 1.5);
  }

  return l2Normalize(vector);
}

function l2Normalize(vector) {
  let sumSquares = 0;
  for (const v of vector) sumSquares += v * v;
  if (sumSquares === 0) return vector;
  const inv = 1 / Math.sqrt(sumSquares);
  for (let i = 0; i < vector.length; i++) vector[i] *= inv;
  return vector;
}

/** Cosine similarity of two L2-normalized vectors (plain dot product). */
export function cosineSimilarity(a, b) {
  if (a.length !== b.length) {
    throw new Error(`cosineSimilarity: dimension mismatch ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

function createLocalEmbedder() {
  const cache = new Map();
  return {
    id: "local-hash-v1",
    kind: "local",
    async embedMany(texts) {
      return texts.map((text) => {
        let vector = cache.get(text);
        if (!vector) {
          vector = localEmbed(text);
          cache.set(text, vector);
        }
        return vector;
      });
    },
  };
}

async function requestRemoteEmbeddings({ baseUrl, apiKey, model, texts }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REMOTE_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, input: texts }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`embeddings API responded ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = await res.json();
    if (!Array.isArray(json.data) || json.data.length !== texts.length) {
      throw new Error("embeddings API returned an unexpected payload shape");
    }
    const byIndex = [...json.data].sort((a, b) => a.index - b.index);
    return byIndex.map((entry) => l2Normalize(Float64Array.from(entry.embedding)));
  } finally {
    clearTimeout(timer);
  }
}

function createRemoteEmbedder({ apiKey, baseUrl, model, logger }) {
  const cache = new Map();
  const local = createLocalEmbedder();
  return {
    id: `remote:${model}`,
    kind: "remote",
    async embedMany(texts) {
      const missing = texts.filter((text) => !cache.has(text));
      if (missing.length > 0) {
        let vectors;
        try {
          vectors = await requestRemoteEmbeddings({ baseUrl, apiKey, model, texts: missing });
        } catch (err) {
          // Whole-request fallback keeps every comparison inside one
          // embedding space; cached remote vectors are simply unused.
          logger?.warn?.(`remote embeddings failed (${err.message}); falling back to local embedder for this request`);
          return local.embedMany(texts);
        }
        missing.forEach((text, i) => cache.set(text, vectors[i]));
      }
      return texts.map((text) => cache.get(text));
    },
  };
}

/**
 * Pick the embedding backend from the environment. Also resolves the match
 * threshold: MAKEFASTER_MATCH_THRESHOLD overrides the per-backend default.
 */
export function createEmbedder(env = process.env, logger = console) {
  const apiKey = env.MAKEFASTER_EMBEDDINGS_API_KEY || env.OPENAI_API_KEY;
  const embedder = apiKey
    ? createRemoteEmbedder({
        apiKey,
        baseUrl: env.MAKEFASTER_EMBEDDINGS_BASE_URL || DEFAULT_REMOTE_BASE_URL,
        model: env.MAKEFASTER_EMBEDDINGS_MODEL || DEFAULT_REMOTE_MODEL,
        logger,
      })
    : createLocalEmbedder();

  const override = Number.parseFloat(env.MAKEFASTER_MATCH_THRESHOLD || "");
  const threshold = Number.isFinite(override) && override > 0 && override < 1
    ? override
    : DEFAULT_MATCH_THRESHOLDS[embedder.kind];

  return { embedder, threshold };
}
