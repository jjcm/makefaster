/**
 * Newline-delimited JSON-RPC 2.0 over a spawned child's stdio.
 *
 * Both protocol children makefaster drives speak this: `cursor-agent acp`
 * (Agent Client Protocol) and `codex app-server`. It is modelled on bb's two
 * connection modules (`plugins/provider-acp/src/bridge/agent-connection.ts` and
 * `plugins/provider-codex/src/bridge/app-server-connection.ts`), including the
 * child-exit races they document:
 *
 * - stdio is always `["pipe","pipe","pipe"]`. stdin is a pipe we write protocol
 *   frames into — never the user's TTY, which is what makes these CLIs decide a
 *   human is present and start prompting.
 * - exit is finalized on `close` (stdio drained) rather than `exit`, with a
 *   bounded grace, because a descendant can inherit and hold the pipes open.
 * - once finalized, late stdout lines are dropped so a dying child cannot
 *   inject stale protocol traffic.
 * - `kill()` escalates SIGTERM to SIGKILL on a timer.
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const CLOSE_AFTER_EXIT_GRACE_MS = 1_000;
const KILL_ESCALATION_MS = 4_000;
const STDERR_TAIL_MAX_LINES = 60;

export class ChildExitedError extends Error {
  constructor(message, { spawnFailed = false } = {}) {
    super(message);
    this.name = "ChildExitedError";
    this.spawnFailed = spawnFailed;
  }
}

/**
 * @param {object} options
 * @param {string} options.command
 * @param {string[]} options.args
 * @param {string} options.cwd
 * @param {NodeJS.ProcessEnv} options.env
 * @param {string} options.label used in error messages
 * @param {(method: string, params: unknown) => void} [options.onNotification]
 * @param {(method: string, params: unknown, responder: {result: (v: unknown) => void, error: (code: number, message: string) => void}) => void} [options.onRequest]
 * @param {(info: {code: number|null, signal: string|null, stderrTail: string, spawnFailed: boolean}) => void} [options.onExit]
 */
export function createJsonRpcChild(options) {
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  const pending = new Map();
  const stderrLines = [];
  let nextId = 1;
  let finalized = false;
  let spawnFailed = false;
  let exitStatus = null;
  let graceTimer = null;
  let stdoutReader = null;

  const stderrTail = () => stderrLines.join("\n");

  function writeFrame(message) {
    const stdin = child.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) return;
    stdin.write(`${JSON.stringify(message)}\n`);
  }

  function finalize(status) {
    if (finalized) return;
    finalized = true;
    if (graceTimer !== null) {
      clearTimeout(graceTimer);
      graceTimer = null;
    }
    stdoutReader?.close();
    child.stdout?.destroy();
    child.stderr?.destroy();
    const tail = stderrTail();
    const error = new ChildExitedError(
      `${options.label} exited (code ${status.code ?? "null"}, signal ${status.signal ?? "null"})${tail ? `: ${tail}` : ""}`,
      { spawnFailed },
    );
    for (const [, request] of pending) {
      if (request.timeout !== null) clearTimeout(request.timeout);
      request.reject(error);
    }
    pending.clear();
    options.onExit?.({ ...status, stderrTail: tail, spawnFailed });
  }

  if (child.stdout) {
    stdoutReader = createInterface({ input: child.stdout, terminal: false });
    stdoutReader.on("line", (line) => {
      if (finalized) return;
      const trimmed = line.trim();
      if (trimmed === "") return;
      let message;
      try {
        message = JSON.parse(trimmed);
      } catch {
        return; // banners and warnings are not protocol frames
      }
      if (typeof message !== "object" || message === null || Array.isArray(message)) return;

      const hasId = typeof message.id === "string" || typeof message.id === "number";

      // A response to something we asked.
      if (hasId && message.method === undefined) {
        const request = pending.get(String(message.id));
        if (!request) return;
        pending.delete(String(message.id));
        if (request.timeout !== null) clearTimeout(request.timeout);
        if (message.error) {
          const error = new Error(message.error.message ?? `${options.label} returned error ${message.error.code ?? "unknown"}`);
          error.code = message.error.code;
          request.reject(error);
        } else {
          request.resolve(message.result);
        }
        return;
      }

      if (typeof message.method !== "string") return;

      // A request from the child that we must answer (a permission or approval).
      if (hasId) {
        let settled = false;
        options.onRequest?.(message.method, message.params, {
          result(value) {
            if (settled || finalized) return;
            settled = true;
            writeFrame({ jsonrpc: "2.0", id: message.id, result: value ?? null });
          },
          error(code, errorMessage) {
            if (settled || finalized) return;
            settled = true;
            writeFrame({ jsonrpc: "2.0", id: message.id, error: { code, message: errorMessage } });
          },
        });
        return;
      }

      options.onNotification?.(message.method, message.params);
    });
  }

  if (child.stderr) {
    const reader = createInterface({ input: child.stderr, terminal: false });
    reader.on("line", (line) => {
      stderrLines.push(line);
      if (stderrLines.length > STDERR_TAIL_MAX_LINES) stderrLines.shift();
    });
  }

  child.on("error", (error) => {
    spawnFailed = true;
    stderrLines.push(error.message);
    finalize({ code: null, signal: null });
  });

  child.on("exit", (code, signal) => {
    exitStatus = { code: code ?? null, signal: signal ?? null };
    graceTimer = setTimeout(() => finalize(exitStatus ?? { code: null, signal: null }), CLOSE_AFTER_EXIT_GRACE_MS);
    graceTimer.unref?.();
  });

  child.on("close", (code, signal) => {
    finalize(exitStatus ?? { code: code ?? null, signal: signal ?? null });
  });

  return {
    get exited() {
      return finalized;
    },
    get stderrTail() {
      return stderrTail();
    },

    request({ method, params, timeoutMs }) {
      if (finalized) {
        return Promise.reject(new ChildExitedError(`${options.label} is not running`, { spawnFailed }));
      }
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const entry = { resolve, reject, timeout: null };
        if (timeoutMs !== undefined) {
          entry.timeout = setTimeout(() => {
            pending.delete(String(id));
            reject(new Error(`${options.label} did not answer ${method} within ${timeoutMs}ms`));
          }, timeoutMs);
          entry.timeout.unref?.();
        }
        pending.set(String(id), entry);
        writeFrame({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
      });
    },

    notify(method, params) {
      if (finalized) return;
      writeFrame({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
    },

    kill() {
      if (finalized) return;
      const escalation = setTimeout(() => {
        if (!finalized) child.kill("SIGKILL");
      }, KILL_ESCALATION_MS);
      escalation.unref?.();
      child.kill("SIGTERM");
    },
  };
}
