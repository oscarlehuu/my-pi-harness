# Plan: Phase B — Planner role for the Foreman orchestrator. Add a read-only planner crew agent; wire it into Gate 1 with fallback to template; parse/persist PLAN-JSON; render founder-facing plan with summary/steps/risks/proposed gates; write proposed .pi/foreman.json only on Gate 1 approval when absent; factor pure helper(s) into planner module and add planner_test.sh covering manifest decision/render/validation plus keep existing tests passing. Follow constraints: no ActivityPhase/dashboard/schema/gates.ts changes; planner read-only; fallback must keep gate_flow_test/gate working when model unavailable.

- Working directory: /Users/a1241968/Desktop/Oscar/my-pi-harness
- Track: backend
- Per-round command gates: verify (`bash extensions/foreman/test/planner_test.sh && bash extensions/foreman/test/gates_test.sh && bash extensions/foreman/test/fallback_test.sh && bash extensions/foreman/test/ledger_test.sh && bash extensions/foreman/dashboard/test/reader_test.sh`)
- Developer: openai-codex/gpt-5.5:xhigh implements; controller runs per-round command gates (exit code = ground truth).
- Tester: cliproxy/claude-opus-4-8:high judges intent and catches cheats.
- Up to 3 fix rounds, then escalate.

