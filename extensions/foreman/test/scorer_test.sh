#!/usr/bin/env bash
# Headless unit test for the Gate 1 assumption scorer.
# Pure data-layer (no pi, no agents, no TTY) — validates risk scoring, routing, globs, and Gate 1 surfacing seams.
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
export ROOT_DIR

node --input-type=module <<'NODE'
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const scorer = await import(pathToFileURL(`${process.env.ROOT_DIR}/extensions/foreman/scorer.ts`).href);
const gates = await import(pathToFileURL(`${process.env.ROOT_DIR}/extensions/foreman/gates.ts`).href);
const planner = await import(pathToFileURL(`${process.env.ROOT_DIR}/extensions/foreman/planner.ts`).href);

function writeForemanJson(repo, value) {
  fs.mkdirSync(path.join(repo, ".pi"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".pi", "foreman.json"), JSON.stringify(value, null, 2));
}

// Confidence -> P(wrong), cost, risk, and low-risk self routing.
const lowRisk = scorer.scoreAssumption({
  assumption: { text: "Cosmetic wording stays unchanged.", confidence: "high" },
  ctx: { highRiskPaths: [], blastRadius: [], filesLikely: [] },
});
assert.equal(lowRisk.cost, "low", "no path/hint/keyword signal -> low cost");
assert.equal(lowRisk.risk, "low", "high confidence + low cost -> low risk");
assert.equal(lowRisk.route, "self", "low-risk assumptions route to self");
assert.match(lowRisk.reasons.join("\n"), /confidence high -> low P\(wrong\)/, "confidence high maps to low P(wrong)");

const domainHighRisk = scorer.scoreAssumption({
  assumption: { text: "The auth API currently stores sessions in the login service.", confidence: "low" },
  ctx: { highRiskPaths: ["src/auth/**"], blastRadius: ["src/auth/session.ts"], filesLikely: [] },
});
assert.equal(domainHighRisk.cost, "high", "highRiskPaths glob match is high cost");
assert.equal(domainHighRisk.risk, "high", "low confidence + high-risk path -> high risk");
assert.equal(domainHighRisk.kind, "domain-fact", "app/API behavior assumptions classify as domain facts");
assert.equal(domainHighRisk.route, "team", "risky domain facts keep the team route seam for Task B");
assert.match(domainHighRisk.reasons.join("\n"), /highRiskPaths matched src\/auth\/\*\* -> src\/auth\/session\.ts/, "path match is recorded as a reason");

const founderHighRisk = scorer.scoreAssumption({
  assumption: { text: "Founder prefers this scope to skip the settings UI.", confidence: "low" },
  ctx: { highRiskPaths: ["src/auth/**"], filesLikely: ["src/auth/settings.ts"] },
});
assert.equal(founderHighRisk.kind, "preference", "scope/preference assumptions classify as preferences");
assert.equal(founderHighRisk.risk, "high", "preference can still be high risk when cost and P(wrong) are high");
assert.equal(founderHighRisk.route, "founder", "risky preference/scope/taste assumptions route to founder");

const missingConfidence = scorer.scoreAssumption({
  assumption: { text: "The external API response shape is stable." },
  ctx: { costHint: "medium" },
});
assert.equal(missingConfidence.risk, "medium", "missing confidence is treated as medium P(wrong) with medium cost");
assert.equal(missingConfidence.route, "team", "medium-risk domain facts route to team seam");
assert.match(missingConfidence.reasons.join("\n"), /confidence missing -> medium P\(wrong\)/, "missing confidence maps to medium P(wrong)");

const mediumRisk = scorer.scoreAssumption({
  assumption: { text: "The app uses a persisted cache for this flow.", confidence: "medium" },
  ctx: { costHint: "medium" },
});
assert.equal(mediumRisk.risk, "medium", "medium P(wrong) x medium cost -> medium risk");
assert.equal(mediumRisk.cost, "medium", "caller cost hint can provide medium cost");

const keywordHighCost = scorer.scoreAssumption({
  assumption: { text: "Deleting production billing records is reversible.", confidence: "medium" },
  ctx: { highRiskPaths: [], blastRadius: [], filesLikely: [] },
});
assert.equal(keywordHighCost.cost, "high", "keyword heuristic is the high-cost backstop");
assert.equal(keywordHighCost.risk, "high", "keyword high cost can make a medium-confidence assumption high risk");

// Verifiable-claim discipline: evidence/concrete consequence is required for risky claims to ride unmarked.
assert.equal(scorer.hasVerifiableEvidence(["See extensions/foreman/index.ts:1530"], ""), true, "file:line is verifiable evidence");
assert.equal(scorer.hasVerifiableEvidence(["Must pass the `SHIP slug` token"], ""), true, "quoted tokens are verifiable evidence");
assert.equal(scorer.hasVerifiableEvidence([], "Change touches extensions/foreman/index.ts"), true, "paths are verifiable evidence");
assert.equal(scorer.hasVerifiableEvidence([], "Failure could double-charge customers"), true, "named consequences are verifiable evidence");
assert.equal(scorer.hasVerifiableEvidence([], "Could cause data loss in prod during a migration"), true, "prod/data-loss/migration consequences are verifiable evidence");
assert.equal(scorer.hasVerifiableEvidence(["this is important", "high impact"], "This seems risky"), false, "bare importance words are not verifiable evidence");

