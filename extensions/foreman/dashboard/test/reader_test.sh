#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd -P)"
export ROOT_DIR

node --input-type=module <<'NODE'
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const reader = await import(pathToFileURL(`${process.env.ROOT_DIR}/extensions/foreman/dashboard/reader.ts`).href);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-reader-test."));
const repo = path.join(tmp, "repo");
const slug = "demo-task";
const oldSlug = "older-done-task";
const ownedDoneSlug = "owned-done-task";
const gateSlug = "ship-gate-task";
const otherSlug = "other-session-task";
const missingTranscriptSlug = "missing-transcript-task";
const planDir = path.join(repo, ".pi", "plans", slug);
const oldPlanDir = path.join(repo, ".pi", "plans", oldSlug);
const ownedDonePlanDir = path.join(repo, ".pi", "plans", ownedDoneSlug);
const gatePlanDir = path.join(repo, ".pi", "plans", gateSlug);
const otherPlanDir = path.join(repo, ".pi", "plans", otherSlug);
const missingTranscriptPlanDir = path.join(repo, ".pi", "plans", missingTranscriptSlug);
const handoffsDir = path.join(planDir, "handoffs");
const transcriptsDir = path.join(planDir, "transcripts");

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeJsonl(file, events, trailing = "") {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, events.map((event) => JSON.stringify(event)).join("\n") + "\n" + trailing);
}

