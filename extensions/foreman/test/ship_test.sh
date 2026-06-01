#!/usr/bin/env bash
# Headless unit test for Foreman release/ship pure helpers.
# Pure data-layer (no git, no pi, no agents, no TTY) — mirrors planner/gates helper tests.
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
export ROOT_DIR

node --input-type=module <<'NODE'
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const ship = await import(pathToFileURL(`${process.env.ROOT_DIR}/extensions/foreman/ship.ts`).href);

// ---- inferCommitType ----
assert.equal(ship.inferCommitType("Fix the crash when the planner exits"), "fix", "fix/crash task -> fix");
assert.equal(ship.inferCommitType("Add a reviewer role for pre-ship gates"), "feat", "add task -> feat");
assert.equal(ship.inferCommitType("implement release action gates"), "feat", "implement task -> feat");
assert.equal(ship.inferCommitType("Refactor docs"), "chore", "other task -> chore");

// ---- buildCommitMessage ----
const longTask = "Implement release action gates for Foreman with a very long task title that must be shortened for git subjects\n\nMore detail.";
const message = ship.buildCommitMessage({
  task: longTask,
  slug: "phase-d-real-ship",
  track: "backend",
  filesChanged: [
    "extensions/foreman/index.ts - wires Gate 2 release actions",
    "extensions/foreman/ship.ts - adds pure ship helpers",
    "extensions/foreman/index.ts - wires Gate 2 release actions",
  ],
  reviewerSummary: "[reviewer] release: approve",
});
const messageAgain = ship.buildCommitMessage({
  task: longTask,
  slug: "phase-d-real-ship",
  track: "backend",
  filesChanged: [
    "extensions/foreman/index.ts - wires Gate 2 release actions",
    "extensions/foreman/ship.ts - adds pure ship helpers",
    "extensions/foreman/index.ts - wires Gate 2 release actions",
  ],
  reviewerSummary: "[reviewer] release: approve",
});
assert.equal(messageAgain, message, "fixed input produces deterministic commit message");
const [subject, , ...bodyLines] = message.split("\n");
const body = bodyLines.join("\n");
assert.match(subject, /^feat\(foreman-task\): /, "subject is conventional with inferred feat type");
assert.ok(subject.length <= 72, `subject should be <= 72 chars, got ${subject.length}: ${subject}`);
assert.match(body, /^Files changed:/, "body starts with files changed section");
assert.match(body, /- extensions\/foreman\/index\.ts - wires Gate 2 release actions/, "body includes index.ts bullet");
assert.match(body, /- extensions\/foreman\/ship\.ts - adds pure ship helpers/, "body includes ship.ts bullet");
assert.equal((body.match(/extensions\/foreman\/index\.ts/g) ?? []).length, 1, "filesChanged bullets are deduped");
assert.match(body, /slug: phase-d-real-ship/, "body notes Foreman slug");
assert.match(body, /track: backend/, "body notes track");
assert.match(body, /Reviewer summary: \[reviewer\] release: approve/, "body includes reviewer summary");

// ---- resolveStagePaths ----
const ledgerRelDir = ".pi/plans/phase-d-real-ship";
assert.deepEqual(
  ship.resolveStagePaths({ gatePaths: ["extensions/foreman/index.ts", "extensions/foreman/ship.ts"], filesChanged: ["ignored.ts - ignored"], ledgerRelDir }),
  ["extensions/foreman/index.ts", "extensions/foreman/ship.ts"],
  "gate paths override handoff-derived paths and do not auto-add the ledger",
);
assert.deepEqual(
  ship.resolveStagePaths({
    filesChanged: [
      "extensions/foreman/index.ts - wired commit action",
      "extensions/foreman/index.ts - duplicate should collapse",
      "`extensions/foreman/ship.ts` - pure helpers",
      "extensions/foreman/test/ship_test.sh",
    ],
    ledgerRelDir,
  }),
  ["extensions/foreman/index.ts", "extensions/foreman/ship.ts", "extensions/foreman/test/ship_test.sh", ledgerRelDir],
  "handoff entries resolve leading path tokens, dedupe, and append ledger dir",
);
assert.deepEqual(
  ship.resolveStagePaths({ filesChanged: [], ledgerRelDir }),
  [ledgerRelDir],
  "empty handoff paths stages only this task ledger",
);
for (const bad of ["-A", ".", ":"]) {
  assert.equal(
    ship.resolveStagePaths({ filesChanged: [`${bad} - unsafe`], ledgerRelDir }).includes(bad),
    false,
    `unsafe whole-tree pathspec ${bad} is never returned from handoff-derived paths`,
  );
  assert.equal(
    ship.resolveStagePaths({ gatePaths: [bad], ledgerRelDir }).includes(bad),
    false,
    `unsafe whole-tree pathspec ${bad} is never returned from gate paths`,
  );
}

// ---- decideShipCommit ----
assert.deepEqual(
  ship.decideShipCommit({ isGitRepo: true, hasReleaseCommitGate: true, stagedCount: 2 }),
  { commit: true, reason: "release commit gate declared with staged changes" },
  "commits only when every predicate is true",
);
assert.deepEqual(
  ship.decideShipCommit({ isGitRepo: true, hasReleaseCommitGate: false, stagedCount: 2 }),
  { commit: false, reason: "no release commit gate declared" },
  "no release commit gate -> skip reason",
);
assert.deepEqual(
  ship.decideShipCommit({ isGitRepo: false, hasReleaseCommitGate: true, stagedCount: 2 }),
  { commit: false, reason: "not a git repo" },
  "not a git repo -> skip reason",
);
assert.deepEqual(
  ship.decideShipCommit({ isGitRepo: true, hasReleaseCommitGate: true, stagedCount: 0 }),
  { commit: false, reason: "nothing to stage" },
  "nothing staged -> skip reason",
);

console.log("Foreman ship helper tests passed");
NODE
