# Plan: Make the Gate-1 understanding layer flow DOWN to the crew: after Gate 1 approval, inject the founder-approved understanding / assumptions / non-goals from the persisted plan into the developer and tester prompts, so the crew implements and judges against the SAME intent the founder confirmed — instead of each crew member re-deriving intent from the raw task string. This closes the loop on the understanding layer (currently it dies at Gate 1; the crew never sees it).

CONTEXT (verified):
- The persisted plan lives at plan.json and is read via readPersistedPlannerDraft(cwd, slug) (index.ts ~680). Its PlannerPlan now carries optional understanding/assumptions/nonGoals/alternatives/blastRadius (planner.ts).
- devContext is initialized at index.ts ~1479 as `Implement this task in ${cwd}:\n${state.task}` (+ gate info). The developer currently gets ONLY the task string.
- testerTask is built at index.ts ~1769 as `Judge whether the work ... satisfies this task: ${state.task} ...`. The tester currently gets ONLY the task string.
- There is already a precedent for injecting founder-approved context into BOTH prompts: formatResolvedDecisions(state.resolvedDecisions) is appended to devContext (decisionsForDev) and testerTask (decisionsForTester). Mirror that exact pattern.

REQUIREMENTS:
1. Add a pure helper in planner.ts (headlessly testable, node-builtin-only, mirroring existing render* style), e.g. `formatIntentContract(plan: PlannerPlan): string` that renders a COMPACT crew-facing block from ONLY the founder-relevant, crew-actionable fields: understanding, assumptions (with confidence), and nonGoals. Deliberately EXCLUDE steps/risks/filesLikely/blastRadius/alternatives (those are founder-facing planning detail, not crew execution intent — keep the prompt lean). Return "" when none of the three fields have content (back-compat: a plan/fallback without them injects nothing).
2. In index.ts, after Gate 1 is approved and the persisted plan is available, read the plan via the existing readPersistedPlannerDraft and compute the intent block ONCE. Inject it:
   - into the INITIAL devContext (index.ts ~1479), clearly framed, e.g. a "Founder-approved intent (build to THIS):" section, so the developer builds to the confirmed understanding and respects non-goals.
   - into testerTask (index.ts ~1769), framed so the tester judges against the confirmed intent AND treats non-goals correctly: do NOT FAIL the work for deliberately-omitted non-goal items.
   Use the same lazy/append style as formatResolvedDecisions so it composes with the existing decisions block and the fail-retry devContext rebuilds don't lose it (the round loop rebuilds devContext on fail — make sure the intent block is reapplied or persists across rounds, mirroring how decisionsForDev is re-attached each round).
3. Keep it OPTIONAL and safe: if there is no persisted plan (legacy path), or the plan has no understanding-layer content, behavior is unchanged (inject nothing). Never throw if plan.json is missing/corrupt — readPersistedPlannerDraft already returns null on failure; handle null.
4. Crew prompt awareness (light touch): in developer.md and tester.md, add a short line acknowledging that when a "Founder-approved intent" block is present, it is the source of truth for what to build/judge and that non-goals are intentionally out of scope. Keep the append-only crew prompt model; do not restructure these files.

TESTS (extend the headless pattern):
- In planner_test.sh: cover formatIntentContract — renders understanding + assumptions(with/without confidence) + nonGoals when present; returns "" when all three empty; excludes steps/risks/blastRadius/alternatives even when those are populated.
- In planner_test.sh or a comment-guard in planner_test.sh: assert index.ts injects the intent block into BOTH devContext and testerTask (grep the wiring, mirroring how existing tests grep for extractJsonBlock usage), and that it is re-attached on fail-retry rounds.
- Preserve ALL existing tests (extractJsonBlock regression, model-line grep, render section tests, reviewer/tester budget tests).

CONSTRAINTS:
- Do NOT change the gates engine, ledger schema, models.json, or the dev/test/review control flow beyond adding the injection.
- planner.ts stays pure/node-builtin-only. No new persisted artifact — reuse plan.json.
- Keep the injected block COMPACT (token-aware): understanding + assumptions + non-goals only, not the whole plan.

