/**
 * Ask a CLI which models the signed-in account can actually run, so the picker
 * offers real choices instead of a hard-coded guess.
 *
 * Every probe here is best effort and bounded: if it fails, the picker falls
 * back to the curated catalog rather than blocking the loop. None of them is a
 * login, and none supplies a credential.
 */

import { spawnSync } from "node:child_process";
import { buildAgentSpawn, childEnv, isAuthRequiredError } from "../invoke.js";
import { parseCursorModelList } from "../models.js";
import { listCodexModels } from "./codexAppServer.js";
import { createJsonRpcChild } from "../jsonrpc.js";

const LIST_TIMEOUT_MS = 20_000;

/**
 * `cursor-agent --list-models`. This doubles as Cursor's sign-in check, which is
 * how bb learns the same thing (`isAuthRequiredModelListError` classifies this
 * exact command's failure).
 *
 * @returns {{models: Array<{id: string, displayName: string}>|null, authRequired: boolean, detail: string|null}}
 */
export function listCursorModels({ provider, env = process.env }) {
  const result = spawnSync(provider.executablePath, ["--list-models"], {
    env: childEnv(env),
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    timeout: LIST_TIMEOUT_MS,
    windowsHide: true,
  });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  if (isAuthRequiredError(output, result.error)) {
    return { models: null, authRequired: true, detail: firstLine(output) };
  }
  if (result.error || result.status !== 0) return { models: null, authRequired: false, detail: firstLine(output) };
  const models = parseCursorModelList(result.stdout || "");
  return { models: models.length > 0 ? models : null, authRequired: false, detail: null };
}

/**
 * Live models for a provider, or null when makefaster could not ask.
 *
 * @returns {Promise<{models: Array<{id: string, displayName: string}>|null, authRequired: boolean, detail: string|null}>}
 */
export async function listModels({ provider, cwd, env = process.env }) {
  switch (provider.key) {
    case "cursor":
      return listCursorModels({ provider, env });
    case "codex":
      try {
        const models = await listCodexModels({ provider, cwd, env });
        return { models: models.length > 0 ? models : null, authRequired: false, detail: null };
      } catch (error) {
        return { models: null, authRequired: isAuthRequiredError(error), detail: error.message };
      }
    case "hermes":
      return listHermesModels({ provider, cwd, env });
    // Claude Code's list needs an Agent SDK probe, and bb's curated catalog is
    // already exactly the five rows that catalog filters down to. Asking would
    // spawn a CLI to learn nothing new.
    default:
      return { models: null, authRequired: false, detail: null };
  }
}

/**
 * Hermes publishes the user's configured provider/model inventory as part of
 * ACP `session/new`. This keeps makefaster's picker live without copying or
 * exposing Hermes credentials or maintaining a second model catalog.
 */
export async function listHermesModels({ provider, cwd, env = process.env, timeoutMs = LIST_TIMEOUT_MS }) {
  const spawnSpec = buildAgentSpawn({ provider, cwd, env });
  const connection = createJsonRpcChild({
    command: spawnSpec.command,
    args: spawnSpec.args,
    cwd,
    env: spawnSpec.options.env,
    label: `${provider.displayName} (acp model list)`,
    onRequest: (_method, _params, responder) => responder.error(-32601, "model-list child serves no requests"),
  });
  try {
    await connection.request({
      method: "initialize",
      params: {
        protocolVersion: 1,
        clientInfo: { name: "makefaster", version: "1.0.0" },
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      },
      timeoutMs,
    });
    const session = await connection.request({
      method: "session/new",
      params: { cwd, mcpServers: [] },
      timeoutMs,
    });
    const entries = session?.models?.availableModels;
    const models = Array.isArray(entries)
      ? entries
        .filter((entry) => entry && typeof entry.modelId === "string" && entry.modelId.trim() !== "")
        .map((entry) => ({ id: entry.modelId, displayName: entry.name || entry.modelId }))
      : [];
    return { models: models.length > 0 ? models : null, authRequired: false, detail: null };
  } catch (error) {
    return {
      models: null,
      authRequired: isAuthRequiredError(error, connection.stderrTail),
      detail: error.message,
    };
  } finally {
    connection.kill();
  }
}

function firstLine(text) {
  const line = String(text).split(/\r?\n/).map((part) => part.trim()).find((part) => part.length > 0);
  return line ? line.slice(0, 160) : null;
}
