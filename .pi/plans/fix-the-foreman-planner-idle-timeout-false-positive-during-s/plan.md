# Plan: Fix the Foreman planner idle-timeout false-positive during silent reasoning. The idle "activity" signal must count ANY model stream event (including reasoning/thinking), not just text deltas. (repo: my-pi-harness, extension: extensions/foreman)

PROBLEM (proven by transcript forensics, post-restart so the dynamic-timeout code IS live): the planner (cliproxy/claude-opus-4-8:xhigh) now runs long (a captured run went 117s, far past the old 30s cap — the dynamic timeout works) but was ABORTED with note "planner idle-timed-out after 45000ms (no activity)". The max inter-event gap in that transcript was EXACTLY 45.0s, occurring right before the abort, with final events "usage, tool_result, agent_end(aborted, exitCode 143)". Root cause: after ~14 tool calls the model entered a long SILENT final-reasoning burst to synthesize the plan. Reasoning/thinking tokens do NOT produce the transcript events that fire onActivity (only tool_call/tool_result and assistant text_delta do), so the idle timer counted the >45s think as "no activity" and killed the planner JUST BEFORE it emitted its ---PLAN-JSON--- block. The planner was working, not hung.

EVIDENCE about the code (read to confirm): in extensions/foreman/index.ts runAgent(), onActivity is invoked from appendTranscript() (the transcript writer). appendTranscript is called for: tool_call, tool_result, and assistant text via the `message_update` handler — BUT that handler only treats ev.assistantMessageEvent?.type === "text_delta" as activity. Other assistantMessageEvent/message_update subtypes (reasoning deltas, thinking, etc.) and other stream events do NOT currently fire onActivity. That is the blind spot.

GOAL: make the idle "activity" signal reflect that the model is genuinely alive/working — count ANY model stream event as activity, including reasoning/thinking — so a long silent reasoning burst does NOT trip the idle timeout. Keep the absolute max-runtime backstop as the real ceiling.

REQUIRED CHANGES (extensions/foreman/index.ts, surgical):

1) Decouple the idle "activity" heartbeat from transcript writing. Add a dedicated activity signal that fires on EVERY parsed stream event in runAgent's onLine handler (i.e. right after a line successfully JSON-parses into `ev`, call options.onActivity?.() once per event), REGARDLESS of event type. This guarantees reasoning/thinking deltas, message_update of any subtype, message_start/_end, tool events, usage events — anything the subprocess emits — all count as "the model is alive". 
   - Keep the existing appendTranscript-based transcript writing EXACTLY as-is for telemetry (do not change what gets written to transcripts). The change is ADDITIVE: onActivity should fire on all events, not only the ones that happen to be transcribed. Make sure onActivity is no longer ONLY reachable via appendTranscript — call it from the top of onLine for every event. (If you keep the appendTranscript call site too, ensure activity is not double-firing in a way that matters — idempotent heartbeat, so harmless; but prefer a single clear call at the top of onLine per parsed event.)
   - Do not let a malformed/unparseable line fire activity (only count successfully parsed events), so a stuck stream emitting garbage doesn't keep it alive forever — the absolute max backstop still applies regardless.

2) Defense-in-depth: raise the DEFAULT idle floor from 45000 to 90000 ms (FOREMAN_PLANNER_IDLE_MS still overrides; keep the legacy FOREMAN_PLANNER_TIMEOUT_MS alias; keep clamps idle>=1000, max>=idle; keep default max=300000). Update resolvePlannerTimeouts in extensions/foreman/planner.ts accordingly (default idle 90000) and its unit test expectations.

