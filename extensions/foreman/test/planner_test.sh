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
assert.match(plannerPrompt, /requirements/, "planner prompt asks for task requirements");
assert.match(plannerPrompt, /NEVER read, echo, or store secret VALUES/, "planner prompt forbids secret value handling");
assert.doesNotMatch(plannerPrompt, /proposedManifest|explicitly provided by the CTO/, "planner prompt has no legacy proposedManifest/CTO override contract");
assert.match(
  foremanIndex,
  /extractJsonBlock\(run\.text,\s*PLAN_JSON_START,\s*PLAN_JSON_END\)/,
  "orchestrator parses planner output with the shared extractJsonBlock helper",
);
assert.doesNotMatch(foremanIndex, /parsePlannerPlanJson\(run\.text\)/, "orchestrator does not parse planner output via the planner helper");
assert.match(foremanIndex, /function toolOnPath\(name: string\)/, "orchestrator owns side-effect-free tool presence checks");
assert.match(foremanIndex, /loadRequirements\(cwd\)/, "orchestrator preflights persisted requirements");
assert.match(foremanIndex, /type: "preflight_checked"/, "orchestrator records requirement preflight checks");
assert.match(foremanIndex, /requirementGaps/, "orchestrator logs missing or unknown requirement gaps");

const verifyGate = { name: "verify", kind: "command", stage: "per-round", command: "npm test" };
const lintGate = { name: "lint", kind: "command", stage: "pre-ship", command: "npm run lint" };
const emptyRequirements = { env: [], tools: [], services: [] };
const taskRequirements = {
  env: [{ name: "OPENAI_API_KEY", reason: "needed for API-backed tests" }],
  tools: [{ name: "git", reason: "inspect repository state" }, { name: "psql", reason: "manual DB checks" }],
  services: [{ name: "postgres", reason: "integration database" }],
};
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
assert.deepEqual(parsed.requirements, emptyRequirements, "plans without requirements default to empty requirements");
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
const requirementsPlan = planner.validatePlannerPlan({
  summary: "Needs external resources",
  steps: ["Check requirements", "Implement"],
  filesLikely: ["src/index.ts"],
  risks: [],
  proposedGates: [],
  requirements: {
    env: [{ name: " OPENAI_API_KEY ", reason: " needed for API-backed tests " }, { name: " " }],
    tools: taskRequirements.tools,
    services: taskRequirements.services,
  },
});
assert.ok(requirementsPlan, "plans with requirements validate");
assert.deepEqual(requirementsPlan.requirements, taskRequirements, "requirements normalize on planner validation");

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
assert.deepEqual(fallback.requirements, emptyRequirements, "fallback declares no special requirements");
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

const requirementsOnlyDecision = planner.decideManifestWrite({
  manifestExists: false,
  proposedGates: [],
  requirements: requirementsPlan.requirements,
  source: "planner",
});
assert.equal(requirementsOnlyDecision.shouldWrite, true, "requirements alone can create the advisory manifest");
assert.deepEqual(requirementsOnlyDecision.manifest, { gates: [], requirements: taskRequirements });

const fallbackRequirementsDecision = planner.decideManifestWrite({
  manifestExists: false,
  proposedGates: [],
  requirements: requirementsPlan.requirements,
  source: "fallback",
});
assert.equal(fallbackRequirementsDecision.shouldWrite, false, "fallback requirements never write a manifest");

const existingDecision = planner.decideManifestWrite({
  manifestExists: true,
  proposedGates: parsed.proposedGates,
  requirements: requirementsPlan.requirements,
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
assert.match(rendered, /## Requirements[\s\S]*\(none detected\)/, "render includes empty requirements section");
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

const toolCalls = [];
const requirementChecks = planner.evaluateRequirementPresence({
  requirements: requirementsPlan.requirements,
  env: { OPENAI_API_KEY: "sk-test" },
  toolPresent(name) {
    toolCalls.push(name);
    return name === "git";
  },
});
assert.deepEqual(toolCalls, ["git", "psql"], "only tool requirements are probed via the injected side-effect-free callback");
assert.deepEqual(
  requirementChecks.map((check) => [check.category, check.name, check.presence]),
  [
    ["env", "OPENAI_API_KEY", "present"],
    ["tools", "git", "present"],
    ["tools", "psql", "missing"],
    ["services", "postgres", "unknown"],
  ],
  "env/tools/services presence is evaluated without service probing",
);
const requirementSummary = planner.summarizeRequirementChecks(requirementChecks);
assert.equal(requirementSummary.present.length, 2, "present requirements are summarized");
assert.equal(requirementSummary.missing.length, 1, "missing requirements are summarized");
assert.equal(requirementSummary.unknown.length, 1, "unknown requirements are summarized");
assert.equal(requirementSummary.hasGaps, true, "missing/unknown requirements count as advisory gaps");
assert.equal(
  planner.summarizeRequirementChecks(requirementChecks.filter((check) => check.presence === "present")).hasGaps,
  false,
  "all-present checks have no gaps",
);
const requirementsRendered = planner.renderFounderPlan(requirementsPlan, {
  task: "Needs APIs",
  cwd: "/tmp/repo",
  track: "backend",
  maxRounds: 3,
  manifestExists: false,
  plannerSource: "planner",
  manifestWriteEligible: true,
  requirementChecks,
});
assert.match(requirementsRendered, /## Requirements/, "requirements render section heading");
assert.match(requirementsRendered, /Env vars\/secrets[\s\S]*✓ OPENAI_API_KEY[\s\S]*needed for API-backed tests/, "env requirement renders present marker and reason");
assert.match(requirementsRendered, /CLI tools\/binaries[\s\S]*✓ git[\s\S]*✗ psql/, "tool requirements render present/missing markers");
assert.match(requirementsRendered, /Services\/runtimes[\s\S]*\? postgres[\s\S]*integration database/, "service requirements render unknown marker and reason");
assert.match(requirementsRendered, /Gate 1 approval/, "requirements-only planner plans still explain manifest write timing");

const requirementsRoundTrip = planner.validatePlannerPlan(JSON.parse(planner.serializePlannerPlan(requirementsPlan)));
assert.deepEqual(requirementsRoundTrip, requirementsPlan, "serialized planner plans preserve requirements");

const roundTrip = planner.validatePlannerPlan(JSON.parse(planner.serializePlannerPlan(parsed)));
assert.deepEqual(roundTrip, parsed, "serialized planner plans validate on reload");

console.log("Foreman planner helper tests passed");
NODE
