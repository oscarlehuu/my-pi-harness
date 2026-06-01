# Plan: Fix the Foreman planner's output discipline so it RELIABLY emits its PLAN-JSON block instead of over-reconnoitering and stopping. PROMPT/CREW-FILE CHANGE ONLY — no orchestrator logic, no timeout, no model change. (repo: my-pi-harness, extension: extensions/foreman)

PROBLEM (confirmed by transcript forensics, not a guess): With the new dynamic timeout, the planner (cliproxy/claude-opus-4-8:xhigh) now runs to NATURAL completion — a captured run did 15 read-only tool calls over 55s (largest inter-event gap 7.3s, so NOT timed out; fallback note was "planner emitted invalid PLAN-JSON", not a timeout). But it spent every turn on interstitial narration ("I'll inspect...", "Let me check the planner.ts module style...", "Let me verify the dashboard test...") and STOPPED after recon WITHOUT ever emitting the ---PLAN-JSON--- block. So run.text had no parseable PLAN-JSON and the controller fell back to the template plan. Root cause = planner output discipline: it over-explores and never "lands the plane" by producing the machine block. The timeout fix, the runAgent text capture, and the PLAN-JSON parser are all CONFIRMED WORKING and must NOT be changed.

GOAL: make the planner (a) bound its recon, and (b) ALWAYS end its FINAL message with the PLAN-JSON block, even if recon is incomplete.

REQUIRED CHANGES (exactly two files; both are prompt text, no code logic):

1) extensions/foreman/crew/planner.md — strengthen the system prompt:
   - Add an explicit RECON BUDGET: instruct the planner to keep recon TIGHT — aim for roughly 6–10 tool calls, prioritize the few files that matter, and do NOT exhaustively read the whole repo. It should stop reconning as soon as it can write a useful plan.
   - Add a hard OUTPUT CONTRACT, stated assertively and placed prominently (both near the top AND right before the PLAN-JSON template): "Your FINAL message MUST contain the ---PLAN-JSON--- block. Do not end your turn after tool calls without emitting it. If recon is incomplete or uncertain, emit your BEST plan anyway with your current knowledge and note assumptions in risks — an imperfect PLAN-JSON is required; narration without the block is a FAILURE."
   - Instruct it to keep narration minimal: do recon, then immediately produce the founder-facing summary + the PLAN-JSON. No long thinking-out-loud between every tool call.
   - Keep everything else (read-only posture, gate schema, the exact PLAN-JSON keys + markers ---PLAN-JSON--- / ---END-PLAN-JSON---) IDENTICAL. Do not change the model line (stays cliproxy/claude-opus-4-8:xhigh) or tools line.

2) extensions/foreman/index.ts — in the plannerTaskFor() function ONLY (the string builder that creates the planner's per-task instruction), reinforce the same contract in the task message: add a final imperative line like "Keep recon tight (~6–10 tool calls). Your FINAL message MUST end with exactly one ---PLAN-JSON--- ... ---END-PLAN-JSON--- block containing summary, steps, filesLikely, risks, proposedGates — even if you must note assumptions in risks. Narration without the block is a failure." Do NOT change any other part of index.ts — not draftPlannerPlan, not the timeout logic, not runAgent, not the parser. Only the plannerTaskFor return string.

STRICT CONSTRAINTS:
- ONLY edit extensions/foreman/crew/planner.md and the plannerTaskFor() string in extensions/foreman/index.ts. Touch nothing else.
- Do NOT change: the model/reasoning level (planner stays opus-4-8:xhigh), the dynamic timeout, runAgent, validatePlannerPlan/parsePlannerPlanJson, gates.ts, guard.ts, reviewer.ts, ship logic, the dashboard, any other crew file.
- Do NOT weaken the read-only posture or the PLAN-JSON key/marker contract (the parser depends on the exact markers ---PLAN-JSON--- and ---END-PLAN-JSON--- and keys summary/steps/filesLikely/risks/proposedGates).
- Keep ALL existing test suites passing (this is a prompt change, so they should be unaffected).

VERIFY APPROACH: this is a prompt-quality change that a unit test can't directly assert (it depends on model behavior). So the verify command (below) (a) runs the full existing suite to prove no regression, and (b) asserts the prompt contract is present in the files via grep: planner.md must still contain "claude-opus-4-8:xhigh", the markers "---PLAN-JSON---" and "---END-PLAN-JSON---", and now also a recon-budget / "FINAL message MUST" style instruction; and index.ts plannerTaskFor must contain a "---PLAN-JSON---" reinforcement line. Do NOT add a new test file unless useful; rely on the existing suites + these greps.

After your change, briefly note in your handoff that real validation requires a live planner run at the next Gate 1 (which the founder will observe), since model behavior can't be unit-tested.

End with the mandatory DEV-JSON machine block.

## Summary (fallback)
Implement the requested task in /Users/a1241968/Desktop/Oscar/my-pi-harness using the backend track, then verify it through Foreman's deterministic dev/test loop.

## Steps
1. Confirm the relevant files and constraints before editing.
2. Developer implements the smallest scoped change and records a structured handoff.
3. Controller runs the resolved per-round command gates and treats their exit codes as ground truth.
4. Tester judges intent, catches cheats, and sends failures back for another bounded fix round.
5. If verification succeeds, pause at Gate 2 for founder ship approval.

## Files likely
- (not identified by planner)

## Risks
- Planner model output was unavailable or invalid, so this deterministic template plan was used.
- Repo-specific edge cases may still be discovered by the developer/tester loop.

## Proposed gates
- verify (per-round command) — command: `grep -q "claude-opus-4-8:xhigh" extensions/foreman/crew/planner.md && grep -q -- "---PLAN-JSON---" extensions/foreman/crew/planner.md && grep -q -- "---END-PLAN-JSON---" extensions/foreman/crew/planner.md && grep -qiE "FINAL message MUST|recon budget|6.10 tool calls|imperfect PLAN-JSON|narration without the block" extensions/foreman/crew/planner.md && grep -q -- "---PLAN-JSON---" extensions/foreman/index.ts && bash extensions/foreman/test/planner_test.sh && bash extensions/foreman/test/planner_timeout_test.sh && bash extensions/foreman/test/gates_test.sh && bash extensions/foreman/test/reviewer_test.sh && bash extensions/foreman/test/guard_test.sh && bash extensions/foreman/test/fallback_test.sh && bash extensions/foreman/test/ledger_test.sh && bash extensions/foreman/dashboard/test/reader_test.sh`

## Proposed manifest
- Planner fallback/invalid output is not eligible to create .pi/foreman.json.

## Execution
- Working directory: /Users/a1241968/Desktop/Oscar/my-pi-harness
- Track: backend
- Developer: openai-codex/gpt-5.5:xhigh implements; controller-owned gates remain ground truth.
- Tester: cliproxy/claude-opus-4-8:high judges intent and catches cheats.
- Up to 3 fix rounds, then escalate.
