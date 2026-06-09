#!/usr/bin/env bash
# Headless unit test for Gate 2 approval friction.
# Pure data-layer (no pi, no agents, no TTY) — validates high-risk path matching and Gate 2 confirm wiring guards.
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
export ROOT_DIR

node --input-type=module <<'NODE'
import assert from "node:assert/strict";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const approval = await import(pathToFileURL(`${process.env.ROOT_DIR}/extensions/foreman/approvalfriction.ts`).href);

const elevated = approval.decideApprovalFriction({
  highRiskPaths: ["src/auth/**", "migrations/*.sql"],
  changedPaths: ["docs/readme.md", "src/auth/session.ts"],
});
assert.equal(elevated.level, "elevated", "touching a configured high-risk path elevates Gate 2 friction");
assert.deepEqual(elevated.matchedPaths, ["src/auth/session.ts"], "matchedPaths reports the high-risk changed path");
assert.match(elevated.reason, /High-risk path glob matched src\/auth\/session\.ts/, "elevated reason names the concrete match");

const normal = approval.decideApprovalFriction({
  highRiskPaths: ["src/auth/**", "migrations/*.sql"],
  changedPaths: ["src/ui/button.ts", "docs/readme.md"],
});
assert.equal(normal.level, "normal", "non-high-risk path changes keep one-tap ship approval");
assert.deepEqual(normal.matchedPaths, [], "normal decisions have no matched paths");
assert.match(normal.reason, /No changed or at-risk paths matched highRiskPaths/, "normal reason explains no match");

const noConfig = approval.decideApprovalFriction({ changedPaths: ["src/auth/session.ts"], highRiskPaths: [] });
assert.equal(noConfig.level, "normal", "without configured highRiskPaths the friction stays dormant");
assert.match(noConfig.reason, /No highRiskPaths configured/, "missing config reason is explicit");

const globbed = approval.decideApprovalFriction({
  highRiskPaths: ["src/**/*.ts", "**/secrets/*.json", "migrations/????_*.sql"],
  changedPaths: [
    "src/app.ts:12",
    "src/lib/nested.ts",
    "config/secrets/prod.json - rotate token",
    "migrations/0001_init.sql",
    "migrations/12_bad.sql",
  ],
});
assert.equal(globbed.level, "elevated", "glob matching handles nested paths, anchors, and candidate extraction");
assert.deepEqual(
  globbed.matchedPaths,
  ["src/app.ts", "src/lib/nested.ts", "config/secrets/prod.json", "migrations/0001_init.sql"],
  "glob matcher supports **, candidate tokens, and ? width without duplicating matches",
);

const approvalSource = fs.readFileSync(`${process.env.ROOT_DIR}/extensions/foreman/approvalfriction.ts`, "utf-8");
const indexSource = fs.readFileSync(`${process.env.ROOT_DIR}/extensions/foreman/index.ts`, "utf-8");
const plannerPrompt = fs.readFileSync(`${process.env.ROOT_DIR}/extensions/foreman/crew/planner.md`, "utf-8");
const repoForemanManifest = fs.readFileSync(`${process.env.ROOT_DIR}/.pi/foreman.json`, "utf-8");
assert.match(approvalSource, /import \{ globMatches \} from "\.\/scorer\.ts"/, "approval friction reuses the scorer glob matcher");
assert.doesNotMatch(approvalSource, /from "node:fs"|from "fs"|require\(["']fs["']\)/, "approval friction stays fs-free/pure");
assert.match(indexSource, /confirm: \{ type: "string"/, "foreman params parse the elevated ship confirm token");
assert.match(indexSource, /params\.confirm/, "Gate 2 approve path reads params.confirm");
assert.match(indexSource, /confirmMatchesElevatedShip\(params, slug\)/, "Gate 2 approve path checks the elevated confirm token before shipping");
assert.match(indexSource, /gate2_confirm_blocked/, "missing elevated confirm is logged instead of shipped");
assert.match(indexSource, /HIGH-RISK CHANGE — review the diff before approving/, "Gate 2 emits the high-risk review banner");
assert.match(indexSource, /formatShipApprovalInstructions\(approvalFriction, slug\)/, "Gate 2 approval-needed emits use friction-aware instructions");
assert.match(indexSource, /loadHighRiskPaths\(cwd\)/, "orchestrator loads repo highRiskPaths outside the pure module");
assert.match(plannerPrompt, /Before you flag an assumption\/risk as risky or surface a team\/founder question, try to resolve it yourself first/, "planner has the tier-2 self-resolve instruction");
assert.match(plannerPrompt, /genuinely cannot resolve it, it has verifiable evidence .*busy expert could answer it in one line/, "planner question-raising gate requires evidence and one-line answerability");
assert.match(repoForemanManifest, /extensions\/foreman\/test\/approvalfriction_test\.sh/, ".pi/foreman.json verify gate runs approvalfriction_test.sh");

console.log("Foreman approval friction tests passed");
NODE
