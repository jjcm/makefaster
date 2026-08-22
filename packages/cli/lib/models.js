/**
 * The model catalog makefaster offers after the provider picker: up to five
 * models per provider, ranked by intelligence.
 *
 * Ranking source of truth is the CursorBench 3.2 snapshot (captured
 * 2026-07-16) that jjcm/bb-plugin-autorouter carries in `benchmarks.ts` as
 * `CURSOR_BENCHMARKS`:
 *   https://github.com/jjcm/bb-plugin-autorouter/blob/main/benchmarks.ts
 * That file scores family x reasoning-level pairs; FAMILY_BEST below keeps the
 * best score per family, which is what "most intelligent" means here. To
 * refresh the ranking, re-read that file and update FAMILY_BEST — the per
 * provider lists stay as they are unless a CLI's own model list changed.
 *
 * Model ids are the strings each CLI actually accepts, not invented names:
 *   - Cursor      `cursor-agent --list-models` output (families x effort tails)
 *   - Claude Code the account-scoped catalog Claude Code reports at startup
 *   - Codex       `model/list` from `codex app-server`
 * Families the snapshot does not score are still offered when a provider has
 * fewer than five ranked models, but they sort last and say so.
 */

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
 * Longest-match family lookup, so `claude-opus-4-8-max` does not resolve
 * through a shorter family that happens to be a substring.
 */
export function benchmarkFamily(modelId) {
  const id = String(modelId).toLowerCase();
  let best = null;
  for (const family of FAMILY_BEST.keys()) {
    if (id.includes(family) && (best === null || family.length > best.length)) best = family;
  }
  return best;
}

export function benchmarkScore(modelId) {
  const family = benchmarkFamily(modelId);
  return family === null ? null : FAMILY_BEST.get(family).score;
}

/**
 * Candidate models per provider, in the order each CLI reports them. Ranking
 * happens in modelsForProvider(); this list only decides what is on offer.
 */
const CANDIDATES = {
  // Cursor routes every family in the snapshot, so its five are the snapshot's
  // top five, pinned to the effort tail the best score came from.
  cursor: [
    { id: "claude-fable-5-max", label: "Claude Fable 5 (max)" },
    { id: "gpt-5.6-sol-max", label: "GPT-5.6 Sol (max)" },
    { id: "gpt-5.6-terra-max", label: "GPT-5.6 Terra (max)" },
    { id: "claude-opus-4-8-max", label: "Claude Opus 4.8 (max)" },
    { id: "claude-sonnet-5-max", label: "Claude Sonnet 5 (max)" },
  ],
  // Anthropic-only. The snapshot scores three Claude families; Opus 5 and
  // Opus 4.7 fill out the five from Claude Code's own catalog, unscored.
  claude: [
    { id: "claude-fable-5", label: "Fable 5" },
    { id: "claude-opus-4-8[1m]", label: "Opus 4.8 (1M)" },
    { id: "claude-sonnet-5", label: "Sonnet 5" },
    { id: "claude-opus-5[1m]", label: "Opus 5 (1M)" },
    { id: "claude-opus-4-7[1m]", label: "Opus 4.7 (1M)" },
  ],
  // OpenAI-only. Four scored families plus GPT-5.2, the next model Codex lists.
  codex: [
    { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
    { id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
    { id: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
    { id: "gpt-5.5", label: "GPT-5.5" },
    { id: "gpt-5.2", label: "GPT-5.2" },
  ],
};

export const MAX_RECOMMENDATIONS = 5;

/**
 * The provider's recommendations, most intelligent first. Scored models sort
 * by CursorBench score descending; unscored ones keep their catalog order and
 * always sort after every scored model.
 *
 * @param {"cursor"|"claude"|"codex"} providerKey
 * @returns {Array<{id: string, label: string, score: number|null, family: string|null, reasoning: string|null, detail: string}>}
 */
export function modelsForProvider(providerKey) {
  const candidates = CANDIDATES[providerKey] || [];
  return candidates
    .map((candidate, order) => {
      const family = benchmarkFamily(candidate.id);
      const best = family === null ? null : FAMILY_BEST.get(family);
      return {
        id: candidate.id,
        label: candidate.label,
        family,
        score: best === null ? null : best.score,
        reasoning: best === null ? null : best.reasoning,
        order,
      };
    })
    .sort((a, b) => {
      if (a.score === null && b.score === null) return a.order - b.order;
      if (a.score === null) return 1;
      if (b.score === null) return -1;
      return b.score - a.score || a.order - b.order;
    })
    .slice(0, MAX_RECOMMENDATIONS)
    .map(({ order, ...model }) => ({ ...model, detail: modelDetail(model) }));
}

function modelDetail(model) {
  if (model.score === null) return "not in the CursorBench 3.2 snapshot";
  return `CursorBench ${model.score} — ${model.family} @ ${model.reasoning}`;
}

/** The top-intelligence model for a provider — the picker's default highlight. */
export function defaultModelFor(providerKey) {
  return modelsForProvider(providerKey)[0] ?? null;
}

/**
 * Resolve a `--model` value. A catalog id (case-insensitive) comes back with
 * its label and score; anything else passes through untouched so a user can
 * name a model this catalog does not list yet.
 */
export function resolveModel(providerKey, modelId) {
  const wanted = String(modelId).trim();
  if (wanted === "") return null;
  const known = modelsForProvider(providerKey).find((model) => model.id.toLowerCase() === wanted.toLowerCase());
  if (known) return known;
  const family = benchmarkFamily(wanted);
  const best = family === null ? null : FAMILY_BEST.get(family);
  return {
    id: wanted,
    label: wanted,
    family,
    score: best === null ? null : best.score,
    reasoning: best === null ? null : best.reasoning,
    detail: best === null ? "not in the CursorBench 3.2 snapshot" : `CursorBench ${best.score} — ${family} @ ${best.reasoning}`,
    passthrough: true,
  };
}
