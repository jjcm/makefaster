/**
 * How makefaster talks to an installed agent CLI: as a hidden worker, the way
 * bb's provider bridges do (get-bb/bb `plugins/provider-*`). Two rules come
 * straight from those bridges:
 *
 *   1. stdio is always piped — never `"inherit"`. bb's claude bridge
 *      (`bridge/sdk-session.ts`) and codex bridge (`bridge/app-server-connection.ts`)
 *      both spawn with `["pipe","pipe","pipe"]`, so the other product's TUI
 *      never draws and makefaster keeps the terminal.
 *   2. stdin is never the user's TTY. Attaching it is what makes these CLIs
 *      decide a human is present and start asking: login, workspace trust,
 *      per-tool permission cards. We pass the prompt as an argument and give
 *      the child `"ignore"` for stdin.
 *
 * Permissions are pre-granted rather than prompted, because the user already
 * opted into a local performance loop by running makefaster:
 *   - Claude Code  `--dangerously-skip-permissions` (bb sets the equivalent
 *     `permissionMode: "bypassPermissions"` + `allowDangerouslySkipPermissions`)
 *   - Codex        `--sandbox workspace-write` with `approval_policy = "never"`
 *     (bb's codex session params use the same never/auto-approve posture)
 *   - Cursor       `--force --trust --approve-mcps`, so neither command
 *     approval nor MCP approval nor workspace trust pops a card
 *
 * Credentials are reused, never created. Nothing here runs `auth login`, opens
 * a browser, or prints a device code; if the install is signed out we say so
 * once and stop.
 */

/** Piped, TTY-free stdio: nothing the child writes reaches the terminal raw. */
export const HEADLESS_STDIO = ["ignore", "pipe", "pipe"];

/** Codex refuses to ask a human here; bb sends the same policy per turn. */
const CODEX_APPROVAL_POLICY_OVERRIDE = 'approval_policy="never"';

function headlessEnv(env) {
  // Inherit the user's environment so ~/.claude, ~/.cursor and
  // CODEX_HOME/~/.codex credentials are found exactly as the native CLI finds
  // them. Only the two color knobs are forced, because the streams we parse
  // are JSON and ANSI escapes in them are noise.
  return { ...env, NO_COLOR: "1", FORCE_COLOR: "0" };
}

/**
 * Build the headless invocation for a provider.
 *
 * @param {object} args
 * @param {{key: string, displayName: string, executablePath: string}} args.provider
 * @param {string} args.prompt
 * @param {string} args.cwd
 * @param {string|null} [args.model] model id passed through to the CLI
 * @param {NodeJS.ProcessEnv} [args.env]
 * @param {boolean} [args.isRoot] Claude Code exits rather than skip permissions as root
 * @returns {{command: string, args: string[], options: object, streamFormat: string}}
 */
export function buildAgentInvocation({ provider, prompt, cwd, model = null, env = process.env, isRoot = false }) {
  const options = { cwd, env: headlessEnv(env), stdio: HEADLESS_STDIO, windowsHide: true };

  switch (provider.key) {
    case "cursor": {
      // `-p` is print mode: full tool access, no interactive UI. `--force`
      // allows commands unless explicitly denied, `--trust` accepts the
      // workspace without prompting (headless only), `--approve-mcps` keeps
      // MCP servers from raising approval cards.
      const argv = [
        "-p",
        "--output-format", "stream-json",
        "--force",
        "--trust",
        "--approve-mcps",
        "--workspace", cwd,
      ];
      if (model) argv.push("--model", model);
      argv.push(prompt);
      return { command: provider.executablePath, args: argv, options, streamFormat: "cursor-stream-json" };
    }

    case "claude": {
      // `-p --output-format stream-json --verbose` is Claude Code's print-mode
      // event stream (verbose is required alongside stream-json).
      const argv = ["-p", "--output-format", "stream-json", "--verbose"];
      // Claude Code refuses to skip permissions as root and exits before the
      // session starts, so keep the auto-approve intent with the strongest
      // mode root accepts (bb drops the flag the same way).
      if (isRoot) argv.push("--permission-mode", "acceptEdits");
      else argv.push("--dangerously-skip-permissions");
      if (model) argv.push("--model", model);
      argv.push(prompt);
      return { command: provider.executablePath, args: argv, options, streamFormat: "claude-stream-json" };
    }

    case "codex": {
      // `codex exec` is the non-interactive entry point; it already defaults to
      // an approval policy of never, and the -c override keeps that true on
      // installs configured otherwise. --sandbox workspace-write lets the loop
      // edit the repo it was pointed at. --full-auto is deliberately absent:
      // it was removed from the CLI.
      const argv = [
        "exec",
        "--sandbox", "workspace-write",
        "-c", CODEX_APPROVAL_POLICY_OVERRIDE,
        "--skip-git-repo-check",
        "--json",
        "--cd", cwd,
      ];
      if (model) argv.push("--model", model);
      argv.push(prompt);
      return { command: provider.executablePath, args: argv, options, streamFormat: "codex-jsonl" };
    }

    default:
      throw new Error(`no headless invocation is defined for provider "${provider.key}"`);
  }
}

