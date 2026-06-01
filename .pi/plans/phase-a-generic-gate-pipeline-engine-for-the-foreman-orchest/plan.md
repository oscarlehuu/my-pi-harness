# Plan: Phase A — Generic gate pipeline engine for the Foreman orchestrator (repo: my-pi-harness, extension: extensions/foreman).

GOAL: Replace the single `verifyCommand` model with a generic, ordered PIPELINE OF GATES so a project can declare multiple checks at different stages (e.g. "unit tests run every round, E2E runs once before ship"). The engine must stay dumb: it only runs commands (exit code = truth), asks judge agents, or performs actions — it does NOT hardcode what "unit" or "e2e" or "mobile" mean. The project declares which gates exist.

DATA MODEL (new module `extensions/foreman/gates.ts`, pure / node-builtins only so it is headlessly unit-testable, same style as fallback.ts):
- type GateKind = "command" | "judge" | "action"
- type GateStage = "per-round" | "pre-ship" | "release"
- interface Gate { name: string; kind: GateKind; stage: GateStage; command?: string; agent?: string; action?: string }
- loadGates(cwd, fallbackVerifyCommand?): Gate[]
  - Reads `<cwd>/.pi/foreman.json` if present: { "gates": Gate[] }. Validate shape; ignore/skip malformed entries defensively (do not throw on a bad file — return what is valid).
  - BACKWARD COMPAT (critical): if NO foreman.json exists, synthesize the legacy behavior — if fallbackVerifyCommand is provided, return a single gate { name:"verify", kind:"command", stage:"per-round", command: fallbackVerifyCommand }; if neither exists, return [].
- runCommandGates(gates, stage, cwd, signal?): runs every command-kind gate whose stage === stage, in declared order, via spawn (shell:true), capturing exit code + tail of output for each. Returns a structured result: { passed: boolean, results: Array<{ name, command, exitCode, output }> }. passed = every gate exited 0. Stop-on-first-failure is fine (document the choice).
- Helper selectors: gatesForStage(gates, stage), hasStage(gates, stage).

WIRE INTO `extensions/foreman/index.ts` (minimal blast radius):
- In the round loop, REPLACE the current single `runVerify(verifyCommand)` call with `runCommandGates(gates, "per-round", cwd, signal)`. The exit-code ground-truth semantics must be preserved exactly: any non-zero gate => the round is a fail (same as today's verifyExit !== 0 path). Feed the failing gate's name+output back to the developer in the existing fail-feedback context.
- Load gates once per task: `const gates = loadGates(cwd, state.verifyCommand ?? params.verifyCommand)`. Persist nothing new in the ledger for now beyond what already exists (gates are re-loaded from foreman.json each run).
- The tester judge step stays exactly as-is (it is the per-round judge). Do NOT implement reviewer or commit/action gates in this phase — but the engine's types and runner MUST already support "pre-ship" and "release" stages so phases C/D can populate them without re-architecting. It is fine if pre-ship/release are simply not invoked yet in index.ts (leave a clearly-commented TODO at the point where pre-ship gates would run, right before GATE 2).
- Keep the Gate 1 plan text honest: list the resolved per-round command gates (names) so the founder sees what will run.

STRICT CONSTRAINTS:
- Full backward compatibility. A task started the OLD way (`foreman({ task, verifyCommand })`, no foreman.json) must behave EXACTLY as before: that one command runs every round, exit code is ground truth. Do not break the existing gate_flow_test.sh contract.
- Do not change the ledger schema, the dashboard, or the developer/tester/ui-developer crew files in this phase.
- gates.ts must have NO imports from pi (`@earendil-works/...`) — node builtins only — so it imports cleanly in a headless node test.

TEST (must create, this is the verify target): `extensions/foreman/test/gates_test.sh` — a headless node test in the SAME style as extensions/foreman/test/fallback_test.sh (node --input-type=module, assert/strict, real tmp dirs). Cover:
1. loadGates with a real .pi/foreman.json returns the declared gates in order, correctly typed.
2. Backward compat: no foreman.json + a fallbackVerifyCommand => exactly one per-round command gate with that command; no foreman.json + no fallback => [].
3. Malformed foreman.json (bad JSON, or a gate missing required fields) does not throw and skips the bad parts.
4. gatesForStage / hasStage select correctly across per-round / pre-ship / release.
5. runCommandGates over two command gates: one `true` (exit 0) and one `false` (exit 1) => passed=false and the results array records both exit codes; an all-passing set => passed=true.

End with the mandatory DEV-JSON machine block.

- Working directory: /Users/a1241968/Desktop/Oscar/my-pi-harness
- Verify command: bash extensions/foreman/test/gates_test.sh && bash extensions/foreman/test/ledger_test.sh && bash extensions/foreman/test/fallback_test.sh && bash extensions/foreman/dashboard/test/reader_test.sh
- Developer: openai-codex/gpt-5.5:xhigh implements; controller runs verify (exit code = ground truth).
- Tester: cliproxy/claude-opus-4-8:high judges intent and catches cheats.
- Up to 3 fix rounds, then escalate.

