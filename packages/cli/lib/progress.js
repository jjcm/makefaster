/**
 * The one line makefaster shows while an agent CLI works in the background.
 *
 * The hidden child streams structured events (Claude Code and Cursor print
 * mode emit stream-json; `codex exec --json` emits JSONL). We do not replay
 * that as a transcript — makefaster owns the terminal, so each event collapses
 * into a short label like "editing index.html" and one status line is rewritten
 * in place. `.makefaster/results.json` stays the source of truth for what
 * happened; this only tells the user the loop is alive.
 */

const MAX_LABEL_CHARS = 68;

function trim(text) {
  const flat = String(text).replace(/\s+/g, " ").trim();
  return flat.length > MAX_LABEL_CHARS ? `${flat.slice(0, MAX_LABEL_CHARS - 1)}…` : flat;
}

function basename(path) {
  const parts = String(path).split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || String(path);
}

/**
 * A command that measures rather than changes is the loop's TEST step; the
 * dashboard tags it that way.
 */
const MEASURING = /lighthouse|webpagetest|\bpsi\b|pagespeed|benchmark|\bbench\b|profil|measure|\bperf\b|playwright|puppeteer|vitest|jest|npm (?:run )?test/i;

/** Verb plus loop step for a tool name, so "Edit"/"apply_patch" both read alike. */
function toolEntry(name, input) {
  const tool = String(name || "").toLowerCase();
  const target = input && typeof input === "object"
    ? input.file_path || input.path || input.filePath || input.notebook_path || null
    : null;
  const where = target ? ` ${basename(target)}` : "";
  if (/^(edit|multiedit|write|notebookedit|apply_?patch|str_?replace|create_?file)/.test(tool)) {
    return { tag: "EXECUTE", text: `editing${where}` };
  }
  if (/^(read|view|open|notebookread)/.test(tool)) return { tag: "OBSERVE", text: `reading${where}` };
  if (/(bash|shell|terminal|exec|run_?command|local_?shell)/.test(tool)) {
    const raw = input && typeof input === "object" ? input.command : null;
    const command = Array.isArray(raw) ? raw.join(" ") : raw || "a command";
    return { tag: MEASURING.test(command) ? "TEST" : "EXECUTE", text: `running ${trim(command)}` };
  }
  if (/(grep|glob|search|codebase|find)/.test(tool)) return { tag: "OBSERVE", text: "searching the repo" };
  if (/(web|fetch|browser|http)/.test(tool)) return { tag: "OBSERVE", text: "fetching from the web" };
  if (/(todo|task|plan)/.test(tool)) return { tag: "PLAN", text: "planning" };
  return { tag: "EXECUTE", text: `${name || "tool"}${where}` };
}

function fromContentBlocks(blocks) {
  if (!Array.isArray(blocks)) return null;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (!block || typeof block !== "object") continue;
    if (block.type === "tool_use") return toolEntry(block.name, block.input);
    if (block.type === "thinking") return { tag: "HYPOTHESIS", text: "thinking" };
    if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
      return { tag: "OBSERVE", text: trim(block.text) };
    }
  }
  return null;
}

/**
 * Collapse one parsed stream event into a loop step and a short label.
 *
 * The tags are the makefaster loop's own vocabulary — OBSERVE, HYPOTHESIS,
 * PLAN, EXECUTE, TEST, RESULT, COMPARE — which is what the dashboard's log
 * panel shows.
 *
 * Deliberately forgiving: any shape it does not recognise returns null and the
 * previous line stays up, because a provider adding an event type must not turn
 * into noise on the user's terminal.
 *
 * @param {string} streamFormat "acp", "codex-app-server", or "claude-stream-json"
 * @param {unknown} event a parsed JSON line
 * @returns {{tag: string, text: string}|null}
 */
