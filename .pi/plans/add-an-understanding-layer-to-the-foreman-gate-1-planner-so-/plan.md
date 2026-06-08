# Plan: Add an "understanding layer" to the Foreman Gate 1 planner so the orchestrator EXPOSES how it understood the task and its design thinking, for the founder to verify BEFORE any code runs. Alignment feature: surface assumptions, non-goals, alternatives, and blast-radius at Gate 1.

SCOPE (planner data-layer only — do NOT touch the dev/test/review loop, gates engine, ledger, or models.json):
Files: extensions/foreman/planner.ts, extensions/foreman/crew/planner.md, extensions/foreman/test/planner_test.sh

1. extensions/foreman/planner.ts — extend the PlannerPlan type with new OPTIONAL, back-compat fields (a plan missing them stays valid):
   - understanding: string (plain founder-facing restatement)
   - assumptions: Array of { text: string; confidence?: low|medium|high }
   - nonGoals: string[] (deliberately out of scope)
   - alternatives: Array of { approach: string; rejectedReason: string }
   - blastRadius: string[] (impact / dependents / where inconsistency could spread)
   Update validatePlannerPlan to normalize+validate these (drop malformed entries, never throw; missing becomes empty/undefined, NOT a rejection). Update fallbackPlannerPlan to emit sensible empty defaults. Update renderFounderPlan to render each as its own markdown section, only when it has content, leaving existing sections intact. Keep planner.ts pure / node-builtin-only, mirroring existing cleanStringList/normalize* style.

2. extensions/foreman/crew/planner.md — update the prompt + the PLAN-JSON contract block + example to require the new keys, instructing the planner to: restate the task in the founder's terms; explore >=2 approaches and record rejected ones with reasons; state assumptions with confidence and explicit non-goals; identify blast radius; and treat YAGNI/KISS/DRY/scale-maintain as a self-critique LENS (prefer simplest thing that works, justify added complexity, prefer reusing/editing existing code, name real tensions) NOT badges to stamp. Keep the HARD OUTPUT CONTRACT framing (still must emit a valid PLAN-JSON; an imperfect plan beats none).

3. extensions/foreman/test/planner_test.sh — extend the existing headless pure-data tests: validatePlannerPlan accepts a plan WITH the new fields, normalizes malformed entries (an alternative missing rejectedReason is dropped; a bad confidence value is coerced/dropped), and still accepts a plan WITHOUT them (back-compat); renderFounderPlan includes the new section headers when content is present and omits them when empty. IMPORTANT: preserve the existing extractJsonBlock regression test already in this file (do not remove or weaken it).

CONSTRAINTS:
- New PLAN-JSON fields are additive and OPTIONAL; no behavior change to gate execution or DoD.
- Keep the append-only crew prompt model intact.

VERIFY: the existing .pi/foreman.json per-round gate runs the full headless suite; all foreman tests must stay green.

## Summary (planner)
Add five optional, back-compat understanding-layer fields to the Foreman Gate 1 planner data-layer (planner.ts), require them in the planner prompt/contract (planner.md), and cover them in the headless planner test while preserving the extractJsonBlock regression.

## Steps
1. planner.ts: extend PlannerPlan with optional understanding:string, assumptions:Array<{text:string;confidence?:'low'|'medium'|'high'}>, nonGoals:string[], alternatives:Array<{approach:string;rejectedReason:string}>, blastRadius:string[].
2. planner.ts: add pure normalizers (normalizeAssumptions drops entries missing text and coerces/drops invalid confidence; normalizeAlternatives drops entries missing approach or rejectedReason) mirroring cleanStringList/normalizePlannerGates; reuse cleanString/isRecord/isNonEmptyString.
3. planner.ts: in validatePlannerPlan normalize the new fields to empty defaults (never throw, never reject when missing) like the always-present requirements field, keeping validate idempotent for round-trip.
4. planner.ts: in fallbackPlannerPlan emit sensible empty defaults for the new fields.
5. planner.ts: in renderFounderPlan add one markdown section per new field, rendered only when it has content, leaving existing sections intact.
6. crew/planner.md: update prompt + PLAN-JSON contract block + example to require the new keys (restate task, >=2 approaches with rejected reasons, assumptions w/ confidence, explicit non-goals, blast radius, YAGNI/KISS/DRY as self-critique lens) while keeping the HARD OUTPUT CONTRACT and append-only model intact; do not remove the model frontmatter line.
7. test/planner_test.sh: add assertions that validate accepts plans WITH the new fields, normalizes malformed entries (alternative missing rejectedReason dropped; bad confidence coerced/dropped), still accepts plans WITHOUT them, and that render includes new section headers only when content is present; KEEP the existing extractJsonBlock regression and model-line grep guard unchanged.
8. Run the full per-round verify suite to confirm all foreman tests stay green.

## Files likely
- `extensions/foreman/planner.ts`
- `extensions/foreman/crew/planner.md`
- `extensions/foreman/test/planner_test.sh`

## Risks
- Round-trip idempotency: validate(serialize(plan)) must equal validate(plan); use always-present empty defaults so the existing deepEqual round-trip test stays green.
- The verify gate greps planner.md for 'claude-opus-4-8:xhigh' and tools/model frontmatter lines are asserted in planner_test.sh — edits must be additive and not touch those lines.
- Existing extractJsonBlock 3-marker regression test must be preserved verbatim; weakening it fails the suite and the task intent.
- New render section header strings are author-chosen and must match exactly between renderFounderPlan and the new test assertions.
- Must stay pure/node-builtin-only in planner.ts and not touch index.ts, gates engine, ledger, or models.json (additive/optional fields only, no gate/DoD behavior change).

## Requirements
### CLI tools/binaries
- ✓ node — headless planner_test.sh runs via node --input-type=module
- ✓ bash — foreman test harness scripts are bash
- ✓ git — release-stage commit action gate

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
