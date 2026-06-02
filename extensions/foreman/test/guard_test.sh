#!/usr/bin/env bash
# Headless unit test for the Foreman route-through-foreman guard classifier.
# Pure classifier coverage (no pi, no agents, no TTY) plus persisted engagement contracts.
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
PI_PKG_DIR="$(npm root -g)/@earendil-works/pi-coding-agent"
export ROOT_DIR PI_PKG_DIR

node --input-type=module <<'NODE'
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const guard = await import(pathToFileURL(`${process.env.ROOT_DIR}/extensions/foreman/guard.ts`).href);
const engagement = await import(pathToFileURL(`${process.env.ROOT_DIR}/extensions/foreman/engagement.ts`).href);

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

function nonGitFallbackContext(cwd = "/workspace") {
  return {
    cwd,
    scratchDirs,
    findRepoRoot: () => cwd,
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
assertGate("write", { path: "src/app.ts", content: "x" }, true, "non-git cwd fallback gates source under cwd", nonGitFallbackContext());
assertGate("bash", { command: "echo x > src/app.ts" }, true, "non-git cwd fallback gates bash redirect under cwd", nonGitFallbackContext());
assertGate("write", { path: "../outside.ts", content: "x" }, false, "non-git cwd fallback still allows outside cwd", nonGitFallbackContext());
assertGate("write", { path: "/tmp/foreman-guard-scratch.ts", content: "x" }, false, "non-git cwd fallback keeps scratch dirs no-impact", nonGitFallbackContext());
assertGate("write", { path: "README.md", content: "x" }, false, "non-git cwd fallback still treats prose as no-impact", nonGitFallbackContext());
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

const engagementTmp = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-engagement-"));
const nonGitTmp = fs.mkdtempSync(path.join("/var/tmp", "foreman-engagement-workspace-"));
process.on("exit", () => {
  try {
    fs.rmSync(engagementTmp, { recursive: true, force: true });
    fs.rmSync(nonGitTmp, { recursive: true, force: true });
  } catch {
    // best-effort cleanup only
  }
});
const agentDir = path.join(engagementTmp, "agent");
const repoA = path.join(engagementTmp, "repo-a");
const repoB = path.join(engagementTmp, "repo-b");
const apiStorePath = path.join(engagementTmp, "api-store", "engagement.json");
fs.mkdirSync(repoA, { recursive: true });
fs.mkdirSync(repoB, { recursive: true });

assert.deepEqual(
  Object.keys(engagement).sort(),
  ["engagementStorePath", "readRepoEngagement", "repoEngagementActive", "repoEngagementKey", "setRepoEngagement"].sort(),
  "engagement.ts exposes the locked API and no old redesigned names",
);

process.env.FOREMAN_ENGAGEMENT_STORE = apiStorePath;
assert.equal(engagement.engagementStorePath(), path.resolve(apiStorePath), "FOREMAN_ENGAGEMENT_STORE overrides the agent-dir store path");
delete process.env.FOREMAN_ENGAGEMENT_STORE;
process.env.PI_CODING_AGENT_DIR = agentDir;
assert.equal(
  engagement.engagementStorePath(),
  path.resolve(path.join(agentDir, "foreman", "engagement.json")),
  "default engagement store lives under PI_CODING_AGENT_DIR/foreman/engagement.json",
);
process.env.FOREMAN_ENGAGEMENT_STORE = apiStorePath;

const keyA = engagement.repoEngagementKey(repoA);
const keyB = engagement.repoEngagementKey(repoB);
assert.match(keyA, /^repo-a-[a-f0-9]{12}$/, "repo engagement key is sanitized tail + short sha256 hash");
assert.notEqual(keyA, keyB, "repo engagement keys are per-root stable identifiers");
assert.equal(engagement.repoEngagementKey(path.join(repoA, "..", "repo-a")), keyA, "repo engagement key resolves roots before hashing");

assert.deepEqual(engagement.readRepoEngagement(repoA), { active: true, source: "default" }, "missing store defaults engagement ON");
assert.equal(engagement.repoEngagementActive(repoA), true, "repoEngagementActive reads the default ON state");
assert.equal(fs.existsSync(apiStorePath), false, "read/default engagement does not create a store file");
fs.mkdirSync(path.dirname(apiStorePath), { recursive: true });
fs.writeFileSync(apiStorePath, "{ definitely not json", "utf-8");
assert.deepEqual(engagement.readRepoEngagement(repoA), { active: true, source: "default" }, "bad store defaults engagement ON without throwing");
fs.writeFileSync(apiStorePath, JSON.stringify({ repos: { [keyA]: { active: false } } }), "utf-8");
assert.deepEqual(engagement.readRepoEngagement(repoA), { active: true, source: "default" }, "malformed repo entries are ignored and default ON");
fs.rmSync(apiStorePath, { force: true });

assert.deepEqual(engagement.setRepoEngagement(repoA, false), { active: false, source: "repo" }, "engage:false persists the OFF override");
assert.deepEqual(engagement.readRepoEngagement(repoA), { active: false, source: "repo" }, "persisted OFF override reads back");
assert.equal(engagement.repoEngagementActive(repoA), false, "repoEngagementActive reads persisted OFF");
assert.deepEqual(engagement.readRepoEngagement(repoB), { active: true, source: "default" }, "engagement is per-repo, not global");
let apiStore = JSON.parse(fs.readFileSync(apiStorePath, "utf-8"));
assert.deepEqual(Object.keys(apiStore), ["repos"], "store shape has only a repos object");
assert.deepEqual(apiStore.repos[keyA].active, false, "store records only active:false OFF overrides");
assert.equal(apiStore.repos[keyA].path, path.resolve(repoA), "store entry records the resolved repo root path");
assert.match(apiStore.repos[keyA].updatedAt, /^\d{4}-\d{2}-\d{2}T/, "store entry records an ISO updatedAt");
assert.equal(Object.values(apiStore.repos).some((entry) => entry.active === true), false, "store never writes active:true entries");

engagement.setRepoEngagement(repoB, false);
engagement.setRepoEngagement(repoA, true);
apiStore = JSON.parse(fs.readFileSync(apiStorePath, "utf-8"));
assert.equal(apiStore.repos[keyA], undefined, "engage:true deletes the repo key and returns to default ON");
assert.equal(apiStore.repos[keyB].active, false, "engage:true deletes only the target repo key");
assert.deepEqual(engagement.readRepoEngagement(repoA), { active: true, source: "default" }, "deleted key reads as default ON");
assert.equal(fs.existsSync(path.join(repoA, ".pi", "foreman-engagement.json")), false, "engagement writes are not project-local");

const indexStorePath = path.join(engagementTmp, "index-store", "engagement.json");
const nonGitCwd = path.join(nonGitTmp, "loose-workspace");
fs.mkdirSync(path.join(nonGitCwd, "src"), { recursive: true });
process.env.FOREMAN_ENGAGEMENT_STORE = indexStorePath;
delete process.env.FOREMAN_CREW;

let sessionStartHandler;
let toolCallHandler;
let foremanDirectCommand;
let foremanTool;
const pi = {
  on(name, handler) {
    if (name === "session_start") sessionStartHandler = handler;
    if (name === "tool_call") toolCallHandler = handler;
  },
  registerCommand(name, def) {
    if (name === "foreman-direct") foremanDirectCommand = def;
  },
  registerShortcut() {},
  registerTool(def) {
    if (def?.name === "foreman") foremanTool = def;
  },
};
const directRoot = path.join(engagementTmp, "direct-root");
const copiedForemanDir = path.join(directRoot, "extensions", "foreman");
fs.cpSync(path.join(process.env.ROOT_DIR, "extensions", "foreman"), copiedForemanDir, { recursive: true });
const scopedModules = path.join(directRoot, "node_modules", "@earendil-works");
fs.mkdirSync(scopedModules, { recursive: true });
fs.symlinkSync(process.env.PI_PKG_DIR, path.join(scopedModules, "pi-coding-agent"), "dir");
const siblingModuleRoot = path.join(process.env.PI_PKG_DIR, "node_modules", "@earendil-works");
if (fs.existsSync(siblingModuleRoot)) {
  for (const sibling of fs.readdirSync(siblingModuleRoot)) {
    const target = path.join(scopedModules, sibling);
    if (!fs.existsSync(target)) fs.symlinkSync(path.join(siblingModuleRoot, sibling), target, "dir");
  }
}
const foremanIndex = await import(pathToFileURL(path.join(copiedForemanDir, "index.ts")).href);
foremanIndex.default(pi);
assert.equal(typeof sessionStartHandler, "function", "foreman registers a passive session_start handler");
assert.equal(typeof toolCallHandler, "function", "foreman registers a tool_call guard handler");
assert.equal(typeof foremanDirectCommand?.handler, "function", "/foreman-direct command registers");
assert.equal(typeof foremanTool?.execute, "function", "foreman tool registers");

const statusByKey = new Map();
const statusEvents = [];
const notifications = [];
const ctx = {
  cwd: nonGitCwd,
  hasUI: false,
  sessionManager: { getSessionId: () => "guard-test-session" },
  ui: {
    setStatus(key, value) {
      statusByKey.set(key, value);
      statusEvents.push({ key, value });
    },
    notify(message, level) {
      notifications.push({ message, level });
    },
  },
};
const signal = new AbortController().signal;
const textOf = (result) => result?.content?.map((part) => part?.text ?? "").join("\n") ?? "";

let block = toolCallHandler({ toolName: "write", input: { path: "src/app.ts", content: "x" } }, ctx);
assert.equal(block?.block, true, "index tool_call gates source writes under a non-git cwd while engaged");
assert.match(block.reason ?? "", /git init/, "non-git gate reason mentions initializing git");
assert.match(block.reason ?? "", /foreman\(\{ engage: false \}\)/, "non-git gate reason mentions engage:false escape hatch");
assert.equal(statusByKey.get("foreman-direct"), undefined, "engaged status is clear");
assert.equal(
  toolCallHandler({ toolName: "write", input: { path: path.join(os.tmpdir(), "foreman-scratch.ts"), content: "x" } }, ctx),
  undefined,
  "index cwd fallback still preserves scratch-dir writes as no-impact",
);

let result = await foremanTool.execute("guard-engage-off", { engage: false, task: "must not start" }, signal, undefined, ctx);
assert.match(textOf(result), /direct-edit mode ON/, "foreman({ engage:false }) reports disabled engagement");
assert.equal(statusByKey.get("foreman-direct"), "⚠ foreman-direct ON (repo)", "disabled engagement uses the specified persisted repo status text");
assert.equal(engagement.repoEngagementActive(nonGitCwd), false, "foreman({ engage:false }) persists OFF for root=findGitRoot(cwd)??cwd");
assert.equal(fs.existsSync(path.join(nonGitCwd, ".pi")), false, "engage-only call returns early and does not start a task/ledger");
block = toolCallHandler({ toolName: "write", input: { path: "src/app.ts", content: "x" } }, ctx);
assert.equal(block, undefined, "OFF engagement returns undefined from tool_call and allows direct edits");

const beforeSessionStartStore = fs.readFileSync(indexStorePath, "utf-8");
sessionStartHandler({}, ctx);
assert.equal(fs.readFileSync(indexStorePath, "utf-8"), beforeSessionStartStore, "session_start reads/statuses only and does not write engagement store");
assert.equal(statusByKey.get("foreman-direct"), "⚠ foreman-direct ON (repo)", "session_start passively reflects persisted OFF status");

result = await foremanTool.execute("guard-engage-on", { engage: true, task: "must not start" }, signal, undefined, ctx);
assert.match(textOf(result), /engagement ON/, "foreman({ engage:true }) reports enabled engagement");
assert.equal(statusByKey.get("foreman-direct"), undefined, "re-enabled engagement clears the persisted repo status text");
assert.equal(engagement.repoEngagementActive(nonGitCwd), true, "foreman({ engage:true }) deletes the OFF override");
assert.equal(fs.existsSync(path.join(nonGitCwd, ".pi")), false, "engage:true is also early and does not start a task/ledger");

await foremanDirectCommand.handler([], ctx);
assert.equal(engagement.repoEngagementActive(nonGitCwd), false, "/foreman-direct toggles persisted engagement OFF");
assert.equal(statusByKey.get("foreman-direct"), "⚠ foreman-direct ON (repo)", "/foreman-direct OFF state sets the specified status text");
await foremanDirectCommand.handler([], ctx);
assert.equal(engagement.repoEngagementActive(nonGitCwd), true, "/foreman-direct toggles persisted engagement back ON");
assert.equal(statusByKey.get("foreman-direct"), undefined, "/foreman-direct ON state clears status");

delete process.env.FOREMAN_ENGAGEMENT_STORE;
fs.rmSync(engagementTmp, { recursive: true, force: true });
fs.rmSync(nonGitTmp, { recursive: true, force: true });

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
