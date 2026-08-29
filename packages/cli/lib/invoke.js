/**
 * How makefaster talks to an installed agent CLI: as a non-TTY protocol child,
 * the way bb's provider bridges do (get-bb/bb `plugins/provider-*`).
 *
 * None of these are the product's interactive CLI, and none of them is a
 * print-mode wrapper around it where a protocol exists:
 *
 *   Cursor       `cursor-agent --model <id> acp` — Agent Client Protocol over
 *                stdio. The model flag is a *global* option and goes before the
 *                `acp` subcommand (bb composes it as `prefixArgs` ahead of the
 *                launch spec's own args). Cursor has no permission flag —
 *                `--force`/`--yolo` belong to other agents — so permission is
 *                granted by answering `session/request_permission`.
 *   Claude Code  `@anthropic-ai/claude-agent-sdk` `query()`, which owns the CLI
 *                pipe itself. Print mode is only the zero-dependency fallback.
 *   Codex        `codex app-server` — JSON-RPC; the model is set on
 *                `thread/start`, not on the command line.
 *
 * Credentials are reused, never created or supplied:
 *
 * - No `login` subcommand is ever run, no browser is opened, no device code is
 *   printed.
 * - No API key is injected. ANTHROPIC_API_KEY, CURSOR_API_KEY and
 *   OPENAI_API_KEY are never set by makefaster — an injected key fights the
 *   OAuth credentials the CLI already stored and can itself cause prompts. The
 *   child inherits the user's environment untouched, so it finds ~/.claude,
 *   ~/.cursor and CODEX_HOME/~/.codex exactly as the native CLI does.
 * - A signed-out install therefore fails with an auth-required error from the
 *   child. That is the expected signal: makefaster reports it in one line and
 *   stops rather than trying to fix it.
 *
 * Because the child has no UI, makefaster must answer its permission and
 * approval requests itself, or the hidden child blocks forever with nothing on
 * screen. Each agent module does that (see lib/agents/).
 */

/** stdin is a pipe we own for protocol frames, never the user's terminal. */
export const PROTOCOL_STDIO = ["pipe", "pipe", "pipe"];

/** Keys makefaster must never set; an injected key can fight stored OAuth. */
export const NEVER_INJECTED_ENV = [
  "ANTHROPIC_API_KEY", "CURSOR_API_KEY", "OPENAI_API_KEY", "CLAUDE_API_KEY",
  "CODEX_API_KEY",
];

/**
 * The child's environment: the user's own, unmodified. Anything makefaster added
 * here would be a credential decision it has no business making.
 */
export function childEnv(env = process.env) {
  return { ...env };
}

/**
 * The spawn spec for a provider's protocol child.
 *
 * @param {object} args
 * @param {{key: string, displayName: string, executablePath: string}} args.provider
 * @param {string|null} [args.model] model id, for providers that pin it at launch
 * @param {string} args.cwd
 * @param {NodeJS.ProcessEnv} [args.env]
 * @returns {{command: string, args: string[], options: object, protocol: string}}
 */
export function buildAgentSpawn({ provider, model = null, cwd, env = process.env }) {
  const options = { cwd, env: childEnv(env), stdio: PROTOCOL_STDIO, windowsHide: true };

  switch (provider.key) {
    case "cursor": {
      // `--model` is a global option, so it precedes the subcommand. Without a
      // model the account default is used rather than a guessed id.
      const argv = model ? ["--model", model, "acp"] : ["acp"];
      return { command: provider.executablePath, args: argv, options, protocol: "acp" };
    }

    case "codex":
      // The model rides thread/start; nothing about it belongs in argv.
      return { command: provider.executablePath, args: ["app-server"], options, protocol: "codex-app-server" };

    case "claude":
      // The Agent SDK spawns the CLI itself; this is the print-mode fallback's
      // spec, and lib/agents/claudeCode.js decides which path is taken.
      return { command: provider.executablePath, args: claudePrintModeArgs({ model, isRoot: isRootProcess() }), options, protocol: "claude-print" };

    default:
      throw new Error(`no protocol invocation is defined for provider "${provider.key}"`);
  }
}

function isRootProcess() {
  return typeof process.getuid === "function" ? process.getuid() === 0 : false;
}

/**
 * Print-mode argv for Claude Code — the fallback when the Agent SDK is not
 * installed. `--setting-sources user,project,local` mirrors what bb passes as
 * the SDK's `settingSources`, so ~/.claude OAuth and settings load exactly as
 * they do for the native CLI.
 *
 * The prompt is not here: it is written to the child's stdin as a stream-json
 * frame, so no prompt ever rides argv and stdin is never the user's TTY.
 */
export function claudePrintModeArgs({ model = null, isRoot = false } = {}) {
  const argv = [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--setting-sources", "user,project,local",
  ];
  // Claude Code refuses to skip permissions as root and exits before the
  // session starts, so keep the auto-approve intent with the strongest mode
  // root accepts. bb drops the SDK flags the same way.
  if (isRoot) argv.push("--permission-mode", "acceptEdits");
  else argv.push("--permission-mode", "bypassPermissions", "--dangerously-skip-permissions");
  if (model) argv.push("--model", model);
  return argv;
}

const AUTH_REQUIRED_PATTERNS = [
  /authentication required/i,
  /not\s+(?:currently\s+)?(?:logged|signed)\s*-?\s*in/i,
  /unauthenticated/i,
  /please\s+(?:run|sign|log)\b[^.]{0,40}\blog\s?in/i,
  /\b(?:invalid|expired|missing)\s+(?:credentials|token|session)\b/i,
  /oauth token has expired/i,
  /run\s+`?[\w-]+ (?:auth )?login`?/i,
  /401\b.*unauthor/i,
];

/**
 * Does this failure mean "sign in first" rather than "something broke"?
 *
 * bb classifies the same way (`isAuthRequiredModelListError` in its ACP
 * bridge): match on the child's own words. Anything unrecognised is left as a
 * normal error, because telling somebody to log in again when that is not the
 * problem sends them down the wrong path.
 */
export function isAuthRequiredError(...parts) {
  const text = parts
    .map((part) => (part instanceof Error ? part.message : typeof part === "string" ? part : ""))
    .join("\n");
  if (text.trim() === "") return false;
  return AUTH_REQUIRED_PATTERNS.some((pattern) => pattern.test(text));
}

/** The one line makefaster prints instead of ever starting a login flow. */
export function signedOutGuidance(provider, detail) {
  const command = provider.signIn || `${provider.executablePath} login`;
  const because = detail ? ` (${String(detail).split(/\r?\n/)[0].slice(0, 120)})` : "";
  return `${provider.displayName} needs a sign-in${because} — sign in once with the native CLI (\`${command}\`), then rerun npx makefaster.`;
}
