/**
 * The hosted provider: makefaster's own agent loop, running on the model proxy
 * at `<api base>/api/openrouter/v1`.
 *
 * The other three providers are agent products driven as protocol children
 * (see lib/invoke.js). This one has no child and no product: the CLI holds the
 * conversation itself, hands the model a small set of tools (lib/agents/tools.js)
 * and runs its calls, so a machine with no Cursor/Claude/Codex install can still
 * run the loop.
 *
 * What this file deliberately does NOT do:
 *
 *   - **hold a credential.** It sends no `authorization` header and reads no
 *     `OPENROUTER_API_KEY`. The server has the key; the CLI has a URL.
 *   - **decide which models exist.** It names the one the user picked, and the
 *     proxy refuses anything outside its own allowlist — so the choice is real
 *     but the set of choices is the server's (see lib/models.js).
 *   - **print anything.** Every line the user sees comes from the dashboard, and
 *     every step it shows comes from the model's own `report_step` calls or from
 *     results.json — the same contract every other provider follows.
 */

import { TOOL_SCHEMAS, createTools, describeToolCall } from "./tools.js";

/** The path the server exposes the OpenAI-compatible proxy on. */
export const CHAT_COMPLETIONS_PATH = "/api/openrouter/v1/chat/completions";

/**
 * The runaway guard, and the only thing on this side that can end a session
 * early — so it is sized from the run rather than fixed. A measured iteration
 * costs a handful of turns (read, edit, build, measure, record), and the walk is
 * as long as the board is, so a flat ceiling silently truncated the checklist on
 * any site with a real one.
 *
 * The ceiling is still a ceiling: a model stuck in a tool cycle cannot bill
 * forever.
 */
const BASE_TURNS = 120;
const TURNS_PER_RUN = 40;
const TURN_CEILING = 4000;

export function turnBudget(plannedRuns) {
  const runs = Number.isFinite(plannedRuns) && plannedRuns > 0 ? Math.floor(plannedRuns) : 5;
  return Math.min(TURN_CEILING, BASE_TURNS + runs * TURNS_PER_RUN);
}

/** How many messages of history to keep before dropping the oldest results. */
const MAX_HISTORY = 80;

const SYSTEM_PROMPT = [
  "You are the makefaster performance loop, running headless inside a user's repository.",
  "",
  "You have no terminal and no user to ask: nothing you do may wait for input. Work only",
  "through the tools you were given, and take the whole task to completion in this one",
  "session — read .makefaster/SKILL.md first and follow it exactly.",
  "",
  "Two things the user actually sees:",
  "  1. call report_step at the start of every step — that file IS the dashboard, and a",
  "     silent run looks like a hung one;",
  "  2. keep .makefaster/results.json valid after every iteration — it is the only record",
  "     that survives you, and the CLI reads it the moment you stop.",
  "",
  "The session is the whole imported checklist plus the few extras the skill allows you",
  "at the end — not the first handful of experiments. Iterations that revert are normal",
  "and are not a reason to stop; there is no miss limit.",
  "",
  "Stop when the skill says to stop, and say so with a final report_step. Do not ask",
  "questions, do not summarize instead of working, and never fabricate a measurement.",
].join("\n");

/**
 * @param {object} args
 * @param {object} args.provider
 * @param {string} args.prompt
 * @param {string} args.cwd
 * @param {string} args.apiBase makefaster server base, e.g. https://makefaster.dev
 * @param {{id: string}|null} [args.model] the allowlisted model the user picked
 * @param {{update: (entry: object|null) => void, done: () => void}} args.reporter
 * @param {AbortSignal} [args.signal]
 * @param {number|null} [args.plannedRuns] measured iterations this session should hold
 * @param {typeof fetch} [args.fetchImpl] test seam
 * @param {number} [args.maxTurns] test seam
 * @returns {Promise<{exitCode: number, stderrTail: string, aborted: boolean, authRequired: boolean, detail: string|null}>}
 */
