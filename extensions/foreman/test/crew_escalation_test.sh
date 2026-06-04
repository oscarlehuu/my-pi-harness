#!/usr/bin/env bash
# Regression test for the crew escalation channel — the fix for crew subprocesses hanging on
# AskUserQuestion. Two layers:
#   1. STATIC: developer/ui-developer agents declare a `tools:` allowlist that EXCLUDES the blocking
#      AskUserQuestion (and foreman, to stop recursive self-invocation) and INCLUDES escalate_question.
#   2. DATA-LAYER: the pending-question ledger channel round-trips — a crew agent records a question,
#      the loop can read it, copy it into durable state (awaiting_decision), and clear the file.
# Pure (no agents, no TTY), mirrors the ledger_test.sh style.
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
export ROOT_DIR

# ---- Layer 1: static crew tool-allowlist guard ----
for agent in developer ui-developer; do
  f="${ROOT_DIR}/extensions/foreman/crew/${agent}.md"
  fm="$(awk 'NR==1 && $0=="---"{f=1;next} f&&$0=="---"{exit} f{print}' "${f}")"
  tools_line="$(printf '%s\n' "${fm}" | grep -E '^tools:' || true)"
  if [[ -z "${tools_line}" ]]; then
    echo "FAIL: ${agent}.md has no \`tools:\` allowlist — it would inherit AskUserQuestion and hang." >&2
    exit 1
  fi
  if printf '%s' "${tools_line}" | grep -qiE '(^|[,: ])AskUserQuestion([, ]|$)'; then
    echo "FAIL: ${agent}.md tools allowlist includes AskUserQuestion (the blocking dialog must be removed)." >&2
    exit 1
  fi
  if printf '%s' "${tools_line}" | grep -qiE '(^|[,: ])foreman([, ]|$)'; then
    echo "FAIL: ${agent}.md tools allowlist includes foreman (crew must not recursively invoke the loop)." >&2
    exit 1
  fi
  if ! printf '%s' "${tools_line}" | grep -qiE '(^|[,: ])escalate_question([, ]|$)'; then
    echo "FAIL: ${agent}.md tools allowlist is missing escalate_question (the non-blocking question channel)." >&2
    exit 1
  fi
  for needed in read write edit bash; do
    if ! printf '%s' "${tools_line}" | grep -qiE "(^|[,: ])${needed}([, ]|\$)"; then
      echo "FAIL: ${agent}.md tools allowlist is missing \`${needed}\` (crew implementer needs it)." >&2
      exit 1
    fi
  done
done
echo "Foreman crew tool-allowlist guard passed"

# ---- Layer 1b: escalate_question is registered ONLY for crew subprocesses (FOREMAN_CREW=1) ----
idx="${ROOT_DIR}/extensions/foreman/index.ts"
if ! grep -q 'name: "escalate_question"' "${idx}"; then
  echo "FAIL: escalate_question tool is not registered in index.ts" >&2
  exit 1
fi
# The registration must be guarded by FOREMAN_CREW so the founder-facing orchestrator never sees it.
if ! grep -Eq 'FOREMAN_CREW === "1"\)\s*\{' "${idx}"; then
  echo "FAIL: escalate_question must be registered behind a FOREMAN_CREW guard." >&2
  exit 1
fi
echo "Foreman escalate_question crew-guard presence check passed"

# ---- Layer 1c: founder decisions reach the TESTER (the gap this fixes) ----
# The tester only sees the task + diff; without the resolved decisions it can FAIL a founder-approved
# literal as a "hardcoded guess". Assert the tester prompt is augmented with the decisions.
if ! grep -q 'formatResolvedDecisions(state.resolvedDecisions)' "${idx}"; then
  echo "FAIL: resolved founder decisions are not computed for the loop (formatResolvedDecisions missing)." >&2
  exit 1
fi
if ! grep -q 'decisionsForTester' "${idx}"; then
  echo "FAIL: the tester prompt is not augmented with founder decisions (decisionsForTester missing)." >&2
  exit 1