const unsubstantiatedRisk = scorer.scoreAssumption({
  assumption: { text: "This is important.", confidence: "low" },
  ctx: { costHint: "high" },
});
assert.equal(unsubstantiatedRisk.risk, "high", "caller hints can still mark an item risky");
assert.equal(unsubstantiatedRisk.unsubstantiated, true, "risky items without evidence are marked unsubstantiated");
const keywordUnsubstantiatedRisk = scorer.scoreAssumption({
  assumption: { text: "The config seems off here.", confidence: "low" },
  ctx: { highRiskPaths: [], blastRadius: [], filesLikely: [] },
});
assert.equal(keywordUnsubstantiatedRisk.cost, "medium", "keyword-derived cost can make a claim risky without caller hints");
assert.equal(keywordUnsubstantiatedRisk.risk, "high", "low confidence + keyword medium cost is high risk");
assert.equal(keywordUnsubstantiatedRisk.unsubstantiated, true, "internal keyword labels are not treated as verifiable evidence");
assert.equal(domainHighRisk.unsubstantiated, undefined, "risky items with concrete path evidence are not marked unsubstantiated");

// Ranking: high risk first, low risk last, stable within ties.
const ranked = scorer.scoreAssumptions(
  [
    { text: "Cosmetic copy remains unchanged.", confidence: "high" },
    { text: "The payment API returns successful refunds synchronously.", confidence: "low" },
    { text: "The database cache can be refreshed later.", confidence: "medium" },
  ],
  { highRiskPaths: [], blastRadius: [], filesLikely: [] },
);
assert.deepEqual(ranked.map((s) => s.risk), ["high", "medium", "low"], "scoreAssumptions ranks by risk descending");
assert.match(ranked[0].text, /payment API/, "highest-risk assumption is first");

// Kind classifier seam for Task B.
assert.equal(scorer.classifyAssumptionKind("The API already returns invoices sorted by date."), "domain-fact", "domain behavior facts classify as domain-fact");
assert.equal(scorer.classifyAssumptionKind("Founder prefers the smallest scope and no UI changes."), "preference", "founder taste/scope classifies as preference");
assert.equal(scorer.classifyAssumptionKind("This is probably fine."), "unknown", "unclear text stays unknown and will route to founder if risky");

// Minimal pure glob matcher.
assert.equal(scorer.globMatches("src/**/*.ts", "src/app.ts"), true, "**/ can match zero directories");
assert.equal(scorer.globMatches("src/**/*.ts", "src/lib/app.ts"), true, "** matches nested directories");
assert.equal(scorer.globMatches("src/*.ts", "src/lib/app.ts"), false, "single * does not cross directories");
assert.equal(scorer.globMatches("extensions/foreman/**", "extensions/foreman/planner.ts"), true, "directory prefix glob matches file");
assert.equal(scorer.globMatches("src/?ar.ts", "src/bar.ts"), true, "? matches one non-slash character");
assert.equal(scorer.globMatches("src/?ar.ts", "src/boar.ts"), false, "? does not match multiple characters");

