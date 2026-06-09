#!/usr/bin/env bash
# Headless unit test for the anti-rubber-stamp scorer calibration loop.
# Pure data-layer + thin fs-reader boundary (no pi, no agents, no TTY).
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
export ROOT_DIR

node --input-type=module <<'NODE'
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const calibration = await import(pathToFileURL(`${process.env.ROOT_DIR}/extensions/foreman/calibration.ts`).href);
const reader = await import(pathToFileURL(`${process.env.ROOT_DIR}/extensions/foreman/calibration-reader.ts`).href);

function obs(overrides = {}) {
  return {
    slug: "task",
    assumptionText: "assumption",
    route: "founder",
    risk: "high",
    wasRejectedWithCorrection: false,
    ...overrides,
  };
}

function repeat(count, make) {
  return Array.from({ length: count }, (_, index) => make(index));
}

// summarizeCalibration aggregates total, clear worth-it signal, neutral signal, route, and risk.
const stats = calibration.summarizeCalibration([
  obs({ slug: "a", route: "founder", risk: "high", wasRejectedWithCorrection: true }),
  obs({ slug: "b", route: "team", risk: "medium", wasRejectedWithCorrection: false }),
  obs({ slug: "c", route: "founder", risk: "medium", wasRejectedWithCorrection: false }),
  obs({ slug: "d", route: "self", risk: "low", wasRejectedWithCorrection: true }),
]);
assert.equal(stats.totalFlags, 4, "total flags count");
assert.equal(stats.worthItCount, 2, "only reject+correction observations count as worth-it");
assert.equal(stats.neutralCount, 2, "all non-reject observations are neutral, not negative");
assert.equal(stats.byRoute.founder.totalFlags, 2, "founder route count");
assert.equal(stats.byRoute.founder.worthItCount, 1, "founder route worth-it count");
assert.equal(stats.byRoute.team.totalFlags, 1, "team route count");
assert.equal(stats.byRoute.self.totalFlags, 1, "self route still aggregates for explicit fixtures");
assert.equal(stats.byRisk.high.totalFlags, 1, "high risk count");
assert.equal(stats.byRisk.medium.totalFlags, 2, "medium risk count");
assert.equal(stats.byRisk.low.totalFlags, 1, "low risk count");

// proposeCalibration is conservative: no proposals for tiny samples, even with a low ratio.
const tinyStats = calibration.summarizeCalibration(repeat(4, (i) => obs({ slug: `tiny-${i}`, route: "founder", risk: "high" })));
assert.deepEqual(calibration.proposeCalibration(tinyStats), [], "no proposal below the minimum sample size");

// With enough samples and low clear-signal ratio, it proposes human review only.
const lowSignalStats = calibration.summarizeCalibration(repeat(5, (i) => obs({ slug: `low-${i}`, route: "founder", risk: "high" })));
const lowSignalProposal = calibration.proposeCalibration(lowSignalStats);
assert.ok(lowSignalProposal.length > 0, "proposal appears above min sample with low worth-it ratio");
assert.match(lowSignalProposal.join("\n"), /consider reviewing/i, "proposal is advisory");
assert.match(lowSignalProposal.join("\n"), /over-flags/i, "proposal asks founder to review over-flagging");
assert.doesNotMatch(lowSignalProposal.join("\n").toLowerCase(), /flag was wrong|flags were wrong/, "proposal never claims a flag was wrong");

// Healthy ratios emit no proposal.
const healthyStats = calibration.summarizeCalibration([
  ...repeat(3, (i) => obs({ slug: `healthy-w-${i}`, route: "team", risk: "medium", wasRejectedWithCorrection: true })),
  ...repeat(3, (i) => obs({ slug: `healthy-n-${i}`, route: "team", risk: "medium", wasRejectedWithCorrection: false })),
]);
assert.deepEqual(calibration.proposeCalibration(healthyStats), [], "healthy worth-it ratios produce no proposal");

