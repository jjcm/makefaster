/**
 * The tools the hosted `makefaster` provider gives the model.
 *
 * The other three providers are whole agent products: makefaster hands them a
 * prompt and they already know how to read a repo, run a build and edit a file.
 * The hosted provider has a model and nothing else, so the agent loop lives
 * here — and so does the smallest set of tools that can actually run the skill:
 * look around, read, write, run something, and report a step.
 *
 * Two rules shape all of them:
 *
 *   - **Everything is scoped to the target directory.** A path that resolves
 *     outside it is refused, so a model that hallucinates `/etc/passwd` or
 *     `../../.ssh/id_rsa` gets an error instead of a file.
 *   - **Every result is bounded.** Output is truncated, commands time out, and
 *     reads are capped, because each result is about to be sent back as prompt
 *     and paid for by the token.
 *
 * The shell tool is as powerful as the repo's own shell — the same as every
 * other agent CLI makefaster drives, which auto-approve their own tool calls.
 * That is the deal the user accepts by running an autoresearch loop on a repo.
 */

import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { STEP_TAGS } from "../stepLog.js";

/** Caps. Each one exists because the result becomes prompt. */
const MAX_READ_BYTES = 60_000;
const MAX_OUTPUT_CHARS = 8_000;
const MAX_LIST_ENTRIES = 200;
const DEFAULT_COMMAND_TIMEOUT_MS = 180_000;
const MAX_COMMAND_TIMEOUT_MS = 900_000;

/** The tool schemas, in OpenAI function-calling shape. */
export const TOOL_SCHEMAS = [
  {
    type: "function",
    function: {
      name: "report_step",
      description:
        "Report what you are doing right now to the user's dashboard. Call this as each step begins. " +
        `One short sentence. Tags: ${STEP_TAGS.join(", ")}.`,
      parameters: {
        type: "object",
        properties: {
          tag: { type: "string", enum: [...STEP_TAGS] },
          text: { type: "string", description: "One sentence. No tool names, file paths, or command strings." },
        },
        required: ["tag", "text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "List the entries of a directory in the repo.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Repo-relative path. Defaults to the repo root." } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a UTF-8 text file from the repo. Long files are truncated; pass start_line to page through.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Repo-relative path." },
          start_line: { type: "integer", description: "1-based first line to return." },
          max_lines: { type: "integer", description: "How many lines to return." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write a file in the repo, creating parent directories. Replaces the whole file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Repo-relative path." },
          contents: { type: "string" },
        },
        required: ["path", "contents"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "Replace an exact snippet in a file. The snippet must appear exactly once.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Repo-relative path." },
          find: { type: "string", description: "Exact text to replace, including indentation." },
          replace: { type: "string" },
        },
        required: ["path", "find", "replace"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_shell",
      description:
        "Run a shell command in the repo root and return its output. Use this for builds, servers, " +
        "measurements and git. Non-interactive only: nothing can prompt you.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          timeout_ms: { type: "integer", description: `Default ${DEFAULT_COMMAND_TIMEOUT_MS}, max ${MAX_COMMAND_TIMEOUT_MS}.` },
        },
        required: ["command"],
      },
    },
  },
];

/** A tool result the model reads. `ok: false` is a message, never a throw. */
function ok(text) {
  return { ok: true, text: String(text) };
}
function failed(text) {
  return { ok: false, text: `error: ${text}` };
}