function stripAnsi(value) {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function visibleLength(value) {
  return [...stripAnsi(value)].length;
}

try {
  fs.mkdirSync(handoffsDir, { recursive: true });
  fs.mkdirSync(transcriptsDir, { recursive: true });
  fs.mkdirSync(oldPlanDir, { recursive: true });
  fs.mkdirSync(ownedDonePlanDir, { recursive: true });
  fs.mkdirSync(gatePlanDir, { recursive: true });
  fs.mkdirSync(otherPlanDir, { recursive: true });
  fs.mkdirSync(missingTranscriptPlanDir, { recursive: true });

  writeJson(path.join(planDir, "state.json"), {
    task: "Demo task",
    slug,
    state: "in_progress",
    workingDirectory: repo,
    ownerSessionId: "sess-owner",
    verifyCommand: "npm test",
    round: 1,
    maxRounds: 3,
    lastReviewedHandoffCount: 2,
    gate1Approved: true,
    gate2Approved: false,
    createdAt: "2026-05-31T11:00:00.000Z",
    updatedAt: "2026-05-31T12:01:13.000Z",
  });
  writeJson(path.join(oldPlanDir, "state.json"), {
    task: "Older done task",
    slug: oldSlug,
    state: "done",
    workingDirectory: repo,
    round: 2,
    maxRounds: 2,
    lastReviewedHandoffCount: 4,
    gate1Approved: true,
    gate2Approved: true,
    createdAt: "2026-05-30T10:00:00.000Z",
    updatedAt: "2026-05-30T12:00:00.000Z",
  });
  writeJson(path.join(ownedDonePlanDir, "state.json"), {
    task: "Finished task should collapse",
    slug: ownedDoneSlug,
    state: "done",
    workingDirectory: repo,
    ownerSessionId: "sess-owner",
    round: 2,
    maxRounds: 2,
    gate1Approved: true,
    gate2Approved: true,
    createdAt: "2026-05-31T10:00:00.000Z",
    updatedAt: "2026-05-31T11:30:00.000Z",
  });
  writeJson(path.join(gatePlanDir, "state.json"), {
    task: "Phase B planner — ship gate",
    slug: gateSlug,
    state: "awaiting_ship",
    workingDirectory: repo,
    ownerSessionId: "sess-owner",
    round: 2,
    maxRounds: 3,
    gate1Approved: true,
    gate2Approved: false,
    createdAt: "2026-05-31T10:30:00.000Z",
    updatedAt: "2026-05-31T11:59:00.000Z",
  });
  writeJson(path.join(otherPlanDir, "state.json"), {
    task: "Other session task",
    slug: otherSlug,
    state: "in_progress",
    workingDirectory: repo,
    ownerSessionId: "other-session",
    round: 1,
    maxRounds: 3,
    gate1Approved: true,
    gate2Approved: false,
    createdAt: "2026-05-31T11:00:00.000Z",
    updatedAt: "2026-05-31T12:01:12.000Z",
  });
  writeJson(path.join(missingTranscriptPlanDir, "state.json"), {
    task: "Missing transcript task",
    slug: missingTranscriptSlug,
    state: "in_progress",
    workingDirectory: repo,
    ownerSessionId: "sess-missing",
    round: 1,
    maxRounds: 3,
    gate1Approved: true,
    gate2Approved: false,
    createdAt: "2026-05-31T11:00:00.000Z",
    updatedAt: "2026-05-31T12:01:10.000Z",
  });

  writeJsonl(path.join(planDir, "log.jsonl"), [
    { timestamp: "2026-05-31T12:00:00.000Z", type: "task_started", task: "Demo task" },
    { timestamp: "2026-05-31T12:00:01.000Z", type: "round_started", round: 1 },
    { timestamp: "2026-05-31T12:00:02.000Z", type: "verify_ran", round: 1, command: "npm test", exitCode: 1 },
    { timestamp: "2026-05-31T12:00:03.000Z", type: "developer_handoff", round: 1, summary: "Implemented the fix" },
    { timestamp: "2026-05-31T12:00:04.000Z", type: "tester_verdict", round: 1, successState: "fail", summary: "Tests still fail" },
    { timestamp: "2026-05-31T12:00:05.000Z", type: "verdict", round: 1, successState: "fail", verifyExit: 1 },
  ]);

  const devSession = "dev-session";
  const testerSession = "tester-session";
  const devTranscript = `2026-05-31T12-00-02-000Z__developer-r1__${devSession}.jsonl`;
  writeJson(path.join(handoffsDir, `2026-05-31T12-00-03-000Z__developer-r1__${devSession}.json`), {
    timestamp: "2026-05-31T12:00:03.000Z",
    role: "developer",
    round: 1,
    sessionId: devSession,
    summary: "Implemented the fix",
    filesChanged: ["calc.py"],
    howToVerify: "npm test",
    raw: "done",
  });
  writeJson(path.join(handoffsDir, `2026-05-31T12-00-04-000Z__tester-r1__${testerSession}.json`), {
    timestamp: "2026-05-31T12:00:04.000Z",
    role: "tester",
    round: 1,
    sessionId: testerSession,
    successState: "fail",
    summary: "Tests still fail",
    raw: "VERDICT: FAIL",
  });

  writeJson(path.join(planDir, "activity.json"), {
    updatedAt: "2026-05-31T12:01:13.000Z",
    round: 1,
    phase: "developer",
    activeTranscript: devTranscript,
    note: "running…",
    pid: 1234,
    ownerSessionId: "sess-owner",
  });
  writeJson(path.join(otherPlanDir, "activity.json"), {
    updatedAt: "2026-05-31T12:01:13.000Z",
    round: 1,
    phase: "developer",
    activeTranscript: null,
    note: "other session running…",
    pid: 2222,
    ownerSessionId: "other-session",
  });
  writeJson(path.join(missingTranscriptPlanDir, "activity.json"), {
    updatedAt: "2026-05-31T12:01:13.000Z",
    round: 1,
    phase: "tester",
    activeTranscript: "does-not-exist.jsonl",
    note: "tester running…",
    pid: 3333,
    ownerSessionId: "sess-missing",
  });

  writeJsonl(path.join(transcriptsDir, devTranscript), [
    { t: "2026-05-31T12:00:53.000Z", kind: "agent_start", role: "developer", round: 1, model: "test/model", task: "Demo task" },
    { t: "2026-05-31T12:01:11.100Z", kind: "tool_call", name: "read", args: { path: "calc.py", offset: 1, limit: 20 } },
    { t: "2026-05-31T12:01:11.200Z", kind: "tool_result", name: "read", ok: true, preview: "def add(a, b):" },
    { t: "2026-05-31T12:01:11.300Z", kind: "text", text: "I found the bug." },
    { t: "2026-05-31T12:01:11.400Z", kind: "usage", input: 1200, output: 300, cost: 0.01, contextTokens: 4096 },
    { t: "2026-05-31T12:01:12.000Z", kind: "tool_call", name: "edit", args: { path: "extensions/foreman/index.ts" } },
    { t: "2026-05-31T12:01:12.100Z", kind: "usage", input: 2200, output: 500, cost: 0.02, contextTokens: 44000 },
    { t: "2026-05-31T12:01:12.700Z", kind: "agent_end", stopReason: "end", exitCode: 0 },
  ], "{ deliberately truncated final line");

  assert.deepEqual(reader.listTasks(path.join(tmp, "missing")), [], "missing repo has no tasks");
  const tasks = reader.listTasks(repo);
  assert.equal(tasks.length, 6, "listTasks includes done tasks too");
  const demoTask = tasks.find((task) => task.slug === slug);
  const legacyTask = tasks.find((task) => task.slug === oldSlug);
  assert.equal(tasks[0].slug, slug, "newest task sorts first");
  assert.equal(demoTask.task, "Demo task");
  assert.equal(demoTask.state, "in_progress");
  assert.equal(demoTask.round, 1);
  assert.equal(demoTask.maxRounds, 3);
  assert.equal(demoTask.gate1Approved, true);
  assert.equal(demoTask.gate2Approved, false);
  assert.equal(demoTask.updatedAt, "2026-05-31T12:01:13.000Z");
  assert.equal(demoTask.verifyCommand, "npm test");
  assert.equal(demoTask.ownerSessionId, "sess-owner", "listTasks surfaces ownerSessionId");
  assert.equal(legacyTask.slug, oldSlug, "done tasks are not filtered out");
  assert.equal(legacyTask.ownerSessionId, undefined, "legacy task without owner stays undefined");

  assert.equal(reader.readActivity(repo, "missing"), null, "missing activity returns null");
  const activity = reader.readActivity(repo, slug);
  assert.deepEqual(activity, {
    updatedAt: "2026-05-31T12:01:13.000Z",
    round: 1,
    phase: "developer",
    activeTranscript: devTranscript,
    note: "running…",
    pid: 1234,
    ownerSessionId: "sess-owner",
  });

  assert.deepEqual(reader.listRuns(repo, "missing"), [], "missing runs return empty array");
  const runs = reader.listRuns(repo, slug);
  assert.deepEqual(runs, [{ file: devTranscript, role: "developer", round: 1, sessionId: devSession }]);

  assert.deepEqual(reader.readTranscript(repo, slug, "missing.jsonl"), [], "missing transcript returns empty array");
  const transcript = reader.readTranscript(repo, slug, devTranscript);
  assert.equal(transcript.length, 8, "truncated final JSONL line is skipped");
  assert.equal(transcript[0].kind, "agent_start");
  assert.equal(transcript[1].kind, "tool_call");
  assert.equal(transcript[2].kind, "tool_result");
  assert.equal(transcript[3].kind, "text");
  assert.equal(transcript[4].kind, "usage");
  assert.equal(transcript[5].kind, "tool_call");
  assert.equal(transcript[6].kind, "usage");
  assert.equal(transcript[7].kind, "agent_end");

  assert.deepEqual(reader.buildRootRows(repo, "missing"), [], "missing root rows return empty array");
  const rows = reader.buildRootRows(repo, slug);
  assert.deepEqual(rows.map((row) => row.kind), ["developer", "verify", "tester"], "root rows are ordered by round and role");
  assert.equal(rows[0].round, 1);
  assert.equal(rows[0].status, "running", "activity overrides matching active transcript to running");
  assert.equal(rows[0].summary, "running…");
  assert.equal(rows[0].live, true, "activeTranscript marks matching row live");
  assert.equal(rows[0].transcriptFile, devTranscript);
  assert.equal(rows[1].status, "exit 1");
  assert.equal(rows[1].summary, "npm test");
  assert.equal(rows[1].live, false);
  assert.equal(rows[2].status, "fail");
  assert.equal(rows[2].summary, "Tests still fail");
  assert.equal(rows[2].live, false);

  // --- footer statusline model + format ---
  const nowMs = Date.parse("2026-05-31T12:01:14.000Z");
  const slModel = reader.buildStatuslineModel(repo, { sessionId: "sess-owner", now: nowMs });
  assert.deepEqual(slModel.map((t) => t.slug), [slug, gateSlug, ownedDoneSlug], "statusline is scoped to the session's tasks");
  const liveStatus = slModel.find((task) => task.slug === slug);
  assert.equal(liveStatus.phase, "developer", "live crew phase comes from fresh activity.json");
  assert.equal(liveStatus.glyph, "running", "actively-spawning task uses the running glyph");
  assert.equal(liveStatus.detail, "dev", "detail names the live developer agent");
  assert.equal(liveStatus.round, 1, "model carries the round");
  assert.equal(liveStatus.liveAction, "editing index.ts", "last tool_call becomes a human live action");
  assert.equal(liveStatus.toolCount, 2, "tool_call events are counted");
  assert.equal(liveStatus.ctxTokens, 44000, "latest usage.contextTokens is surfaced");
  assert.equal(liveStatus.elapsedMs, 21000, "elapsed is derived from agent_start.t and injected now");
  assert.equal(liveStatus.lastMovementMs, 2000, "lastMovementMs is derived from the last tool_call.t and injected now");
  assert.equal(liveStatus.stage, "dev", "developer round 1 maps to the dev step");
  assert.ok(liveStatus.label.length <= 37, "task label is bounded for the footer");

  const missingTranscriptModel = reader.buildStatuslineModel(repo, { sessionId: "sess-missing", now: nowMs });
  assert.equal(missingTranscriptModel[0].glyph, "running", "fresh missing transcript still marks the task running");
  assert.equal(missingTranscriptModel[0].liveAction, undefined, "absent transcript omits liveAction");
  assert.equal(missingTranscriptModel[0].toolCount, undefined, "absent transcript omits toolCount");
  assert.equal(missingTranscriptModel[0].ctxTokens, undefined, "absent transcript omits ctxTokens");
  assert.equal(missingTranscriptModel[0].elapsedMs, undefined, "absent transcript omits elapsedMs");
  assert.equal(missingTranscriptModel[0].lastMovementMs, undefined, "absent transcript omits lastMovementMs");

  assert.deepEqual(
    reader.buildStatuslineModel(repo, { sessionId: "nobody", now: nowMs }),
    [],
    "a session with no owned tasks gets an empty statusline",
  );

  const staleModel = reader.buildStatuslineModel(repo, { sessionId: "sess-owner", now: nowMs + 60000 });
  assert.equal(staleModel[0].phase, "developer", "footer liveness survives past staleMs for active non-done tasks");
  assert.equal(staleModel[0].glyph, "idle", "picker-oriented running glyph still falls back to idle after staleMs");
  assert.equal(staleModel[0].lastMovementMs, 62000, "liveness movement keeps advancing past staleMs");

  const slLine = reader.formatStatusLine(slModel, { frame: 0, maxWidth: 160 });
  assert.ok(slLine.startsWith("FOREMAN "), "footer line carries the FOREMAN brand prefix");
  assert.ok(slLine.includes("✓plan ●dev ○test ○fix ○ship"), "footer line shows the fixed stage stepper");
  assert.ok(slLine.includes("r1/3"), "footer line shows round/max");
  assert.ok(slLine.includes("21s"), "footer line shows elapsed time");
  assert.ok(slLine.includes("moved 2s ago"), "footer line shows last movement age");
  assert.ok(slLine.includes("editing index.ts"), "footer line shows the live action");
  assert.ok(slLine.includes("◆ Phase B planner"), "footer line includes a short gate chip");
  assert.ok(slLine.endsWith("✓1"), "footer line collapses done tasks into a trailing count chip");
  assert.ok(!slLine.includes("Finished task should collapse"), "done tasks are not listed individually");
  assert.ok(!slLine.includes("Other session task"), "footer excludes tasks owned by another session");
  assert.ok(visibleLength(slLine) <= 160, "footer line respects the requested max width");
  assert.notEqual(
    reader.formatStatusLine(slModel, { frame: 0, maxWidth: 160 }),
    reader.formatStatusLine(slModel, { frame: 1, maxWidth: 160 }),
    "the live spinner animates across frames",
  );
  assert.equal(reader.formatStatusLine([]), "", "empty model clears the status line");
  assert.equal(
    reader.formatStatusLine([{ ...slModel[2] }]),
    "FOREMAN  idle · last: owned-done-task ✓ done r2/2",
    "done-only model renders the idle/last task footer",
  );
  assert.ok(
    reader.formatStatusLine(slModel, { color: (token, text) => `<${token}>${text}</${token}>`, frame: 0, maxWidth: 1000 }).includes("<accent>"),
    "format applies the injected colorizer",
  );

  const baseStageTask = {
    slug: "stage-task",
    label: "Pimote daemon",
    state: "in_progress",
    phase: "developer",
    glyph: "running",
    round: 1,
    maxRounds: 3,
    detail: "dev",
    elapsedMs: 21000,
    lastMovementMs: 2000,
    liveAction: "running npm test",
  };
  const lineFor = (patch, opts = {}) => reader.formatStatusLine([{ ...baseStageTask, ...patch }], { frame: 1, maxWidth: 1000, ...opts });
  assert.ok(lineFor({ phase: "planner", liveRole: "planner", round: 0, detail: "plan" }).includes("●plan ○dev ○test ○fix ○ship"), "planner maps to the plan step");
  assert.ok(lineFor({ phase: "developer", round: 1, detail: "dev" }).includes("✓plan ●dev ○test ○fix ○ship"), "developer round 1 maps to the dev step");
  assert.ok(lineFor({ phase: "verify", liveRole: "verify", detail: "verify" }).includes("✓plan ✓dev ●test ○fix ○ship"), "verify maps to the test step");
  assert.ok(lineFor({ phase: "tester", liveRole: "tester", detail: "test" }).includes("✓plan ✓dev ●test ○fix ○ship"), "tester maps to the test step");
  assert.ok(lineFor({ phase: "developer", round: 2, detail: "dev" }).includes("✓plan ✓dev ✓test ●fix ○ship"), "developer round 2 maps to the fix step with test done");
  const shipLine = lineFor({ state: "awaiting_ship", phase: null, glyph: "gate", stage: "ship", round: 2, detail: "ship?" });
  assert.ok(shipLine.includes("✓plan ✓dev ✓test ✓fix ●ship"), "awaiting_ship maps to the ship step");
  assert.ok(shipLine.includes("◆ awaiting ship · approve?"), "awaiting_ship renders as an approval prompt");

  const formatWithBg = (lastMovementMs, patch = {}) => {
    const tokens = [];
    const line = reader.formatStatusLine([{ ...baseStageTask, lastMovementMs, ...patch }], {
      frame: 0,
      maxWidth: 1000,
      bg: (token, text) => {
        tokens.push(token);
        return `<bg:${token}>${text}</bg:${token}>`;
      },
    });
    return { line, tokens };
  };
  // Tint tokens must be REAL theme background keys (theme.bg throws on unknown keys); the theme
  // exposes *Bg keys only, so assert those exact keys here to prevent regressing the crash.
  const VALID_BG_TOKENS = new Set(["selectedBg", "userMessageBg", "customMessageBg", "toolPendingBg", "toolSuccessBg", "toolErrorBg", "pageBg", "cardBg", "infoBg"]);
  assert.deepEqual(formatWithBg(59999).tokens, [], "healthy movement under 60s does not tint the bar");
  const stalling = formatWithBg(60000);
  assert.deepEqual(stalling.tokens, ["toolPendingBg"], "movement at 60s tints the whole bar with a real pending-bg token");
  assert.ok(stalling.tokens.every((t) => VALID_BG_TOKENS.has(t)), "stalling tint token is a real theme bg key");
  assert.ok(stalling.line.startsWith("<bg:toolPendingBg>FOREMAN"), "warning tint wraps the whole FOREMAN band");
  assert.ok(stalling.line.includes("⚠"), "stalling uses the warning liveness glyph");
  const stuck = formatWithBg(180000);
  assert.deepEqual(stuck.tokens, ["toolErrorBg"], "movement at 180s tints the whole bar with a real error-bg token");
  assert.ok(stuck.tokens.every((t) => VALID_BG_TOKENS.has(t)), "stuck tint token is a real theme bg key");
  assert.ok(stuck.line.startsWith("<bg:toolErrorBg>FOREMAN"), "error tint wraps the whole FOREMAN band");
  assert.ok(stuck.line.includes("✗ NO MOVEMENT"), "stuck uses the no-movement liveness text");
  const awaitingShip = formatWithBg(180000, { state: "awaiting_ship", phase: null, glyph: "gate", stage: "ship", round: 2, detail: "ship?" });
  assert.deepEqual(awaitingShip.tokens, [], "awaiting_ship is not an alarm and does not tint");
  assert.ok(awaitingShip.line.includes("◆ awaiting ship · approve?"), "awaiting_ship keeps the warning approval accent");

  const narrowLine = lineFor({ phase: "tester", liveRole: "tester", round: 2, detail: "test", liveAction: "running a very long test command" }, { maxWidth: 34 });
  assert.ok(narrowLine.includes("●test"), "narrow footer keeps the current stage");
  assert.ok(narrowLine.includes("r2/3"), "narrow footer keeps the round");
  assert.ok(narrowLine.includes("21s ·2s"), "narrow footer keeps compact liveness");
  assert.ok(!narrowLine.includes("moved"), "narrow footer drops right-side liveness prose first");
  assert.ok(visibleLength(narrowLine) <= 34, "narrow footer respects the requested max width");

  const longLabelLine = reader.formatStatusLine(
    [{ ...baseStageTask, label: "Fix two cosmetic bugs in the Foreman status panel shipped in commit b3bac70…" }],
    { frame: 0, maxWidth: 140 },
  );
  assert.ok(!longLabelLine.includes("…"), "footer word-clips labels without a Unicode ellipsis");
  assert.ok(longLabelLine.includes("Fix two cosmetic bugs"), "footer keeps the useful head of a long label");

  const sorted = reader.sortForPicker(
    [
      { slug: "done", task: "done", state: "done", round: 1, maxRounds: 1, gate1Approved: true, gate2Approved: true, updatedAt: "2026-05-31T12:04:00.000Z", ownerSessionId: "mine" },
      { slug: "gate", task: "gate", state: "awaiting_ship", round: 1, maxRounds: 1, gate1Approved: true, gate2Approved: false, updatedAt: "2026-05-31T12:03:00.000Z", ownerSessionId: "other" },
      { slug: "live-other", task: "live other", state: "in_progress", round: 1, maxRounds: 1, gate1Approved: true, gate2Approved: false, updatedAt: "2026-05-31T12:02:00.000Z", ownerSessionId: "other" },
      { slug: "live-mine", task: "live mine", state: "in_progress", round: 1, maxRounds: 1, gate1Approved: true, gate2Approved: false, updatedAt: "2026-05-31T12:01:00.000Z", ownerSessionId: "mine" },
      { slug: "progress", task: "progress", state: "in_progress", round: 1, maxRounds: 1, gate1Approved: true, gate2Approved: false, updatedAt: "2026-05-31T12:05:00.000Z", ownerSessionId: "mine" },
    ],
    "mine",
    { liveSlugs: ["live-other", "live-mine"] },
  );
  assert.deepEqual(
    sorted.map((task) => task.slug),
    ["live-mine", "live-other", "gate", "progress", "done"],
    "picker sort orders attention first, then this session before others at equal attention, then done last",
  );

  console.log("Foreman dashboard reader tests passed");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
NODE
