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
 *   - **choose a model.** The proxy pins it, so a model in the request would be
 *     discarded anyway. `--model` is not used by this provider.
 *   - **print anything.** Every line the user sees comes from the dashboard, and
 *     every step it shows comes from the model's own `report_step` calls or from
 *     results.json — the same contract every other provider follows.
 */

import { TOOL_SCHEMAS, createTools, describeToolCall } from "./tools.js";

/** The path the server exposes the OpenAI-compatible proxy on. */
export const CHAT_COMPLETIONS_PATH = "/api/openrouter/v1/chat/completions";

/**
 * Enough turns for a full loop — a baseline, a walk down the checklist and five
 * extras is a long conversation — and a hard stop so a model that gets stuck in
 * a tool cycle cannot bill forever.
 */
const MAX_TURNS = 400;

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
  "Stop when the skill says to stop, and say so with a final report_step. Do not ask",
  "questions, do not summarize instead of working, and never fabricate a measurement.",
].join("\n");

/**
 * @param {object} args
 * @param {object} args.provider
 * @param {string} args.prompt
 * @param {string} args.cwd
 * @param {string} args.apiBase makefaster server base, e.g. https://makefaster.dev
 * @param {{update: (entry: object|null) => void, done: () => void}} args.reporter
 * @param {AbortSignal} [args.signal]
 * @param {typeof fetch} [args.fetchImpl] test seam
 * @param {number} [args.maxTurns] test seam
 * @returns {Promise<{exitCode: number, stderrTail: string, aborted: boolean, authRequired: boolean, detail: string|null}>}
 */
export async function runOpenRouterSession({
  prompt,
  cwd,
  apiBase,
  reporter,
  signal,
  stepLogPath,
  fetchImpl = fetch,
  maxTurns = MAX_TURNS,
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
      response = await requestCompletion({ endpoint, messages, fetchImpl, signal });
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
 * One completion. No credential is sent — the server holds it — and no model is
 * named, because the server pins it.
 */
async function requestCompletion({ endpoint, messages, fetchImpl, signal }) {
  const res = await fetchImpl(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ messages, tools: TOOL_SCHEMAS, tool_choice: "auto", max_tokens: 8192 }),
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