export function classifyEvent(streamFormat, event) {
  if (!event || typeof event !== "object") return null;

  if (streamFormat === "acp") return classifyAcpUpdate(event);
  if (streamFormat === "codex-app-server") return classifyCodexNotification(event);
  if (streamFormat === "codex-jsonl") return classifyCodexEvent(event);

  // Claude Code and Cursor print mode share the stream-json envelope.
  const type = event.type;
  if (type === "system") return event.subtype === "init" ? { tag: "OBSERVE", text: "session started" } : null;
  if (type === "assistant" || type === "user") return fromContentBlocks(event.message?.content) ?? null;
  if (type === "result") {
    const turns = typeof event.num_turns === "number" ? ` after ${event.num_turns} turns` : "";
    return event.is_error || event.subtype === "error"
      ? { tag: "RESULT", text: `the agent reported an error${turns}` }
      : { tag: "RESULT", text: `agent finished${turns}` };
  }
  if (type === "tool_call" || type === "tool_use") return toolEntry(event.name || event.tool, event.input || event.args);
  return null;
}

/** ACP `session/update` payloads from `cursor-agent acp`. */
function classifyAcpUpdate(update) {
  const kind = String(update.sessionUpdate || "");
  switch (kind) {
    case "agent_message_chunk":
      return { tag: "OBSERVE", text: trim(textOf(update.content)) || null };
    case "agent_thought_chunk":
      return { tag: "HYPOTHESIS", text: "thinking" };
    case "user_message_chunk":
      return null; // our own prompt echoed back
    case "plan":
      return { tag: "PLAN", text: describeAcpPlan(update.entries) };
    case "tool_call":
    case "tool_call_update":
      return acpToolCall(update);
    case "current_mode_update":
      return { tag: "OBSERVE", text: `mode: ${trim(update.currentModeId || "changed")}` };
    case "usage_update":
      return null; // token accounting is not loop progress
    default:
      return null;
  }
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (content && typeof content === "object" && typeof content.text === "string") return content.text;
  return "";
}

function describeAcpPlan(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return "planning";
  const pending = entries.find((entry) => entry?.status === "in_progress") ?? entries.find((entry) => entry?.status === "pending");
  return trim(pending?.content || `${entries.length} planned steps`);
}

/**
 * ACP tool calls carry a `kind` from a fixed vocabulary plus a human title, so
 * the title is the label and the kind decides the loop step.
 */
function acpToolCall(update) {
  const kind = String(update.kind || "other");
  const title = trim(update.title || "");
  const path = Array.isArray(update.locations) ? update.locations[0]?.path : null;
  const where = path ? ` ${basename(path)}` : "";
  switch (kind) {
    case "edit":
    case "delete":
    case "move":
      return { tag: "EXECUTE", text: title || `editing${where}` };
    case "read":
    case "search":
      return { tag: "OBSERVE", text: title || `reading${where}` };
    case "execute": {
      const command = trim(update.rawInput?.command || title || "a command");
      return { tag: MEASURING.test(command) ? "TEST" : "EXECUTE", text: title || `running ${command}` };
    }
    case "think":
      return { tag: "HYPOTHESIS", text: title || "thinking" };
    case "fetch":
      return { tag: "OBSERVE", text: title || "fetching from the web" };
    default:
      return { tag: "EXECUTE", text: title || "working" };
  }
}

/** `codex app-server` notifications. */
function classifyCodexNotification({ method, params }) {
  const name = String(method || "");
  if (name === "turn/started") return { tag: "OBSERVE", text: "turn started" };
  if (name === "turn/completed") return { tag: "RESULT", text: "turn completed" };
  if (name === "turn/failed") return { tag: "RESULT", text: trim(params?.error?.message || "the turn failed") };
  if (name === "thread/started") return { tag: "OBSERVE", text: "session started" };
  if (name === "item/agentMessage/delta" || name === "item/reasoning/delta") return null; // token noise
  if (name === "item/started" || name === "item/completed" || name === "item/updated") {
    return codexItem(params?.item);
  }
  if (name.endsWith("/requestApproval")) return { tag: "EXECUTE", text: "approval requested" };
  return null;
}

function codexItem(item) {
  if (!item || typeof item !== "object") return null;
  switch (String(item.type || "")) {
    case "commandExecution": {
      const command = trim(item.command || "a command");
      return { tag: MEASURING.test(command) ? "TEST" : "EXECUTE", text: `running ${command}` };
    }
    case "fileChange": {
      const first = Array.isArray(item.changes) ? item.changes[0] : null;
      const path = first?.path || first?.file || null;
      return { tag: "EXECUTE", text: path ? `editing ${basename(path)}` : "editing files" };
    }
    case "reasoning":
      return { tag: "HYPOTHESIS", text: "thinking" };
    case "agentMessage":
      return { tag: "OBSERVE", text: trim(item.text || "writing a reply") };
    case "webSearch":
      return { tag: "OBSERVE", text: "searching the web" };
    case "mcpToolCall":
      return { tag: "EXECUTE", text: trim(`${item.server || "mcp"} ${item.tool || "tool"}`) };
    case "todoList":
      return { tag: "PLAN", text: "planning" };
    default:
      return null;
  }
}

