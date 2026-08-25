/**
 * Codex over `codex app-server`.
 *
 * bb supervises app-server children rather than shelling out to `codex exec`
 * (`plugins/provider-codex/src/bridge/bridge.ts` resolves the launch to
 * `{ command: "codex", args: ["app-server"] }`), and this follows that: the
 * model and the permission posture ride `thread/start` and `turn/start`, so
 * nothing about them is guessed from a command line whose flags have changed
 * several times.
 *
 * Approvals are answered here. Even with `approvalPolicy: "never"` the
 * app-server can still raise a permission request, and a hidden child blocking
 * on one would hang with nothing on screen — so all three approval methods bb
 * handles are handled.
 */

import { createJsonRpcChild } from "../jsonrpc.js";
import { buildAgentSpawn, isAuthRequiredError } from "../invoke.js";
import { classifyEvent } from "../progress.js";
import { thinkingTextOf } from "../thinkingTrace.js";

const CLIENT_INFO = { name: "makefaster", version: "1.0.0", title: null };
const INITIALIZE_PARAMS = { clientInfo: CLIENT_INFO, capabilities: { experimentalApi: true } };
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * The workspace-write posture: the loop may edit the repo it was pointed at and
 * reach the network to profile it, and it is never asked to confirm — the same
 * shape bb builds in `toCodexPermissionSettings` for a workspace scope.
 */
function permissionSettings(cwd) {
  return {
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: "workspace-write",
    sandboxPolicy: {
      type: "workspaceWrite",
      writableRoots: [cwd],
      networkAccess: true,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    },
  };
}

/** Answer an approval request without a human. Session-scoped where offered. */
function answerApproval(method, params, responder) {
  switch (method) {
    case "item/commandExecution/requestApproval": {
      const decisions = Array.isArray(params?.availableDecisions) ? params.availableDecisions : [];
      const decision = decisions.includes("acceptForSession") ? "acceptForSession" : "accept";
      responder.result({ decision });
      return `approved ${String(params?.command ?? "a command").slice(0, 60)}`;
    }
    case "item/fileChange/requestApproval":
      responder.result({ decision: params?.grantRoot ? "acceptForSession" : "accept" });
      return "approved a file change";
    case "item/permissions/requestApproval":
      // Grant exactly what was asked for; inventing a wider profile would be a
      // decision the user never made.
      responder.result({ permissions: params?.permissions ?? {}, scope: "session" });
      return "granted the requested permissions";
    default:
      responder.error(-32601, `makefaster does not implement ${method}`);
      return null;
  }
}

/**
 * Run one prompt to completion over the app-server.
 *
 * @returns {Promise<{exitCode: number, stderrTail: string, aborted: boolean, authRequired: boolean}>}
 */
export async function runCodexSession({ provider, prompt, cwd, model = null, env = process.env, reporter, signal }) {
  const spawnSpec = buildAgentSpawn({ provider, cwd, env });
  const settings = permissionSettings(cwd);

  let exitInfo = null;
  let turnSettled = null;
  const connection = createJsonRpcChild({
    command: spawnSpec.command,
    args: spawnSpec.args,
    cwd,
    env: spawnSpec.options.env,
    label: `${provider.displayName} (app-server)`,
    onNotification: (method, params) => {
      // Reasoning arrives as deltas the classifier drops as token noise; the
      // trace keeps the text and the panel still sees nothing.
      reporter.thought?.(thinkingTextOf("codex-app-server", { method, params }));
      reporter.update(classifyEvent("codex-app-server", { method, params }));
      // The turn is what makefaster waits on: turn/start only acknowledges the
      // dispatch, so completion arrives as a notification.
      if (method === "turn/completed" || method === "turn/failed") {
        turnSettled?.({ status: params?.turn?.status ?? (method === "turn/failed" ? "failed" : "completed") });
      }
    },
    onRequest: (method, params, responder) => {
      const label = answerApproval(method, params, responder);
      if (label) reporter.update({ tag: "EXECUTE", text: label });
    },
    onExit: (info) => {
      exitInfo = info;
      turnSettled?.({ status: "childExited" });
    },
  });

  const onAbort = () => connection.kill();
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    await connection.request({ method: "initialize", params: INITIALIZE_PARAMS, timeoutMs: REQUEST_TIMEOUT_MS });

    const thread = await connection.request({
      method: "thread/start",
      params: {
        cwd,
        approvalPolicy: settings.approvalPolicy,
        approvalsReviewer: settings.approvalsReviewer,
        sandbox: settings.sandbox,
        ...(model?.id ?? model ? { model: model?.id ?? model } : {}),
      },
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    const threadId = thread?.thread?.id;
    if (typeof threadId !== "string") throw new Error(`${provider.displayName} did not return a thread id`);

    const settled = new Promise((resolve) => {
      turnSettled = resolve;
    });

    await connection.request({
      method: "turn/start",
      params: {
        threadId,
        input: [{ type: "text", text: prompt, text_elements: [] }],
        approvalPolicy: settings.approvalPolicy,
        approvalsReviewer: settings.approvalsReviewer,
        sandboxPolicy: settings.sandboxPolicy,
        ...(model?.id ?? model ? { model: model?.id ?? model } : {}),
      },
      timeoutMs: REQUEST_TIMEOUT_MS,
    });

    const outcome = await settled;
    return finish({ aborted: Boolean(signal?.aborted), exitCode: outcome.status === "failed" ? 1 : 0 });
  } catch (error) {
    if (signal?.aborted) return finish({ aborted: true });
    if (isAuthRequiredError(error, exitInfo?.stderrTail, connection.stderrTail)) {
      return finish({ aborted: false, authRequired: true, detail: error.message });
    }
    if (exitInfo?.spawnFailed) throw new Error(`failed to launch ${provider.displayName} (${spawnSpec.command}): ${error.message}`);
    return finish({ aborted: false, exitCode: 1, detail: error.message });
  } finally {
    signal?.removeEventListener("abort", onAbort);
    connection.kill();
    reporter.done();
  }

  function finish({ aborted, exitCode = 0, authRequired = false, detail = null }) {
    return {
      exitCode: aborted ? 0 : exitCode,
      stderrTail: (exitInfo?.stderrTail || connection.stderrTail || "").trim(),
      aborted,
      authRequired,
      detail,
    };
  }
}

/**
 * Live model list from the app-server, used to fill the Codex picker's fifth
 * slot. Best effort: a failure means the picker shows the four the benchmark
 * snapshot scores rather than an invented fifth.
 *
 * @returns {Promise<Array<{id: string, displayName: string}>>}
 */
export async function listCodexModels({ provider, cwd, env = process.env, timeoutMs = 15_000 }) {
  const spawnSpec = buildAgentSpawn({ provider, cwd, env });
  const connection = createJsonRpcChild({
    command: spawnSpec.command,
    args: spawnSpec.args,
    cwd,
    env: spawnSpec.options.env,
    label: `${provider.displayName} (app-server)`,
    onRequest: (_method, _params, responder) => responder.error(-32601, "model-list child serves no requests"),
  });
  try {
    await connection.request({ method: "initialize", params: INITIALIZE_PARAMS, timeoutMs });
    const result = await connection.request({ method: "model/list", timeoutMs });
    const data = Array.isArray(result?.data) ? result.data : [];
    return data
      .filter((entry) => entry && typeof entry.model === "string" && entry.hidden !== true)
      .map((entry) => ({ id: entry.model, displayName: typeof entry.displayName === "string" && entry.displayName ? entry.displayName : entry.model }));
  } finally {
    connection.kill();
  }
}
