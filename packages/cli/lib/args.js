/**
 * Argument parsing for `npx makefaster [dir] [flags]`. Hand-rolled so the CLI
 * stays dependency-free.
 *
 * `--max-misses` used to cap the run at n consecutive measurements with no
 * serious improvement. It is gone: a streak of misses is what walking a ranked
 * checklist honestly looks like early on, and stopping for it ended sessions
 * five measurements into a fifty-category list. The flag is still recognized so
 * it can say that rather than read as a typo.
 */

export const USAGE = `Usage: npx makefaster [dir] [options]

Runs the makefaster autoresearch loop against the site in [dir] (default:
the current directory), driving an agent CLI you already have installed and are
signed into. The agent CLI runs hidden: makefaster keeps the terminal, so its
native interface never draws and it never asks you to log in, trust the
workspace, or approve individual tools.

Options:
  --cli <cursor|claude|codex>   Skip the picker and use this agent. It must be
                                installed on this machine: makefaster drives
                                your own install and hosts no model of its own.
  --model <id>                  Skip the model picker and use this model id.
                                The ids come from the chosen CLI's own model
                                list (see the picker for the ranked five).
  --url <example.com>           The public URL of the site (used for the
                                site-leaderboard submission)
  --api <base>                  Leaderboard API base
                                (default: $MAKEFASTER_API_BASE or https://makefaster.dev)
  --improvements <path|url>     Override the improvement-checklist source
  --extras <n>                  How many hypotheses of its own the agent may add
                                after the checklist is finished (default 5, and
                                it may use fewer). The run is the whole imported
                                checklist plus these — there is no early stop.
  --no-tui                      Skip the full-screen dashboard and print plain
                                progress lines (automatic when not a TTY)
  -h, --help                    Show this help
  -v, --version                 Print the version

Environment:
  CURSOR_AGENT_EXECUTABLE, CLAUDE_CODE_EXECUTABLE (or BB_CLAUDE_CODE_EXECUTABLE),
  CODEX_EXECUTABLE               Explicit paths to agent CLI binaries
  MAKEFASTER_API_BASE            Leaderboard API base
  MAKEFASTER_NO_TUI              Skip the full-screen dashboard
  NO_COLOR                       Disable colors
`;

/**
 * How many hypotheses of its own the agent may add once the checklist is done.
 * The only model-chosen part of the run, and the only budget in it: the
 * checklist's own length comes from the live board, not from here.
 */
export const DEFAULT_EXTRAS = 5;
const MAX_EXTRAS = 20;

const CLI_ALIASES = new Map([
  ["cursor", "cursor"], ["cursor-agent", "cursor"], ["agent", "cursor"],
  ["claude", "claude"], ["claude-code", "claude"], ["claudecode", "claude"],
  ["codex", "codex"],
]);

/**
 * `--cli makefaster` used to select makefaster's own hosted model, served
 * through makefaster.dev. It is gone, and the names it answered to are kept
 * here so passing one says that rather than reading as a typo.
 */
const REMOVED_CLIS = new Set(["makefaster", "openrouter", "hosted"]);

export function parseArgs(argv) {
  const args = {
    targetDir: null,
    cli: null,
    model: null,
    url: null,
    api: null,
    improvementsSource: null,
    extras: DEFAULT_EXTRAS,
    tui: true,
    help: false,
    version: false,
  };
  const errors = [];

  const takeValue = (list, i, flag) => {
    const value = list[i + 1];
    if (value === undefined || value.startsWith("-")) {
      errors.push(`${flag} needs a value`);
      return null;
    }
    return value;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "-h": case "--help": args.help = true; break;
      case "-v": case "--version": args.version = true; break;
      case "--no-tui": args.tui = false; break;
      case "--cli": {
        const value = takeValue(argv, i, "--cli");
        if (value !== null) {
          i++;
          const wanted = value.toLowerCase();
          const key = CLI_ALIASES.get(wanted);
          if (key) args.cli = key;
          else if (REMOVED_CLIS.has(wanted)) {
            errors.push(`--cli ${value} is gone: makefaster no longer hosts a model of its own — use --cli cursor, claude, or codex.`);
          } else errors.push(`--cli must be one of: cursor, claude, codex (got "${value}")`);
        }
        break;
      }
      case "--model": {
        const value = takeValue(argv, i, "--model");
        if (value !== null) { i++; args.model = value; }
        break;
      }
      case "--url": {
        const value = takeValue(argv, i, "--url");
        if (value !== null) { i++; args.url = value; }
        break;
      }
      case "--api": {
        const value = takeValue(argv, i, "--api");
        if (value !== null) { i++; args.api = value.replace(/\/$/, ""); }
        break;
      }
      case "--improvements": {
        const value = takeValue(argv, i, "--improvements");
        if (value !== null) { i++; args.improvementsSource = value; }
        break;
      }
      case "--extras": {
        const value = takeValue(argv, i, "--extras");
        if (value !== null) {
          i++;
          const n = Number.parseInt(value, 10);
          if (!Number.isInteger(n) || n < 0 || n > MAX_EXTRAS) errors.push(`--extras must be an integer between 0 and ${MAX_EXTRAS}`);
          else args.extras = n;
        }
        break;
      }
      case "--max-misses": {
        // Consume the value so it is not reported a second time as a stray
        // positional argument.
        if (takeValue(argv, i, "--max-misses") !== null) i++;
        errors.push("--max-misses is gone: the loop no longer stops on a miss streak. It runs the " +
          "whole imported checklist and then up to --extras hypotheses of its own.");
        break;
      }
      default:
        if (arg.startsWith("-")) {
          errors.push(`unknown option "${arg}"`);
        } else if (args.targetDir === null) {
          args.targetDir = arg;
        } else {
          errors.push(`unexpected argument "${arg}"`);
        }
    }
  }

  return { args, errors };
}
