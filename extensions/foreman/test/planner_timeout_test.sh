#!/usr/bin/env bash
# Headless unit test for Foreman planner timeout helpers.
# Pure data-layer (no pi, no agents, no TTY) — validates dynamic idle/max timeout decisions.
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
export ROOT_DIR

node --input-type=module <<'NODE'
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const planner = await import(pathToFileURL(`${process.env.ROOT_DIR}/extensions/foreman/planner.ts`).href);

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

assert.deepEqual(planner.resolvePlannerTimeouts({}), { idleMs: 45_000, maxMs: 300_000 }, "defaults are 45s idle / 5m max");
assert.deepEqual(
  planner.resolvePlannerTimeouts({ FOREMAN_PLANNER_IDLE_MS: "12000", FOREMAN_PLANNER_MAX_MS: "120000" }),
  { idleMs: 12_000, maxMs: 120_000 },
  "IDLE/MAX env overrides are honored",
);
assert.deepEqual(
  planner.resolvePlannerTimeouts({ FOREMAN_PLANNER_TIMEOUT_MS: "2222" }),
  { idleMs: 2_222, maxMs: 300_000 },
  "legacy FOREMAN_PLANNER_TIMEOUT_MS sets idle when FOREMAN_PLANNER_IDLE_MS is absent",
);
assert.deepEqual(
  planner.resolvePlannerTimeouts({ FOREMAN_PLANNER_TIMEOUT_MS: "2222", FOREMAN_PLANNER_IDLE_MS: "3333" }),
  { idleMs: 3_333, maxMs: 300_000 },
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

console.log("Foreman planner timeout helper tests passed");
NODE
