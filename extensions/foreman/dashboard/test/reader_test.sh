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
const planDir = path.join(repo, ".pi", "plans", slug);
const oldPlanDir = path.join(repo, ".pi", "plans", oldSlug);
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
    updatedAt: "2026-05-31T12:00:00.000Z",
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
    updatedAt: "2026-05-31T12:00:06.000Z",
    round: 1,
    phase: "developer",
    activeTranscript: devTranscript,
    note: "running…",
    pid: 1234,
    ownerSessionId: "sess-owner",
  });

  writeJsonl(path.join(transcriptsDir, devTranscript), [
    { t: "2026-05-31T12:00:02.000Z", kind: "agent_start", role: "developer", round: 1, model: "test/model", task: "Demo task" },
    { t: "2026-05-31T12:00:02.100Z", kind: "tool_call", name: "read", args: { path: "calc.py", offset: 1, limit: 20 } },
    { t: "2026-05-31T12:00:02.200Z", kind: "tool_result", name: "read", ok: true, preview: "def add(a, b):" },
    { t: "2026-05-31T12:00:02.300Z", kind: "text", text: "I found the bug." },
    { t: "2026-05-31T12:00:02.400Z", kind: "usage", input: 1200, output: 300, cost: 0.01, contextTokens: 4096 },
    { t: "2026-05-31T12:00:02.500Z", kind: "agent_end", stopReason: "end", exitCode: 0 },
  ], "{ deliberately truncated final line");

  assert.deepEqual(reader.listTasks(path.join(tmp, "missing")), [], "missing repo has no tasks");
  const tasks = reader.listTasks(repo);
  assert.equal(tasks.length, 2, "listTasks includes done tasks too");
  assert.equal(tasks[0].slug, slug, "newest task sorts first");
  assert.equal(tasks[0].task, "Demo task");
  assert.equal(tasks[0].state, "in_progress");
  assert.equal(tasks[0].round, 1);
  assert.equal(tasks[0].maxRounds, 3);
  assert.equal(tasks[0].gate1Approved, true);
  assert.equal(tasks[0].gate2Approved, false);
  assert.equal(tasks[0].updatedAt, "2026-05-31T12:00:00.000Z");
  assert.equal(tasks[0].verifyCommand, "npm test");
  assert.equal(tasks[0].ownerSessionId, "sess-owner", "listTasks surfaces ownerSessionId");
  assert.equal(tasks[1].slug, oldSlug, "done tasks are not filtered out");
  assert.equal(tasks[1].ownerSessionId, undefined, "legacy task without owner stays undefined");

  assert.equal(reader.readActivity(repo, "missing"), null, "missing activity returns null");
  const activity = reader.readActivity(repo, slug);
  assert.deepEqual(activity, {
    updatedAt: "2026-05-31T12:00:06.000Z",
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
  assert.equal(transcript.length, 6, "truncated final JSONL line is skipped");
  assert.equal(transcript[0].kind, "agent_start");
  assert.equal(transcript[1].kind, "tool_call");
  assert.equal(transcript[2].kind, "tool_result");
  assert.equal(transcript[3].kind, "text");
  assert.equal(transcript[4].kind, "usage");
  assert.equal(transcript[5].kind, "agent_end");

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

  // --- statusline (footer) model + format ---
  // activity.json above is stamped at 12:00:06; treat "now" as right after it so it counts live.
  const nowMs = Date.parse("2026-05-31T12:00:07.000Z");
  const slModel = reader.buildStatuslineModel(repo, { sessionId: "sess-owner", now: nowMs });
  assert.deepEqual(slModel.map((t) => t.slug), [slug], "statusline is scoped to the session's tasks");
  assert.equal(slModel[0].phase, "developer", "live crew phase comes from fresh activity.json");
  assert.equal(slModel[0].glyph, "running", "actively-spawning task uses the running glyph");
  assert.ok(slModel[0].label.length <= 23, "task label is shortened for the footer");

  assert.deepEqual(
    reader.buildStatuslineModel(repo, { sessionId: "nobody", now: nowMs }),
    [],
    "a session with no owned tasks gets an empty statusline",
  );

  const staleModel = reader.buildStatuslineModel(repo, { sessionId: "sess-owner", now: nowMs + 60000 });
  assert.equal(staleModel[0].phase, null, "stale activity is not treated as a live agent");
  assert.equal(staleModel[0].glyph, "idle", "in_progress with stale activity falls back to idle");

  const slLine = reader.formatStatusline(slModel);
  assert.ok(slLine.startsWith("foreman "), "statusline carries the foreman prefix");
  assert.ok(slLine.includes(":dev"), "statusline shows the live developer agent");
  assert.equal(reader.formatStatusline([]), "", "empty model clears the status line");
  assert.ok(
    reader.formatStatusline(slModel, { color: (token, text) => `<${token}>${text}</${token}>` }).includes("<accent>"),
    "format applies the injected colorizer",
  );

  console.log("Foreman dashboard reader tests passed");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
NODE
