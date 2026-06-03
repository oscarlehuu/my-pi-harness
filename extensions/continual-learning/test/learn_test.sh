#!/usr/bin/env bash
# Headless integration test for the learning orchestrator (runLearningPass) with injected deps.
# No real pi subprocess, no network — validates success-only index refresh, AGENTS.md scaffold, and delta gating.
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
export ROOT_DIR
WORK="$(mktemp -d)"
export WORK
trap 'rm -rf "$WORK"' EXIT

node --input-type=module <<'NODE'
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.env.ROOT_DIR;
const work = process.env.WORK;

// learn.ts imports the real runner lazily (only when no injectable `run` is given), and uses
// `import type` for the runner types, so this module loads pi-free on the inject path below.
const learn = await import(pathToFileURL(`${root}/extensions/continual-learning/learn.ts`).href);

// --- fixture: a fake transcript on disk + a stub updater ---
const cwd = path.join(work, "repo");
fs.mkdirSync(cwd, { recursive: true });
const fakeTranscript = path.join(work, "sess.jsonl");
fs.writeFileSync(fakeTranscript, [
  JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "Always use tabs." }] } }),
  JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Got it." }] } }),
].join("\n"));

let capturedTask = null;
const stubRun = async (_agent, task) => { capturedTask = task; return { text: "Updated AGENTS.md.", exitCode: 0, stderr: "" }; };
const listTranscripts = () => [{ path: fakeTranscript, mtimeMs: 1000 }];

const paths = learn.resolveLearnPaths(cwd);

// --- first pass: delta present -> runs, writes index + scaffold ---
const out1 = await learn.runLearningPass({
  cwd, agent: { systemPrompt: "x" }, now: 5000, agentDir: "/unused",
  run: stubRun, listTranscripts,
});
assert.equal(out1.ran, true, "first pass runs when transcript is new");
assert.equal(out1.ok, true, "successful updater marks outcome ok");
assert.equal(out1.deltaCount, 1, "one delta processed");
assert.ok(fs.existsSync(paths.agentsMd), "AGENTS.md scaffold created");
const md = fs.readFileSync(paths.agentsMd, "utf-8");
assert.ok(md.includes("## Learned Corrections"), "scaffold has corrections heading");
assert.ok(md.includes("## Learned User Preferences"), "scaffold has preferences heading");
assert.ok(md.includes("## Learned Workspace Facts"), "scaffold has facts heading");
assert.ok(fs.existsSync(paths.indexFile), "index written after successful updater");
const idx = JSON.parse(fs.readFileSync(paths.indexFile, "utf-8"));
assert.equal(idx.entries[fakeTranscript].mtimeMs, 1000, "index records processed mtime");
assert.ok(capturedTask.includes("Always use tabs."), "updater task carries transcript digest");
assert.ok(capturedTask.includes(paths.agentsMd), "updater task references AGENTS.md path");

// --- second pass: no new delta (same mtime, now indexed) -> does not run ---
capturedTask = null;
const out2 = await learn.runLearningPass({
  cwd, agent: { systemPrompt: "x" }, now: 6000, agentDir: "/unused",
  run: stubRun, listTranscripts,
});
assert.equal(out2.ran, false, "second pass skips when no transcript delta");
assert.equal(capturedTask, null, "updater not invoked on empty delta");

// --- third pass: transcript advanced -> runs again ---
const listAdvanced = () => [{ path: fakeTranscript, mtimeMs: 2000 }];
const out3 = await learn.runLearningPass({
  cwd, agent: { systemPrompt: "x" }, now: 7000, agentDir: "/unused",
  run: stubRun, listTranscripts: listAdvanced,
});
assert.equal(out3.ran, true, "advanced transcript re-triggers a pass");
const idx3 = JSON.parse(fs.readFileSync(paths.indexFile, "utf-8"));
assert.equal(idx3.entries[fakeTranscript].mtimeMs, 2000, "index updated to new mtime");

// --- failed updater: surfaces failure and does NOT advance the index ---
const failingRun = async () => ({ text: "", exitCode: 42, stderr: "model unavailable\nrate limited" });
const listFailedAdvanced = () => [{ path: fakeTranscript, mtimeMs: 3000 }];
const outFail = await learn.runLearningPass({
  cwd, agent: { systemPrompt: "x" }, now: 8000, agentDir: "/unused",
  run: failingRun, listTranscripts: listFailedAdvanced,
});
assert.equal(outFail.ran, true, "failed updater still counts as attempted run");
assert.equal(outFail.ok, false, "non-zero updater marks outcome not ok");
assert.match(outFail.reason, /updater exited 42/, "failure reason includes exit code");
assert.match(outFail.reason, /rate limited/, "failure reason includes stderr tail");
const idxFail = JSON.parse(fs.readFileSync(paths.indexFile, "utf-8"));
assert.equal(idxFail.entries[fakeTranscript].mtimeMs, 2000, "failed updater does not advance index");

