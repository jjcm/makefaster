/**
 * Cursor Agent over the Agent Client Protocol.
 *
 * `cursor-agent --model <id> acp` speaks ACP as a JSON-RPC peer on stdio. That
 * is the same launch bb uses (`plugins/provider-acp/server.ts` declares
 * `command: "cursor-agent", args: ["acp"]` with `modelCli.selectFlag: "--model"`
 * composed ahead of it), and it is not the interactive CLI: no TUI is drawn and
 * the prompt is a protocol frame rather than a terminal argument.
 *
 * Cursor exposes no permission flag, so this module *is* the permission policy:
 * every `session/request_permission` is answered here. If it were not, the
 * hidden child would block forever on a question with no UI to ask it in.
 *
 * makefaster advertises no client filesystem capability, so the agent uses its
 * own file tools rather than asking us to read and write on its behalf.
 */

import { createJsonRpcChild } from "../jsonrpc.js";
import { buildAgentSpawn, isAuthRequiredError } from "../invoke.js";
import { classifyEvent } from "../progress.js";

const ACP_PROTOCOL_VERSION = 1;
const CLIENT_INFO = { name: "makefaster", version: "1.0.0" };
const HANDSHAKE_TIMEOUT_MS = 60_000;

/** Prefer a lasting grant so the same tool is not re-asked every iteration. */
function pickPermissionOption(options) {
  const byKind = (kinds) => options.find((option) => kinds.includes(option?.kind))?.optionId;
  return byKind(["allow_always"]) ?? byKind(["allow_once"]) ?? options[0]?.optionId;
}

/**
 * Run one prompt to completion over ACP.
 *
 * @param {object} args
 * @param {{key: string, displayName: string, executablePath: string, signIn?: string}} args.provider
 * @param {string} args.prompt
 * @param {string} args.cwd
 * @param {{id: string}|null} [args.model]
 * @param {NodeJS.ProcessEnv} [args.env]
 * @param {{update: (entry: object|null) => void, done: () => void}} args.reporter
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<{exitCode: number, stderrTail: string, aborted: boolean, stopReason: string|null, authRequired: boolean}>}
 */
export async function runAcpSession({ provider, prompt, cwd, model = null, env = process.env, reporter, signal }) {
  const spawnSpec = buildAgentSpawn({ provider, model: model?.id ?? model ?? null, cwd, env });

  let exitInfo = null;
  const connection = createJsonRpcChild({
    command: spawnSpec.command,
    args: spawnSpec.args,
    cwd,
    env: spawnSpec.options.env,
    label: `${provider.displayName} (acp)`,
    onNotification: (method, params) => {
      if (method !== "session/update") return;
      reporter.update(classifyEvent("acp", params?.update));
    },
    onRequest: (method, params, responder) => {
      if (method === "session/request_permission") {
        const options = Array.isArray(params?.options) ? params.options : [];
        const optionId = pickPermissionOption(options);
        // The user started a local performance loop; approving is the whole
        // point. Cancelling is only for a request we cannot answer at all.
        responder.result(optionId === undefined ? { outcome: { outcome: "cancelled" } } : { outcome: { outcome: "selected", optionId } });
        reporter.update({ tag: "EXECUTE", text: `approved ${params?.toolCall?.title || params?.toolCall?.kind || "a tool call"}` });
        return;
      }
      // We told the agent we have no filesystem or terminal capability, so any
      // other request is one it should not have made.
      responder.error(-32601, `makefaster does not implement ${method}`);
    },
    onExit: (info) => {
      exitInfo = info;
    },
  });

  const onAbort = () => connection.kill();
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    await connection.request({
      method: "initialize",
      params: {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientInfo: CLIENT_INFO,
        // False on both, so the agent never asks makefaster to touch the repo.
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      },
      timeoutMs: HANDSHAKE_TIMEOUT_MS,
    });

    // No `authenticate` call: Cursor advertises no auth methods and reuses the
    // credentials `cursor-agent login` already wrote. A signed-out install
    // fails here, which is the signal we want.
    const session = await connection.request({
      method: "session/new",
      params: { cwd, mcpServers: [] },
      timeoutMs: HANDSHAKE_TIMEOUT_MS,
    });
    const sessionId = session?.sessionId;
    if (typeof sessionId !== "string") throw new Error(`${provider.displayName} did not return an ACP session id`);

    const result = await connection.request({
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: prompt }] },
    });

    return finish({ stopReason: result?.stopReason ?? null, aborted: Boolean(signal?.aborted) });
  } catch (error) {
    if (signal?.aborted) return finish({ stopReason: "cancelled", aborted: true });
    const authRequired = isAuthRequiredError(error, exitInfo?.stderrTail, connection.stderrTail);
    if (authRequired) return finish({ stopReason: null, aborted: false, authRequired: true, detail: error.message });
    if (exitInfo?.spawnFailed) throw new Error(`failed to launch ${provider.displayName} (${spawnSpec.command}): ${error.message}`);
    return finish({ stopReason: null, aborted: false, exitCode: 1, detail: error.message });
  } finally {
    signal?.removeEventListener("abort", onAbort);
    connection.kill();
    reporter.done();
  }

  function finish({ stopReason, aborted, authRequired = false, exitCode = 0, detail = null }) {
    return {
      exitCode: aborted ? 0 : exitCode,
      stderrTail: (exitInfo?.stderrTail || connection.stderrTail || "").trim(),
      aborted,
      stopReason,
      authRequired,
      detail,
    };
  }
}
