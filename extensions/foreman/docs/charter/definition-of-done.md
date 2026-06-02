# Definition of Done

Foreman's Definition of Done is strict and machine-evaluated. Gate 2 approval is necessary, but it
is not enough to override failed checks or ambiguous reviewer output.

## Six checks

A task is done only when all six checks pass or are explicitly not applicable:

1. **Plan approval** — Gate 1 was approved by the founder.
2. **Per-round command gates** — the latest per-round command gates passed, or the check is `n/a`
   because no per-round command gates ran.
3. **Tester judgment** — the latest tester verdict is `success`; `fail`, `partial`, `blocked`, or a
   missing verdict is not done.
4. **Pre-ship command gates** — declared pre-ship command gates passed, or the check is `n/a` because
   none were declared or ran.
5. **Reviewer gate** — if a pre-ship reviewer judge gate is declared, the latest reviewer verdict must
   cleanly be `APPROVE`. `REQUEST-CHANGES`, missing output, or inconclusive/unknown reviewer output
   blocks done. If no reviewer gate is declared, this check is `n/a`.
6. **Founder ship approval** — Gate 2 was approved by the founder.

## Blocking semantics

`done=true` only when there are no blockers. Foreman turns each failed check into a blocker and keeps
the task out of the `done` state until the blockers are resolved. An inconclusive reviewer verdict is
not silently treated as approval: it is surfaced as a warning/checklist item and blocks commit because
strict DoD requires a clean reviewer `APPROVE` whenever a reviewer gate is declared.

If Gate 2 is approved while blockers remain, Foreman withholds commit, keeps the task at Gate 2, and
reports the blockers. To rerun reviewer work, reject the ship gate with feedback that asks for a live
reviewer rerun; there is no force-ship bypass for strict DoD.

## Where the checklist is recorded

The full checklist is recorded in three places:

1. **CTO Gate 2 relay** — the CTO must state the DoD rationale in conversation before/with the
   `AskUserQuestion` Gate 2 approval prompt: which checks passed or are `n/a`, that founder sign-off
   is the only remaining item, or that commit is WITHHELD and why.
2. **Ledger event** — when Foreman marks the task done, it writes a `done_evaluated` event containing
   `done: true`, `blockers`, and the full `checklist` to `<repo>/.pi/plans/<slug>/log.jsonl`.
3. **Auto-commit message body** — when a release `commit` action gate is configured and runs, Foreman
   includes the rendered `Definition of Done:` block in the commit message body.

This makes ship rationale visible to the founder, durable in the task ledger, and attached to the git
history when release auto-commit is enabled.
