import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectProviders, missingCliGuidance } from "../lib/detect.js";

function makeSandbox() {
  const root = mkdtempSync(join(tmpdir(), "mf-detect-"));
  const bin = join(root, "bin");
  const home = join(root, "home");
  mkdirSync(bin, { recursive: true });
  mkdirSync(home, { recursive: true });
  return { root, bin, home };
}

function fakeBinary(dir, name) {
  const path = join(dir, name);
  writeFileSync(path, "#!/bin/sh\necho fake\n");
  chmodSync(path, 0o755);
  return path;
}

const quietProbe = () => ({ ok: true, version: "9.9.9 (test)", output: "9.9.9 (test)" });

function detect({ env = {}, home, isRoot = false, probeVersion = quietProbe } = {}) {
  return detectProviders({
    env: { PATH: "", ...env },
    platform: "linux",
    home,
    isRoot,
    execDir: null,
    probeVersion,
  });
}

test("finds all three providers on PATH", () => {
  const { root, bin, home } = makeSandbox();
  try {
    fakeBinary(bin, "cursor-agent");
    fakeBinary(bin, "claude");
    fakeBinary(bin, "codex");
    const reports = detect({ env: { PATH: bin }, home });
    for (const report of reports) {
      assert.equal(report.found, true, `${report.key} should be found`);
      assert.equal(report.source, "path");
      assert.equal(report.version, "9.9.9 (test)");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("falls back to well-known install locations", () => {
  const { root, home } = makeSandbox();
  try {
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    mkdirSync(join(home, ".claude", "local"), { recursive: true });
    mkdirSync(join(home, ".cursor", "bin"), { recursive: true });
    fakeBinary(join(home, ".claude", "local"), "claude");
    fakeBinary(join(home, ".cursor", "bin"), "cursor-agent");
    const reports = detect({ home });
    const claude = reports.find((r) => r.key === "claude");
    const cursor = reports.find((r) => r.key === "cursor");
    const codex = reports.find((r) => r.key === "codex");
    assert.equal(claude.found, true);
    assert.equal(claude.source, "well-known");
    assert.equal(claude.executablePath, join(home, ".claude", "local", "claude"));
    assert.equal(cursor.found, true);
    assert.equal(cursor.source, "well-known");
    assert.equal(codex.found, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("well-known locations are skipped when running as root", () => {
  const { root, home } = makeSandbox();
  try {
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    fakeBinary(join(home, ".local", "bin"), "claude");
    const reports = detect({ home, isRoot: true });
    assert.equal(reports.find((r) => r.key === "claude").found, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("env override wins and BB_CLAUDE_CODE_EXECUTABLE is honored", () => {
  const { root, bin, home } = makeSandbox();
  try {
    const claudePath = fakeBinary(bin, "my-claude");
    const reports = detect({ env: { BB_CLAUDE_CODE_EXECUTABLE: claudePath }, home });
    const claude = reports.find((r) => r.key === "claude");
    assert.equal(claude.found, true);
    assert.equal(claude.source, "env:BB_CLAUDE_CODE_EXECUTABLE");
    assert.equal(claude.executablePath, claudePath);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a broken env override is a visible error, not a silent fall-through", () => {
  const { root, bin, home } = makeSandbox();
  try {
    fakeBinary(bin, "claude"); // valid binary on PATH that must NOT be used
    const reports = detect({
      env: { PATH: bin, CLAUDE_CODE_EXECUTABLE: join(root, "does-not-exist") },
      home,
    });
    const claude = reports.find((r) => r.key === "claude");
    assert.equal(claude.found, false);
    assert.match(claude.error, /CLAUDE_CODE_EXECUTABLE/);
    assert.match(claude.error, /does-not-exist/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a bare `agent` binary is only accepted when it is Cursor's", () => {
  const { root, bin, home } = makeSandbox();
  try {
    fakeBinary(bin, "agent"); // some unrelated agent
    let reports = detect({
      env: { PATH: bin },
      home,
      probeVersion: () => ({ ok: true, version: "0.1", output: "generic agent 0.1" }),
    });
    assert.equal(reports.find((r) => r.key === "cursor").found, false, "unrelated `agent` must be rejected");

    // Same binary, but --version identifies it as Cursor's agent.
    reports = detect({
      env: { PATH: bin },
      home,
      probeVersion: () => ({ ok: true, version: "2026.1", output: "cursor-agent 2026.1" }),
    });
    assert.equal(reports.find((r) => r.key === "cursor").found, true, "`agent` reporting cursor must be accepted");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a symlinked `agent` resolving into a cursor install is accepted without probing", () => {
  const { root, bin, home } = makeSandbox();
  try {
    const versions = join(home, ".local", "share", "cursor-agent", "versions", "1.0");
    mkdirSync(versions, { recursive: true });
    const real = fakeBinary(versions, "cursor-agent");
    symlinkSync(real, join(bin, "agent"));
    const reports = detect({
      env: { PATH: bin },
      home,
      probeVersion: (path) => (path.endsWith("agent") ? { ok: true, version: "1.0", output: "1.0" } : quietProbe()),
    });
    const cursor = reports.find((r) => r.key === "cursor");
    assert.equal(cursor.found, true);
    assert.equal(cursor.source, "path");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("config-home hints surface when the binary is missing", () => {
  const { root, home } = makeSandbox();
  try {
    mkdirSync(join(home, ".codex"), { recursive: true });
    const reports = detect({ home });
    const codex = reports.find((r) => r.key === "codex");
    assert.equal(codex.found, false);
    assert.match(codex.hint, /\.codex/);
    assert.match(codex.hint, /no runnable binary/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("missingCliGuidance names every installer and does not offer a bundled model", () => {
  const { root, home } = makeSandbox();
  try {
    const reports = detect({ home });
    const guidance = missingCliGuidance(reports);
    assert.match(guidance, /does not bundle or download a model/);
    assert.match(guidance, /cursor\.com\/install/);
    assert.match(guidance, /claude\.ai\/install\.sh/);
    assert.match(guidance, /npm install -g @openai\/codex/);
    assert.match(guidance, /CLAUDE_CODE_EXECUTABLE/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
