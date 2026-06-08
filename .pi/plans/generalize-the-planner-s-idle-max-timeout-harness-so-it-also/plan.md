# Plan: Generalize the planner's idle/max timeout harness so it also guards the developer, ui-developer fallback, tester, and reviewer runAgent calls in extensions/foreman/index.ts.

PROBLEM: Only the planner (draftPlannerPlan, ~index.ts:697-765) currently has an AbortController + heartbeat timeout (idle 90s / max 300s via resolvePlannerTimeouts + decidePlannerTimeout + the onActivity heartbeat runAgent already exposes). The other four crew runAgent call sites await the pi subprocess indefinitely:
- developer: index.ts:1539
- ui-developer fallback: index.ts:1569
- tester: index.ts:1685
- reviewer (pre-ship judge gate): index.ts:1834
A hung subprocess (esp. the reviewer pre-ship judge) can today only be killed by founder Esc. This is the known "reviewer gate can hang" footgun.

REQUIREMENTS:
1. Extract the existing planner timeout mechanism (AbortController + idle/max timers + onActivity heartbeat + decidePlannerTimeout) into ONE reusable helper that wraps runAgent and returns a result plus a timeout outcome ({ timedOut, reason } where reason is "idle"|"max"|null).
2. Apply that helper to developer, ui-developer fallback, tester, and reviewer.
3. Graceful degradation on timeout (NEVER hang):
   - developer/ui-developer timeout -> treat the round as a failed dev attempt, feed a clear "implementer timed out (idle/max)" note back into the next round's devContext (respecting maxRounds).
   - tester timeout -> treat as a non-success verdict (fail) so the loop retries or escalates, with the timeout noted in the handoff/log; do NOT silently convert to success.
   - reviewer timeout -> treat as inconclusive (decision "unknown"/flagged), same path as the existing flaky-parse case (proceed to Gate 2 flagged, do NOT reopen forever, do NOT auto-approve).
   - Keep planner unchanged behaviorally: still falls back to the deterministic template plan on timeout.
4. Config: reuse the FOREMAN_*_MS env-var pattern. Keep planner's existing vars working. Add per-role idle/max envs with sensible defaults (developer may be longer than tester/reviewer). Centralize defaults so they're easy to see.
5. Record timeouts to the ledger log (a "<role>_timed_out" event with reason) and the activity note, mirroring how the planner already annotates its fallback.

CONSTRAINTS:
- Keep runAgent itself a thin transport; put the timeout orchestration in the wrapper, not baked into runAgent's stream loop.
- Do not change crew .md files or models.json. Do not touch unrelated code.
- Preserve the append-only system prompt / quota safety behavior.

TESTS: Extend the headless pattern in extensions/foreman/test/planner_timeout_test.sh (pure data-layer, no pi/agents) to cover the generalized helper's decision function for the new roles, including the degradation mapping (tester timeout -> fail, reviewer timeout -> inconclusive/flagged). The existing .pi/foreman.json per-round verify gate already runs the full test suite.

## Summary (planner)
Generalize the planner's idle/max timeout harness into one reusable runAgent wrapper (AbortController + idle/max timers + onActivity heartbeat + shared decide function) and apply it to developer, ui-developer fallback, tester, and reviewer in extensions/foreman/index.ts, with graceful per-role degradation (dev->failed round note, tester->fail, reviewer->inconclusive/flagged), centralized per-role FOREMAN_*_MS config, and ledger+activity timeout annotations. Planner behavior is preserved; pure decision/config helpers stay headlessly testable.

