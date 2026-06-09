#!/usr/bin/env bash
# Headless unit test for Foreman crew timeout helpers.
# Pure data-layer (no pi, no agents, no TTY) — validates dynamic idle/max timeout decisions and degradation mapping.
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
export ROOT_DIR

node --input-type=module <<'NODE'
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const planner = await import(pathToFileURL(`${process.env.ROOT_DIR}/extensions/foreman/planner.ts`).href);
const timeouts = await import(pathToFileURL(`${process.env.ROOT_DIR}/extensions/foreman/agent-timeouts.ts`).href);
const indexSource = readFileSync(`${process.env.ROOT_DIR}/extensions/foreman/index.ts`, "utf8");
const onLineStart = indexSource.indexOf("\t\tconst onLine = (line: string) => {");
assert.notEqual(onLineStart, -1, "runAgent has an onLine stream handler");
const onLineEnd = indexSource.indexOf("\t\t};\n\t\tproc.stdout.on", onLineStart);
assert.notEqual(onLineEnd, -1, "onLine handler boundaries are recognizable");
const onLineBody = indexSource.slice(onLineStart, onLineEnd);
const parseIndex = onLineBody.indexOf("ev = JSON.parse(line);");
const activityIndex = onLineBody.indexOf("options.onActivity?.();");
const firstTypedBranchIndex = onLineBody.indexOf("if (ev.type === \"message_start\"");
assert.ok(parseIndex !== -1, "onLine parses JSON stream events");
assert.ok(activityIndex > parseIndex, "onLine fires activity only after a stream event parses");
assert.ok(activityIndex < firstTypedBranchIndex, "onLine fires activity before event-type filtering/transcript writing");
assert.equal(
  (indexSource.match(/options\.onActivity\?\.\(\);/g) ?? []).length,
  1,
  "activity heartbeat is centralized to one parsed-event call site",
);

assert.deepEqual(
  planner.decidePlannerTimeout({ now: 11_000, startedAt: 0, lastActivityAt: 5_000, idleMs: 5_000, maxMs: 30_000 }),
  { abort: true, reason: "idle" },
  "idle exceeded while total runtime is under max -> idle abort",
);
assert.deepEqual(
  planner.decidePlannerTimeout({ now: 30_001, startedAt: 0, lastActivityAt: 29_750, idleMs: 5_000, maxMs: 30_000 }),
  { abort: true, reason: "max" },
  "max exceeded despite recent activity -> max abort",
);
assert.deepEqual(
  planner.decidePlannerTimeout({ now: 9_000, startedAt: 0, lastActivityAt: 7_500, idleMs: 5_000, maxMs: 30_000 }),
  { abort: false, reason: null },
  "neither bound exceeded -> no abort",
);
assert.deepEqual(
  planner.decidePlannerTimeout({ now: 30_001, startedAt: 0, lastActivityAt: 0, idleMs: 5_000, maxMs: 30_000 }),
  { abort: true, reason: "max" },
  "when both idle and max are exceeded, max has precedence",
);

assert.ok(indexSource.includes("async function runAgentWithTimeout"), "generalized runAgent timeout wrapper exists");
assert.ok(indexSource.includes("timeoutLogType(role)"), "timeouts are recorded through per-role ledger event names");

