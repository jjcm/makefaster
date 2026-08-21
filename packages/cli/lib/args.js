/**
 * Argument parsing for `npx makefaster [dir] [flags]`. Hand-rolled so the CLI
 * stays dependency-free.
 */

export const USAGE = `Usage: npx makefaster [dir] [options]

Runs the makefaster autoresearch loop against the site in [dir] (default:
the current directory), driving an agent CLI you already have installed.

Options:
  --cli <cursor|claude|codex>   Skip the picker and use this agent CLI
  --url <example.com>           The public URL of the site (used for the
                                site-leaderboard submission)
  --api <base>                  Leaderboard API base
                                (default: $MAKEFASTER_API_BASE or https://makefaster.dev)
  --improvements <path|url>     Override the improvement-checklist source
  --max-misses <n>              Stop after n consecutive missed iterations (default 5)
  -h, --help                    Show this help
  -v, --version                 Print the version

Environment:
  CURSOR_AGENT_EXECUTABLE, CLAUDE_CODE_EXECUTABLE (or BB_CLAUDE_CODE_EXECUTABLE),
  CODEX_EXECUTABLE               Explicit paths to agent CLI binaries
  MAKEFASTER_API_BASE            Leaderboard API base
  NO_COLOR                       Disable colors
`;

const CLI_ALIASES = new Map([
  ["cursor", "cursor"], ["cursor-agent", "cursor"], ["agent", "cursor"],
  ["claude", "claude"], ["claude-code", "claude"], ["claudecode", "claude"],
  ["codex", "codex"],
]);

export function parseArgs(argv) {
  const args = {
    targetDir: null,
    cli: null,
    url: null,
    api: null,
    improvementsSource: null,
    maxMisses: 5,
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
      case "--cli": {
        const value = takeValue(argv, i, "--cli");
        if (value !== null) {
          i++;
          const key = CLI_ALIASES.get(value.toLowerCase());
          if (!key) errors.push(`--cli must be one of: cursor, claude, codex (got "${value}")`);
          else args.cli = key;
        }
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
