#!/usr/bin/env bash
# Headless unit test for Foreman Gate 1 planner helpers.
# Pure data-layer (no pi, no agents, no TTY) — validates PLAN-JSON, render, and manifest decisions.
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
export ROOT_DIR

node --input-type=module <<'NODE'
import assert from "node:assert/strict";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const planner = await import(pathToFileURL(`${process.env.ROOT_DIR}/extensions/foreman/planner.ts`).href);
const plannerPrompt = fs.readFileSync(`${process.env.ROOT_DIR}/extensions/foreman/crew/planner.md`, "utf-8");
const foremanIndex = fs.readFileSync(`${process.env.ROOT_DIR}/extensions/foreman/index.ts`, "utf-8");
assert.match(plannerPrompt, /^model: cliproxy\/claude-opus-4-8:xhigh$/m, "planner model is the required read-only planner model");
assert.match(plannerPrompt, /^tools: read, grep, find, ls, bash$/m, "planner tools are read-only recon tools");
assert.match(plannerPrompt, /Propose gates only for commands that actually exist in the repo\./, "planner prompt requires real repo commands");
assert.doesNotMatch(plannerPrompt, /proposedManifest|explicitly provided by the CTO/, "planner prompt has no legacy proposedManifest/CTO override contract");
assert.match(
  foremanIndex,
  /extractJsonBlock\(run\.text,\s*PLAN_JSON_START,\s*PLAN_JSON_END\)/,
  "orchestrator parses planner output with the shared extractJsonBlock helper",
);
assert.doesNotMatch(foremanIndex, /parsePlannerPlanJson\(run\.text\)/, "orchestrator does not parse planner output via the planner helper");

const verifyGate = { name: "verify", kind: "command", stage: "per-round", command: "npm test" };
const lintGate = { name: "lint", kind: "command", stage: "pre-ship", command: "npm run lint" };
const validText = `Planner prose\n${planner.PLAN_JSON_START}\n${JSON.stringify({
  summary: "Add the planner role safely.",
  steps: ["Inspect current Gate 1", "Wire planner fallback", "Run tests"],
  filesLikely: ["extensions/foreman/index.ts", "extensions/foreman/planner.ts"],
  risks: ["Model unavailable"],
  proposedGates: [verifyGate, lintGate],
})}\n${planner.PLAN_JSON_END}\ntrailing`;

const parsed = planner.parsePlannerPlanJson(validText);
assert.ok(parsed, "valid PLAN-JSON parses");
assert.equal(parsed.summary, "Add the planner role safely.");
assert.deepEqual(parsed.steps, ["Inspect current Gate 1", "Wire planner fallback", "Run tests"]);
assert.deepEqual(parsed.filesLikely, ["extensions/foreman/index.ts", "extensions/foreman/planner.ts"]);
assert.deepEqual(parsed.proposedGates, [verifyGate, lintGate]);
const legacyManifestKey = "proposed" + "Manifest";
assert.equal(legacyManifestKey in parsed, false, "planner plans do not model legacy manifest proposals");

assert.equal(planner.parsePlannerPlanJson("no markers"), null, "missing markers reject");
assert.equal(
  planner.parsePlannerPlanJson(`${planner.PLAN_JSON_START}\n{ nope\n${planner.PLAN_JSON_END}`),
  null,
  "bad JSON rejects",
);
assert.equal(
  planner.parsePlannerPlanJson(`${planner.PLAN_JSON_START}\n{}\n${planner.PLAN_JSON_END}`),
  null,
  "empty PLAN-JSON rejects",
);
assert.equal(
  planner.validatePlannerPlan({ summary: "No steps", steps: [], filesLikely: [], risks: [], proposedGates: [] }),
  null,
  "steps are required",
);
assert.equal(
  planner.validatePlannerPlan({ summary: "Missing files", steps: ["Do it"], risks: [], proposedGates: [] }),
  null,
  "filesLikely key is required",
);
assert.deepEqual(
  planner.validatePlannerPlan({
    summary: "Drop invalid gates",
    steps: ["Do it"],
    filesLikely: ["src/index.ts"],
    risks: [],
    proposedGates: [verifyGate, { name: "bad", kind: "command", stage: "per-round" }],
  })?.proposedGates,
  [verifyGate],
  "invalid proposed gates are dropped",
);

