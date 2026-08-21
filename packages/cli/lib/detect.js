/**
 * Detect the inference/agent CLIs already installed on this machine, the way
 * bb / get-bb does: makefaster never vendors a model or starts an inference
 * server — it piggybacks on the agent CLIs the user already has and is
 * signed into.
 *
 * Per provider, in order:
 *   1. explicit env override (e.g. CLAUDE_CODE_EXECUTABLE / the documented
 *      BB_CLAUDE_CODE_EXECUTABLE) — if set but not executable, the provider
 *      is reported with an error instead of silently falling through;
 *   2. a PATH scan for the provider's executable names (executable regular
 *      files only, symlinks followed);
 *   3. well-known install locations (~/.local/bin, ~/.claude/local,
 *      ~/.cursor/bin, Homebrew, /usr/local/bin, beside the running node for
 *      npm-global installs) — skipped when running as root so a user-writable
 *      binary is never picked up with elevated privileges (root can still use
 *      the env overrides);
 *   4. config-home hints (~/.cursor, ~/.claude, CODEX_HOME or ~/.codex) are
 *      reported as evidence ("config found, binary missing") but never launch
 *      anything by themselves.
 */

import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const VERSION_PROBE_TIMEOUT_MS = 5_000;

export const PROVIDERS = [
  {
    key: "cursor",
    displayName: "Cursor Agent",
    // `cursor-agent` is the installed binary; newer installs also expose a
    // bare `agent`. The bare name is generic, so an `agent` hit must prove it
    // is Cursor's (resolved path or --version mentions cursor) before use.
    executables: ["cursor-agent", "agent"],
    envOverrides: ["MAKEFASTER_CURSOR_EXECUTABLE", "CURSOR_AGENT_EXECUTABLE"],
    wellKnown: ({ home }) => [
      join(home, ".local", "bin", "cursor-agent"),
      join(home, ".cursor", "bin", "cursor-agent"),
      "/opt/homebrew/bin/cursor-agent",
      "/usr/local/bin/cursor-agent",
    ],
    homeHints: ({ home }) => [join(home, ".cursor")],
    install: "curl https://cursor.com/install -fsS | bash",
    validateAmbiguousName: (name, { resolvedPath, versionOutput }) => {
      if (name !== "agent") return true;
      return /cursor/i.test(resolvedPath) || /cursor/i.test(versionOutput || "");
    },
  },
  {
    key: "claude",
    displayName: "Claude Code",
    executables: ["claude"],
    envOverrides: ["CLAUDE_CODE_EXECUTABLE", "BB_CLAUDE_CODE_EXECUTABLE"],
    wellKnown: ({ home }) => [
      join(home, ".local", "bin", "claude"),
      join(home, ".claude", "local", "claude"),
      "/opt/homebrew/bin/claude",
      "/usr/local/bin/claude",
    ],
    homeHints: ({ home }) => [join(home, ".claude")],
    install: "curl -fsSL https://claude.ai/install.sh | bash   (or: npm install -g @anthropic-ai/claude-code)",
  },
  {
    key: "codex",
    displayName: "Codex",
    executables: ["codex"],
    envOverrides: ["MAKEFASTER_CODEX_EXECUTABLE", "CODEX_EXECUTABLE"],
    wellKnown: ({ home, execDir }) => [
      join(home, ".local", "bin", "codex"),
      "/opt/homebrew/bin/codex",
      "/usr/local/bin/codex",
      // npm -g installs land beside the node binary under nvm/volta/asdf.
      ...(execDir ? [join(execDir, "codex")] : []),
    ],
    homeHints: ({ home, env }) => [env.CODEX_HOME || join(home, ".codex")],
    install: "npm install -g @openai/codex",
  },
];

function isExecutableFile(candidatePath) {
  try {
    accessSync(candidatePath, constants.X_OK);
    return statSync(candidatePath).isFile();
  } catch {
    return false;
  }
}

function windowsCandidates(basePath, env) {
  const pathext = (env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean);
  return [basePath, ...pathext.map((ext) => basePath + ext.toLowerCase()), ...pathext.map((ext) => basePath + ext)];
}

