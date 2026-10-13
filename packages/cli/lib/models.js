/**
 * The model catalog makefaster offers after the provider picker: up to five
 * models per provider, ranked by intelligence — plus the hosted provider's own
 * short list, which is ranked by nothing because the server decides what is on
 * it (see HOSTED_MODELS).
 *
 * Ranking source of truth is the CursorBench 3.2 snapshot (captured
 * 2026-07-16) that jjcm/bb-plugin-autorouter carries in `benchmarks.ts` as
 * `CURSOR_BENCHMARKS`:
 *   https://github.com/jjcm/bb-plugin-autorouter/blob/main/benchmarks.ts
 * That file scores family x reasoning-level pairs; FAMILY_BEST below keeps the
 * best score per family, which is what "most intelligent" means here. To
 * refresh the ranking, re-read that file and update FAMILY_BEST.
 *
 * The three providers do not share a model-id namespace, and none of the ids
 * here is invented:
 *
 *   Cursor       ids are *variants*: family plus reasoning effort plus an
 *                optional `-fast` twin, e.g. `claude-fable-5-thinking-medium`.
 *                They come from `cursor-agent --list-models`, and the picker
 *                intersects this catalog with that live list when it can run it.
 *   Claude Code  ids carry no effort suffix — reasoning is a separate field —
 *                and some carry a bracketed context parameter that is part of
 *                the id, e.g. `claude-opus-4-8[1m]`. This is bb's curated
 *                catalog (plugins/provider-claude-code/src/model-catalog-data.ts),
 *                which is exactly five rows.
 *   Codex        plain family ids from the app-server's `model/list`.
 *
 * A family the snapshot does not score is never given a made-up number: it
 * sorts after every scored model and says so. Codex only has four scored
 * families, so its fifth slot is filled from the live list or left empty.
 */

/**
 * The hosted provider's models — the ones the makefaster.dev proxy will spend
 * its OpenRouter credential on. The set is the server's, not this catalog's,
 * so these ids must match `AllowedModels` in backend/internal/inference. None
 * is in the CursorBench snapshot, so none carries a score.
 *
 * The ids are sent verbatim. The labels are for the picker. A single entry is
 * selected without a prompt; if the list grows, the first entry is the default.
 * Union Alpha is the free option.
 */
export const HOSTED_MODELS = Object.freeze([
  Object.freeze({
    id: "stealth/union-alpha",
    label: "Union Alpha (free)",
    detail: "free on OpenRouter via makefaster.dev",
  }),
]);

/**
 * Resolve a `--model` value for the hosted provider. Unlike the agent CLIs,
 * there is no passthrough: the proxy serves exactly these, so an id it does
 * not serve is a mistake to report rather than something to forward and have
 * refused mid-run. Matching is case-insensitive; the id that comes back is the
 * canonical one to send.
 *
 * @returns {{id: string, label: string, detail: string}|null} null when not offered
 */
export function resolveHostedModel(modelId) {
  const wanted = String(modelId ?? "").trim().toLowerCase();
  if (wanted === "") return null;
  return HOSTED_MODELS.find((model) => model.id.toLowerCase() === wanted) ?? null;
}

/** Best CursorBench 3.2 score per model family, and the effort it came from. */
export const FAMILY_BEST = new Map([
  ["claude-fable-5", { score: 70.5, reasoning: "max" }],
  ["gpt-5.6-sol", { score: 67.2, reasoning: "max" }],
  ["gpt-5.6-terra", { score: 64.9, reasoning: "max" }],
  ["claude-opus-4-8", { score: 62.3, reasoning: "max" }],
  ["claude-sonnet-5", { score: 61.5, reasoning: "max" }],
  ["gpt-5.6-luna", { score: 61.1, reasoning: "max" }],
  // grok-4.5 scores in the snapshot already carry the requested 10% reduction.
  ["grok-4.5", { score: 60.03, reasoning: "high" }],
  ["gpt-5.5", { score: 58.4, reasoning: "high" }],
  ["composer-2.5", { score: 56.1, reasoning: "medium" }],
]);

