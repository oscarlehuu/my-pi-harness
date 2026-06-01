#!/usr/bin/env bash
# Headless unit test for the UI-developer fallback detector + the ledger 'track' field.
# Pure data-layer (no agents, no TTY) — mirrors the ledger_test.sh style.
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
export ROOT_DIR

node --input-type=module <<'NODE'
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const fb = await import(pathToFileURL(`${process.env.ROOT_DIR}/extensions/foreman/fallback.ts`).href);
const led = await import(pathToFileURL(`${process.env.ROOT_DIR}/extensions/foreman/ledger.ts`).href);

// ---- devFallbackReason: each failure signal trips fallback ----
assert.equal(
  fb.devFallbackReason({ exitCode: 1 }, true, "a", "b"),
  "process exited 1",
  "non-zero exit -> fallback",
);
assert.equal(
  fb.devFallbackReason({ exitCode: 0 }, false, "a", "b"),
  "no DEV-JSON machine block",
  "missing machine block -> fallback",
);
assert.equal(
  fb.devFallbackReason({ exitCode: 0 }, true, "same", "same"),
  "no file changes on disk",
  "unchanged tree -> fallback",
);

// ---- devFallbackReason: a real, well-formed run does NOT fall back ----
assert.equal(
  fb.devFallbackReason({ exitCode: 0 }, true, "before", "after"),
  null,
  "edited tree + machine block -> no fallback",
);
// When git is unavailable (null snapshots) we can't use the tree signal; a clean run still passes.
assert.equal(
  fb.devFallbackReason({ exitCode: 0 }, true, null, null),
  null,
  "no git snapshot + machine block -> no fallback (don't false-trip)",
);

// ---- workingTreeSnapshot: real git repo reflects a new file; non-repo returns null ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-fallback-test."));
try {
  assert.equal(fb.workingTreeSnapshot(path.join(tmp, "not-a-repo")), null, "missing dir -> null snapshot");

  const repo = path.join(tmp, "repo");
  fs.mkdirSync(repo, { recursive: true });
  const { spawnSync } = await import("node:child_process");
  spawnSync("git", ["init", "-q"], { cwd: repo });
  const clean = fb.workingTreeSnapshot(repo);
  assert.equal(clean, "", "fresh repo -> empty porcelain snapshot");
  fs.writeFileSync(path.join(repo, "App.tsx"), "export const App = () => null;\n");
  const dirty = fb.workingTreeSnapshot(repo);
  assert.notEqual(dirty, clean, "adding a file changes the snapshot (detects 'made edits')");

  // ---- ledger: track persists and defaults to backend ----
  led.configureMirror(path.join(tmp, "mirror"));
  const fe = led.initLedger(repo, "Build the settings page UI", 3, undefined, "sess-fe", "frontend");
  assert.equal(fe.track, "frontend", "frontend track is stored");
  assert.equal(led.readState(repo, fe.slug).track, "frontend", "frontend track survives a reload");
  const be = led.initLedger(repo, "Add a backend cache layer", 3, undefined, "sess-be");
  assert.equal(be.track, "backend", "track defaults to backend when omitted");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("Foreman fallback + track tests passed");
NODE
