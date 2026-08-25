/**
 * The hidden agent's reasoning, captured to `.makefaster/thinking-trace.jsonl`.
 *
 * This is NOT `.makefaster/thinking.log`. That file is the agent's own
 * user-facing report — one tagged line per step, written on purpose, and the
 * only thing the dashboard shows (see stepLog.js). This file is the other
 * thing: the thinking text the provider's protocol stream carries and that
 * makefaster otherwise collapses into the word "thinking" and throws away.
 *
 * Nothing reads it during a run. It exists so the end screen can offer to
 * submit the round's chain of thought — a separate, explicit yes — and it is
 * written under `.makefaster/`, which the session already excludes from git.
 *
 * What goes in: reasoning text, in order, and nothing else. Tool calls, tool
 * results, file contents and command output are not thinking, so no extractor
 * below reads them and the caps make an accidental log dump impossible anyway.
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

/** One block of reasoning; longer than this is a transcript, not a thought. */
export const MAX_BLOCK_CHARS = 8_000;

/** How many blocks one round may record. */
export const MAX_BLOCKS = 400;

/** The whole file's ceiling, so a chatty model cannot fill a disk. */
export const MAX_TOTAL_CHARS = 200_000;

/** Chunks this far apart are separate thoughts rather than one being streamed. */
const COALESCE_GAP_MS = 4_000;

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(textOf).filter(Boolean).join("");
  if (content && typeof content === "object" && typeof content.text === "string") return content.text;
  return "";
}

/**
 * The reasoning text in one parsed stream event, or null when the event is not
 * a thought. Every branch reads a field the provider documents as reasoning —
 * never a tool result, a diff, or a command's output.
 *
 * @param {string} streamFormat "acp", "claude-stream-json", "codex-app-server",
 *   "codex-jsonl", or "openai-message" (the hosted provider's own completions)
 * @param {unknown} event
 * @returns {string|null}
 */
export function thinkingTextOf(streamFormat, event) {
  if (!event || typeof event !== "object") return null;
  const text = extract(streamFormat, event);
  // Returned verbatim, not trimmed: reasoning arrives as deltas and the spaces
  // between them are part of the sentence. The block is trimmed when it closes.
  return typeof text === "string" && text.trim() !== "" ? text : null;
}

function extract(streamFormat, event) {
  switch (streamFormat) {
    case "acp":
      return event.sessionUpdate === "agent_thought_chunk" ? textOf(event.content) : null;

    case "claude-stream-json": {
      if (event.type !== "assistant") return null;
      const blocks = event.message?.content;
      if (!Array.isArray(blocks)) return null;
      // `redacted_thinking` is deliberately skipped: it is an encrypted blob,
      // not text, and it is not ours to try to unwrap.
      return blocks
        .filter((block) => block && block.type === "thinking")
        .map((block) => (typeof block.thinking === "string" ? block.thinking : textOf(block)))
        .filter(Boolean)
        .join("\n")
        || null;
    }

    case "codex-app-server": {
      const method = String(event.method || "");
      if (method === "item/reasoning/delta") return textOf(event.params?.delta);
      if (/^item\/(started|updated|completed)$/.test(method)) {
        const item = event.params?.item;
        return item && item.type === "reasoning" ? textOf(item.text ?? item.summary) : null;
      }
      return null;
    }

    case "codex-jsonl": {
      const inner = event.msg && typeof event.msg === "object" ? event.msg : event;
      const item = inner.item && typeof inner.item === "object" ? inner.item : null;
      if (item && /reasoning/.test(String(item.item_type || item.type || ""))) {
        return textOf(item.text ?? item.summary);
      }
      return /^agent_reasoning/.test(String(inner.type || "")) ? textOf(inner.delta ?? inner.text) : null;
    }

    // The hosted provider holds the conversation itself, so its "event" is an
    // assistant message. OpenRouter puts reasoning in one of three shapes
    // depending on the upstream model.
    case "openai-message": {
      if (typeof event.reasoning === "string") return event.reasoning;
      if (typeof event.reasoning_content === "string") return event.reasoning_content;
      return Array.isArray(event.reasoning_details) ? textOf(event.reasoning_details) : null;
    }

    default:
      return null;
  }
}