// Manifest highRiskPaths loader: missing/malformed -> [], valid globs normalize.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-scorer-test."));
try {
  assert.deepEqual(gates.loadHighRiskPaths(path.join(tmp, "missing")), [], "missing manifest -> []");

  const malformedRepo = path.join(tmp, "malformed");
  fs.mkdirSync(path.join(malformedRepo, ".pi"), { recursive: true });
  fs.writeFileSync(path.join(malformedRepo, ".pi", "foreman.json"), "{ not json");
  assert.deepEqual(gates.loadHighRiskPaths(malformedRepo), [], "malformed manifest -> []");

  const wrongShapeRepo = path.join(tmp, "wrong-shape");
  writeForemanJson(wrongShapeRepo, { highRiskPaths: "src/**" });
  assert.deepEqual(gates.loadHighRiskPaths(wrongShapeRepo), [], "non-array highRiskPaths -> []");

  const validRepo = path.join(tmp, "valid");
  writeForemanJson(validRepo, { gates: [], highRiskPaths: [" src/auth/** ", "", 42, "migrations/*.sql"] });
  assert.deepEqual(gates.loadHighRiskPaths(validRepo), ["src/auth/**", "migrations/*.sql"], "valid highRiskPaths globs parse and trim");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// Gate-1 rendering is advisory/additive: scorer signal reorders/annotates, but no assumptions are removed.
const scoredPlan = {
  summary: "Score assumptions.",
  assumptions: [
    { text: "Cosmetic wording stays unchanged.", confidence: "high" },
    { text: "The payment API returns successful refunds synchronously.", confidence: "low" },
  ],
  nonGoals: [],
  alternatives: [],
  blastRadius: [],
  steps: ["Score", "Render"],
  filesLikely: [],
  risks: [],
  proposedGates: [],
  requirements: { env: [], tools: [], services: [] },
};
const rendered = planner.renderFounderPlan(scoredPlan, {
  task: "Score assumptions",
  cwd: "/tmp/repo",
  track: "backend",
  maxRounds: 3,
  manifestExists: true,
  plannerSource: "planner",
  manifestWriteEligible: true,
  highRiskPaths: [],
});
assert.match(rendered, /## Assumptions/, "assumption section still renders");
assert.match(rendered, /\[!\] verify this: The payment API returns successful refunds synchronously/, "high-risk assumptions are marked for verification");
assert.match(rendered, /\(low risk\) Cosmetic wording stays unchanged/, "low-risk assumptions are de-emphasized rather than removed");
assert.ok(
  rendered.indexOf("The payment API returns") < rendered.indexOf("Cosmetic wording"),
  "high-risk assumptions render before low-risk assumptions",
);
assert.match(rendered, /route: team→founder for now/, "team route degrades to founder-visible surfacing in Task A");

const unsubstantiatedRendered = planner.renderFounderPlan({
  summary: "Flag weak evidence.",
  assumptions: [{ text: "This is important.", confidence: "low" }],
  nonGoals: [],
  alternatives: [],
  blastRadius: [],
  steps: ["Score", "Render"],
  filesLikely: [],
  risks: [],
  proposedGates: [],
  requirements: { env: [], tools: [], services: [] },
}, {
  task: "Flag weak evidence",
  cwd: "/tmp/repo",
  track: "backend",
  maxRounds: 3,
  manifestExists: true,
  plannerSource: "planner",
  manifestWriteEligible: true,
  highRiskPaths: [],
  assumptionCostHint: "high",
});
assert.match(unsubstantiatedRendered, /This is important\. \[unsubstantiated — verify or downgrade\]/, "Gate 1 annotates risky items that lack verifiable evidence");

const keywordUnsubstantiatedRendered = planner.renderFounderPlan({
  summary: "Flag keyword-only weak evidence.",
  assumptions: [{ text: "The config seems off here.", confidence: "low" }],
  nonGoals: [],
  alternatives: [],
  blastRadius: [],
  steps: ["Score", "Render"],
  filesLikely: [],
  risks: [],
  proposedGates: [],
  requirements: { env: [], tools: [], services: [] },
}, {
  task: "Flag keyword-only weak evidence",
  cwd: "/tmp/repo",
  track: "backend",
  maxRounds: 3,
  manifestExists: true,
  plannerSource: "planner",
  manifestWriteEligible: true,
  highRiskPaths: [],
});
assert.match(keywordUnsubstantiatedRendered, /The config seems off here\. \[unsubstantiated — verify or downgrade\]/, "Gate 1 annotates keyword-cost risky items without external evidence");

const backCompatRendered = planner.renderFounderPlan(scoredPlan, {
  task: "Score assumptions",
  cwd: "/tmp/repo",
  track: "backend",
  maxRounds: 3,
  manifestExists: true,
  plannerSource: "planner",
  manifestWriteEligible: true,
});
assert.match(backCompatRendered, /- Cosmetic wording stays unchanged\. _\(confidence: high\)_/, "no scorer signal keeps legacy assumption rendering");
assert.doesNotMatch(backCompatRendered, /\[!\]|low risk|route:/, "legacy render is unchanged when caller supplies no scorer signal");

// Grep guards for the Gate-1 wiring seam.
const plannerSource = fs.readFileSync(`${process.env.ROOT_DIR}/extensions/foreman/planner.ts`, "utf-8");
const indexSource = fs.readFileSync(`${process.env.ROOT_DIR}/extensions/foreman/index.ts`, "utf-8");
const repoForemanManifest = fs.readFileSync(`${process.env.ROOT_DIR}/.pi/foreman.json`, "utf-8");
assert.match(plannerSource, /scoreAssumptions\(plan\.assumptions/, "renderFounderPlan scorer path calls scoreAssumptions");
assert.match(indexSource, /loadHighRiskPaths\(cwd\)/, "Gate 1 passes manifest highRiskPaths into the planner render");
assert.match(indexSource, /const plannerContext = \{[\s\S]*highRiskPaths,[\s\S]*\};/, "Gate 1 builds a planner context with scorer highRiskPaths");
assert.match(indexSource, /renderFounderPlan\(drafted\.plan, plannerContext\)/, "Gate 1 render receives the shared scorer context");
assert.match(repoForemanManifest, /extensions\/foreman\/test\/scorer_test\.sh/, ".pi/foreman.json verify gate runs scorer_test.sh");

console.log("Foreman assumption scorer tests passed");
NODE
