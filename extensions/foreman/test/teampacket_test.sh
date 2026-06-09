#!/usr/bin/env bash
# Headless unit test for the Gate 1 team question packet formatter.
# Pure data-layer (no pi, no agents, no TTY) — validates advisory team relay packet behavior.
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
export ROOT_DIR

node --input-type=module <<'NODE'
import assert from "node:assert/strict";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const { buildTeamPacket } = await import(pathToFileURL(`${process.env.ROOT_DIR}/extensions/foreman/teampacket.ts`).href);
const planner = await import(pathToFileURL(`${process.env.ROOT_DIR}/extensions/foreman/planner.ts`).href);

function scored(text, { route = "team", risk = "medium", confidence = "medium", reasons = [`reason for ${text}`], kind = "domain-fact", cost = risk } = {}) {
  return { text, route, risk, confidence, reasons, kind, cost };
}

const mixed = [
  scored("medium team domain fact", { risk: "medium", confidence: "medium", reasons: ["medium evidence", "risk medium: medium P(wrong) x medium cost"] }),
  scored("high founder preference", { route: "founder", risk: "high", confidence: "low", reasons: ["founder-only reason"], kind: "preference" }),
  scored("low team domain fact", { route: "team", risk: "low", confidence: "high", reasons: ["low reason"], cost: "low" }),
  scored("high team domain fact", { risk: "high", confidence: "low", reasons: ["highRiskPaths matched src/auth/** -> src/auth/session.ts", "risk high: high P(wrong) x high cost"] }),
  scored("self handled copy", { route: "self", risk: "medium", confidence: "medium", reasons: ["self reason"], kind: "unknown" }),
];
const packet = buildTeamPacket(mixed);
assert.match(packet, /^## Questions for your team \(relay these\)/, "packet starts with the relay heading");
assert.match(packet, /Paste into your team channel/, "wording is founder/team-relay oriented");
assert.match(packet, /Gate 1 can proceed on these unless someone vetoes\/corrects one/, "packet explains assume-unless-vetoed behavior without adding a pause");
assert.match(packet, /I'm assuming high team domain fact\. Is that correct\?/, "team-routed high-risk assumptions are rendered as near yes/no questions");
assert.match(packet, /I'm assuming medium team domain fact\. Is that correct\?/, "team-routed medium-risk assumptions are included");
assert.doesNotMatch(packet, /high founder preference|self handled copy/, "founder/self routes are excluded");
assert.doesNotMatch(packet, /low team domain fact/, "low-risk team assumptions are dropped");
assert.ok(packet.indexOf("high team domain fact") < packet.indexOf("medium team domain fact"), "risk-desc ordering renders high before medium");
assert.match(packet, /confidence: low; risk: high/, "item carries confidence and risk band");
assert.match(packet, /highRiskPaths matched src\/auth\/\*\* -> src\/auth\/session\.ts/, "item carries scorer evidence/reasons");
assert.match(packet, /risk high: high P\(wrong\) x high cost/, "item carries why-risky scorer reason");

const sevenTeamItems = [
  scored("team high 1", { risk: "high", confidence: "low" }),
  scored("team medium 1", { risk: "medium", confidence: "medium" }),
  scored("team medium 2", { risk: "medium", confidence: "medium" }),
  scored("team high 2", { risk: "high", confidence: "low" }),
  scored("team medium 3", { risk: "medium", confidence: "medium" }),
  scored("team medium 4", { risk: "medium", confidence: "medium" }),
  scored("team high 3", { risk: "high", confidence: "low" }),
];
const capped = buildTeamPacket(sevenTeamItems);
assert.equal((capped.match(/^\d+\. /gm) ?? []).length, 5, "default cap renders at most five questions");
assert.match(capped, /Showing top 5 of 7/, "packet notes when the default cap omits lower-ranked items");
assert.ok(capped.indexOf("team high 1") < capped.indexOf("team medium 1"), "high-risk items are sorted ahead of medium-risk items before capping");
assert.match(capped, /team high 3/, "all high-risk items survive the cap");
assert.match(capped, /team medium 1/, "first medium-risk item survives after highs");
assert.match(capped, /team medium 2/, "second medium-risk item survives after highs");
assert.doesNotMatch(capped, /team medium 3|team medium 4/, "lower-ranked medium-risk items are omitted by cap");

const customCap = buildTeamPacket(sevenTeamItems, { maxItems: 2 });
assert.equal((customCap.match(/^\d+\. /gm) ?? []).length, 2, "maxItems option is respected");
assert.match(customCap, /team high 1/, "custom cap keeps first high-risk item");
assert.match(customCap, /team high 2/, "custom cap keeps second high-risk item");
assert.doesNotMatch(customCap, /team high 3|team medium 1/, "custom cap omits remaining items");
assert.equal(buildTeamPacket(sevenTeamItems, { maxItems: 0 }), "", "zero cap returns empty string");

assert.equal(buildTeamPacket([]), "", "empty scorer output returns empty string");
assert.equal(buildTeamPacket([scored("founder only", { route: "founder", risk: "high" }), scored("self only", { route: "self", risk: "medium" })]), "", "no team-routed assumptions returns empty string");
assert.equal(buildTeamPacket([scored("low only", { route: "team", risk: "low", confidence: "high", cost: "low" })]), "", "only low-risk team assumptions returns empty string");

const noConfidence = scored("missing confidence team fact", { risk: "medium", reasons: ["confidence missing -> medium P(wrong)"] });
delete noConfidence.confidence;
const noConfidencePacket = buildTeamPacket([noConfidence]);
assert.match(noConfidencePacket, /confidence: missing; risk: medium/, "missing confidence is explicit in the packet");
assert.match(noConfidencePacket, /missing confidence team fact/, "assumption text is present");
assert.match(noConfidencePacket, /confidence missing -> medium P\(wrong\)/, "reasons are present");

const renderedPlan = planner.renderFounderPlan({
  summary: "Render team packet.",
  assumptions: [
    { text: "The billing API currently returns paid invoices synchronously.", confidence: "low" },
    { text: "Founder prefers no settings UI in this scope.", confidence: "low" },
  ],
  nonGoals: [],
  alternatives: [],
  blastRadius: [],
  steps: ["Score assumptions", "Render packet"],
  filesLikely: [],
  risks: [],
  proposedGates: [],
  requirements: { env: [], tools: [], services: [] },
}, {
  task: "Render team packet",
  cwd: "/tmp/repo",
  track: "backend",
  maxRounds: 3,
  manifestExists: true,
  plannerSource: "planner",
  manifestWriteEligible: true,
  highRiskPaths: [],
});
assert.match(renderedPlan, /## Assumptions[\s\S]*## Questions for your team \(relay these\)/, "renderFounderPlan appends the team packet after assumptions");
assert.match(renderedPlan, /I'm assuming The billing API currently returns paid invoices synchronously\. Is that correct\?/, "rendered plan includes the team-routed domain-fact question");
assert.doesNotMatch(renderedPlan, /I'm assuming Founder prefers no settings UI/, "rendered team packet excludes founder-routed preference assumptions");

const plannerSource = fs.readFileSync(`${process.env.ROOT_DIR}/extensions/foreman/planner.ts`, "utf-8");
const indexSource = fs.readFileSync(`${process.env.ROOT_DIR}/extensions/foreman/index.ts`, "utf-8");
const teampacketSource = fs.readFileSync(`${process.env.ROOT_DIR}/extensions/foreman/teampacket.ts`, "utf-8");
const repoForemanManifest = fs.readFileSync(`${process.env.ROOT_DIR}/.pi/foreman.json`, "utf-8");
assert.match(plannerSource, /import \{ buildTeamPacket \} from "\.\/teampacket\.ts"/, "planner render path imports the pure team-packet formatter");
assert.match(plannerSource, /renderFounderPlan[\s\S]*buildTeamPacket\(scoredAssumptions\)/, "Gate-1 founder plan render path calls buildTeamPacket");
assert.match(indexSource, /buildTeamQuestionPacketForPlan\(drafted\.plan,[\s\S]*highRiskPaths: highRiskPaths/, "Gate 1 computes the same packet for the ledger event using the scorer context");
assert.match(indexSource, /teamQuestionPacket: teamQuestionPacket \|\| undefined/, "Gate 1 awaiting ledger event records the packet text when present");
assert.match(teampacketSource, /import type \{ ScoredAssumption \} from "\.\/scorer\.ts"/, "teampacket imports only the scorer assumption type");
assert.doesNotMatch(teampacketSource, /from "node:fs"|from "fs"|require\(["']fs["']\)/, "teampacket has no filesystem import");
assert.match(repoForemanManifest, /extensions\/foreman\/test\/teampacket_test\.sh/, ".pi/foreman.json verify gate runs teampacket_test.sh");

console.log("Foreman team question packet tests passed");
NODE
