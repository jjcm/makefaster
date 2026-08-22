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

/** Verb for a tool name, so "Edit"/"apply_patch" both read as "editing". */
function toolLabel(name, input) {
  const tool = String(name || "").toLowerCase();
  const target = input && typeof input === "object"
    ? input.file_path || input.path || input.filePath || input.notebook_path || null
    : null;
  const where = target ? ` ${basename(target)}` : "";
  if (/^(edit|multiedit|write|notebookedit|apply_?patch|str_?replace|create_?file)/.test(tool)) return `editing${where}`;
  if (/^(read|view|open|notebookread)/.test(tool)) return `reading${where}`;
  if (/(bash|shell|terminal|exec|run_?command|local_?shell)/.test(tool)) {
    const command = input && typeof input === "object" ? input.command : null;
    return `running ${trim(Array.isArray(command) ? command.join(" ") : command || "a command")}`;
  }
  if (/(grep|glob|search|codebase|find)/.test(tool)) return "searching the repo";
  if (/(web|fetch|browser|http)/.test(tool)) return "fetching from the web";
  if (/(todo|task|plan)/.test(tool)) return "planning";
  return `${name || "tool"}${where}`;
}

function fromContentBlocks(blocks) {
  if (!Array.isArray(blocks)) return null;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (!block || typeof block !== "object") continue;
    if (block.type === "tool_use") return toolLabel(block.name, block.input);
    if (block.type === "thinking") return "thinking";
    if (block.type === "text" && typeof block.text === "string" && block.text.trim()) return trim(block.text);
  }
  return null;
}

/**
 * Collapse one parsed stream event into a short status label.
 *
 * Deliberately forgiving: any shape it does not recognise returns null and the
 * previous label stays up, because a provider adding an event type must not
 * turn into noise on the user's terminal.
 *
 * @param {string} streamFormat from buildAgentInvocation()
 * @param {unknown} event a parsed JSON line
 * @returns {string|null}
 */
export function describeEvent(streamFormat, event) {
  if (!event || typeof event !== "object") return null;

  if (streamFormat === "codex-jsonl") return describeCodexEvent(event);

  // Claude Code and Cursor print mode share the stream-json envelope.
  const type = event.type;
  if (type === "system") return event.subtype === "init" ? "session started" : null;
  if (type === "assistant" || type === "user") {
    const message = event.message;
    return fromContentBlocks(message?.content) ?? null;
  }
  if (type === "result") {
    const turns = typeof event.num_turns === "number" ? ` after ${event.num_turns} turns` : "";
    return event.is_error || event.subtype === "error" ? `the agent reported an error${turns}` : `agent finished${turns}`;
  }
  if (type === "tool_call" || type === "tool_use") return toolLabel(event.name || event.tool, event.input || event.args);
  return null;
}

function describeCodexEvent(event) {
  // Codex has shipped two JSONL envelopes: a flat `{type, ...}` item stream and
  // an older `{msg: {type, ...}}` wrapper. Handle both.
  const inner = event.msg && typeof event.msg === "object" ? event.msg : event;
  const type = String(inner.type || "");
  const item = inner.item && typeof inner.item === "object" ? inner.item : null;

  if (item) {
    const kind = String(item.item_type || item.type || "");
    if (/command/.test(kind)) return `running ${trim(item.command || "a command")}`;
    if (/patch|file|edit/.test(kind)) {
      const changes = item.changes && typeof item.changes === "object" ? Object.keys(item.changes) : [];
      return changes.length > 0 ? `editing ${basename(changes[0])}` : "editing files";
    }
    if (/reasoning/.test(kind)) return "thinking";
    if (/agent_message|assistant/.test(kind)) return trim(item.text || "writing a reply");
    if (/web_search/.test(kind)) return "searching the web";
    if (kind) return trim(kind.replace(/_/g, " "));
  }

  if (/^task_started|session_configured|thread\.started/.test(type)) return "session started";
  if (/^exec_command_begin/.test(type)) {
    const command = inner.command;
    return `running ${trim(Array.isArray(command) ? command.join(" ") : command || "a command")}`;
  }
  if (/^patch_apply_begin|apply_patch/.test(type)) return "editing files";
  if (/^agent_reasoning/.test(type)) return "thinking";
  if (/^agent_message/.test(type)) return trim(inner.message || "writing a reply");
  if (/^(task_complete|turn\.completed|thread\.completed)/.test(type)) return "agent finished";
  if (/error/.test(type)) return trim(inner.message || "the agent reported an error");
  return null;
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
    update(label) {
      count += 1;
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