const out4 = await learn.runLearningPass({
  cwd, agent: { systemPrompt: "x" }, now: 9000, agentDir: "/unused",
  run: stubRun, listTranscripts: listFailedAdvanced,
});
assert.equal(out4.ran, true, "failed delta is retried on next pass");
assert.equal(out4.ok, true, "retry succeeds");
const idx4 = JSON.parse(fs.readFileSync(paths.indexFile, "utf-8"));
assert.equal(idx4.entries[fakeTranscript].mtimeMs, 3000, "retry advances index after success");

// --- batching: only transcripts included in the updater digest are indexed ---
const bulkCwd = path.join(work, "bulk-repo");
fs.mkdirSync(bulkCwd, { recursive: true });
const bulkTranscripts = Array.from({ length: 9 }, (_, i) => {
  const file = path.join(work, `bulk-${i}.jsonl`);
  fs.writeFileSync(file, JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: `Durable lesson ${i}` }] } }));
  return { path: file, mtimeMs: 10_000 + i };
});
const bulkPaths = learn.resolveLearnPaths(bulkCwd);
const outBulk1 = await learn.runLearningPass({
  cwd: bulkCwd, agent: { systemPrompt: "x" }, now: 10000, agentDir: "/unused",
  run: stubRun, listTranscripts: () => bulkTranscripts,
});
assert.equal(outBulk1.deltaCount, 8, "first batch includes at most eight transcripts");
const idxBulk1 = JSON.parse(fs.readFileSync(bulkPaths.indexFile, "utf-8"));
assert.equal(Object.keys(idxBulk1.entries).length, 8, "only included transcripts indexed");
assert.ok(!idxBulk1.entries[bulkTranscripts[8].path], "over-cap transcript is not marked before mining");
const outBulk2 = await learn.runLearningPass({
  cwd: bulkCwd, agent: { systemPrompt: "x" }, now: 11000, agentDir: "/unused",
  run: stubRun, listTranscripts: () => bulkTranscripts,
});
assert.equal(outBulk2.deltaCount, 1, "remaining transcript drains on next pass");
const idxBulk2 = JSON.parse(fs.readFileSync(bulkPaths.indexFile, "utf-8"));
assert.equal(Object.keys(idxBulk2.entries).length, 9, "second pass indexes the remaining transcript");

// --- digest cap: a single oversized transcript still makes progress ---
const bigTranscript = path.join(work, "big.jsonl");
fs.writeFileSync(bigTranscript, Array.from({ length: 20 }, () => JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "x".repeat(5000) }] } })).join("\n"));
const built = learn.buildUpdaterTask({ deltas: [{ path: bigTranscript, mtimeMs: 1 }], agentsMd: "/agents", indexFile: "/index" });
assert.equal(built.included.length, 1, "oversized first transcript is still included");

// --- scaffold idempotency: existing AGENTS.md keeps hand-written content ---
fs.writeFileSync(paths.agentsMd, "# My Project\n\nHand-written.\n");
learn.ensureLearnedScaffold(paths.agentsMd);
const md2 = fs.readFileSync(paths.agentsMd, "utf-8");
assert.ok(md2.includes("# My Project"), "existing content preserved");
assert.ok(md2.includes("## Learned Corrections"), "corrections heading appended");
assert.ok(md2.includes("## Learned User Preferences"), "missing learned headings appended");
assert.ok(md2.includes("Hand-written."), "hand-written body intact");

// --- upgrade path: a doc with only the OLD two sections gets Corrections inserted AT THE TOP ---
const legacyMd = path.join(work, "legacy-AGENTS.md");
fs.writeFileSync(legacyMd, [
  "## Learned User Preferences",
  "- Concise commits",
  "",
  "## Learned Workspace Facts",
  "- npm test runs the suite",
  "",
].join("\n"));
learn.ensureLearnedScaffold(legacyMd);
const up = fs.readFileSync(legacyMd, "utf-8");
assert.ok(up.includes("## Learned Corrections"), "corrections heading inserted on upgrade");
assert.ok(up.indexOf("## Learned Corrections") < up.indexOf("## Learned User Preferences"), "corrections inserted ABOVE preferences, not appended at bottom");
assert.ok(up.includes("- Concise commits") && up.includes("- npm test runs the suite"), "existing learned bullets preserved on upgrade");

console.log("continual-learning learn_test: ALL PASS");
NODE
echo "learn_test exit: $?"
