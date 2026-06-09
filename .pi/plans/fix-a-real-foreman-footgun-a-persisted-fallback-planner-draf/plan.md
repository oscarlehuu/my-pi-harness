# Plan: Fix a real Foreman footgun: a persisted FALLBACK planner draft is reused instead of re-running the planner, so once the planner falls back (timeout/invalid PLAN-JSON), fixing the cause and resuming never re-runs the planner — it keeps serving the stale template plan. This bit us twice this session.

ROOT CAUSE (verified): in index.ts the planning branch (around index.ts:1691-1695) does `const drafted = persisted ? persisted : await draftPlannerPlan(...)`. readPersistedPlannerDraft (index.ts:945) returns ANY persisted draft including ones with source "fallback". So a previously-persisted fallback draft short-circuits a real planner re-run. See extensions/foreman/docs/INTERNALS.md for the planner/Gate-1 flow.

FIX (founder-approved approach — implement this, do not re-litigate):
- Only reuse a persisted draft when it is a REAL planner plan (source === "planner"). If the persisted draft is a fallback (source === "fallback"), do NOT short-circuit: re-run draftPlannerPlan so a fixed planner gets a fresh chance. (PersistedPlannerDraft already carries a `source` field — confirm via readPersistedPlannerDraft / the PersistedPlannerDraft type in planner.ts.)
- Keep behavior identical for the normal case: a real "planner" draft is still reused (no needless re-runs), and a brand-new task with no persisted draft still drafts once.
- The freshly re-run draft (whether it comes back "planner" or "fallback" again) must still be persisted via writePersistedPlannerDraft as today, so a subsequent resume is consistent.
- Do NOT change the Gate-1-approved path or any post-approval logic; this only affects which draft is shown at the planning gate.

EDGE CASES:
- If the planner re-runs and falls back AGAIN, that's fine — it persists the new fallback and shows it; we simply don't want a STALE fallback to permanently block a real re-run.
- Must not introduce an infinite loop: re-running on fallback happens only when the planning branch is entered (a resume/new invocation), not in a tight loop.

TESTS:
- Add/extend a headless test (planner_test.sh or a small dedicated test that the .pi/foreman.json verify gate runs) asserting the reuse predicate: a persisted draft with source "planner" is reused; a persisted draft with source "fallback" is treated as absent (triggers a re-draft). If the decision is inlined in index.ts, extract a tiny pure predicate (e.g. shouldReusePersistedDraft(draft): boolean) into planner.ts so it is headlessly testable, and grep-assert index.ts uses it at the planning branch.
- Preserve ALL existing tests.

CONSTRAINTS:
- Keep planner.ts pure/node-builtin-only. Minimal change to index.ts (only the planning-branch reuse decision).
- Do not touch models.json, the gate engine, ledger schema, or the dev/test/review loop.
- This is exactly the kind of internals change INTERNALS.md documents — the doc-er stage should update INTERNALS.md (the planner/Gate-1 flow section) to note that only source:"planner" drafts are reused.

VERIFY: the .pi/foreman.json per-round gate runs the full headless suite; keep everything green.

## Summary (planner)
Fix the stale-fallback planner reuse footgun: at the Gate-1 planning branch (index.ts:1691-1694) any persisted draft short-circuits draftPlannerPlan, so a persisted source:'fallback' draft permanently blocks a real planner re-run. Add a pure shouldReusePersistedDraft(draft) predicate in planner.ts that only reuses source:'planner' drafts; wire it into the single planning-branch decision so fallback drafts trigger a fresh draftPlannerPlan while real planner drafts are still reused and brand-new tasks still draft once. The re-run result is persisted as today. Extend planner_test.sh to unit-test the predicate and grep-assert index.ts uses it; doc the rule in INTERNALS.md.

## Steps
1. Confirm PersistedPlannerDraft.source semantics: index.ts:934 type (Extract<PlannerSource,'planner'|'fallback'>) and readPersistedPlannerDraft default-to-'fallback' at index.ts:967; PlannerSource exported at planner.ts:31.
2. Add pure, node-builtin-only shouldReusePersistedDraft(draft: { source?: PlannerSource } | null | undefined): boolean to planner.ts returning draft?.source === 'planner' (structural shape avoids importing the index.ts type; keeps planner.ts import-pure).
3. Import shouldReusePersistedDraft from ./planner.ts in index.ts (existing planner import block at index.ts:64-69).
4. Rewrite only the planning-branch reuse decision (index.ts:1691-1694): reuse persisted only when shouldReusePersistedDraft(persisted) is true; otherwise (no draft, or source==='fallback') await draftPlannerPlan(...). Leave writePersistedPlannerDraft (index.ts:1709) and renderFounderPlan wiring unchanged.
5. Do NOT touch the Gate-1 approve branch (index.ts:1672-1675) or any post-approval/intent logic (index.ts:1748-1749).
6. Extend extensions/foreman/test/planner_test.sh: assert shouldReusePersistedDraft({source:'planner'})===true, ({source:'fallback'})===false, and null/undefined/missing-source===false; add a grep-assert that index.ts references shouldReusePersistedDraft at the planning branch.
7. Doc-er: update extensions/foreman/docs/INTERNALS.md Gate-1 flow (around INTERNALS.md:44) to state only source:'planner' drafts are reused and a persisted fallback re-runs draftPlannerPlan.
8. Run the per-round verify gate (full headless suite) and keep everything green.

## Files likely
- `extensions/foreman/planner.ts`
- `extensions/foreman/index.ts`
- `extensions/foreman/test/planner_test.sh`
- `extensions/foreman/docs/INTERNALS.md`

## Risks
- Task says PersistedPlannerDraft 'in planner.ts' but the interface actually lives in index.ts:934 (only PlannerSource is in planner.ts); the predicate will accept a structural { source?: PlannerSource } shape to keep planner.ts pure and avoid importing the index type.
- readPersistedPlannerDraft coerces unknown/legacy-wrapped source to 'fallback' (index.ts:967), so legacy drafts now correctly trigger a re-draft instead of being reused — intended by the fix but a behavior change for pre-source drafts; note in tests.
- Must keep the reuse decision a single site; accidental change to the approve branch or intent-load (readPersistedPlannerDraft at index.ts:1672/1748) would regress Gate-1 — scope strictly to index.ts:1691-1694.
- No infinite loop: re-draft fires once per planning-branch entry (resume/new invocation), which ends by emitting the approval prompt and returning; verified the branch is not inside the round loop.
- If draftPlannerPlan itself depends on host/pi APIs it cannot move to planner.ts — only the boolean predicate is extracted, so planner.ts purity is preserved.
- planner.ts is import-pure (header at planner.ts:4); the new predicate adds no fs/pi imports.

## Requirements
### CLI tools/binaries
- ✓ node — headless tests run via `node --input-type=module` and import .ts modules directly (native TS type-stripping)
- ✓ bash — verify gate and all *_test.sh runners are bash scripts
- ✓ grep — verify gate begins with a grep assertion on planner.md and tests grep index.ts source
- ✓ git — release-stage commit action gate operates on the repo

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
