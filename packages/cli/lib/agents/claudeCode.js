/**
 * Claude Code, driven the way bb drives it: through
 * `@anthropic-ai/claude-agent-sdk`'s `query()`, which owns the CLI pipe itself.
 * bb's options (`plugins/provider-claude-code/src/bridge/sdk-session.ts`) are
 * what matter here and are mirrored:
 *
 *   pathToClaudeCodeExecutable  the install makefaster detected
 *   settingSources              ["user","project","local"] so ~/.claude OAuth
 *                               and settings load, not just the project's
 *   permissionMode              "bypassPermissions" plus
 *                               allowDangerouslySkipPermissions — dropped under
 *                               root, where the CLI refuses and exits
 *   canUseTool                  the auto-approve that still answers under root
 *   prompt                      an async iterable, never a TTY
 *
 * makefaster ships zero dependencies, so the SDK is an optional peer: if it
 * resolves it is used, and if it does not, the fallback is print mode over piped
 * stdio with the same setting sources and permission mode. Both paths emit the
 * same message objects, so everything downstream is identical.
 *
 * No API key is ever set. The SDK inherits the environment as-is and finds the
 * credentials `claude auth login` already stored.
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { buildAgentSpawn, claudePrintModeArgs, childEnv, isAuthRequiredError } from "../invoke.js";
import { classifyEvent } from "../progress.js";
import { thinkingTextOf } from "../thinkingTrace.js";

const SDK_MODULE = "@anthropic-ai/claude-agent-sdk";

function isRootProcess() {
  return typeof process.getuid === "function" ? process.getuid() === 0 : false;
}

/** Resolve the Agent SDK if the user happens to have it; never install it. */
export async function loadClaudeAgentSdk(importer = (specifier) => import(specifier)) {
  try {
    const module = await importer(SDK_MODULE);
    return typeof module?.query === "function" ? module : null;
  } catch {
    return null;
  }
}

/**
 * Run one prompt to completion.
 *
 * @returns {Promise<{exitCode: number, stderrTail: string, aborted: boolean, authRequired: boolean, path: "sdk"|"print"}>}
 */
export async function runClaudeSession({ provider, prompt, cwd, model = null, env = process.env, reporter, signal, sdkLoader = loadClaudeAgentSdk }) {
  const sdk = await sdkLoader();
  if (sdk) return runWithSdk({ sdk, provider, prompt, cwd, model, env, reporter, signal });
  return runWithPrintMode({ provider, prompt, cwd, model, env, reporter, signal });
}

async function runWithSdk({ sdk, provider, prompt, cwd, model, env, reporter, signal }) {
  const isRoot = isRootProcess();
  const abortController = new AbortController();
  const onAbort = () => abortController.abort();
  signal?.addEventListener("abort", onAbort, { once: true });

  let stderrTail = "";
  const options = {
    abortController,
    cwd,
    env: childEnv(env),
    pathToClaudeCodeExecutable: provider.executablePath,
    // Load the user's global configuration, not just this project's — bb had to
    // fix exactly this, because "project" alone hid ~/.claude from the session.
    settingSources: ["user", "project", "local"],
    includePartialMessages: false,
    stderr: (chunk) => {
      stderrTail = `${stderrTail}${chunk}`.slice(-4000);
    },
    // A hidden session has no one to ask, so every tool is pre-approved. Under
    // root the CLI rejects the skip flags and exits, so the mode is downgraded
    // and canUseTool carries the same intent instead.
    ...(isRoot
      ? { permissionMode: "acceptEdits" }
      : { permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true }),
    canUseTool: async (toolName) => {
      reporter.update({ tag: "EXECUTE", text: `approved ${toolName}` });
      return { behavior: "allow", updatedInput: undefined };
    },
    ...(model?.id ?? model ? { model: model?.id ?? model } : {}),
  };

  try {
    const session = sdk.query({ prompt: singlePromptIterable(prompt), options });
    for await (const message of session) {
      reporter.thought?.(thinkingTextOf("claude-stream-json", message));
      reporter.update(classifyEvent("claude-stream-json", message));
    }
    return { exitCode: 0, stderrTail: stderrTail.trim(), aborted: Boolean(signal?.aborted), authRequired: false, path: "sdk" };
  } catch (error) {
    if (signal?.aborted) return { exitCode: 0, stderrTail: stderrTail.trim(), aborted: true, authRequired: false, path: "sdk" };
    if (isAuthRequiredError(error, stderrTail)) {
      return { exitCode: 1, stderrTail: stderrTail.trim(), aborted: false, authRequired: true, detail: error.message, path: "sdk" };
    }
    return { exitCode: 1, stderrTail: stderrTail.trim(), aborted: false, authRequired: false, detail: error.message, path: "sdk" };
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reporter.done();
  }
}

/** The SDK's prompt shape: one user message, then the stream closes. */
async function* singlePromptIterable(text) {
  yield { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, session_id: "" };
}

function runWithPrintMode({ provider, prompt, cwd, model, env, reporter, signal }) {
  const spawnSpec = buildAgentSpawn({ provider, model: model?.id ?? model ?? null, cwd, env });
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(spawnSpec.command, spawnSpec.args, spawnSpec.options);
    } catch (error) {
      reject(new Error(`failed to launch ${provider.displayName} (${spawnSpec.command}): ${error.message}`));
      return;
    }

    let stderrTail = "";
    let settled = false;
    const onAbort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", onAbort, { once: true });

    // The prompt goes in as a stream-json frame rather than on argv, so stdin
    // stays a pipe we control and the terminal is never attached.
    child.stdin?.write(`${JSON.stringify({ type: "user", message: { role: "user", content: prompt } })}\n`);
    child.stdin?.end();

    if (child.stdout) {
      const reader = createInterface({ input: child.stdout, terminal: false });
      reader.on("line", (line) => {
        const trimmed = line.trim();
        if (trimmed === "") return;
        try {
          const event = JSON.parse(trimmed);
          reporter.thought?.(thinkingTextOf("claude-stream-json", event));
          reporter.update(classifyEvent("claude-stream-json", event));
        } catch {
          /* not a protocol frame */
        }
      });
    }
    child.stderr?.setEncoding("utf8").on("data", (chunk) => {
      stderrTail = `${stderrTail}${chunk}`.slice(-4000);
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      reporter.done();
      if (signal?.aborted) {
        resolve({ exitCode: 0, stderrTail: stderrTail.trim(), aborted: true, authRequired: false, path: "print" });
        return;
      }
      reject(new Error(`failed to launch ${provider.displayName} (${spawnSpec.command}): ${error.message}`));
    });

    child.on("close", (code, closeSignal) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      reporter.done();
      const aborted = Boolean(signal?.aborted);
      const exitCode = aborted ? 0 : code ?? (closeSignal ? 1 : 0);
      resolve({
        exitCode,
        stderrTail: stderrTail.trim(),
        aborted,
        authRequired: !aborted && exitCode !== 0 && isAuthRequiredError(stderrTail),
        path: "print",
      });
    });
  });
}

/** Print-mode argv, re-exported so tests assert one definition. */
export { claudePrintModeArgs };