## Steps
1. Generalize the pure timeout layer in planner.ts: add resolveAgentTimeouts(role, env) backed by a centralized per-role defaults table (FOREMAN_<ROLE>_IDLE_MS/_MAX_MS), keeping resolvePlannerTimeouts and decidePlannerTimeout exports working unchanged; add small pure degradation-mapping helpers returning {event,reason,note,degrade} for developer/tester/reviewer.
2. Extract index.ts:697-765 into one runAgentWithTimeout(agent, task, cwd, options, timeouts) helper returning {run, timedOut, reason}, composing the external founder-Esc signal and using onActivity for the heartbeat; keep runAgent itself a thin transport with its single centralized onActivity call site untouched.
3. Add a centralized AGENT_TIMEOUTS map near index.ts:78 (planner/developer/tester/reviewer) and route planner through the wrapper so it still falls back to the deterministic template plan on timeout.
4. Wrap developer (index.ts:1539) and ui-developer fallback (index.ts:1569) with the developer budget; on timeout route to the failed-round devContext rebuild with an 'implementer timed out (idle/max)' note and continue, respecting maxRounds and skipping verify/tester for the hung implementer.
5. Wrap tester (index.ts:1685); on timeout force successState 'fail' (never silently success), note it in the handoff/log, and let the existing fail path feed back to the developer.
6. Wrap reviewer (index.ts:1834) with the reviewer budget; on timeout synthesize decision 'unknown' so it flows through decideReviewOutcome -> proceed-but-flagged (same flaky-parse path), avoiding reopen-forever and auto-approve.
7. Record each timeout via writeActivity note and appendLog({type:'<role>_timed_out', round, reason}), mirroring the planner fallback annotation.
8. Extend extensions/foreman/test/planner_timeout_test.sh to cover resolveAgentTimeouts per-role defaults/env overrides and the degradation mapping (tester->fail, reviewer->inconclusive/flagged), preserving existing planner assertions and the single-heartbeat grep.
9. Run the verify gate (full headless suite) and confirm green.

## Files likely
- `extensions/foreman/index.ts`
- `extensions/foreman/planner.ts`
- `extensions/foreman/test/planner_timeout_test.sh`

## Risks
- RunAgentOptions.role is planner|developer|tester only (reviewer collapses to tester); timeout-role must be passed separately or the wrong per-role budget is selected.
- Developer timeout must skip verify/tester and route to the failed-round rebuild without double-incrementing the round or skipping a handoff/log, and must still terminate at maxRounds (rounds_exhausted).
- Tester timeout must force fail even when verifyExit===0, otherwise the existing 'command gates passed -> success' branch would wrongly ship a hung verdict.
- Reviewer timeout maps to flagged via decision 'unknown'; if an aborted runAgent returns exitCode 0 the wrapper must set 'unknown' explicitly rather than relying on a non-zero exit (needs confirming runAgent's abort exitCode/marker).
- Must preserve existing planner_timeout_test.sh assertions (resolvePlannerTimeouts/decidePlannerTimeout exports and exactly one onActivity call site) or the verify gate breaks.
- Degradation/config helpers must stay free of fs/pi imports to remain headlessly unit-testable, matching planner.ts's pure-layer boundary.
- Centralizing in planner.ts vs a new pure module (e.g. agent_timeouts.ts) is a judgment call; chose least-churn extension of planner.ts to avoid touching unrelated wiring.

## Requirements
### Env vars/secrets
- ✗ FOREMAN_PLANNER_IDLE_MS — Existing planner idle-timeout override; must keep working.
- ✗ FOREMAN_PLANNER_MAX_MS — Existing planner max-runtime override; must keep working.
- ✗ FOREMAN_PLANNER_TIMEOUT_MS — Legacy planner idle alias; preserve back-compat.
- ✗ FOREMAN_DEVELOPER_IDLE_MS — New per-role developer idle override (longer default than tester/reviewer).
- ✗ FOREMAN_DEVELOPER_MAX_MS — New per-role developer max-runtime override.
- ✗ FOREMAN_TESTER_IDLE_MS — New per-role tester idle override.
- ✗ FOREMAN_TESTER_MAX_MS — New per-role tester max-runtime override.
- ✗ FOREMAN_REVIEWER_IDLE_MS — New per-role reviewer idle override (pre-ship judge hang guard).
- ✗ FOREMAN_REVIEWER_MAX_MS — New per-role reviewer max-runtime override.
### CLI tools/binaries
- ✓ node — Headless tests run via 'node --input-type=module' with top-level await/ESM imports.
- ✓ bash — Test harness scripts (*.sh) and the verify gate are bash.
- ✓ pi — runAgent spawns the pi subprocess at runtime (via piInvocation); not needed for the pure data-layer tests.

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
