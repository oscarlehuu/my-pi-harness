# Plan: Document the CTO's standing rule: at Gate 2 (ship), the CTO must always state WHY the task is allowed to commit (the Definition of Done rationale) before the founder approves. DOC-ONLY change to the charter files. (repo: my-pi-harness, extension: extensions/foreman)

WHY: Foreman now records the Definition of Done (DoD) rationale in both the auto-commit message and the done_evaluated ledger event. The founder also wants the CTO (main pi session) to ALWAYS relay that rationale in plain language at Gate 2 — i.e. tell the founder which DoD checks passed and therefore why a commit is permitted — as a standing behavior, not only when asked.

EXACT BEHAVIOR TO DOCUMENT (the new standing rule):
- When Foreman pauses at Gate 2 (ship) for a task, the CTO, before/with the AskUserQuestion Approve/Revise relay, explicitly states the Definition of Done status: which checks passed (plan approved, per-round command gates, tester success, pre-ship command gates if any, reviewer APPROVE if a reviewer gate is declared) and that the only remaining item is the founder's sign-off — i.e. WHY the task is eligible to commit. If any check is a blocker (e.g. an inconclusive reviewer verdict), the CTO states that the commit is WITHHELD and why.
- This pairs with what Foreman already does automatically: the DoD checklist is rendered at Gate 2, recorded in the done_evaluated log event (with the full checklist), and embedded in the auto-commit message body. The CTO's job is to relay that rationale conversationally so the founder always knows why a commit is (or is not) allowed.
- Keep it concise; this is the existing "talk to the founder at decision points" behavior, now with an explicit requirement to include the commit rationale at Gate 2.

DELIVERABLES (edit ONLY these two files):
1) extensions/foreman/AGENTS.md — in the gate/loop guidance and/or the "When to talk to the founder" section, add that at Gate 2 the CTO always states the Definition of Done rationale (why the commit is permitted, or why it is withheld) when relaying the ship gate via AskUserQuestion. Keep consistent with the recently-added AskUserQuestion relay guidance; do not rewrite unrelated sections.
2) extensions/foreman/docs/CHARTER.md — in "The two gates" and/or "Definition of Done" section, document the same standing rule: the CTO relays the DoD rationale at Gate 2 (the why-it-can-commit), consistent with the auto-commit message + done_evaluated event already carrying that checklist.

STRICT CONSTRAINTS:
- DOC-ONLY. Do NOT touch any .ts file, any crew/*.md, gates.ts/index.ts/ship.ts/done.ts/reviewer.ts/planner.ts, the dashboard, tests, or .pi/foreman.json. Only AGENTS.md and CHARTER.md change. (A prior task already wired the code; this task is purely the CTO-behavior documentation.)
- Do NOT change foreman tool behavior or params.
- Keep edits tight and in the existing doc voice; no unrelated rewrites.
- Keep ALL existing suites passing (this is a doc change; the per-round verify gate runs the suite to prove no regression).

VERIFY: doc accuracy. The assertions (in the verify command): AGENTS.md and CHARTER.md each mention the Definition of Done rationale at Gate 2 (grep for "Definition of Done" in both), and git diff --name-only shows only the two doc files among source (no .ts / .pi/foreman.json / crew changes). Plus the full existing test suite.

Note in your handoff: when this task reaches Gate 2 and the founder approves, the resulting auto-commit message should now contain the "Definition of Done:" block (the feature wired in the previous task, now live after restart) — a live demonstration that the rationale is recorded.

End with the mandatory DEV-JSON machine block.

## Summary (planner)
Doc-only change documenting the CTO's standing rule: at Gate 2 (ship), the CTO must always state the Definition of Done rationale (which checks passed → why a commit is permitted, or why it is withheld) when relaying the ship gate via AskUserQuestion. Edit ONLY extensions/foreman/AGENTS.md and extensions/foreman/docs/CHARTER.md, consistent with the already-wired DoD checklist that Foreman renders at Gate 2, logs in done_evaluated, and embeds in the auto-commit message. No .ts/crew/.pi/foreman.json/dashboard/test changes.

## Steps
1. AGENTS.md — in the Gate 2 bullet of 'The Foreman loop' (and/or the gate-4 AskUserQuestion relay paragraph) and the 'When to talk to the founder' section, add that at Gate 2 the CTO always states the Definition of Done rationale: which checks passed (plan approved, per-round command gates, tester success, pre-ship command gates if any, reviewer APPROVE if a reviewer gate is declared) and that only the founder's sign-off remains — i.e. WHY the commit is permitted; if a check is a blocker (e.g. inconclusive reviewer), state the commit is WITHHELD and why. Use the literal phrase 'Definition of Done'. Keep tight and consistent with existing AskUserQuestion relay voice.
2. CHARTER.md — in 'The two gates' (Gate 2 row / following paragraph) and/or the 'Definition of Done' section, document the same standing rule: the CTO relays the DoD rationale at Gate 2 conversationally (the why-it-can-commit, or why-withheld), consistent with the auto-commit message body and done_evaluated event already carrying that checklist. No unrelated rewrites.
3. Self-check the doc assertions locally: grep -q 'Definition of Done' in both files; confirm git diff --name-only shows no .ts/.pi/foreman.json/crew changes; sanity-run the existing suites the per-round gate covers.

## Files likely
- `extensions/foreman/AGENTS.md`
- `extensions/foreman/docs/CHARTER.md`

## Risks
- AGENTS.md currently uses 'DoD' not the literal 'Definition of Done'; the verify grep will fail unless the exact phrase is added there. CHARTER.md already has the heading so its grep passes — still add the standing-rule sentence.
- Scope discipline: must not touch any .ts (done.ts/index.ts/ship.ts/gates.ts/reviewer.ts/planner.ts), crew/*.md, dashboard, tests, or .pi/foreman.json. Code is already wired; this is purely CTO-behavior documentation.
- Working tree already has dirty .pi/plans/*/{log.jsonl,state.json} (normal ledger churn) and untracked plan dirs; the verify's git diff --name-only is scoped to '*.ts' '.pi/foreman.json' 'extensions/foreman/crew', so this churn won't fail the assertion — do not 'clean it up'.
- The task's described verify (doc grep + scoped diff + full suite incl. ship_test.sh/done_test.sh) is broader than the currently-resolved per-round 'verify' gate in .pi/foreman.json (which omits ship/done tests and adds the planner.md grep). I am reflecting the existing gates, not overwriting; the controller's verify exit code is ground truth at run time.
- Handoff note: when this task reaches Gate 2 and the founder approves, the resulting auto-commit message should now contain the 'Definition of Done:' block (wired in the prior task, live after restart) — a live demonstration that the rationale is recorded.

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