VERIFY: the existing .pi/foreman.json per-round gate runs the full headless suite; all foreman tests must stay green.

## Summary (planner)
Flow the Gate-1 founder-approved understanding/assumptions/non-goals down to the crew: add a pure formatIntentContract(plan) helper in planner.ts and inject its compact output into the developer's devContext and the tester's testerTask after Gate 1 approval, mirroring the existing formatResolvedDecisions injection so the crew builds and judges against the confirmed intent (and does not fail work for deliberately-omitted non-goals). Optional and back-compatible: legacy/no-plan and content-free plans inject nothing.

## Steps
1. planner.ts (~line 343, beside renderFounderPlan): add pure formatIntentContract(plan: PlannerPlan): string rendering ONLY understanding + assumptions (with optional confidence, reusing hasContent) + nonGoals; return "" when all three are empty; deliberately exclude steps/risks/filesLikely/blastRadius/alternatives. Stays node-builtin-only.
2. index.ts (import block ~60-68): add formatIntentContract to the existing ./planner.ts import.
3. index.ts (~1477-1479, after the state.gate1Approved check and before devContext init): read the persisted plan via readPersistedPlannerDraft(cwd, slug) (null-safe; on null inject nothing) and compute the intent contract ONCE.
4. index.ts (round loop ~1599, where decisionsForDev is re-attached): frame the dev block as 'Founder-approved intent (build to THIS):' and append it to devContext alongside decisionsForDev each round, so the fail-retry devContext rebuild (~2097) never drops it; the initial round-1 devContext (~1479) thereby also carries it.
5. index.ts (~1768-1776, testerTask): lazily append the intent block (mirroring decisionsForTester) framed so the tester judges against the confirmed intent AND does NOT FAIL the work for deliberately-omitted non-goal items.
6. crew/developer.md and crew/tester.md: append one short line each acknowledging that a present 'Founder-approved intent' block is the source of truth for what to build/judge and that non-goals are intentionally out of scope (append-only; no restructure).
7. test/planner_test.sh: add formatIntentContract cases (renders understanding + assumptions with/without confidence + nonGoals; returns "" when all three empty; excludes steps/risks/blastRadius/alternatives even when populated) and grep-wiring asserts that index.ts injects the intent block into BOTH devContext and testerTask and re-attaches it on fail-retry rounds, mirroring the existing extractJsonBlock grep style; preserve all existing assertions.
8. Run the existing per-round verify gate (full headless suite) and confirm all foreman tests stay green.

## Files likely
- `extensions/foreman/planner.ts`
- `extensions/foreman/index.ts`
- `extensions/foreman/crew/developer.md`
- `extensions/foreman/crew/tester.md`
- `extensions/foreman/test/planner_test.sh`

## Risks
- The tester-FAIL devContext rebuild at index.ts:2097 (and the pre-ship/timeout/decision rebuilds at ~1496/1513/1531/1689/1914/2019) replace devContext wholesale; the intent block must be re-attached inside the round loop (like decisionsForDev at ~1599), not only in the initial literal at ~1479, or it is lost after round 1.
- Back-compat: formatIntentContract must return "" for fallback/legacy plans lacking understanding-layer content, and readPersistedPlannerDraft returns null on missing/corrupt plan.json — both must inject nothing and never throw.
- Compactness/token budget: the block must include only understanding/assumptions/nonGoals (asserted by new exclusion tests); do not leak steps/risks/blastRadius/alternatives.
- Must not disturb existing planner_test.sh assertions (extractJsonBlock regression, model-line grep, render section tests) or the gates/ledger/reviewer/fallback/guard suites run by the verify gate.
- Read-only recon: cited line numbers are approximate and may shift slightly during implementation.

## Requirements
### CLI tools/binaries
- ✓ node — runs the headless planner_test.sh harness (node --input-type=module) imported by the verify gate
- ✓ bash — executes the per-round verify gate test scripts
- ✓ grep — verify gate greps planner.md and the new tests grep index.ts wiring

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