function truncate(text, max = MAX_OUTPUT_CHARS) {
  const value = String(text ?? "");
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n… [${value.length - max} more characters truncated]`;
}

/**
 * Resolve a repo-relative path, refusing anything outside the target directory.
 * An absolute path inside the repo is allowed — models write them constantly —
 * but one pointing anywhere else is not.
 */
function insideRepo(cwd, path) {
  const candidate = resolve(cwd, String(path ?? "."));
  const rel = relative(cwd, candidate);
  if (rel.startsWith("..") || (isAbsolute(rel) && rel !== "")) return null;
  return candidate;
}

/**
 * Build the tool implementations for one session.
 *
 * @param {object} args
 * @param {string} args.cwd the repo the loop is running against
 * @param {string} args.stepLogPath `.makefaster/thinking.log`
 * @param {AbortSignal} [args.signal] aborts a running command
 * @returns {Record<string, (input: object) => Promise<{ok: boolean, text: string}>>}
 */
export function createTools({ cwd, stepLogPath, signal }) {
  const scoped = (path) => {
    const resolved = insideRepo(cwd, path);
    if (!resolved) throw new Error(`path is outside the repo: ${path}`);
    return resolved;
  };

  return {
    async report_step({ tag, text }) {
      const upper = String(tag ?? "").toUpperCase();
      if (!STEP_TAGS.includes(upper)) {
        return failed(`tag must be one of ${STEP_TAGS.join(", ")}`);
      }
      const sentence = String(text ?? "").replace(/\s+/g, " ").trim();
      if (!sentence) return failed("text is required");
      try {
        mkdirSync(dirname(stepLogPath), { recursive: true });
        appendFileSync(stepLogPath, `[${upper}] ${sentence}\n`);
      } catch (err) {
        return failed(`could not write the step log: ${err.message}`);
      }
      return ok("reported");
    },

    async list_dir({ path = "." }) {
      try {
        const dir = scoped(path);
        const entries = readdirSync(dir, { withFileTypes: true })
          .filter((entry) => entry.name !== ".git" && entry.name !== "node_modules")
          .slice(0, MAX_LIST_ENTRIES)
          .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));
        return ok(entries.length > 0 ? entries.join("\n") : "(empty)");
      } catch (err) {
        return failed(err.message);
      }
    },

    async read_file({ path, start_line: startLine, max_lines: maxLines }) {
      try {
        const file = scoped(path);
        if (statSync(file).size > MAX_READ_BYTES * 4) {
          return failed(`file is too large to read whole (${statSync(file).size} bytes) — narrow it with run_shell`);
        }
        const lines = readFileSync(file, "utf8").split(/\r?\n/);
        const from = Math.max(1, Number(startLine) || 1);
        const count = Math.max(1, Number(maxLines) || lines.length);
        const slice = lines.slice(from - 1, from - 1 + count);
        const numbered = slice.map((line, i) => `${from + i}\t${line}`).join("\n");
        return ok(truncate(numbered, MAX_READ_BYTES));
      } catch (err) {
        return failed(err.message);
      }
    },

    async write_file({ path, contents }) {
      try {
        const file = scoped(path);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, String(contents ?? ""));
        return ok(`wrote ${relative(cwd, file) || path}`);
      } catch (err) {
        return failed(err.message);
      }
    },

    async edit_file({ path, find, replace }) {
      try {
        const file = scoped(path);
        const before = readFileSync(file, "utf8");
        const needle = String(find ?? "");
        if (!needle) return failed("find is required");
        const occurrences = before.split(needle).length - 1;
        if (occurrences === 0) return failed("find did not match — read the file again and copy the text exactly");
        if (occurrences > 1) return failed(`find matched ${occurrences} times — include more context so it is unique`);
        writeFileSync(file, before.replace(needle, String(replace ?? "")));
        return ok(`edited ${relative(cwd, file) || path}`);
      } catch (err) {
        return failed(err.message);
      }
    },

    run_shell({ command, timeout_ms: timeoutMs }) {
      const script = String(command ?? "").trim();
      if (!script) return Promise.resolve(failed("command is required"));
      const timeout = Math.min(Math.max(Number(timeoutMs) || DEFAULT_COMMAND_TIMEOUT_MS, 1_000), MAX_COMMAND_TIMEOUT_MS);

      return new Promise((resolvePromise) => {
        // No stdin: a command that tries to prompt gets EOF instead of hanging
        // the loop forever waiting for a user who is watching a dashboard.
        const child = spawn("/bin/sh", ["-c", script], {
          cwd,
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, CI: "1", NO_COLOR: "1" },
        });

        let out = "";
        let err = "";
        let settled = false;
        const finish = (text) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener?.("abort", onAbort);
          resolvePromise(ok(truncate(text)));
        };

        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          finish(`${out}${err}\n[timed out after ${timeout}ms]`);
        }, timeout);
        timer.unref?.();

        const onAbort = () => {
          child.kill("SIGKILL");
          finish(`${out}${err}\n[stopped]`);
        };
        signal?.addEventListener?.("abort", onAbort, { once: true });

        child.stdout.on("data", (chunk) => { out += chunk; });
        child.stderr.on("data", (chunk) => { err += chunk; });
        child.on("error", (spawnError) => finish(`could not run the command: ${spawnError.message}`));
        child.on("close", (code) => {
          const body = `${out}${err}`.trim();
          finish(`exit ${code}\n${body || "(no output)"}`);
        });
      });
    },
  };
}

/** A one-line label for the dashboard's heartbeat, per tool call. */
export function describeToolCall(name, input) {
  switch (name) {
    case "report_step": return `reporting: ${input?.text ?? ""}`.slice(0, 120);
    case "list_dir": return `listing ${input?.path || "."}`;
    case "read_file": return `reading ${input?.path ?? ""}`;
    case "write_file": return `writing ${input?.path ?? ""}`;
    case "edit_file": return `editing ${input?.path ?? ""}`;
    case "run_shell": return `running ${String(input?.command ?? "").slice(0, 80)}`;
    default: return name;
  }
}
