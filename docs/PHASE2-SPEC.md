# Phase 2 Spec — The Loop Extension (v1, for approval)

One-page spec. Build only after founder approves. Grounded in real Factory CLI data
(read from oscars-macbook-pro `~/.factory/missions/`) + verified Phase 1 handshakes.

## Goal
A custom pi extension that turns the manual dev→test→fix loop (proven in Phase 1) into a
DETERMINISTIC, machine-enforced loop with an on-disk ledger + 2 gates. No slash command.
Reuses Phase 1's crew + subagent primitive — does NOT reimplement spawning.

## Reuse from Phase 1 (do not rebuild)
- subagent extension = the spawn primitive (loop calls it underneath)
- scout/developer/tester `.md` + routing (`:thinking` inline) = the crew, unchanged
- tester PASS/FAIL/partial verdict = the loop's decision signal
- append-only system prompt for cliproxy agents = inherited invariant (subscription quota safety)

## The ledger (in-repo, committed)
Location: `<repo>/.pi/plans/<task-slug>/` — one per repo at repo root (monorepo or not).
```
<repo>/.pi/plans/<task-slug>/
  state.json     { task, state, workingDirectory(relative), round, maxRounds,
                   lastReviewedHandoffCount, gate1Approved, gate2Approved }
  plan.md        approved plan (human-readable)
  tasks.json     [{ id, description, status, sessionIds[] }]   flat list, no milestones
  handoffs/      <ts>__<task>__<session>.json   one per worker run (retry history = multiple files)
  log.jsonl      append-only event stream
```
Git: harness auto-creates `.pi/.gitignore` →
```
.pi/*
!.pi/plans/
.pi/plans/*/transcripts/
.pi/plans/*/**/*.log
```
→ only `.pi/plans/` committed (survives machine moves); rest of `.pi/` + noisy artifacts ignored.

## Handoff schema (per run, from real Droid)
```
{ timestamp, workerSessionId, featureId(task), successState: success|partial|blocked,
  returnToOrchestrator,
  handoff: { salientSummary, whatWasImplemented, whatWasLeftUndone,
             verification: { commandsRun: [{command, exitCode, observation}] },
             discoveredIssues: [{severity, description, suggestedFix}] } }
```
tester writes this; `verification.commandsRun` + `discoveredIssues` = the fix channel back to dev.

## The loop (deterministic, machine-enforced)
```
start task → write state(in_progress) BEFORE action
LOOP (round = 1..maxRounds, default 3):
  developer implements (round 1) | applies discoveredIssues fixes (round >1)
  → write dev handoff
  tester runs verification, emits successState
  → write tester handoff, append log event
  successState == success  → task DONE, exit loop
  successState == partial  → escalate to founder (work done, off-scope blocker)
  successState == blocked   → STOP, escalate to founder
  FAIL/retry & round < max  → feed discoveredIssues to developer, round++
  round == max & not success → STOP, escalate to founder
```
Verdict is a FIELD (successState), not prose-parsed. Retry = same task re-run, not new task.

## Gates (conversational, not commands)
- GATE 1 (plan approval): after plan.md drafted, before loop starts. Founder yes → set gate1Approved, start.
- GATE 2 (ship): after task DONE, before declaring shipped/merge. Founder yes → set gate2Approved.

## Trigger (hybrid)
CTO starts a task via a loop tool (controls WHEN); the dev→test→fix retry inside is
machine-enforced (can't be skipped/forgotten). State written BEFORE every action.

## Resume (handoff cursor, from real Droid)
On "where were we?": read state.json → if task in_progress, read handoffs with index
> lastReviewedHandoffCount → reconstruct round/verdict → report to founder, offer to continue.
Cursor (not scan) = reliable mid-session jump, any machine that has the repo.

## What the extension ADDS (the only new code)
1. loop controller (round logic, verdict-driven retry, caps)
2. ledger read/write (state.json, tasks.json, handoffs/, log.jsonl, auto .gitignore)
3. the 2 gates (conversational hooks)
Everything else = call Phase 1 subagent primitive.

## Acceptance test (reuse Phase 1 rig)
Same broken-task handshake, but HANDS-OFF:
1. seed repo: broken add() + correct test
2. start task via loop tool
3. assert: MACHINE drives dev→test→fix, retries on FAIL, stops at PASS (not founder/CTO by hand)
4. assert: ledger written (.pi/plans/<task>/ with handoffs + log + state)
5. assert RESUME: kill mid-loop, restart, picks up from handoff cursor
6. assert quota-safe: cliproxy calls cost 0 (append-only prompt preserved)

## Locked decisions
1. 3-valued successState  2. handoff-cursor resume  3. separate handoff files
4. ledger in-repo `.pi/plans/<task>/`, one per repo root  5. only `.pi/plans/` committed
6. repo = project (no project slug)  7. fix = retry same task (cap 3)
8. trigger = hybrid  9. append-only prompt invariant  10. worktrees deferred

## Out of scope (dropped from Droid; YAGNI)
milestones, preconditions, VAL assertions, validation-contract/state, dual scrutiny+user-testing
gates, evidence/, worker-transcripts (committed), services.yaml, global cross-project dashboard,
worktrees/parallel workers.
```
