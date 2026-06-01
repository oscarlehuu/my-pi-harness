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
    { t: "2026-05-31T12:00:02.000Z", kind: "agent_start", role: "developer", round: 1, model: "test/model", task: "Demo task" },
    { t: "2026-05-31T12:00:02.100Z", kind: "tool_call", name: "read", args: { path: "calc.py", offset: 1, limit: 20 } },
    { t: "2026-05-31T12:00:02.200Z", kind: "tool_result", name: "read", ok: true, preview: "def add(a, b):" },
    { t: "2026-05-31T12:00:02.300Z", kind: "text", text: "I found the bug." },
    { t: "2026-05-31T12:00:02.400Z", kind: "usage", input: 1200, output: 300, cost: 0.01, contextTokens: 4096 },
    { t: "2026-05-31T12:00:02.500Z", kind: "tool_call", name: "edit", args: { path: "extensions/foreman/index.ts" } },
    { t: "2026-05-31T12:00:02.600Z", kind: "usage", input: 2200, output: 500, cost: 0.02, contextTokens: 44000 },
    { t: "2026-05-31T12:00:02.700Z", kind: "agent_end", stopReason: "end", exitCode: 0 },
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

  // --- statusline / status panel model + format ---
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
  assert.equal(liveStatus.elapsedMs, 72000, "elapsed is derived from agent_start.t and injected now");
  assert.ok(liveStatus.label.length <= 37, "task label is bounded for the footer/panel");

  const missingTranscriptModel = reader.buildStatuslineModel(repo, { sessionId: "sess-missing", now: nowMs });
  assert.equal(missingTranscriptModel[0].glyph, "running", "fresh missing transcript still marks the task running");
  assert.equal(missingTranscriptModel[0].liveAction, undefined, "absent transcript omits liveAction");
  assert.equal(missingTranscriptModel[0].toolCount, undefined, "absent transcript omits toolCount");
  assert.equal(missingTranscriptModel[0].ctxTokens, undefined, "absent transcript omits ctxTokens");
  assert.equal(missingTranscriptModel[0].elapsedMs, undefined, "absent transcript omits elapsedMs");

  assert.deepEqual(
    reader.buildStatuslineModel(repo, { sessionId: "nobody", now: nowMs }),
    [],
    "a session with no owned tasks gets an empty statusline",
  );

  const staleModel = reader.buildStatuslineModel(repo, { sessionId: "sess-owner", now: nowMs + 60000 });
  assert.equal(staleModel[0].phase, null, "stale activity is not treated as a live agent");
  assert.equal(staleModel[0].glyph, "idle", "in_progress with stale activity falls back to idle");

  const slLine = reader.formatStatusline(slModel, { frame: 0 });
  assert.ok(slLine.startsWith("foreman "), "statusline carries the foreman prefix");
  assert.ok(slLine.includes("R1 dev"), "statusline shows the round + live developer agent");
  assert.notEqual(
    reader.formatStatusline(slModel, { frame: 0 }),
    reader.formatStatusline(slModel, { frame: 1 }),
    "the live spinner animates across frames",
  );
  assert.equal(reader.formatStatusline([]), "", "empty model clears the status line");
  assert.ok(
    reader.formatStatusline(slModel, { color: (token, text) => `<${token}>${text}</${token}>`, frame: 0 }).includes("<accent>"),
    "format applies the injected colorizer",
  );

  const panel0 = reader.formatStatusPanel(slModel, { frame: 0, width: 58 });
  const panel1 = reader.formatStatusPanel(slModel, { frame: 1, width: 58 });
  assert.ok(panel0.length <= 7, "panel respects the setWidget line budget");
  assert.ok(panel0[0].startsWith("─ FOREMAN"), "panel title starts with the FOREMAN brand rule");
  assert.ok(panel0[0].includes("2 active · 1 done"), "panel title summarizes active work and collapses done to a count");
  assert.ok(!panel0.join("\n").includes("Finished task should collapse"), "done tasks are not rendered as individual blocks");
  assert.ok(panel0[1].includes("DEV"), "running row includes a role badge");
  assert.ok(panel0[1].includes("R1/3"), "running row includes round/max");
  assert.ok(panel0[1].includes("1m 12s"), "running row includes elapsed time");
  assert.ok(panel0[2].includes("↳ editing index.ts · 2 tools · 44k ctx"), "running row includes live action/tool/context details");
  assert.ok(panel0.join("\n").includes("needs you: ship?"), "gate task asks for ship approval");
  assert.notEqual(panel0[1], panel1[1], "panel spinner animates across frames");
  assert.ok(!panel0.join("\n").includes("Other session task"), "panel excludes tasks owned by another session");
  assert.deepEqual(reader.formatStatusPanel([]), [], "empty panel model renders no widget lines");

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
    "picker sort orders attention first, then yours before others at equal attention, then done last",
  );

  console.log("Foreman dashboard reader tests passed");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
NODE
