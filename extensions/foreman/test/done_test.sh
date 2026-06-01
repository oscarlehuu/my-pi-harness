#!/usr/bin/env bash
# Headless unit test for Foreman's strict Definition of Done helpers.
# Pure data-layer (no pi, no agents, no TTY) — validates the machine gate before release actions.
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
export ROOT_DIR

node --input-type=module <<'NODE'
import assert from "node:assert/strict";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const doneMod = await import(pathToFileURL(`${process.env.ROOT_DIR}/extensions/foreman/done.ts`).href);

function base(overrides = {}) {
  return {
    gate1Approved: true,
    gate2Approved: true,
    latestTesterState: "success",
    perRoundCommandGatesPassed: true,
    preShipCommandGatesPassed: true,
    reviewerGateDeclared: true,
    reviewerDecision: "approve",
    ...overrides,
  };
}

// ---- evaluateDoneness strict truth table ----
const clean = doneMod.evaluateDoneness(base());
assert.equal(clean.done, true, "all hard checks + reviewer APPROVE -> done");
assert.deepEqual(clean.blockers, [], "clean DoD has no blockers");
assert.deepEqual(
  clean.checklist.map((check) => check.name),
  ["Plan approval", "Per-round command gates", "Tester judgment", "Pre-ship command gates", "Reviewer gate", "Founder ship approval"],
  "checklist has one check per DoD dimension in order",
);
assert.ok(clean.checklist.every((check) => check.status === "pass"), "all-hard-pass checklist is green");

const unknownReview = doneMod.evaluateDoneness(base({ reviewerDecision: "unknown" }));
assert.equal(unknownReview.done, false, "declared reviewer gate + UNKNOWN is not done");
assert.ok(
  unknownReview.blockers.includes("reviewer verdict inconclusive — strict DoD requires a clean APPROVE"),
  "unknown reviewer verdict yields strict inconclusive blocker",
);
assert.equal(unknownReview.checklist.find((check) => check.name === "Reviewer gate")?.status, "warn", "unknown reviewer is warn + blocker");

const missingReview = doneMod.evaluateDoneness(base({ reviewerDecision: undefined }));
assert.equal(missingReview.done, false, "declared reviewer gate + missing verdict is not done");
assert.ok(missingReview.blockers.includes("reviewer verdict inconclusive — strict DoD requires a clean APPROVE"), "missing reviewer verdict is inconclusive");

const requestedChanges = doneMod.evaluateDoneness(base({ reviewerDecision: "request-changes" }));
assert.equal(requestedChanges.done, false, "reviewer REQUEST-CHANGES is not done");
assert.ok(requestedChanges.blockers.includes("reviewer requested changes"), "request-changes blocks done");

const noReviewerNoCommandGates = doneMod.evaluateDoneness(base({
  reviewerGateDeclared: false,
  reviewerDecision: undefined,
  perRoundCommandGatesPassed: undefined,
  preShipCommandGatesPassed: undefined,
}));
assert.equal(noReviewerNoCommandGates.done, true, "no reviewer gate + no command gates + tester success + founder gates -> done");
assert.equal(noReviewerNoCommandGates.checklist.find((check) => check.name === "Reviewer gate")?.status, "n/a", "no reviewer gate is n/a");
assert.equal(noReviewerNoCommandGates.checklist.find((check) => check.name === "Per-round command gates")?.status, "n/a", "no per-round command gates is n/a");
assert.equal(noReviewerNoCommandGates.checklist.find((check) => check.name === "Pre-ship command gates")?.status, "n/a", "no pre-ship command gates is n/a");

for (const latestTesterState of ["partial", "blocked", "fail"]) {
  const result = doneMod.evaluateDoneness(base({ latestTesterState }));
  assert.equal(result.done, false, `tester ${latestTesterState} is not done`);
  assert.ok(result.blockers.includes(`tester verdict not success (${latestTesterState})`), `tester ${latestTesterState} blocker is recorded`);
}
assert.equal(doneMod.evaluateDoneness(base({ latestTesterState: undefined })).done, false, "missing tester verdict is not done");

