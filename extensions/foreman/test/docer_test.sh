#!/usr/bin/env bash
# Headless unit test for Foreman doc-er/docs drift helpers and orchestration wiring.
# Pure data-layer (no pi, no agents, no TTY) plus grep guards for the soft doc-er stage.
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
export ROOT_DIR

node --input-type=module <<'NODE'
import assert from "node:assert/strict";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const drift = await import(pathToFileURL(`${process.env.ROOT_DIR}/extensions/foreman/docdrift.ts`).href);
const foremanIndex = fs.readFileSync(`${process.env.ROOT_DIR}/extensions/foreman/index.ts`, "utf8");
const docErPrompt = fs.readFileSync(`${process.env.ROOT_DIR}/extensions/foreman/crew/doc-er.md`, "utf8");

assert.deepEqual(
  drift.detectLikelyStaleDocs({
    changedCodePaths: ["extensions/foreman/index.ts"],
    updatedDocPaths: [],
    docFiles: [
      { path: "extensions/foreman/docs/INTERNALS.md", content: "Control flow lives in extensions/foreman/index.ts:2075." },
      { path: "docs/unrelated.md", content: "No code anchor here." },
    ],
  }),
  ["extensions/foreman/docs/INTERNALS.md"],
  "changed code path referenced by an un-updated doc is flagged",
);
assert.deepEqual(
  drift.detectLikelyStaleDocs({
    changedCodePaths: ["extensions/foreman/index.ts"],
    updatedDocPaths: ["extensions/foreman/docs/INTERNALS.md"],
    docFiles: [{ path: "extensions/foreman/docs/INTERNALS.md", content: "Control flow lives in extensions/foreman/index.ts:2075." }],
  }),
  [],
  "doc updated by doc-er this task is not flagged",
);
assert.deepEqual(
  drift.detectLikelyStaleDocs({
    changedCodePaths: ["./extensions/foreman/index.ts:2340"],
    updatedDocPaths: ["extensions/foreman/docs/INTERNALS.md:45"],
    docFiles: [{ path: "extensions/foreman/docs/INTERNALS.md", content: "Control flow lives in extensions/foreman/index.ts." }],
  }),
  [],
  "line anchors in changed/updated paths normalize before drift detection",
);
assert.deepEqual(
  drift.detectLikelyStaleDocs({
    changedCodePaths: ["extensions/foreman/index.ts"],
    updatedDocPaths: [],
    docFiles: [{ path: "extensions/foreman/docs/INTERNALS.md", content: "Reviewer helpers live in extensions/foreman/reviewer.ts." }],
  }),
  [],
  "unreferenced changed code path is not flagged",
);
assert.equal(drift.isForemanDocumentationPath("docs/architecture.md"), true, "top-level docs path is allowed documentation");
assert.equal(drift.isForemanDocumentationPath("extensions/foreman/docs/INTERNALS.md"), true, "extension docs path is allowed documentation");
assert.equal(drift.isForemanDocumentationPath("extensions/foreman/index.ts"), false, "code path is not documentation");

assert.match(docErPrompt, /^name: doc-er$/m, "doc-er crew name is declared");
assert.match(docErPrompt, /^model: cliproxy\/claude-opus-4-8:medium$/m, "doc-er uses Opus medium: reliable tool-calling (Gemini flaked the doc-er tool loop) but a lighter thinking budget than the high judges, since writing docs needs reliability not deep reasoning");
assert.match(docErPrompt, /^tools: read, grep, find, ls, bash, edit, write$/m, "doc-er has docs-editing tools but no foreman/AskUserQuestion");
assert.match(docErPrompt, /Write ONLY under `docs\/` and `extensions\/\*\/docs\/`/, "doc-er prompt enforces docs-only writes");
assert.match(docErPrompt, /NEVER touch `AGENTS\.md`/, "doc-er prompt forbids AGENTS.md");
assert.match(docErPrompt, /NEVER edit code/, "doc-er prompt forbids code edits");
assert.match(docErPrompt, /DOC-ER: UPDATED <paths>/, "doc-er prompt declares UPDATED machine line");
assert.match(docErPrompt, /DOC-ER: NONE <reason>/, "doc-er prompt declares NONE machine line");

assert.match(foremanIndex, /runDocErStage\(/, "orchestrator has a doc-er stage helper");
assert.match(foremanIndex, /runAgentWithTimeout\([\s\S]*?\"doc-er\"[\s\S]*?\)/, "doc-er is invoked through runAgentWithTimeout with timeoutRole doc-er");
assert.match(foremanIndex, /type: "doc_er_result"/, "doc-er outcome is recorded to the ledger");
assert.match(foremanIndex, /type: "doc_drift_checked"/, "drift detector result is recorded to the ledger");
assert.match(foremanIndex, /doc-er exited \$\{docRun\.exitCode\}/, "doc-er non-zero exit degrades to a soft NONE outcome");
assert.match(foremanIndex, /docOutcome\.timeout\.timedOut/, "doc-er timeout has explicit graceful degradation");
assert.match(foremanIndex, /state\.state = "awaiting_ship"/, "Gate 2 awaiting transition still exists after soft doc-er stage");
assert.match(foremanIndex, /Documentation:\\n\$\{docGate2Lines\}/, "Gate 2 emit surfaces doc-er/drift status");
assert.doesNotMatch(foremanIndex, /doc_er_result[\s\S]{0,400}done_blocked/, "doc-er result is not wired as a strict DoD blocker");

console.log("Foreman doc-er/drift helper tests passed");
NODE
