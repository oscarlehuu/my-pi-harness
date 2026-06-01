# Plan: Dynamic activity-based planner timeout for Foreman (replace the fixed 30s wall-clock cap). TIMEOUT ONLY — do NOT change any model, reasoning level, or crew file. (repo: my-pi-harness, extension: extensions/foreman)

PROBLEM (diagnosed from ledger evidence): the Foreman planner ALWAYS falls back to the template plan. Every plan.meta.json records `source: "fallback", note: "planner timed out after 30000ms"`. The latest captured planner transcript shows it running cliproxy/claude-opus-4-8:xhigh, doing real read-only recon (10 tool calls), ALREADY EMITTING TEXT, then SIGTERM-aborted at exactly 30.011s (stopReason "aborted", exitCode 143) before finishing its ---PLAN-JSON--- block. The planner is healthy; the FIXED 30s wall-clock timeout in index.ts kills it mid-work. The reasoning level is NOT the cause and must NOT be touched.

Current code (extensions/foreman/index.ts):
  const PLANNER_TIMEOUT_MS = Math.max(1000, Number(process.env.FOREMAN_PLANNER_TIMEOUT_MS ?? 30000) || 30000);
and inside draftPlannerPlan() a single `setTimeout(() => { timedOut = true; controller.abort(); }, PLANNER_TIMEOUT_MS)` that aborts the planner regardless of whether it is actively making progress.

GOAL: make the planner timeout DYNAMIC — never kill a planner that is actively working, only one that has genuinely stalled — with an absolute backstop so a pathological tool-loop can't run forever.

REQUIRED CHANGES:

1) extensions/foreman/index.ts — replace the single fixed wall-clock planner timeout with TWO bounds:
   a) IDLE timeout: abort the planner only if NO activity has occurred for `idleMs` (default 45000). "Activity" = any transcript event from the planner subprocess (tool_call, tool_result, text/message events — every place runAgent writes a transcript line). The idle timer RESETS on each activity, so a planner that keeps making tool calls / emitting tokens is never killed.
   b) ABSOLUTE backstop: regardless of activity, abort after `maxMs` (default 300000 = 5 min).
   - Env-overridable: idle via `FOREMAN_PLANNER_IDLE_MS`, absolute via `FOREMAN_PLANNER_MAX_MS`. BACK-COMPAT: the legacy `FOREMAN_PLANNER_TIMEOUT_MS`, if set and FOREMAN_PLANNER_IDLE_MS is absent, becomes the idle value. Clamp idle>=1000, max>=idle.
   - WIRING: add an OPTIONAL `onActivity?: () => void` to RunAgentOptions and call it wherever runAgent writes a transcript line (appendTranscript site). ONLY the planner path passes onActivity; developer/tester/reviewer calls omit it and are byte-for-byte unchanged. Use onActivity to reset an idle timer; keep a separate absolute timer for maxMs. On abort, set the fallback note to "planner idle-timed-out after <idleMs>ms (no activity)" or "planner hit max runtime <maxMs>ms" accordingly.
   - Replace the old PLANNER_TIMEOUT_MS constant with the resolver below. Preserve the fallback-to-template behavior EXACTLY: any planner failure/timeout still falls back to the template plan and NEVER blocks Gate 1.

2) PURE testable helpers in extensions/foreman/planner.ts (node-builtins only; it already exists):
   - decidePlannerTimeout({ now, startedAt, lastActivityAt, idleMs, maxMs }) => { abort: boolean, reason: "idle" | "max" | null }. If BOTH bounds are exceeded, prefer reason "max" (document precedence; check max first).
   - resolvePlannerTimeouts(env) => { idleMs, maxMs }: pure function of an env-like object (no global process.env reads inside). Defaults idle=45000, max=300000. FOREMAN_PLANNER_IDLE_MS / FOREMAN_PLANNER_MAX_MS override. Legacy FOREMAN_PLANNER_TIMEOUT_MS sets idle only when FOREMAN_PLANNER_IDLE_MS is absent. Clamp idle>=1000; if max<idle raise max to idle.

STRICT CONSTRAINTS:
- TIMEOUT ONLY. Do NOT modify extensions/foreman/crew/planner.md or ANY crew file. Do NOT change any model or reasoning level anywhere. (A verify gate greps planner.md to assert it still says claude-opus-4-8:xhigh.)
- Minimal blast radius: do NOT change the ActivityPhase union, ledger schema/Handoff type, gates.ts, guard.ts, reviewer.ts, or the dashboard.
- onActivity is OPTIONAL; dev/tester/reviewer behavior is byte-for-byte identical.
- Quota safety: planner still spawned via the append-only runAgent path; no replace-style system prompt.
- Planner stays read-only and still falls back to the template plan on any error/timeout (Gate 1 never blocks).
- Keep ALL existing test suites passing.

TEST (create + verify target): extensions/foreman/test/planner_timeout_test.sh — headless node test (style of planner_test.sh/gates_test.sh), importing the pure helpers from planner.ts:
- decidePlannerTimeout: (a) idle exceeded, total under maxMs => reason "idle"; (b) max exceeded with recent activity => reason "max"; (c) neither => { abort:false, reason:null }; (d) BOTH exceeded => reason "max" (precedence).
- resolvePlannerTimeouts: defaults 45000/300000; IDLE/MAX env overrides; legacy FOREMAN_PLANNER_TIMEOUT_MS sets idle and is overridden by FOREMAN_PLANNER_IDLE_MS when both present; clamps (idle>=1000; max raised to idle when smaller).
Also run the existing suites so nothing regressed.

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
- verify (per-round command) — command: `bash extensions/foreman/test/planner_timeout_test.sh && bash extensions/foreman/test/planner_test.sh && bash extensions/foreman/test/reviewer_test.sh && bash extensions/foreman/test/gates_test.sh && bash extensions/foreman/test/guard_test.sh && bash extensions/foreman/test/fallback_test.sh && bash extensions/foreman/test/ledger_test.sh && bash extensions/foreman/dashboard/test/reader_test.sh && grep -q "claude-opus-4-8:xhigh" extensions/foreman/crew/planner.md`

## Proposed manifest
- Planner fallback/invalid output is not eligible to create .pi/foreman.json.

## Execution
- Working directory: /Users/a1241968/Desktop/Oscar/my-pi-harness
- Track: backend
- Developer: openai-codex/gpt-5.5:xhigh implements; controller-owned gates remain ground truth.
- Tester: cliproxy/claude-opus-4-8:high judges intent and catches cheats.
- Up to 3 fix rounds, then escalate.