STRICT CONSTRAINTS:
- Minimal blast radius: only extensions/foreman/index.ts (runAgent onActivity wiring) and extensions/foreman/planner.ts (default idle 45000->90000) + its test. Do NOT change the model/reasoning level, the dynamic-timeout state-machine logic (decidePlannerTimeout stays as-is: idle/max precedence unchanged), runAgent's text/PLAN-JSON capture, gates.ts, guard.ts, reviewer.ts, ship logic, dashboard, or any crew/*.md.
- onActivity must remain OPTIONAL and only passed by the planner path; developer/tester/reviewer runs still omit it and are behaviorally identical (firing onActivity for them is a no-op since they don't pass it).
- The absolute max-runtime backstop (default 300000ms) MUST still abort a genuinely-stuck planner — verify the maxTimer is independent of activity.
- Fallback-to-template on any real timeout/error is preserved; Gate 1 never blocks.
- Keep ALL existing suites passing.

TEST (update + verify target): extend extensions/foreman/test/planner_timeout_test.sh (or its helpers) to assert:
- resolvePlannerTimeouts default idleMs is now 90000 (and max 300000); FOREMAN_PLANNER_IDLE_MS override still wins; legacy FOREMAN_PLANNER_TIMEOUT_MS still aliases idle; clamps still hold (idle>=1000; max>=idle).
- decidePlannerTimeout unchanged semantics: idle exceeded => "idle"; max exceeded (even with recent activity) => "max"; both => "max"; neither => no abort. (This proves the state machine is intact; the real activity-heartbeat wiring is integration-level and validated by the next live Gate 1 run, which the founder will observe.)
Run ALL existing suites in the verify command so nothing regressed. Also grep index.ts to assert onActivity is invoked in the onLine handler path (not only via appendTranscript) — e.g. assert the onLine handler calls onActivity for every parsed event.

Note in your handoff: full validation requires a live planner run at the next Gate 1 (founder will observe) — the planner should now survive its long final-reasoning burst and emit a real PLAN-JSON.

End with the mandatory DEV-JSON machine block.

## Summary (planner)
Fix the Foreman planner idle-timeout false-positive during silent reasoning. Decouple the idle activity heartbeat from transcript writing by firing options.onActivity?.() once per successfully-parsed stream event at the top of runAgent's onLine handler in extensions/foreman/index.ts, so reasoning/thinking deltas (and every other event type) count as 'the model is alive'. As defense-in-depth, raise the default idle floor from 45000ms to 90000ms in extensions/foreman/planner.ts. The absolute max-runtime backstop (300000ms) and decidePlannerTimeout precedence are unchanged; fallback-to-template on real timeout/error is preserved.

## Steps
1. Read runAgent() in extensions/foreman/index.ts (onLine ~283-348, appendTranscript ~218-221) and the planner timeout wiring (~615-650) to confirm onActivity flows only through the planner path and the maxTimer is activity-independent.
2. In onLine, immediately after the line JSON-parses into ev (after the try/catch that returns on malformed lines), add options.onActivity?.() so a heartbeat fires once per parsed event regardless of type; malformed lines still skip it.
3. Remove the onActivity?.() side-effect from appendTranscript so the heartbeat lives in one clear place (writeTranscript telemetry stays byte-for-byte identical); keep all appendTranscript transcript writes exactly as-is.
4. In extensions/foreman/planner.ts, change DEFAULT_PLANNER_IDLE_MS from 45_000 to 90_000; leave FOREMAN_PLANNER_IDLE_MS / legacy FOREMAN_PLANNER_TIMEOUT_MS aliasing, MIN_PLANNER_IDLE_MS clamp, DEFAULT_PLANNER_MAX_MS, and decidePlannerTimeout untouched.
5. Update extensions/foreman/test/planner_timeout_test.sh: change the default-timeouts assertion to expect idleMs 90_000 (max 300_000); keep override/alias/clamp and decidePlannerTimeout precedence assertions.
6. Add a grep-based assertion (in the timeout test or a small helper step) that index.ts invokes onActivity inside the onLine handler path (not only via appendTranscript), to lock in the heartbeat wiring.
7. Run the full resolved verify command so every existing suite passes; record the handoff noting live Gate 1 validation is required (founder will observe the planner surviving its long final-reasoning burst and emitting a real PLAN-JSON).

## Files likely
- `extensions/foreman/index.ts`
- `extensions/foreman/planner.ts`
- `extensions/foreman/test/planner_timeout_test.sh`

## Risks
- Heartbeat-on-every-event is intentionally broad; the absolute maxTimer (default 300000ms, activity-independent) remains the real ceiling and must still abort a genuinely-stuck planner — verify the maxTimer wiring is not touched.
- If the onActivity call in appendTranscript is kept alongside the new onLine call, the heartbeat double-fires for transcribed events; this is idempotent (just resets lastActivityAt) and harmless, but the plan prefers a single call at the top of onLine for clarity.
- Only the planner passes onActivity; must confirm developer/tester/reviewer runAgent calls remain behaviorally identical (firing onActivity is a no-op when undefined).
- Unit/integration coverage proves the state machine and default values; full validation of the silent-reasoning fix is integration-level and requires a live planner run at the next Gate 1, which the founder will observe (planner should survive its long final-reasoning burst and emit a real ---PLAN-JSON---).
- Strict blast-radius: no changes to model/reasoning level, decidePlannerTimeout precedence, PLAN-JSON capture, gates.ts, guard.ts, reviewer.ts, ship logic, dashboard, or crew/*.md.

## Proposed gates
- verify (per-round command) — command: `grep -q "claude-opus-4-8:xhigh" extensions/foreman/crew/planner.md && bash extensions/foreman/test/planner_timeout_test.sh && bash extensions/foreman/test/planner_test.sh && bash extensions/foreman/test/gates_test.sh && bash extensions/foreman/test/reviewer_test.sh && bash extensions/foreman/test/guard_test.sh && bash extensions/foreman/test/fallback_test.sh && bash extensions/foreman/test/ledger_test.sh && bash extensions/foreman/dashboard/test/reader_test.sh`

## Proposed manifest
- Will write proposed .pi/foreman.json only after Gate 1 approval.

## Execution
- Working directory: /Users/a1241968/Desktop/Oscar/my-pi-harness
- Track: backend
- Developer: openai-codex/gpt-5.5:xhigh implements; controller-owned gates remain ground truth.
- Tester: cliproxy/claude-opus-4-8:high judges intent and catches cheats.
- Up to 3 fix rounds, then escalate.
