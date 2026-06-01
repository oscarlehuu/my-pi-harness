#!/usr/bin/env bash
# Headless unit test for the Foreman route-through-foreman guard classifier.
# Pure classifier coverage (no pi, no agents, no TTY) — mirrors the existing foreman tests.
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
export ROOT_DIR

node --input-type=module <<'NODE'
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const guard = await import(pathToFileURL(`${process.env.ROOT_DIR}/extensions/foreman/guard.ts`).href);

const repo = "/repo";
const scratchDirs = ["/tmp", "/private/tmp", "/private/var/folders", "/var/folders"];

function isUnder(target, dir) {
  const relative = path.relative(path.resolve(dir), path.resolve(target));
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function repoContext(repoRoot = repo) {
  return {
    cwd: repoRoot,
    scratchDirs,
    findRepoRoot: (p) => isUnder(p, repoRoot) ? repoRoot : null,
  };
}

function outOfRepoContext(cwd = "/workspace") {
  return {
    cwd,
    scratchDirs,
    findRepoRoot: () => null,
  };
}

function classify(toolName, input = {}, context = repoContext()) {
  return guard.classifyToolCall({ toolName, input }, context);
}

function assertGate(toolName, input, expected, label, context = repoContext()) {
  const result = classify(toolName, input, context);
  assert.equal(result.gate, expected, label);
  if (expected) assert.match(result.reason ?? "", /foreman\(/, `${label}: gated reason nudges to foreman(...)`);
}

function assertNoImpact(absPath, ctx, expected, label) {
  assert.equal(guard.isNoImpactPath(absPath, ctx), expected, label);
}

assertNoImpact("/tmp/y.txt", { repoRoot: repo, scratchDirs }, true, "scratch path is no-impact");
assertNoImpact("/outside/app.ts", { repoRoot: null, scratchDirs }, true, "repoRoot=null is no-impact");
assertNoImpact(`${repo}/README.md`, { repoRoot: repo, scratchDirs }, true, "repo README.md is prose/no-impact");
assertNoImpact(`${repo}/docs/guide.md`, { repoRoot: repo, scratchDirs }, true, "repo docs/guide.md is prose/no-impact by extension");
assertNoImpact(`${repo}/src/app.ts`, { repoRoot: repo, scratchDirs }, false, "repo src/app.ts is impactful");
assertNoImpact(`${repo}/config.json`, { repoRoot: repo, scratchDirs }, false, "repo config.json is impactful");
assertNoImpact(`${repo}/package.json`, { repoRoot: repo, scratchDirs }, false, "repo package.json is impactful");
assertNoImpact(`${repo}/Dockerfile`, { repoRoot: repo, scratchDirs }, false, "repo Dockerfile is impactful");
assertNoImpact("/repo-foo/x.ts", { repoRoot: repo, scratchDirs: [] }, true, "boundary: /repo-foo is not under /repo");

assertGate("edit", { path: "/tmp/a.ts", edits: [{ oldText: "a", newText: "b" }] }, false, "edit to scratch path does not gate");
assertGate("write", { path: "outside.ts", content: "x" }, false, "write out-of-repo does not gate", outOfRepoContext());
assertGate("edit", { path: "README.md", edits: [{ oldText: "a", newText: "b" }] }, false, "edit prose in repo does not gate");
assertGate("edit", { path: "src/app.ts", edits: [{ oldText: "a", newText: "b" }] }, true, "edit source in repo gates");
assertGate("write", { path: "config.json", content: "{}" }, true, "write config in repo gates");

assertGate("edit", { path: "a.ts", edits: [{ oldText: "a", newText: "b" }] }, true, "edit gates for real source in repo");
assertGate("write", { path: "a.ts", content: "x" }, true, "write gates for real source in repo");

for (const name of ["read", "grep", "find", "ls", "foreman", "subagent"]) {
  assertGate(name, {}, false, `${name} does not gate`);
}

for (const command of [
  "npm test",
  "git status",
  "git diff",
  "git log --oneline",
  "git show HEAD",
  "ls -la",
  "grep -r foo .",
  "echo hi",
  "cat x",
  "find . -maxdepth 1",
  "pwd",
  "which node",
]) {
  assertGate("bash", { command }, false, `read-only bash allowed: ${command}`);
}

assertGate("bash", { command: "echo x > /tmp/y.txt" }, false, "scratch redirect does not gate");
assertGate("bash", { command: "echo x > src/a.ts" }, true, "repo source redirect gates");
assertGate("bash", { command: "sed -i s/a/b/ README.md" }, false, "sed in-place prose does not gate");
assertGate("bash", { command: "sed -i s/a/b/ src/a.ts" }, true, "sed in-place source gates");

for (const command of [
  "echo x > a.ts",
  "sed -i 's/a/b/' a.ts",
  "tee a.ts",
  "git apply p.patch",
  "patch < p",
  "cp /tmp/x a.ts",
  "mv a b.ts",
]) {
  assertGate("bash", { command }, true, `write bash gates for impactful/unknown target: ${command}`);
}

console.log("Foreman guard tests passed");
NODE