function classifyCodexEvent(event) {
  // Codex has shipped two JSONL envelopes: a flat `{type, ...}` item stream and
  // an older `{msg: {type, ...}}` wrapper. Handle both.
  const inner = event.msg && typeof event.msg === "object" ? event.msg : event;
  const type = String(inner.type || "");
  const item = inner.item && typeof inner.item === "object" ? inner.item : null;

  if (item) {
    const kind = String(item.item_type || item.type || "");
    if (/command/.test(kind)) {
      const command = trim(item.command || "a command");
      return { tag: MEASURING.test(command) ? "TEST" : "EXECUTE", text: `running ${command}` };
    }
    if (/patch|file|edit/.test(kind)) {
      const changes = item.changes && typeof item.changes === "object" ? Object.keys(item.changes) : [];
      return { tag: "EXECUTE", text: changes.length > 0 ? `editing ${basename(changes[0])}` : "editing files" };
    }
    if (/reasoning/.test(kind)) return { tag: "HYPOTHESIS", text: "thinking" };
    if (/agent_message|assistant/.test(kind)) return { tag: "OBSERVE", text: trim(item.text || "writing a reply") };
    if (/web_search/.test(kind)) return { tag: "OBSERVE", text: "searching the web" };
    if (kind) return { tag: "EXECUTE", text: trim(kind.replace(/_/g, " ")) };
  }

  if (/^task_started|session_configured|thread\.started/.test(type)) return { tag: "OBSERVE", text: "session started" };
  if (/^exec_command_begin/.test(type)) {
    const raw = inner.command;
    const command = trim(Array.isArray(raw) ? raw.join(" ") : raw || "a command");
    return { tag: MEASURING.test(command) ? "TEST" : "EXECUTE", text: `running ${command}` };
  }
  if (/^patch_apply_begin|apply_patch/.test(type)) return { tag: "EXECUTE", text: "editing files" };
  if (/^agent_reasoning/.test(type)) return { tag: "HYPOTHESIS", text: "thinking" };
  if (/^agent_message/.test(type)) return { tag: "OBSERVE", text: trim(inner.message || "writing a reply") };
  if (/^(task_complete|turn\.completed|thread\.completed)/.test(type)) return { tag: "RESULT", text: "agent finished" };
  if (/error/.test(type)) return { tag: "RESULT", text: trim(inner.message || "the agent reported an error") };
  return null;
}

/** The label alone, for the plain-text progress line on a non-TTY. */
export function describeEvent(streamFormat, event) {
  return classifyEvent(streamFormat, event)?.text ?? null;
}

/**
 * A single-line status writer.
 *
 * On a TTY the line is rewritten in place, so the whole run costs one row. When
 * output is redirected there is no cursor to move, so it prints a line per
 * change instead and repeats nothing.
 *
 * @param {object} [options]
 * @param {(chunk: string) => void} [options.write]
 * @param {boolean} [options.isTty]
 * @param {string} [options.prefix]
 */
export function createProgressReporter({ write, isTty, prefix = "  " } = {}) {
  const out = write ?? ((chunk) => process.stdout.write(chunk));
  const tty = isTty ?? Boolean(process.stdout.isTTY);
  let last = null;
  let dirty = false;
  let count = 0;

  return {
    get eventCount() {
      return count;
    },
    get lastLabel() {
      return last;
    },
    /** @param {{tag: string, text: string}|string|null} entry */
    update(entry) {
      count += 1;
      const label = typeof entry === "string" ? entry : entry?.text ?? null;
      if (!label || label === last) return;
      last = label;
      if (tty) {
        out(`\r\u001b[2K${prefix}${label}`);
        dirty = true;
      } else {
        out(`${prefix}${label}\n`);
      }
    },
    /** Leave the terminal clean for whatever makefaster prints next. */
    done() {
      if (tty && dirty) {
        out("\r\u001b[2K");
        dirty = false;
      }
    },
  };
}