// Reader signal discipline: reject+correction => worth-it; approved straight-through => neutral; malformed/pending skipped.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-calibration-test."));
try {
  const repo = path.join(tmp, "repo");
  const plans = path.join(repo, ".pi", "plans");
  function writeLog(slug, lines) {
    const dir = path.join(plans, slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "log.jsonl"), `${lines.join("\n")}\n`);
  }
  const line = (value) => JSON.stringify(value);

  writeLog("approved-task", [
    line({ type: "gate1_awaiting", scoredAssumptions: [
      { text: "The billing API behavior is stable.", route: "team", risk: "high" },
      { text: "Founder prefers no settings UI.", route: "founder", risk: "medium" },
    ] }),
    "{ malformed json",
    line({ type: "gate1_approved" }),
    line({ type: "gate2_awaiting" }),
    line({ type: "gate2_approved" }),
  ]);

  writeLog("pending-task", [
    line({ type: "gate1_awaiting", scoredAssumptions: [{ text: "Pending team fact.", route: "team", risk: "high" }] }),
  ]);

  writeLog("rejected-task", [
    line({ type: "gate1_awaiting", scoredAssumptions: [
      { text: "Auth sessions are stored in login service.", route: "team", risk: "high" },
      { text: "Founder prefers skipping audit log.", route: "founder", risk: "medium" },
      { text: "Low-risk copy stays unchanged.", route: "self", risk: "low" },
      { text: "Bad route is skipped.", route: "nobody", risk: "high" },
    ] }),
    line({ type: "gate1_rejected", feedback: "Correction: auth sessions are stored in the edge cache." }),
  ]);

  fs.mkdirSync(path.join(plans, "missing-log"), { recursive: true });

  const observations = reader.readCalibrationObservationsFromPlans(repo);
  assert.equal(observations.length, 4, "reader extracts founder/team flags from rejected and approved tasks only");
  assert.deepEqual(observations.map((o) => o.slug).sort(), ["approved-task", "approved-task", "rejected-task", "rejected-task"], "pending/missing logs are skipped");
  assert.equal(observations.find((o) => o.assumptionText?.includes("Auth sessions"))?.wasRejectedWithCorrection, true, "gate1 reject+feedback marks task flags worth-it");
  assert.equal(observations.find((o) => o.assumptionText?.includes("billing API"))?.wasRejectedWithCorrection, false, "approved-straight task flags are neutral");
  assert.equal(observations.some((o) => o.route === "self"), false, "self-routed assumptions were not raised and are not reader observations");

  const fromLines = calibration.extractCalibrationObservationsFromLogLines([
    { slug: "gate2-reject", lines: [
      line({ type: "gate1_awaiting", scoredAssumptions: [{ text: "External API stays stable.", route: "team", risk: "medium" }] }),
      line({ type: "gate1_approved" }),
      line({ type: "gate2_rejected", feedback: "Correction: external API changed shape." }),
    ] },
  ]);
  assert.equal(fromLines.length, 1, "pure log-line reader handles gate2 reject signal");
  assert.equal(fromLines[0].wasRejectedWithCorrection, true, "gate2 reject+feedback marks worth-it");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

const calibrationSource = fs.readFileSync(`${process.env.ROOT_DIR}/extensions/foreman/calibration.ts`, "utf-8");
const indexSource = fs.readFileSync(`${process.env.ROOT_DIR}/extensions/foreman/index.ts`, "utf-8");
const manifest = fs.readFileSync(`${process.env.ROOT_DIR}/.pi/foreman.json`, "utf-8");
assert.doesNotMatch(calibrationSource, /from "node:fs"|from "fs"|require\(["']fs["']\)/, "pure calibration core has no filesystem import");
assert.match(indexSource, /scoredAssumptions: scoredAssumptionsForLog/, "gate1_awaiting ledger event records scored assumptions additively");
assert.match(indexSource, /registerCommand\("foreman-calibration"/, "manual calibration command is registered");
assert.match(manifest, /extensions\/foreman\/test\/calibration_test\.sh/, ".pi/foreman.json verify gate runs calibration_test.sh");

const report = calibration.formatCalibrationReport(lowSignalStats, lowSignalProposal);
assert.match(report, /advisory/i, "report is human-advisory");
assert.match(report, /does not auto-tune scorer\.ts/, "report states scorer is not auto-tuned");
assert.match(report, /does not write AGENTS\.md/, "report states AGENTS.md is not auto-written");

console.log("Foreman scorer calibration tests passed");
NODE