const fallback = planner.fallbackPlannerPlan({
  task: "Fix calc.add",
  cwd: "/tmp/repo",
  track: "backend",
  maxRounds: 3,
  verifyCommand: "python3 -m pytest -q",
  existingGates: [],
});
assert.match(fallback.summary, /backend track/, "fallback mentions track");
assert.deepEqual(fallback.filesLikely, [], "fallback does not guess files");
assert.deepEqual(fallback.proposedGates, [
  { name: "verify", kind: "command", stage: "per-round", command: "python3 -m pytest -q" },
]);
assert.equal(legacyManifestKey in fallback, false, "fallback does not synthesize a manifest");

const fallbackDecision = planner.decideManifestWrite({
  manifestExists: false,
  proposedGates: fallback.proposedGates,
  source: "fallback",
});
assert.equal(fallbackDecision.shouldWrite, false, "fallback/invalid planner output never writes a manifest");
assert.match(fallbackDecision.reason, /not eligible/);

const missingSourceDecision = planner.decideManifestWrite({
  manifestExists: false,
  proposedGates: parsed.proposedGates,
});
assert.equal(missingSourceDecision.shouldWrite, false, "missing source metadata defaults to fallback/not eligible");
assert.match(missingSourceDecision.reason, /not eligible/);

const writeDecision = planner.decideManifestWrite({
  manifestExists: false,
  proposedGates: parsed.proposedGates,
  source: "planner",
});
assert.equal(writeDecision.shouldWrite, true, "absent manifest + valid planner proposedGates writes on approval");
assert.deepEqual(writeDecision.manifest, { gates: parsed.proposedGates });
assert.match(writeDecision.reason, /Gate 1 approval/);

const existingDecision = planner.decideManifestWrite({
  manifestExists: true,
  proposedGates: parsed.proposedGates,
  source: "planner",
});
assert.equal(existingDecision.shouldWrite, false, "existing manifest is preserved");
assert.match(existingDecision.reason, /preserved/);

const noGateDecision = planner.decideManifestWrite({
  manifestExists: false,
  proposedGates: [],
  source: "planner",
});
assert.equal(noGateDecision.shouldWrite, false, "empty proposedGates are not written");
assert.match(noGateDecision.reason, /No valid proposed gates/);

const rendered = planner.renderFounderPlan(parsed, {
  task: "Fix calc.add",
  cwd: "/tmp/repo",
  track: "backend",
  maxRounds: 3,
  verifyCommand: "python3 -m pytest -q",
  developerModel: "dev/model",
  testerModel: "test/model",
  manifestExists: false,
  plannerSource: "planner",
  manifestWriteEligible: true,
});
assert.match(rendered, /## Summary \(planner\)/, "render includes summary heading and source");
assert.match(rendered, /## Steps[\s\S]*1\./, "render includes numbered steps");
assert.match(rendered, /## Files likely[\s\S]*`extensions\/foreman\/index\.ts`/, "render includes files likely");
assert.match(rendered, /## Risks[\s\S]*Model unavailable/, "render includes risks");
assert.match(rendered, /## Proposed gates[\s\S]*verify \(per-round command\)[\s\S]*`npm test`/, "render includes gate name/stage/command");
assert.match(rendered, /## Proposed gates[\s\S]*lint \(pre-ship command\)[\s\S]*`npm run lint`/, "render includes multiple gate stages");
assert.match(rendered, /## Proposed manifest[\s\S]*Gate 1 approval/, "render includes manifest decision");
assert.match(rendered, /Developer: dev\/model/, "render includes execution metadata");

const fallbackRendered = planner.renderFounderPlan(fallback, {
  task: "Fix calc.add",
  cwd: "/tmp/repo",
  track: "backend",
  maxRounds: 3,
  verifyCommand: "python3 -m pytest -q",
  developerModel: "dev/model",
  testerModel: "test/model",
  manifestExists: false,
  plannerSource: "fallback",
  manifestWriteEligible: false,
});
assert.match(fallbackRendered, /## Summary \(fallback\)/, "fallback render marks source");
assert.match(fallbackRendered, /## Files likely[\s\S]*not identified/, "fallback render is explicit about unknown files");
assert.match(fallbackRendered, /## Proposed gates[\s\S]*verify \(per-round command\)[\s\S]*python3 -m pytest -q/, "fallback still renders legacy verify gate");
assert.match(fallbackRendered, /not eligible to create \.pi\/foreman\.json/, "fallback render says no manifest write");

const roundTrip = planner.validatePlannerPlan(JSON.parse(planner.serializePlannerPlan(parsed)));
assert.deepEqual(roundTrip, parsed, "serialized planner plans validate on reload");

console.log("Foreman planner helper tests passed");
NODE