fi
echo "Foreman tester-sees-founder-decisions check passed"

# ---- Layer 2: pending-question ledger channel round-trips ----
node --input-type=module <<'NODE'
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const led = await import(pathToFileURL(`${process.env.ROOT_DIR}/extensions/foreman/ledger.ts`).href);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-escalation-test."));
try {
  const repo = path.join(tmp, "repo");
  led.configureMirror(null);

  const s = led.initLedger(repo, "Task that needs a founder decision mid-flight", 3, undefined, "sess-1");
  s.gate1Approved = true; s.state = "in_progress"; led.writeState(repo, s);

  // No question yet.
  assert.equal(led.readPendingQuestion(repo, s.slug), null, "no pending question initially");

  // Crew (child) records a question; returns immediately in real life.
  const q = {
    round: 1,
    askedBy: "developer",
    question: "Should tapping Stop on a terminal session hard-abort or soft-steer?",
    context: "The extension bridge has no abort; only inject is available.",
    options: ["Soft-steer via inject (recommended)", "Hard-abort"],
    createdAt: new Date().toISOString(),
  };
  led.writePendingQuestion(repo, s.slug, q);

  // Parent (loop) reads it back intact.
  const got = led.readPendingQuestion(repo, s.slug);
  assert.ok(got, "pending question is readable by the parent loop");
  assert.equal(got.question, q.question, "question text round-trips");
  assert.deepEqual(got.options, q.options, "options round-trip");

  // Parent consumes it: copy into durable state, then clear the file.
  led.clearPendingQuestion(repo, s.slug);
  s.state = "awaiting_decision";
  s.pendingDecision = got;
  led.writeState(repo, s);

  assert.equal(led.readPendingQuestion(repo, s.slug), null, "pending file cleared after consumption");
  const reloaded = led.readState(repo, s.slug);
  assert.equal(reloaded.state, "awaiting_decision", "state moved to awaiting_decision");
  assert.equal(reloaded.pendingDecision?.question, q.question, "question persisted in durable state for restart-safe resume");

  // pending_question.json must be ledger-ignored (machine-local, like activity.json).
  const gi = fs.readFileSync(path.join(repo, ".pi/.gitignore"), "utf8");
  assert.ok(gi.includes("plans/*/pending_question.json"), "pending_question.json is gitignored");

  // clearPendingQuestion is idempotent / safe when the file is already gone.
  led.clearPendingQuestion(repo, s.slug);
  assert.equal(led.readPendingQuestion(repo, s.slug), null, "clear is safe when nothing is pending");

  // ---- founder decision persists across rounds (so the tester knows it's approved, not guessed) ----
  s.state = "in_progress";
  s.pendingDecision = undefined;
  s.resolvedDecisions = [
    ...(s.resolvedDecisions ?? []),
    { round: got.round, question: got.question, decision: "Soft-steer via inject", createdAt: new Date().toISOString() },
  ];
  led.writeState(repo, s);
  const afterAnswer = led.readState(repo, s.slug);
  assert.equal(afterAnswer.resolvedDecisions?.length, 1, "resolved decision persisted on the ledger");
  assert.equal(afterAnswer.resolvedDecisions?.[0].decision, "Soft-steer via inject", "decision text persisted");
  assert.equal(afterAnswer.resolvedDecisions?.[0].question, got.question, "decision keeps the question it answered");
  // It must survive a ledger wipe+restore so a restart-resumed task still tells the tester it was approved.
  led.configureMirror(path.join(tmp, "mirror2"));
  led.writeState(repo, afterAnswer); // re-mirror with mirror enabled
  fs.rmSync(path.join(repo, ".pi/plans", s.slug, "state.json"));
  led.restoreFromMirror(repo);
  assert.equal(led.readState(repo, s.slug).resolvedDecisions?.[0].decision, "Soft-steer via inject", "decision restored from mirror");
  led.configureMirror(null);

  console.log("Foreman crew escalation ledger tests passed");
} finally {
  led.configureMirror(null);
  fs.rmSync(tmp, { recursive: true, force: true });
}
NODE
