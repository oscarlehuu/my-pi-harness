#!/usr/bin/env bash
# Headless unit test for the generic Foreman gate pipeline engine.
# Pure data-layer/command runner (no pi, no agents, no TTY) — mirrors fallback_test.sh style.
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
export ROOT_DIR

node --input-type=module <<'NODE'
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const gatesMod = await import(pathToFileURL(`${process.env.ROOT_DIR}/extensions/foreman/gates.ts`).href);

function writeForemanJson(repo, value) {
  fs.mkdirSync(path.join(repo, ".pi"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".pi", "foreman.json"), JSON.stringify(value, null, 2));
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-gates-test."));
try {
  // 1. loadGates reads declared gates in order and preserves the typed gate payloads.
  const declaredRepo = path.join(tmp, "declared");
  const declared = [
    { name: "unit", kind: "command", stage: "per-round", command: "npm test" },
    { name: "review", kind: "judge", stage: "pre-ship", agent: "tester" },
    { name: "tag", kind: "action", stage: "release", action: "git tag v1.0.0" },
  ];
  writeForemanJson(declaredRepo, { gates: declared });
  assert.deepEqual(gatesMod.loadGates(declaredRepo, "ignored fallback"), declared, "declared gates load in order");

  // 2. Backward compatibility when no foreman.json exists.
  const legacyRepo = path.join(tmp, "legacy");
  assert.deepEqual(
    gatesMod.loadGates(legacyRepo, "python3 -m pytest -q"),
    [{ name: "verify", kind: "command", stage: "per-round", command: "python3 -m pytest -q" }],
    "legacy verifyCommand becomes one per-round command gate",
  );
  assert.deepEqual(gatesMod.loadGates(path.join(tmp, "no-fallback")), [], "no config + no fallback -> no gates");

  // 3. Malformed foreman.json never throws and skips bad parts.
  const badJsonRepo = path.join(tmp, "bad-json");
  fs.mkdirSync(path.join(badJsonRepo, ".pi"), { recursive: true });
  fs.writeFileSync(path.join(badJsonRepo, ".pi", "foreman.json"), "{ this is not json");
  assert.deepEqual(gatesMod.loadGates(badJsonRepo, "ignored fallback"), [], "bad JSON -> [] without fallback");

  const mixedRepo = path.join(tmp, "mixed");
  writeForemanJson(mixedRepo, {
    gates: [
      { name: "ok", kind: "command", stage: "per-round", command: "true" },
      { name: "missing command", kind: "command", stage: "per-round" },
      { name: "bad stage", kind: "command", stage: "nightly", command: "true" },
      { name: "missing agent", kind: "judge", stage: "pre-ship" },
      "not an object",
    ],
  });
  assert.deepEqual(
    gatesMod.loadGates(mixedRepo),
    [{ name: "ok", kind: "command", stage: "per-round", command: "true" }],
    "invalid gate entries are skipped while valid entries survive",
  );

  // 4. gatesForStage / hasStage select correctly across all stages.
  const loaded = gatesMod.loadGates(declaredRepo);
  assert.deepEqual(gatesMod.gatesForStage(loaded, "per-round").map((g) => g.name), ["unit"], "per-round selector");
  assert.deepEqual(gatesMod.gatesForStage(loaded, "pre-ship").map((g) => g.name), ["review"], "pre-ship selector");
  assert.deepEqual(gatesMod.gatesForStage(loaded, "release").map((g) => g.name), ["tag"], "release selector");
  assert.equal(gatesMod.hasStage(loaded, "per-round"), true, "has per-round");
  assert.equal(gatesMod.hasStage(loaded, "pre-ship"), true, "has pre-ship");
  assert.equal(gatesMod.hasStage(loaded, "release"), true, "has release");
  assert.equal(gatesMod.hasStage([], "release"), false, "empty set has no release stage");

  // 5. runCommandGates runs command gates in order and records exit codes.
  const runRepo = path.join(tmp, "runner");
  fs.mkdirSync(runRepo, { recursive: true });
  const mixedRun = await gatesMod.runCommandGates(
    [
      { name: "passes", kind: "command", stage: "per-round", command: "true" },
      { name: "fails", kind: "command", stage: "per-round", command: "false" },
    ],
    "per-round",
    runRepo,
  );
  assert.equal(mixedRun.passed, false, "one failing command fails the aggregate run");
  assert.deepEqual(mixedRun.results.map((r) => [r.name, r.exitCode]), [["passes", 0], ["fails", 1]], "records both exits");

  const allPassing = await gatesMod.runCommandGates(
    [
      { name: "one", kind: "command", stage: "per-round", command: "printf one" },
      { name: "two", kind: "command", stage: "per-round", command: "printf two" },
      { name: "release-only", kind: "command", stage: "release", command: "false" },
    ],
    "per-round",
    runRepo,
  );
  assert.equal(allPassing.passed, true, "all selected command gates passing -> passed=true");
  assert.deepEqual(allPassing.results.map((r) => r.exitCode), [0, 0], "non-selected stages do not run");
  assert.equal(allPassing.results[0].output, "one", "captures stdout tail");
}
finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("Foreman gate pipeline tests passed");
NODE
