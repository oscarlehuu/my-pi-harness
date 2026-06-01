# Plan: Record WHY a task was allowed to commit: thread the Definition-of-Done checklist into (a) the auto-commit message body and (b) the done_evaluated ledger event. (repo: my-pi-harness, extension: extensions/foreman)

WHY: When Foreman auto-commits on Gate 2 approval, the commit message lists files + reviewer summary but does NOT state WHY the commit was permitted (which DoD checks passed). The done_evaluated log event only records { done:true, blockers:[] } — it drops the checklist. The founder wants the rationale recorded durably in BOTH places.

CONTEXT — READ FIRST (real recon):
- extensions/foreman/index.ts, the Gate 2 approve branch (around index.ts:1230-1256): it already computes `const doneness = evaluateCurrentDoneness(true)` and `const doneChecklist = renderDoneChecklist(doneness)`. On done=true it logs `appendLog(cwd, slug, { type: "done_evaluated", done: true, blockers: [] })` then calls `runReleaseActionGates({ cwd, slug, state, track, gates: releaseActionGates, signal })`. The `doneChecklist` string and `doneness` object are IN SCOPE here but are NOT passed to runReleaseActionGates and NOT included in done_evaluated.
- extensions/foreman/done.ts: `renderDoneChecklist(result)` returns the multi-line "Definition of Done:" block (✓/✗/⚠/– per check + Blockers line). `DonenessResult` = { done, blockers, checklist:[{name,status,detail}] }. Reuse these — do NOT change done.ts logic.
- extensions/foreman/ship.ts: `buildCommitMessage({ task, slug, track, filesChanged, reviewerSummary })` builds the conventional-commit message. It currently appends "Files changed:", "Shipped via Foreman (...)", and optional "Reviewer summary:". This is where the DoD block must be added.
- extensions/foreman/index.ts runReleaseCommitGate (around index.ts:850-875): calls buildCommitMessage({ task, slug, track, filesChanged, reviewerSummary }). This is the call site that must also pass the new doneSummary through.

DELIVERABLES:

1) ship.ts — extend buildCommitMessage to accept an OPTIONAL `doneSummary?: string` field on BuildCommitMessageInput. When present and non-empty, append it to the commit body (after the "Shipped via Foreman" line and Reviewer summary line), as its own block. Keep it deterministic and tidy: a blank line then the doneSummary verbatim (it is already a formatted "Definition of Done:" block). When absent, the message is byte-identical to today (backward-compatible). Keep subject + existing body composition unchanged.

2) index.ts — thread the DoD checklist from the Gate 2 approve branch down into the commit:
   - Add an optional field to the runReleaseActionGates input (and runReleaseCommitGate input) e.g. `doneSummary?: string`, and pass `doneChecklist` into it from the Gate 2 approve call.
   - In runReleaseCommitGate, pass that `doneSummary` through to buildCommitMessage({ ..., doneSummary }).
   - Plain ascii: when building the commit, the body should now contain the "Definition of Done:" block explaining why it was allowed to commit.

3) index.ts — enrich the done_evaluated log event so the rationale is persisted in the ledger too: change `appendLog(cwd, slug, { type: "done_evaluated", done: true, blockers: [] })` to include the full checklist, e.g. `{ type: "done_evaluated", done: true, blockers: doneness.blockers, checklist: doneness.checklist }`. (doneness is already in scope.) Do NOT change the done_blocked event shape beyond also optionally adding checklist if trivial — focus on done_evaluated carrying the checklist.