function resolveOnPath(executableName, { env, platform }) {
  const pathEnv = env.PATH || env.Path || "";
  for (const searchDir of pathEnv.split(delimiter)) {
    if (!searchDir) continue;
    const base = join(searchDir, executableName);
    const candidates = platform === "win32" ? windowsCandidates(base, env) : [base];
    for (const candidate of candidates) {
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

function directoryExists(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function defaultProbeVersion(executablePath) {
  try {
    const result = spawnSync(executablePath, ["--version"], {
      encoding: "utf8",
      timeout: VERSION_PROBE_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = `${result.stdout || ""}\n${result.stderr || ""}`;
    const line = output.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
    return { ok: result.status === 0, version: line ? line.slice(0, 60) : null, output };
  } catch {
    return { ok: false, version: null, output: "" };
  }
}

function safeRealpath(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * @param {object} [options] test injection points
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {string} [options.platform]
 * @param {string} [options.home]
 * @param {boolean} [options.isRoot]
 * @param {string|null} [options.execDir] directory of the running node binary
 * @param {(path: string) => {ok: boolean, version: string|null, output: string}} [options.probeVersion]
 * @returns {Array<{key, displayName, install, found, executablePath, source, version, error, hint}>}
 */
export function detectProviders(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? env.HOME ?? homedir();
  const isRoot = options.isRoot ?? (typeof process.getuid === "function" ? process.getuid() === 0 : false);
  const execDir = options.execDir === undefined ? dirname(process.execPath) : options.execDir;
  const probeVersion = options.probeVersion ?? defaultProbeVersion;

  return PROVIDERS.map((provider) => {
    const report = {
      key: provider.key,
      displayName: provider.displayName,
      install: provider.install,
      found: false,
      executablePath: null,
      source: null,
      version: null,
      error: null,
      hint: null,
    };

    // 1. Explicit env override — a broken override is an error the user must
    //    see, not something to silently skip (bb behaves the same way).
    for (const envName of provider.envOverrides) {
      const value = env[envName]?.trim();
      if (!value) continue;
      if (isExecutableFile(value)) {
        report.found = true;
        report.executablePath = value;
        report.source = `env:${envName}`;
      } else {
        report.error = `${envName} is set but does not point to an executable file: ${value}`;
      }
      break;
    }

    // 2. PATH scan.
    if (!report.found && !report.error) {
      for (const executableName of provider.executables) {
        const onPath = resolveOnPath(executableName, { env, platform });
        if (!onPath) continue;
        if (provider.validateAmbiguousName) {
          const resolvedPath = safeRealpath(onPath);
          let versionOutput = "";
          if (!/cursor/i.test(resolvedPath)) {
            versionOutput = probeVersion(onPath).output;
          }
          if (!provider.validateAmbiguousName(executableName, { resolvedPath, versionOutput })) {
            continue; // some unrelated `agent` binary — not ours to launch
          }
        }
        report.found = true;
        report.executablePath = onPath;
        report.source = "path";
        break;
      }
    }

    // 3. Well-known install locations (never as root).
    if (!report.found && !report.error && !isRoot) {
      for (const candidate of provider.wellKnown({ home, env, execDir })) {
        if (isExecutableFile(candidate)) {
          report.found = true;
          report.executablePath = candidate;
          report.source = "well-known";
          break;
        }
      }
    }

    // 4. Config-home evidence for the "not found" message.
    if (!report.found) {
      for (const hintPath of provider.homeHints({ home, env })) {
        if (directoryExists(hintPath)) {
          report.hint = `${hintPath} exists — ${provider.displayName} has been used here, but no runnable binary was found`;
          break;
        }
      }
    }

    // Version banner for the picker.
    if (report.found) {
      const probe = probeVersion(report.executablePath);
      if (probe.version) report.version = probe.version;
    }

    return report;
  });
}

/** The user-facing "nothing installed" guidance, in bb's missing-CLI tone. */
export function missingCliGuidance(reports) {
  const lines = [
    "makefaster could not find any supported agent CLI on this machine.",
    "",
    "makefaster does not bundle or download a model — it drives an agent CLI",
    "you already have and are signed into. Install one of these, then run",
    "`npx makefaster` again:",
    "",
  ];
  for (const report of reports) {
    lines.push(`  ${report.displayName.padEnd(14)}${report.install}`);
  }
  lines.push("");
  const hints = reports.filter((r) => r.hint).map((r) => `  note: ${r.hint}`);
  if (hints.length > 0) lines.push(...hints, "");
  const errors = reports.filter((r) => r.error).map((r) => `  error: ${r.error}`);
  if (errors.length > 0) lines.push(...errors, "");
  lines.push(
    "If your CLI lives somewhere unusual, point makefaster at it with",
    "CURSOR_AGENT_EXECUTABLE, CLAUDE_CODE_EXECUTABLE (BB_CLAUDE_CODE_EXECUTABLE",
    "works too), or CODEX_EXECUTABLE.",
  );
  return lines.join("\n");
}
