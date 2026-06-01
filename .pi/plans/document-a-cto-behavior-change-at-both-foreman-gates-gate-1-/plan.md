# Plan: Document a CTO behavior change: at BOTH Foreman gates (Gate 1 plan, Gate 2 ship), the CTO must present an AskUserQuestion dialog for Approve/Revise instead of only printing the raw `foreman({ resume: true, approve: true })` commands. DOC-ONLY change to the charter files. (repo: my-pi-harness, extension: extensions/foreman)

WHY: Today when Foreman pauses at a gate, the CTO (main pi session) relays the gate by printing the approve/revise command text and the founder types `foreman({ resume: true, approve: true })`. The founder wants a click-based AskUserQuestion dialog instead. This is a CTO-behavior/charter change — NOT a foreman code change (foreman's gate machinery, persistence, and resume-across-sessions stay exactly as-is; the dialog lives in how the CTO relays the gate).

EXACT MECHANIC TO DOCUMENT (this is the new standing behavior):
- When `foreman` returns a Gate 1 (plan) pause OR a Gate 2 (ship) pause, the CTO calls the AskUserQuestion tool with a single-select question:
  - header: "Gate 1" (plan) or "Gate 2" (ship)
  - question: a short relay of what's being decided (the plan summary at Gate 1; the DoD/ship summary at Gate 2)
  - options: "Approve" (proceed) and "Revise" (send back with feedback). The founder may also type a custom free-text answer, which is treated as Revise feedback.
- The CTO then TRANSLATES the founder's answer into the existing foreman call:
  - "Approve" -> foreman({ resume: true, approve: true })  (plus slug when needed)
  - "Revise" / custom free-text -> foreman({ resume: true, reject: "<the founder's feedback>" })
- The foreman tool's gate contract is UNCHANGED — AskUserQuestion is only the CTO's relay surface; approve/reject still flow through foreman({ resume, approve|reject }). If no UI is available (headless), the CTO falls back to the plain command relay (AskUserQuestion already degrades in headless mode).

DELIVERABLES (edit these two files only):
1) extensions/foreman/AGENTS.md — in "The Foreman loop" section, update the gate-advance guidance (currently around step 4: "Advance a gate with foreman({ resume: true, approve: true }); revise with foreman({ resume: true, reject: '<feedback>' })"). Add that the CTO presents an AskUserQuestion (Approve/Revise) at BOTH Gate 1 and Gate 2 and translates the choice into that same foreman call. Keep the existing command syntax documented (it's the headless fallback + what AskUserQuestion maps to). Also reflect it briefly in the "When to talk to the founder" section if appropriate.
2) extensions/foreman/docs/CHARTER.md — in "The two gates" section/table, document the same: each gate is relayed to the founder via an AskUserQuestion (Approve/Revise), which the CTO translates into foreman({ resume:true, approve:true }) or foreman({ resume:true, reject:"…" }). Keep the table's existing approve/revise command columns as the underlying mechanism.

STRICT CONSTRAINTS:
- DOC-ONLY. Do NOT touch any .ts file, any crew/*.md, gates.ts/index.ts/ship.ts/done.ts/reviewer.ts/planner.ts, the dashboard, tests, or .pi/foreman.json. Only AGENTS.md and CHARTER.md change.
- Do NOT change the foreman tool's actual gate behavior or parameters — this only documents how the CTO relays gates. The approve/reject params and resume semantics are unchanged.
- Keep the edits tight and consistent with the existing doc voice; do not rewrite unrelated sections.
- The headless fallback (plain command relay when no UI) must be explicitly noted so the behavior is well-defined without a TTY.

VERIFY: this is a doc change; correctness is that the new guidance is present and accurate. The repo's per-round command gate (from .pi/foreman.json) will run the full test suite to prove no code regression. Additionally these assertions must hold (and are in the verify command): AGENTS.md and CHARTER.md each mention AskUserQuestion in a gate context, and no .ts/.pi/foreman.json files were modified by this task (git diff --name-only shows only the two doc files).

End with the mandatory DEV-JSON machine block.

## Summary (planner)
DOC-ONLY change to two foreman charter files documenting a new CTO relay behavior: at BOTH Foreman gates (Gate 1 plan, Gate 2 ship) the CTO presents an AskUserQuestion (Approve/Revise, free-text treated as Revise) and translates the answer into the UNCHANGED foreman({ resume:true, approve:true }) or foreman({ resume:true, reject:'<feedback>' }) call; plain command relay is the explicit headless fallback. Foreman's gate machinery, params, persistence, and resume semantics are untouched. Only AGENTS.md and CHARTER.md change.

## Steps
1. Edit extensions/foreman/AGENTS.md '## The Foreman loop' step 4 (AGENTS.md:88): document that the CTO presents an AskUserQuestion at BOTH Gate 1 and Gate 2 (header 'Gate 1'/'Gate 2'; question = short relay of the plan summary / DoD-ship summary; options Approve and Revise; custom free-text = Revise feedback) and translates the choice into the same foreman call — Approve -> foreman({ resume:true, approve:true }) (plus slug when needed), Revise/free-text -> foreman({ resume:true, reject:'<feedback>' }). Keep the existing command syntax as what AskUserQuestion maps to AND the headless fallback (note AskUserQuestion degrades to plain command relay when no UI/TTY).
2. Briefly reflect the AskUserQuestion relay in AGENTS.md '## When to talk to the founder' Gate-approval bullet (AGENTS.md:101) without rewriting the section.
3. Edit extensions/foreman/docs/CHARTER.md '## The two gates' (CHARTER.md:81): add prose/note that each gate is relayed to the founder via an AskUserQuestion (Approve/Revise) which the CTO translates into foreman({ resume:true, approve:true }) or foreman({ resume:true, reject:'…' }); keep the table's existing Approve/Revise command columns as the underlying mechanism; explicitly note the plain-command headless fallback.
4. Keep edits tight and in the existing doc voice; do not touch any .ts, crew/*.md, dashboard, tests, .pi/foreman.json, or unrelated sections.
5. Self-verify: confirm both docs mention AskUserQuestion in a gate context and git diff --name-only shows only the two doc files (no .ts / .pi/foreman.json).

## Files likely
- `extensions/foreman/AGENTS.md`
- `extensions/foreman/docs/CHARTER.md`

## Risks
- Scope creep into foreman code/behavior: STRICT doc-only — must not edit any .ts, crew/*.md, gates.ts/index.ts/ship.ts/done.ts/reviewer.ts/planner.ts, dashboard, tests, or .pi/foreman.json.
- Must NOT alter foreman's gate contract/params/resume semantics; AskUserQuestion is only the CTO relay surface, approve/reject still flow through foreman.
- Headless behavior must stay well-defined: explicitly document the plain command relay fallback when no UI/TTY is available.
- Working tree already has unrelated .pi/plans/*.jsonl + state.json churn from prior runs; the no-modification assertion targets *.ts and .pi/foreman.json (and crew), which this task leaves untouched, so the gate's git diff check is scoped to those paths.
- proposedGates mirror the existing .pi/foreman.json gates exactly (verified all referenced test scripts and planner.md exist); not overwriting or copying the legacy controller-fallback command.

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