/**
 * Longest-match family lookup, so `claude-opus-4-8-thinking-medium` does not
 * resolve through a shorter family that happens to be a substring. A family
 * followed by another version number is a different model: `claude-fable-5-1`
 * and `claude-sonnet-5-5` must not borrow Fable 5's or Sonnet 5's score.
 */
export function benchmarkFamily(modelId) {
  const id = String(modelId).toLowerCase();
  let best = null;
  for (const family of FAMILY_BEST.keys()) {
    const at = id.indexOf(family);
    if (at === -1 || /^[-.]\d/.test(id.slice(at + family.length))) continue;
    if (best === null || family.length > best.length) best = family;
  }
  return best;
}

export function benchmarkScore(modelId) {
  const family = benchmarkFamily(modelId);
  return family === null ? null : FAMILY_BEST.get(family).score;
}

/**
 * Candidate models per provider, in each CLI's own order. Ranking happens in
 * modelsForProvider(); this list only decides what is on offer.
 */
const CANDIDATES = {
  // Cursor routes every family in the snapshot. bb's primary variants pin
  // medium effort, so these are the snapshot's top five at medium thinking.
  // Opus 5 and Grok 4.6 are newer than the snapshot: they are offered as
  // unscored candidates rather than ranked on a score they do not have.
  cursor: [
    { id: "claude-fable-5-thinking-medium", label: "Claude Fable 5 (thinking)" },
    { id: "gpt-5.6-sol-medium", label: "GPT-5.6 Sol" },
    { id: "gpt-5.6-terra-medium", label: "GPT-5.6 Terra" },
    { id: "claude-opus-4-8-thinking-medium", label: "Claude Opus 4.8 (thinking)" },
    { id: "claude-sonnet-5-thinking-medium", label: "Claude Sonnet 5 (thinking)" },
    { id: "claude-opus-5-thinking-medium", label: "Claude Opus 5 (thinking)" },
    { id: "cursor-grok-4.6-medium", label: "Cursor Grok 4.6" },
  ],
  // The current Claude Code lineup, five rows. Opus 5.5, Fable 5.1, Sonnet 5.5
  // and Opus 5 are newer than the snapshot, so they rank after Fable 5 rather
  // than on a score they do not have. Older ids still work through --model.
  claude: [
    { id: "claude-opus-5-5[1m]", label: "Opus 5.5 (1M)" },
    { id: "claude-fable-5-1", label: "Fable 5.1" },
    { id: "claude-sonnet-5-5", label: "Sonnet 5.5" },
    { id: "claude-fable-5", label: "Fable 5" },
    { id: "claude-opus-5[1m]", label: "Opus 5 (1M)" },
  ],
  // The GPT-6 families come from the app-server's own `model/list` and are
  // newer than the snapshot, so they rank after GPT-5.6 Sol, the best scored
  // one. An account without them gets them dropped and refilled from the live
  // list — never invented.
  codex: [
    { id: "gpt-6.1-sol", label: "GPT-6.1 Sol" },
    { id: "gpt-6-sol", label: "GPT-6 Sol" },
    { id: "gpt-6-astra", label: "GPT-6 Astra" },
    { id: "gpt-6-luna", label: "GPT-6 Luna" },
    { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
  ],
};

export const MAX_RECOMMENDATIONS = 5;

/**
 * The score ranks the *family*, not this exact id. The snapshot scores
 * family x effort pairs and FAMILY_BEST keeps each family's best, so saying
 * "@ max" next to an id that pins medium would misread as this variant's own
 * score.
 */
function describe(model) {
  if (model.score === null) return "not in the CursorBench 3.2 snapshot";
  return `CursorBench ${model.score} — best for ${model.family}`;
}

function annotate(candidate, order) {
  const family = benchmarkFamily(candidate.id);
  const best = family === null ? null : FAMILY_BEST.get(family);
  const model = {
    id: candidate.id,
    label: candidate.label,
    family,
    score: best === null ? null : best.score,
    reasoning: best === null ? null : best.reasoning,
    order,
  };
  return { ...model, detail: describe(model) };
}

function byIntelligence(a, b) {
  if (a.score === null && b.score === null) return a.order - b.order;
  if (a.score === null) return 1;
  if (b.score === null) return -1;
  return b.score - a.score || a.order - b.order;
}

/**
 * The provider's recommendations, most intelligent first.
 *
 * `live` is what the CLI itself reports, when makefaster could ask. Given one,
 * the catalog is reconciled against it rather than trusted blindly: ids the CLI
 * does not list are dropped (an account without Fable access should not be
 * offered Fable), and for a provider with fewer than five scored families the
 * remaining slots are filled from the live list. Without one, the static
 * catalog stands.
 *
 * @param {"cursor"|"claude"|"codex"} providerKey
 * @param {{live?: Array<{id: string, displayName?: string}>|null}} [options]
 * @returns {Array<{id: string, label: string, score: number|null, family: string|null, reasoning: string|null, detail: string}>}
 */
export function modelsForProvider(providerKey, { live = null } = {}) {
  const candidates = CANDIDATES[providerKey] || [];
  if (candidates.length === 0) return [];

  const liveIds = Array.isArray(live) && live.length > 0 ? new Map(live.map((entry) => [entry.id.toLowerCase(), entry])) : null;

  let offered = candidates.map(annotate);
  if (liveIds) {
    offered = offered.filter((model) => liveIds.has(model.id.toLowerCase()));
    // Fill from the live list only when the curated candidates cannot fill five,
    // preferring scored families so a fill is still an intelligence ranking.
    if (offered.length < MAX_RECOMMENDATIONS) {
      const known = new Set(offered.map((model) => model.id.toLowerCase()));
      const extras = [...liveIds.values()]
        .filter((entry) => !known.has(entry.id.toLowerCase()))
        .map((entry, index) => annotate({ id: entry.id, label: entry.displayName || entry.id }, candidates.length + index))
        .sort(byIntelligence);
      offered = [...offered, ...extras.slice(0, MAX_RECOMMENDATIONS - offered.length)];
    }
  }

  return offered
    .sort(byIntelligence)
    .slice(0, MAX_RECOMMENDATIONS)
    .map(({ order, ...model }) => model);
}

/**
 * The picker's rows: the model name and nothing else. The id slug, the
 * CursorBench score, and the "best for" copy stay out of the list — the row a
 * user scans is the name, and the id is confirmed right after the choice.
 *
 * @param {Array<{label: string}>} models
 * @returns {Array<{label: string}>}
 */
export function modelPickerOptions(models) {
  return models.map((model) => ({ label: model.label }));
}

/** The top-intelligence model for a provider — the picker's default highlight. */
export function defaultModelFor(providerKey, options) {
  return modelsForProvider(providerKey, options)[0] ?? null;
}

/**
 * Resolve a `--model` value. A catalog id (case-insensitive) comes back with its
 * label and score; anything else passes through untouched, so a model released
 * after this snapshot still works.
 */
export function resolveModel(providerKey, modelId, options) {
  const wanted = String(modelId).trim();
  if (wanted === "") return null;
  const known = modelsForProvider(providerKey, options).find((model) => model.id.toLowerCase() === wanted.toLowerCase());
  if (known) return known;
  const { order, ...model } = annotate({ id: wanted, label: wanted }, 0);
  return { ...model, passthrough: true };
}

/** Parse `cursor-agent --list-models` output: one `id - Display Name` per line. */
export function parseCursorModelList(output) {
  const models = [];
  for (const line of String(output).split(/\r?\n/)) {
    const match = /^\s*([A-Za-z0-9][\w.\-[\]]*)\s+-\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const [, id, displayName] = match;
    if (id === "auto") continue; // a router, not a model to rank
    models.push({ id, displayName });
  }
  return models;
}
