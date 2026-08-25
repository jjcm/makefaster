/**
 * Argument parsing for `npx makefaster [dir] [flags]`. Hand-rolled so the CLI
 * stays dependency-free.
 */

export const USAGE = `Usage: npx makefaster [dir] [options]

Runs the makefaster autoresearch loop against the site in [dir] (default:
the current directory), driving either makefaster's own hosted model or an
agent CLI you already have installed and are signed into. An agent CLI runs
hidden: makefaster keeps the terminal, so its native interface never draws and
it never asks you to log in, trust the workspace, or approve individual tools.

Options:
  --cli <makefaster|cursor|claude|codex>
                                Skip the picker and use this agent.
                                "makefaster" is the hosted default: the model
                                runs through makefaster.dev, so it needs no
                                local CLI, no account, and no API key of yours.
  --model <id>                  Skip the model picker and use this model id
                                (the ids come from the chosen CLI's own model
                                list; see the picker for the ranked five).
                                Unused by --cli makefaster, whose model is
                                pinned by the server.
  --url <example.com>           The public URL of the site (used for the
                                site-leaderboard submission)
  --api <base>                  Leaderboard API base
                                (default: $MAKEFASTER_API_BASE or https://makefaster.dev)
  --improvements <path|url>     Override the improvement-checklist source
  --max-misses <n>              Stop after n consecutive missed iterations (default 5)
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

const CLI_ALIASES = new Map([
  // The hosted provider answers to both names: it is makefaster's own option,
  // and it is OpenRouter underneath.
  ["makefaster", "makefaster"], ["openrouter", "makefaster"], ["hosted", "makefaster"],
  ["cursor", "cursor"], ["cursor-agent", "cursor"], ["agent", "cursor"],
  ["claude", "claude"], ["claude-code", "claude"], ["claudecode", "claude"],
  ["codex", "codex"],
]);

export function parseArgs(argv) {
  const args = {
    targetDir: null,
    cli: null,
    model: null,
    url: null,
    api: null,
    improvementsSource: null,
    maxMisses: 5,
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
          const key = CLI_ALIASES.get(value.toLowerCase());
          if (!key) errors.push(`--cli must be one of: makefaster, cursor, claude, codex (got "${value}")`);
          else args.cli = key;
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
      case "--max-misses": {
        const value = takeValue(argv, i, "--max-misses");
        if (value !== null) {
          i++;
          const n = Number.parseInt(value, 10);
          if (!Number.isInteger(n) || n < 1 || n > 100) errors.push("--max-misses must be an integer between 1 and 100");
          else args.maxMisses = n;
        }
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
