#!/usr/bin/env bash
# Headless unit test for the foreman ledger: session-scoped resume + durable out-of-tree mirror.
# Pure data-layer (no agents, no TTY) — mirrors the AskUserQuestion/reader test style.
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
export ROOT_DIR

node --input-type=module <<'NODE'
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const led = await import(pathToFileURL(`${process.env.ROOT_DIR}/extensions/foreman/ledger.ts`).href);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-ledger-test."));
try {
  const repo = path.join(tmp, "repo");
  const mirror = path.join(tmp, "mirror");
  led.configureMirror(mirror);

  // ---- resume targeting (session-scoped) ----
  const a = led.initLedger(repo, "Task A for session one", 3, undefined, "sess-1");
  a.gate1Approved = true; a.state = "in_progress"; led.writeState(repo, a);
  const b = led.initLedger(repo, "Task B for session two", 3, undefined, "sess-2");
  b.gate1Approved = true; b.state = "awaiting_ship"; led.writeState(repo, b);
  const bPlanDir = path.join(repo, ".pi/plans", b.slug);
  fs.writeFileSync(path.join(bPlanDir, "plan.json"), JSON.stringify({ summary: "draft" }, null, 2));
  fs.writeFileSync(path.join(bPlanDir, "plan.meta.json"), JSON.stringify({ source: "fallback" }, null, 2));
  led.writeState(repo, b);

  assert.equal(led.resolveResumable(repo, { sessionId: "sess-1" }).state?.slug, a.slug, "session 1 resolves its own task");
  assert.equal(led.resolveResumable(repo, { sessionId: "sess-2" }).state?.slug, b.slug, "session 2 resolves its own task (no hijack)");
  assert.match(
    led.resolveResumable(repo, { sessionId: "sess-x" }).error ?? "",
    /Multiple resumable tasks/,
    "unknown session with 2 unowned tasks -> ambiguous error",
  );
  assert.equal(led.resolveResumable(repo, { slug: b.slug, sessionId: "sess-1" }).state?.slug, b.slug, "explicit slug overrides ownership");

  // ---- durable mirror: written on every mutation ----
  const mirrorRepoDir = fs.readdirSync(mirror)[0];
  const mTask = (slug) => path.join(mirror, mirrorRepoDir, "plans", slug);
  const mState = (slug) => path.join(mTask(slug), "state.json");
  assert.ok(fs.existsSync(mState(a.slug)), "task A mirrored");
  assert.ok(fs.existsSync(mState(b.slug)), "task B mirrored");
  assert.equal(JSON.parse(fs.readFileSync(mState(b.slug), "utf8")).state, "awaiting_ship", "mirror tracks state changes");
  assert.ok(fs.existsSync(path.join(mTask(b.slug), "plan.json")), "planner plan json is mirrored");
  assert.equal(JSON.parse(fs.readFileSync(path.join(mTask(b.slug), "plan.meta.json"), "utf8")).source, "fallback", "planner source metadata is mirrored");

  // ---- the pimote failure: wipe the whole in-repo .pi (git clean / crash) ----
  fs.rmSync(path.join(repo, ".pi"), { recursive: true, force: true });
  assert.equal(led.listResumable(repo).length, 0, "nothing resumable while ledger is wiped");

  // ---- restore self-heals from the mirror ----
  led.restoreFromMirror(repo);
  assert.ok(fs.existsSync(path.join(repo, ".pi/plans", a.slug, "state.json")), "task A restored from mirror");
  assert.ok(fs.existsSync(path.join(repo, ".pi/plans", b.slug, "log.jsonl")), "task B log restored");
  assert.equal(JSON.parse(fs.readFileSync(path.join(repo, ".pi/plans", b.slug, "plan.meta.json"), "utf8")).source, "fallback", "planner metadata restored from mirror");
  assert.equal(led.resolveResumable(repo, { sessionId: "sess-1" }).state?.state, "in_progress", "restored task resumes with state intact");

  // ---- restore never clobbers a present in-repo ledger ----
  a.state = "escalated"; led.writeState(repo, a);
  led.restoreFromMirror(repo);
  assert.equal(led.readState(repo, a.slug).state, "escalated", "existing in-repo ledger wins over mirror");

  // ---- mirror disabled -> still functions, no mirror writes ----
  led.configureMirror(null);
  const c = led.initLedger(repo, "Task C with mirror off", 3);
  assert.ok(fs.existsSync(path.join(repo, ".pi/plans", c.slug, "state.json")), "works with mirror disabled");

  console.log("Foreman ledger tests passed");
} finally {
  led.configureMirror(null);
  fs.rmSync(tmp, { recursive: true, force: true });
}
NODE