/**
 * A trace file, open for one round.
 *
 * Providers stream reasoning as many small chunks, so chunks that arrive back
 * to back are one block: `record` appends into an open buffer and `flush`
 * closes it. The reporter decoration below flushes on the first event that is
 * not a thought, which is exactly where one block of reasoning ends.
 *
 * A chunk that contains everything already buffered is a cumulative snapshot
 * rather than a continuation (some providers send both the deltas and the
 * finished text), so it replaces the buffer instead of doubling it.
 *
 * @param {object} args
 * @param {string} args.path
 * @param {() => number} [args.clock] test seam
 */
export function openThinkingTrace({ path, clock = Date.now }) {
  let buffer = "";
  let lastAt = 0;
  let blocks = 0;
  let chars = 0;
  let dropped = 0;

  function full() {
    return blocks >= MAX_BLOCKS || chars >= MAX_TOTAL_CHARS;
  }

  function flush() {
    const text = buffer.trim();
    buffer = "";
    if (text === "") return;
    if (full()) {
      dropped += 1;
      return;
    }
    const entry = { seq: blocks + 1, at: new Date(clock()).toISOString(), text: text.slice(0, MAX_BLOCK_CHARS) };
    try {
      appendFileSync(path, JSON.stringify(entry) + "\n");
    } catch {
      return; // a trace nobody asked for yet must never break the run
    }
    blocks += 1;
    chars += entry.text.length;
  }

  return {
    /** @param {string|null|undefined} text */
    record(text) {
      if (typeof text !== "string" || text.trim() === "") return;
      const now = clock();
      if (buffer !== "" && now - lastAt > COALESCE_GAP_MS) flush();
      lastAt = now;

      if (buffer !== "" && text.startsWith(buffer)) buffer = text;
      else if (buffer !== "" && buffer.endsWith(text)) return;
      else buffer += text;

      if (buffer.length >= MAX_BLOCK_CHARS) flush();
    },
    flush,
    close() {
      flush();
    },
    get stats() {
      return { blocks, chars, dropped };
    },
  };
}

/**
 * Wrap a reporter so the trace fills itself from the same stream the progress
 * line already consumes. `thought` is what the agent modules call with raw
 * reasoning text; `update` keeps its existing meaning and doubles as the block
 * boundary, because an event that is not a thought means the thought ended.
 *
 * The wrapper is transparent: `eventCount` and `lastLabel` still come from the
 * reporter underneath, so the dashboard and the plain progress line behave
 * exactly as they did.
 *
 * @param {{update: Function, done: Function}} reporter
 * @param {{record: Function, flush: Function}} trace
 */
export function withThinkingTrace(reporter, trace) {
  return {
    get eventCount() {
      return reporter.eventCount;
    },
    get lastLabel() {
      return reporter.lastLabel;
    },
    update(entry) {
      const tag = entry && typeof entry === "object" ? entry.tag : null;
      if (tag !== "HYPOTHESIS") trace.flush();
      reporter.update(entry);
    },
    thought(text) {
      trace.record(text);
    },
    done() {
      trace.flush();
      reporter.done?.();
    },
  };
}

/**
 * Read a trace back as ordered blocks. Unparseable lines are skipped rather
 * than failing: the file is appended to by a live run, so the last line may be
 * half-written when a round is stopped.
 *
 * @param {string} path
 * @returns {Array<{at: string, text: string}>}
 */
export function readThinkingTrace(path) {
  if (!existsSync(path)) return [];
  let contents;
  try {
    contents = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const blocks = [];
  for (const line of contents.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const text = typeof entry?.text === "string" ? entry.text.trim() : "";
    if (text === "") continue;
    blocks.push({ at: typeof entry.at === "string" ? entry.at : "", text });
  }
  return blocks;
}

/** Start a round on an empty trace rather than replaying the last one. */
export function resetThinkingTrace(path) {
  try {
    writeFileSync(path, "");
  } catch {
    /* the trace is best-effort; a run must not fail over it */
  }
}
