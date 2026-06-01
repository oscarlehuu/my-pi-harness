#!/usr/bin/env bash
# Headless unit test for Foreman pre-ship reviewer helpers.
# Pure data-layer (no pi, no agents, no TTY) — validates REVIEW parsing and gate decisions.
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
export ROOT_DIR

node --input-type=module <<'NODE'
import assert from "node:assert/strict";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const reviewer = await import(pathToFileURL(`${process.env.ROOT_DIR}/extensions/foreman/reviewer.ts`).href);
const gatesMod = await import(pathToFileURL(`${process.env.ROOT_DIR}/extensions/foreman/gates.ts`).href);
const reviewerPrompt = fs.readFileSync(`${process.env.ROOT_DIR}/extensions/foreman/crew/reviewer.md`, "utf-8");
const foremanIndex = fs.readFileSync(`${process.env.ROOT_DIR}/extensions/foreman/index.ts`, "utf-8");

assert.match(foremanIndex, /runCommandGates\(gates,\s*"pre-ship",\s*cwd,\s*signal\)/, "orchestrator runs pre-ship command gates through runCommandGates");
assert.match(foremanIndex, /parseReviewVerdict\(reviewRun\.text\)/, "orchestrator parses reviewer output with the pure helper");
assert.doesNotMatch(foremanIndex, /TODO\(Phase C\)/, "Phase C pre-ship hook is implemented");
assert.match(reviewerPrompt, /^name: reviewer$/m, "reviewer crew name is declared");
assert.match(reviewerPrompt, /^model: cliproxy\/claude-opus-4-8:xhigh$/m, "reviewer uses the required Opus xhigh model");
assert.match(reviewerPrompt, /^tools: read, grep, find, ls, bash$/m, "reviewer tools are read-only");
assert.match(reviewerPrompt, /REVIEW: APPROVE/, "reviewer prompt documents approve verdict");
assert.match(reviewerPrompt, /REVIEW: REQUEST-CHANGES/, "reviewer prompt documents request-changes verdict");
assert.match(reviewerPrompt, /BLOCKING:/, "reviewer prompt requires blocking section");
assert.match(reviewerPrompt, /NITS:/, "reviewer prompt separates non-blocking nits");

const approved = reviewer.parseReviewVerdict(`Looks good.\n\nREVIEW: APPROVE\n\nNITS:\n- extensions/foreman/index.ts:1 - optional polish`);
assert.equal(approved.decision, "approve", "approve verdict parses");
assert.deepEqual(approved.blocking, [], "approve has no blocking findings");
assert.deepEqual(approved.nits, ["extensions/foreman/index.ts:1 - optional polish"], "nits are captured separately");

const requestChanges = reviewer.parseReviewVerdict(`Review notes\nREVIEW: REQUEST-CHANGES\n\nBLOCKING:\n- extensions/foreman/index.ts:1108 - run pre-ship gates before Gate 2.\n* extensions/foreman/reviewer.ts:42 - unknown verdict must not approve.\n\nNITS:\n1. extensions/foreman/crew/reviewer.md:10 - tighten wording.`);
assert.equal(requestChanges.decision, "request-changes", "request-changes verdict parses");
assert.deepEqual(
  requestChanges.blocking,
  [
    "extensions/foreman/index.ts:1108 - run pre-ship gates before Gate 2.",
    "extensions/foreman/reviewer.ts:42 - unknown verdict must not approve.",
  ],
  "blocking bullets are captured without bullet markers",
);
assert.deepEqual(requestChanges.nits, ["extensions/foreman/crew/reviewer.md:10 - tighten wording."], "nits never become blocking");

const proseOnly = reviewer.parseReviewVerdict("I think this is probably fine, but I forgot the machine line.");
assert.equal(proseOnly.decision, "unknown", "missing REVIEW line is unknown, not approve");
assert.deepEqual(proseOnly.blocking, [], "unknown may have no blocking findings");

assert.deepEqual(
  reviewer.decideReviewOutcome(requestChanges),
  {
    action: "reopen",
    reopen: true,
    proceedToGate2: false,
    flagged: false,
    reason: "reviewer requested blocking changes",
  },
  "request-changes reopens the dev loop",
);
assert.deepEqual(
  reviewer.decideReviewOutcome(approved),
  {
    action: "proceed",
    reopen: false,
    proceedToGate2: true,
    flagged: false,
    reason: "reviewer approved",
  },
  "approve proceeds to Gate 2",
);
assert.deepEqual(
  reviewer.decideReviewOutcome(proseOnly),
  {
    action: "proceed-but-flagged",
    reopen: false,
    proceedToGate2: true,
    flagged: true,
    reason: "reviewer verdict was inconclusive",
  },
  "unknown proceeds to Gate 2 flagged instead of reopening forever or silently approving",
);

const gates = [
  { name: "unit", kind: "command", stage: "per-round", command: "npm test" },
  { name: "e2e", kind: "command", stage: "pre-ship", command: "npm run e2e" },
  { name: "review", kind: "judge", stage: "pre-ship", agent: "reviewer" },
  { name: "tag", kind: "action", stage: "release", action: "git tag v1.0.0" },
];
assert.deepEqual(
  gatesMod.gatesForStage(gates, "pre-ship"),
  [gates[1], gates[2]],
  "pre-ship selector includes command+judge pre-ship gates only",
);
assert.deepEqual(gatesMod.gatesForStage(gates, "per-round"), [gates[0]], "per-round gate is ignored by pre-ship selector");
assert.deepEqual(gatesMod.gatesForStage(gates, "release"), [gates[3]], "release gate is ignored by pre-ship selector");

console.log("Foreman reviewer helper tests passed");
NODE