STRICT CONSTRAINTS:
- Minimal blast radius: only extensions/foreman/ship.ts and extensions/foreman/index.ts. Do NOT change done.ts logic, gates.ts, guard.ts, reviewer.ts, planner.ts, the ledger schema/Handoff type, the dashboard, crew/*.md, or .pi/foreman.json.
- buildCommitMessage with no doneSummary must be byte-identical to today (existing ship_test.sh assertions must still pass).
- The commit must still be best-effort (never reverse done) and safely scoped (resolveStagePaths unchanged). doneSummary only adds message body text — it must be passed as part of the argv -m body (no shell interpolation; the existing spawn-argv commit path is unchanged).
- Keep ALL existing suites passing.

TEST (update + verify target): extend extensions/foreman/test/ship_test.sh:
- buildCommitMessage WITH a doneSummary => body contains the "Definition of Done:" block text (assert the doneSummary string appears in the message, after the Shipped-via-Foreman line).
- buildCommitMessage WITHOUT doneSummary => body is unchanged (no "Definition of Done:" text); assert the prior expected message still holds (byte-identical/backward-compatible).
Also run ALL existing suites so nothing regressed (the per-round verify gate from .pi/foreman.json runs them).

Note in your handoff: this task itself, when it reaches Gate 2 and the founder approves, should produce an auto-commit whose message now contains the Definition of Done block — a live demonstration.

End with the mandatory DEV-JSON machine block.

## Summary (planner)
Thread the Definition-of-Done checklist into both the auto-commit message body and the done_evaluated ledger event. Extend buildCommitMessage (ship.ts) with an optional doneSummary appended verbatim after the Shipped-via-Foreman/Reviewer lines (backward-compatible when absent); thread doneChecklist from the Gate 2 approve branch through runReleaseActionGates -> runReleaseCommitGate -> buildCommitMessage; and enrich done_evaluated with doneness.blockers + doneness.checklist. Extend ship_test.sh to cover with/without doneSummary, then run all suites.

## Steps
1. ship.ts: add optional doneSummary?: string to BuildCommitMessageInput; in buildCommitMessage, after the optional 'Reviewer summary:' line, when doneSummary is present and non-empty push a blank line then the verbatim doneSummary block. No change to subject or existing body composition; absent doneSummary => byte-identical output.
2. index.ts (runReleaseCommitGate input ~line 826) and runReleaseActionGates input (~line 898): add optional doneSummary?: string. runReleaseActionGates already calls runReleaseCommitGate({ ...input, gate }) so the field threads automatically.
3. index.ts (~line 869-875): pass doneSummary: input.doneSummary into the buildCommitMessage({ task, slug, track, filesChanged, reviewerSummary }) call.
4. index.ts Gate 2 approve branch (~line 1254): pass doneSummary: doneChecklist into runReleaseActionGates({ cwd, slug, state, track, gates: releaseActionGates, signal }).
5. index.ts (~line 1250): change appendLog done_evaluated to { type: 'done_evaluated', done: true, blockers: doneness.blockers, checklist: doneness.checklist } (doneness already in scope).
6. ship_test.sh: add a buildCommitMessage WITH doneSummary case asserting the Definition-of-Done block text appears after the Shipped-via-Foreman line; add a WITHOUT case asserting no 'Definition of Done:' text and the prior expected body still holds.
7. Run the full verify suite plus the edited ship_test.sh and done_test.sh to confirm no regressions.

## Files likely
- `extensions/foreman/ship.ts`
- `extensions/foreman/index.ts`
- `extensions/foreman/test/ship_test.sh`

## Risks
- renderDoneChecklist emits unicode icons (checkmark/x/warn/dash); 'plain ascii' in the task refers to avoiding shell interpolation (the commit uses spawn argv -m subject -m body, unchanged), not stripping the block — the doneSummary is passed verbatim, which is safe.
- commitMessageParts trims and rejoins the body by lines; a multi-line doneSummary block is preserved as-is, but verify the trailing/leading blank-line handling keeps the block intact in body.
- appendLog is typed Record<string, unknown> with no ledger schema/Handoff type to update, so adding checklist is safe and within constraints; done_blocked is intentionally left unchanged (optional per task).
- The resolved per-round 'verify' gate does not itself include ship_test.sh or done_test.sh; those run via the controller/legacy fallback. Must run them explicitly to confirm the new assertions pass without altering .pi/foreman.json.
- Read-only recon: did not execute tests; assertions on exact byte-identical backward-compat are based on reading buildCommitMessage and the current ship_test.sh expectations.

## Proposed gates
- verify (per-round command) — command: `grep -q "claude-opus-4-8:xhigh" extensions/foreman/crew/planner.md && bash extensions/foreman/test/planner_timeout_test.sh && bash extensions/foreman/test/planner_test.sh && bash extensions/foreman/test/gates_test.sh && bash extensions/foreman/test/reviewer_test.sh && bash extensions/foreman/test/guard_test.sh && bash extensions/foreman/test/fallback_test.sh && bash extensions/foreman/test/ledger_test.sh && bash extensions/foreman/dashboard/test/reader_test.sh`
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