export async function runOpenRouterSession({
  prompt,
  cwd,
  apiBase,
  model = null,
  reporter,
  signal,
  stepLogPath,
  plannedRuns = null,
  fetchImpl = fetch,
  maxTurns = turnBudget(plannedRuns),
}) {
  const endpoint = `${String(apiBase || "").replace(/\/$/, "")}${CHAT_COMPLETIONS_PATH}`;
  const tools = createTools({ cwd, stepLogPath, signal });
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: prompt },
  ];

  const stop = (patch) => ({ exitCode: 0, stderrTail: "", aborted: false, authRequired: false, detail: null, ...patch });

  for (let turn = 0; turn < maxTurns; turn++) {
    if (signal?.aborted) return stop({ aborted: true });

    let response;
    try {
      response = await requestCompletion({ endpoint, messages, model, fetchImpl, signal });
    } catch (err) {
      if (signal?.aborted) return stop({ aborted: true });
      return stop({ exitCode: 1, stderrTail: err.message, detail: err.message });
    }

    const message = response.choices?.[0]?.message;
    if (!message) {
      const detail = "the model returned no message — the hosted model may be unavailable right now";
      return stop({ exitCode: 1, stderrTail: detail, detail });
    }

    // Assistant prose is not shown anywhere: the panel is the step log. It is
    // kept in the history because it is the model's own reasoning trail.
    messages.push(message);
    reporter?.update?.({ tag: "EXECUTE", text: labelFor(message) });

    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    if (calls.length === 0) {
      // No tool calls means the model has stopped working. Its final prose is
      // not the deliverable — results.json is — so the session ends here.
      reporter?.done?.();
      return stop({});
    }

    for (const call of calls) {
      if (signal?.aborted) return stop({ aborted: true });
      const name = call?.function?.name;
      const input = parseArguments(call?.function?.arguments);
      reporter?.update?.({ tag: "EXECUTE", text: describeToolCall(name, input) });

      const tool = tools[name];
      const result = tool
        ? await tool(input).catch((err) => ({ ok: false, text: `error: ${err.message}` }))
        : { ok: false, text: `error: no such tool "${name}"` };

      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: result.text,
      });
    }

    trimHistory(messages);
  }

  const detail = `the hosted model ran ${maxTurns} turns without finishing; stopping so it cannot bill further`;
  return stop({ exitCode: 1, stderrTail: detail, detail });
}

/**
 * One completion. No credential is sent — the server holds it — and the model is
 * the id the user picked, verbatim: the proxy allowlists what it will serve, so
 * an id it does not know comes back as a refusal rather than a surprise bill.
 * Omitting it lets the server use its own default.
 */
async function requestCompletion({ endpoint, messages, model, fetchImpl, signal }) {
  const payload = { messages, tools: TOOL_SCHEMAS, tool_choice: "auto", max_tokens: 8192 };
  if (model?.id) payload.model = model.id;

  const res = await fetchImpl(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(payload),
    signal,
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const reason = Array.isArray(body?.errors)
      ? body.errors.join("; ")
      : body?.error?.message || `HTTP ${res.status}`;
    throw new Error(`the hosted model refused the request: ${reason}`);
  }
  return body;
}

function parseArguments(raw) {
  if (raw === undefined || raw === null) return {};
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/** The heartbeat label for a turn; never shown in the thinking panel. */
function labelFor(message) {
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls.length : 0;
  if (calls > 0) return `planning ${calls} tool call${calls === 1 ? "" : "s"}`;
  return "writing a reply";
}

/**
 * Keep the conversation bounded. The system prompt and the kickoff instruction
 * are never dropped — they are the whole contract — and history is cut at a
 * message that does not orphan a tool result from its call.
 */
function trimHistory(messages) {
  if (messages.length <= MAX_HISTORY) return;
  const keepFrom = messages.length - (MAX_HISTORY - 2);
  let cut = keepFrom;
  while (cut < messages.length && messages[cut].role === "tool") cut++;
  messages.splice(2, cut - 2);
}
