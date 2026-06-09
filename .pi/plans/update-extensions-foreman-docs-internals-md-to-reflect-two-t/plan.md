# Plan: Update extensions/foreman/docs/INTERNALS.md to reflect two things the docs are currently stale on (the drift-detector flagged INTERNALS.md after the planner-reuse fix). This is a docs-only task; the doc-er stage at the end is expected to do most/all of the work, but the developer should also make the change so it ships even if doc-er degrades.

WHAT TO DOCUMENT (both are already true in the code — verify against it, cite anchors):

1. PLANNER DRAFT REUSE RULE (shipped in commit 444f6b5): At the Gate-1 planning branch, Foreman now only reuses a persisted planner draft when it is a REAL planner plan. The pure predicate shouldReusePersistedDraft(draft) in planner.ts returns draft?.source === "planner"; index.ts uses it at the planning branch (the `const drafted = shouldReusePersistedDraft(persisted) ? persisted : await draftPlannerPlan(...)` line). A persisted draft with source "fallback" is treated as absent so a fixed planner gets a fresh re-run; the re-run result is still persisted. Document this in the planner/Gate-1 flow section so future agents know a fallback draft does NOT permanently stick.

2. ADD-A-CREW-ROLE INSTALL STEP (a real footgun hit this session): when you add a NEW crew agent .md under extensions/*/crew/, it is NOT live until ./install.sh is re-run — install.sh symlinks each crew .md per-file into ~/.pi/agent/agents/, so a freshly added role (e.g. doc-er) throws ENOENT (no such file ~/.pi/agent/agents/<role>.md) until linked. Add this to the extension-recipes / NEVER-do (or a "gotchas") section: "Adding a crew role requires re-running ./install.sh before it can be spawned."

REQUIREMENTS:
- Update ONLY extensions/foreman/docs/INTERNALS.md (and you MAY update extensions/foreman/docs/CHARTER.md ONLY if a planner-reuse mention genuinely belongs there; otherwise leave CHARTER alone).
- Keep INTERNALS.md's existing structure and agent-friendly style (stable headers, file:line/function anchors, dense, NEVER-do where relevant). Update in place; do not restructure.
- Verify every anchor you add/change against the actual code (shouldReusePersistedDraft in planner.ts, its use in index.ts, the install.sh crew-linking loop). Prefer function-name anchors over brittle line numbers.
- Do NOT touch code, tests, AGENTS.md, or models.json.

VERIFY: docs-only change; the .pi/foreman.json per-round headless suite must stay green (it is unaffected by markdown). The doc-er stage should also run at the end now that it is linked — this task doubles as a live check that doc-er writes correctly.

## Summary (planner)
Docs-only update to extensions/foreman/docs/INTERNALS.md for two facts already true in code: (1) the Gate-1 planner-draft reuse rule (shouldReusePersistedDraft -> source==='planner'; fallback drafts treated as absent so a fixed planner re-runs, and the re-run is re-persisted, shipped in 444f6b5), correcting the now-stale Gate-1 anchors that the drift-detector flagged; and (2) a new footgun/gotcha that adding a crew role requires re-running ./install.sh (per-file symlink loop) before it can be spawned. Update in place, keep structure/agent-style, prefer function-name anchors. Leave CHARTER.md unchanged (reuse rule is internals, not framework contract). Developer makes the edits so they ship even if the soft doc-er stage degrades; doc-er at the end may refine.

## Steps
1. Re-confirm anchors (recon done): shouldReusePersistedDraft() at planner.ts:70-74 returns draft?.source === 'planner'; planning-branch use at index.ts:1687; re-run re-persisted via writePersistedPlannerDraft() at index.ts:1702; writeProposedManifestOnGate1Approval() def index.ts:1098 / call index.ts:1666-1669; install.sh crew-linking loop install.sh:48-53 calling link() (ln -s at install.sh:24); pi agents dir ~/.pi/agent/agents/*.md (install.sh:42).
2. In INTERNALS.md §02 module map (line 24) and §03 Gate-1 bullet (line 44): keep the existing prose, make explicit that a persisted source==='fallback' draft is treated as absent so a fixed planner gets a fresh re-run and the re-run result IS re-persisted (fallback does NOT permanently stick), and replace the stale Gate-1 line anchors (index.ts:1394 / 1403-1420 / 1429-1475) with verified function-name anchors (shouldReusePersistedDraft(), draftPlannerPlan(), writePersistedPlannerDraft(), writeProposedManifestOnGate1Approval()) plus current line backstops.
3. Add the add-a-crew-role install gotcha to §09 (NEVER boundaries / footguns), cross-referencing the §08 'add a new timeout-guarded crew role' recipe: state that a freshly added extensions/*/crew/<role>.md is NOT live until ./install.sh re-runs (it throws ENOENT on ~/.pi/agent/agents/<role>.md), anchored to the install.sh crew loop (install.sh:48-53) and link()/ln -s (install.sh:24).
4. Leave CHARTER.md unchanged: confirm no planner-reuse mention genuinely belongs in the framework/kernel contract (it is an implementation detail) and document that decision.
5. Verify: run the existing per-round verify gate command to confirm the headless suite stays green (markdown-only edit cannot affect it, and the planner.md grep check is untouched); confirm no edits to code, tests, AGENTS.md, or models.json; pre-ship reviewer + soft doc-er run at end (doc-er now linked = live check).