assert.equal(doneMod.evaluateDoneness(base({ gate1Approved: false })).done, false, "Gate 1 approval is required");
assert.ok(doneMod.evaluateDoneness(base({ gate1Approved: false })).blockers.includes("plan not approved"), "Gate 1 blocker text");
assert.equal(doneMod.evaluateDoneness(base({ perRoundCommandGatesPassed: false })).done, false, "per-round command gate failure blocks done");
assert.equal(doneMod.evaluateDoneness(base({ preShipCommandGatesPassed: false })).done, false, "pre-ship command gate failure blocks done");
assert.ok(doneMod.evaluateDoneness(base({ preShipCommandGatesPassed: false })).blockers.includes("pre-ship command gates failed"), "pre-ship failure blocker text");
assert.equal(doneMod.evaluateDoneness(base({ preShipCommandGatesPassed: undefined })).done, true, "undefined pre-ship command gates is n/a, not a blocker");
assert.equal(doneMod.evaluateDoneness(base({ gate2Approved: false })).done, false, "Gate 2 founder approval is required");
assert.ok(doneMod.evaluateDoneness(base({ gate2Approved: false })).blockers.includes("founder ship approval missing"), "Gate 2 blocker text");

// ---- renderDoneChecklist ----
const rendered = doneMod.renderDoneChecklist(unknownReview);
assert.match(rendered, /^Definition of Done:/, "rendered checklist has a heading");
for (const label of ["Plan approval", "Per-round command gates", "Tester judgment", "Pre-ship command gates", "Reviewer gate", "Founder ship approval"]) {
  assert.match(rendered, new RegExp(label), `rendered checklist includes ${label}`);
}
assert.match(rendered, /⚠ Reviewer gate:/, "rendered checklist uses warning icon for inconclusive review");
assert.match(rendered, /Blockers:\n- reviewer verdict inconclusive — strict DoD requires a clean APPROVE/, "rendered checklist lists blockers");
assert.match(doneMod.renderDoneChecklist(clean), /Blockers: none/, "clean checklist says there are no blockers");

// ---- extractDonenessInputs scans LAST relevant log events ----
const extracted = doneMod.extractDonenessInputs([
  { type: "verdict", successState: "fail" },
  { type: "verify_ran", exitCode: 1 },
  { type: "pre_ship_command_gates_ran", passed: false },
  { type: "pre_ship_reviewer_verdict", decision: "unknown" },
  { type: "verdict", successState: "success" },
  { type: "verify_ran", exitCode: 0 },
  { type: "pre_ship_command_gates_ran", passed: true },
  { type: "pre_ship_reviewer_verdict", decision: "approve" },
  { type: "verdict", successState: "not-a-real-state" },
  { type: "pre_ship_reviewer_verdict", decision: "not-a-real-decision" },
], { gate1Approved: true, gate2Approved: false, reviewerGateDeclared: true });
assert.deepEqual(extracted, {
  gate1Approved: true,
  gate2Approved: false,
  latestTesterState: "success",
  perRoundCommandGatesPassed: true,
  preShipCommandGatesPassed: true,
  reviewerGateDeclared: true,
  reviewerDecision: "approve",
}, "extractDonenessInputs picks the last valid relevant ledger events");

// ---- repo gate config is versioned and declares full pipeline ----
const foremanConfig = JSON.parse(fs.readFileSync(`${process.env.ROOT_DIR}/.pi/foreman.json`, "utf-8"));
assert.ok(foremanConfig.gates.some((gate) => gate.name === "verify" && gate.kind === "command" && gate.stage === "per-round"), "per-round verify gate remains declared");
assert.ok(foremanConfig.gates.some((gate) => gate.name === "review" && gate.kind === "judge" && gate.stage === "pre-ship" && gate.agent === "reviewer"), "pre-ship reviewer judge gate is declared");
assert.ok(foremanConfig.gates.some((gate) => gate.name === "commit" && gate.kind === "action" && gate.stage === "release" && gate.action === "commit"), "release commit action gate is declared");

console.log("Foreman Definition of Done helper tests passed");
NODE

# Shell-level assertions requested for the repo activation.
grep -q '"name": "review"' "$ROOT_DIR/.pi/foreman.json"
grep -q '"kind": "judge"' "$ROOT_DIR/.pi/foreman.json"
grep -q '"stage": "pre-ship"' "$ROOT_DIR/.pi/foreman.json"
grep -q '"name": "commit"' "$ROOT_DIR/.pi/foreman.json"
grep -q '"kind": "action"' "$ROOT_DIR/.pi/foreman.json"
grep -q '"action": "commit"' "$ROOT_DIR/.pi/foreman.json"

ignored="$(cd "$ROOT_DIR" && git check-ignore .pi/foreman.json || true)"
if [[ -n "$ignored" ]]; then
  echo "FAIL: .pi/foreman.json is still ignored: $ignored" >&2
  exit 1
fi