assert.deepEqual(planner.resolvePlannerTimeouts({}), { idleMs: 180_000, maxMs: 480_000 }, "planner defaults raised to 180s idle / 8m max (xhigh reads many files then deliberates before PLAN-JSON)");
assert.deepEqual(timeouts.resolveAgentTimeouts({}, "developer"), { idleMs: 180_000, maxMs: 900_000 }, "developer default budget is longer");
assert.deepEqual(timeouts.resolveAgentTimeouts({}, "ui-developer"), { idleMs: 180_000, maxMs: 900_000 }, "ui-developer fallback default budget is longer");
assert.deepEqual(timeouts.resolveAgentTimeouts({}, "tester"), { idleMs: 90_000, maxMs: 300_000 }, "tester default budget is bounded like planner");
assert.deepEqual(timeouts.resolveAgentTimeouts({}, "reviewer"), { idleMs: 180_000, maxMs: 720_000 }, "reviewer default budget is generous (xhigh + heavy recon), bounded like the developer");
assert.deepEqual(
  planner.resolvePlannerTimeouts({ FOREMAN_PLANNER_IDLE_MS: "12000", FOREMAN_PLANNER_MAX_MS: "120000" }),
  { idleMs: 12_000, maxMs: 120_000 },
  "IDLE/MAX env overrides are honored",
);
assert.deepEqual(
  planner.resolvePlannerTimeouts({ FOREMAN_PLANNER_TIMEOUT_MS: "2222" }),
  { idleMs: 2_222, maxMs: 480_000 },
  "legacy FOREMAN_PLANNER_TIMEOUT_MS sets idle when FOREMAN_PLANNER_IDLE_MS is absent",
);
assert.deepEqual(
  planner.resolvePlannerTimeouts({ FOREMAN_PLANNER_TIMEOUT_MS: "2222", FOREMAN_PLANNER_IDLE_MS: "3333" }),
  { idleMs: 3_333, maxMs: 480_000 },
  "FOREMAN_PLANNER_IDLE_MS overrides legacy FOREMAN_PLANNER_TIMEOUT_MS",
);
assert.deepEqual(
  planner.resolvePlannerTimeouts({ FOREMAN_PLANNER_IDLE_MS: "25", FOREMAN_PLANNER_MAX_MS: "50" }),
  { idleMs: 1_000, maxMs: 1_000 },
  "idle clamps to >=1000 and max is raised to idle when smaller",
);
assert.deepEqual(
  planner.resolvePlannerTimeouts({ FOREMAN_PLANNER_IDLE_MS: "5000", FOREMAN_PLANNER_MAX_MS: "4000" }),
  { idleMs: 5_000, maxMs: 5_000 },
  "max is raised to idle when max override is smaller",
);
assert.deepEqual(
  timeouts.resolveAgentTimeouts({ FOREMAN_DEVELOPER_IDLE_MS: "240000", FOREMAN_DEVELOPER_MAX_MS: "1200000" }, "developer"),
  { idleMs: 240_000, maxMs: 1_200_000 },
  "developer per-role env overrides are honored",
);
assert.deepEqual(
  timeouts.resolveAgentTimeouts({ FOREMAN_UI_DEVELOPER_IDLE_MS: "210000", FOREMAN_UI_DEVELOPER_MAX_MS: "600000" }, "ui-developer"),
  { idleMs: 210_000, maxMs: 600_000 },
  "ui-developer fallback per-role env overrides are honored",
);
assert.deepEqual(
  timeouts.resolveAgentTimeouts({ FOREMAN_TESTER_IDLE_MS: "45000", FOREMAN_TESTER_MAX_MS: "180000" }, "tester"),
  { idleMs: 45_000, maxMs: 180_000 },
  "tester per-role env overrides are honored",
);
assert.deepEqual(
  timeouts.resolveAgentTimeouts({ FOREMAN_REVIEWER_IDLE_MS: "60000", FOREMAN_REVIEWER_MAX_MS: "240000" }, "reviewer"),
  { idleMs: 60_000, maxMs: 240_000 },
  "reviewer per-role env overrides are honored",
);
assert.deepEqual(
  timeouts.timeoutEnvKeys("ui-developer"),
  { idle: "FOREMAN_UI_DEVELOPER_IDLE_MS", max: "FOREMAN_UI_DEVELOPER_MAX_MS" },
  "hyphenated ui-developer role maps to usable env var names",
);
assert.deepEqual(
  timeouts.decideAgentTimeout({ now: 10_001, startedAt: 0, lastActivityAt: 0, idleMs: 10_000, maxMs: 60_000 }),
  { abort: true, reason: "idle" },
  "generalized timeout decision covers non-planner roles",
);

const idleOutcome = { timedOut: true, reason: "idle" };
assert.deepEqual(
  timeouts.decideAgentTimeoutDegradation("planner", idleOutcome).action,
  "planner-fallback",
  "planner timeout still maps to fallback plan",
);
assert.deepEqual(
  timeouts.decideAgentTimeoutDegradation("developer", idleOutcome).action,
  "retry-developer-round",
  "developer timeout maps to a failed dev attempt / retry",
);
assert.deepEqual(
  timeouts.decideAgentTimeoutDegradation("ui-developer", { timedOut: true, reason: "max" }).action,
  "retry-developer-round",
  "ui-developer fallback timeout maps to a failed dev attempt / retry",
);
const testerDegradation = timeouts.decideAgentTimeoutDegradation("tester", idleOutcome);
assert.equal(testerDegradation.action, "fail-tester-verdict", "tester timeout maps to non-success verdict");
assert.equal(testerDegradation.successState, "fail", "tester timeout is fail, never success");
const reviewerDegradation = timeouts.decideAgentTimeoutDegradation("reviewer", idleOutcome);
assert.equal(reviewerDegradation.action, "flag-reviewer-inconclusive", "reviewer timeout maps to inconclusive pre-ship review");
assert.equal(reviewerDegradation.reviewDecision, "unknown", "reviewer timeout records UNKNOWN decision");
assert.equal(reviewerDegradation.flagged, true, "reviewer timeout is flagged for Gate 2 rather than auto-approved");
assert.deepEqual(
  timeouts.decideAgentTimeoutDegradation("tester", { timedOut: false, reason: null }),
  { action: "none", note: "" },
  "non-timeout has no degradation",
);

console.log("Foreman planner timeout helper tests passed");
NODE