## Files likely
- `extensions/foreman/docs/INTERNALS.md`
- `extensions/foreman/planner.ts (read-only verify)`
- `extensions/foreman/index.ts (read-only verify)`
- `install.sh (read-only verify)`
- `extensions/foreman/docs/CHARTER.md (read-only; expected no change)`

## Risks
- The reuse-rule description already exists in §02/§03; the real drift is stale post-444f6b5 line anchors. Scope risk: avoid mass-fixing every stale anchor in the doc — limit anchor edits to the planner/Gate-1 reuse references and the new install gotcha, preferring function-name anchors to reduce future drift.
- Other unrelated stale anchors may exist (e.g. §05 readPersistedPlannerDraft cited at index.ts:681 vs actual index.ts:939); out of scope unless directly part of the reuse-rule references being touched — noted but not broadly refactored.
- Line-number anchors are brittle; mitigated by using file:functionName anchors per the doc's own maintenance rule.
- doc-er is newly symlinked this session; if it degrades the change still ships because the developer makes the edit (soft Gate-2 status only).
- Markdown-only change cannot break the headless suite, but the verify gate's `grep -q "claude-opus-4-8:xhigh" extensions/foreman/crew/planner.md` must stay true — unaffected by editing INTERNALS.md.

## Requirements
### Services/runtimes
- ? Node.js/TypeScript runtime — Foreman extension is TS; tests run under node
- ? pi CLI + model routing (cliproxy/Claude) — pre-ship reviewer and soft doc-er crew stages; existing infra, no new secrets

## Proposed gates
- verify (per-round command) — command: `grep -q "claude-opus-4-8:xhigh" extensions/foreman/crew/planner.md && bash extensions/foreman/test/planner_timeout_test.sh && bash extensions/foreman/test/planner_test.sh && bash extensions/foreman/test/gates_test.sh && bash extensions/foreman/test/reviewer_test.sh && bash extensions/foreman/test/docer_test.sh && bash extensions/foreman/test/guard_test.sh && bash extensions/foreman/test/fallback_test.sh && bash extensions/foreman/test/ledger_test.sh && bash extensions/foreman/dashboard/test/reader_test.sh`
- review (pre-ship judge) — agent: reviewer
- commit (release action) — action: `commit`

## Proposed manifest
- Existing .pi/foreman.json is present and will be preserved.

## Execution
- Working directory: /Users/a1241968/Desktop/Oscar/my-pi-harness
- Track: backend
- Developer: openai-codex/gpt-5.5:xhigh implements; controller-owned gates remain ground truth.
- Tester: cliproxy/claude-opus-4-8:high judges intent and catches cheats.
- Up to 3 fix rounds, then escalate.