/**
 * A read-only "are you still signed in?" probe. Never a login: each of these
 * only reports stored credential state.
 *
 * @returns {{command: string, args: string[], options: object, signedOutExitCodes: number[]}|null}
 */
export function buildAuthProbe({ provider, env = process.env }) {
  const options = { env: headlessEnv(env), stdio: HEADLESS_STDIO, windowsHide: true, encoding: "utf8" };
  switch (provider.key) {
    case "cursor":
      return { command: provider.executablePath, args: ["status", "--format", "json"], options, signedOutExitCodes: [] };
    case "claude":
      // Documented: exits 0 when logged in, 1 when not.
      return { command: provider.executablePath, args: ["auth", "status"], options, signedOutExitCodes: [1] };
    case "codex":
      return { command: provider.executablePath, args: ["login", "status"], options, signedOutExitCodes: [] };
    default:
      return null;
  }
}

const SIGNED_OUT_PATTERNS = [
  /not\s+(?:currently\s+)?(?:logged|signed)\s*-?\s*in/i,
  /logged\s+out/i,
  /no\s+(?:stored\s+)?credentials/i,
  /unauthenticated/i,
  /"logged_?in"\s*:\s*false/i,
  /"authenticated"\s*:\s*false/i,
  /"is_?logged_?in"\s*:\s*false/i,
];

// A CLI too old to know the probe subcommand fails for reasons that say nothing
// about credentials. Those runs proceed rather than blocking the user.
const INCONCLUSIVE_PATTERNS = [
  /unknown\s+(?:command|option|subcommand|argument)/i,
  /unrecognized\s+(?:subcommand|option|argument)/i,
  /unexpected\s+argument/i,
  /invalid\s+(?:command|subcommand)/i,
  /did\s+you\s+mean/i,
  /^\s*usage:/im,
];

/**
 * Classify a finished auth probe.
 *
 * Only a positive signal marks an install signed out — an unexplained failure
 * is "unknown" and the loop proceeds, because wrongly telling somebody to log
 * in again is worse than letting the real run report the real error.
 *
 * @returns {{state: "signed-in"|"signed-out"|"unknown", detail: string|null}}
 */
export function interpretAuthProbe({ status, stdout = "", stderr = "", error = null, timedOut = false, signedOutExitCodes = [] }) {
  const output = `${stdout}\n${stderr}`;
  if (SIGNED_OUT_PATTERNS.some((pattern) => pattern.test(output))) {
    return { state: "signed-out", detail: firstMeaningfulLine(output) };
  }
  if (error || timedOut) return { state: "unknown", detail: timedOut ? "the probe timed out" : String(error?.message || error) };
  if (status === 0) return { state: "signed-in", detail: null };
  if (INCONCLUSIVE_PATTERNS.some((pattern) => pattern.test(output))) {
    return { state: "unknown", detail: "this CLI does not support the sign-in probe" };
  }
  if (signedOutExitCodes.includes(status)) {
    return { state: "signed-out", detail: firstMeaningfulLine(output) };
  }
  return { state: "unknown", detail: firstMeaningfulLine(output) };
}

function firstMeaningfulLine(output) {
  const line = output.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
  return line ? line.slice(0, 160) : null;
}

/** The one line makefaster prints instead of ever starting a login flow. */
export function signedOutGuidance(provider, detail) {
  const command = provider.signIn || `${provider.executablePath} login`;
  return `${provider.displayName} is signed out${detail ? ` (${detail})` : ""} — sign in once with the native CLI (\`${command}\`), then rerun npx makefaster.`;
}
