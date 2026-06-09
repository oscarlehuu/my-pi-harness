# Plan: Create an agent-friendly code-level internals doc for the Foreman extension so crew agents (and future maintainers) can extend index.ts without re-reading all ~2000 lines. This is the "doc nền" / backfill: it establishes both the baseline architecture knowledge AND the section format that a future doc-er stage will maintain in place.

DELIVERABLE: a new file extensions/foreman/docs/INTERNALS.md — a code-level map of the Foreman implementation (NOT a rewrite of the framework-level CHARTER.md, which already covers "what Foreman is" — this is "how the code is laid out and how to change it safely").

SCOPE / what to document (read the real code; cite file:line where it helps an agent navigate):
1. Module map: one line each for index.ts, planner.ts, gates.ts, reviewer.ts, ship.ts, done.ts, ledger.ts, engagement.ts, guard.ts, fallback.ts, agent-timeouts.ts, dashboard/reader.ts, dashboard/view.ts — what each owns. Note that index.ts is the orchestrator and the others are pure/testable helpers.
2. The control flow inside index.ts: where the round loop lives (while state.round < maxRounds), the order developer -> per-round command gates -> tester -> pre-ship (command gates + reviewer judge) -> Gate 2 -> release, and roughly where each lives (function/line anchors that are stable enough to be useful).
3. Key crew-invocation seams an extender will touch: runAgent (thin transport) vs runAgentWithTimeout (timeout wrapper), the per-role AGENT_TIMEOUTS, and how onActivity drives the idle heartbeat.
4. How founder-approved context flows to crew: formatResolvedDecisions (escalation answers) and formatIntentContract (Gate-1 understanding/assumptions/non-goals) are injected into BOTH devContext (re-attached every round inside the loop) and testerTask. Call out the critical invariant: the fail-retry rebuild of devContext REPLACES it wholesale, so any per-round injected context MUST be re-attached inside the loop, not only in the initial literal.
5. The escalation machinery: escalate_question (FOREMAN_CREW=1) -> pending question -> state "awaiting_decision" -> resume({answer}) folds into resolvedDecisions. This is the reusable pause/resume channel.
6. The gate pipeline + DoD: .pi/foreman.json gates (kind command|judge|action, stage per-round|pre-ship|release), exit code = ground truth, strict DoD requires a clean reviewer APPROVE (no force-ship bypass).
7. Extension recipes ("to add X, touch Y"): e.g. "to inject new founder-approved context into the crew, add a pure formatter in planner.ts and re-attach it beside formatResolvedDecisions in the round loop AND in testerTask"; "to add a new timeout-guarded crew role, add it to AGENT_TIMEOUTS and call runAgentWithTimeout"; "to add a gate, declare it in .pi/foreman.json".
8. Invariants / footguns an agent MUST respect (NEVER list): crew cliproxy agents use append-only system prompts (quota safety) — never replace with --system-prompt; planner.ts/gates.ts/etc must stay pure/node-builtin-only (headlessly testable); commit gate stages only filesChanged + ledger, never git add -A; extractJsonBlock must tolerate prose mentions of the markers.

FORMAT (agent-friendly first, human-friendly second):
- Stable, machine-scannable section headers (an explicit, predictable structure a future doc-er can update in place).
- Every non-obvious claim carries a file:line or function-name anchor.
- A short "Start here" pointer and a "NEVER do" boundaries section.
- Self-contained sections (mirror the CHARTER's "one concept = one section" rule).
- Lead each section with the actionable fact, not prose; keep it dense, no marketing.
- Add a one-line note at the top: this is the code-level internals map; CHARTER.md remains the framework kernel; AGENTS.md (continual-learning) holds learned process/preferences — keep those concerns separate.

CONSTRAINTS:
- This task ONLY creates extensions/foreman/docs/INTERNALS.md (and may add a one-line pointer to it from extensions/foreman/docs/CHARTER.md's "Docs structure" section IF it fits naturally). Do NOT modify index.ts or any other code. Do NOT touch AGENTS.md.
- Accuracy over completeness: every file:line / function reference must be verified against the actual code (read it; do not guess line numbers). If unsure of an exact line, cite the function name instead.
- Keep it maintainable: prefer function-name anchors over brittle exact line numbers where the function is easy to grep.

VERIFY: there is no code to unit-test here; the per-round command gate (full headless suite) must still pass unchanged (this task adds only a markdown doc, so the suite is unaffected). The reviewer will judge whether the doc is accurate against the code and genuinely useful for an agent extending Foreman.

## Summary (planner)
Create extensions/foreman/docs/INTERNALS.md: an agent-friendly, code-level internals map of the Foreman extension (module map, index.ts control flow, crew-invocation seams, founder-context flow + the re-attach invariant, escalation pause/resume channel, gate pipeline + strict DoD, extension recipes, and a NEVER-do boundaries section). Every non-obvious claim carries a verified file:line or function-name anchor. Optionally add a one-line pointer from CHARTER.md's 'Docs structure' section. Doc-only: no code touched; the per-round headless suite is unaffected.

## Steps
1. Create extensions/foreman/docs/INTERNALS.md with stable machine-scannable section headers, a one-line top note (code-level map; CHARTER=kernel; AGENTS=learned process), and a 'Start here' pointer.
2. Module map section: one line per file (index.ts orchestrator; planner/gates/reviewer/ship/done/ledger/engagement/guard/fallback/agent-timeouts + dashboard/reader+view as pure/testable helpers), each with a function-name or file:line anchor.
3. Control-flow section for index.ts: round loop while (state.round < state.maxRounds) at index.ts:1582; order developer (runAgentWithTimeout ~1610) -> per-round command gates (runCommandGates 'per-round' ~1752) -> tester (testerTask ~1776) -> pre-ship command gates + reviewer judge (~1869-2060) -> Gate 2 awaiting_ship (~2073) -> release action gates (~1573); Gate 1 at ~1394.
4. Seams section: runAgent (index.ts:236, thin transport) vs runAgentWithTimeout (index.ts:422, timeout wrapper), AGENT_TIMEOUTS (index.ts:88 from agent-timeouts.ts resolveAllAgentTimeouts), onActivity idle heartbeat (index.ts:336 + recordActivity in the wrapper).
5. Founder-context flow section: formatResolvedDecisions (index.ts:536) + formatIntentContract (planner.ts:348) injected into devContext (re-attached each round at index.ts:1605-1607) AND testerTask (index.ts:1776). Call out the invariant: fail-retry rebuilds devContext wholesale (e.g. index.ts:2106/1696), so per-round context MUST be re-attached inside the loop.
6. Escalation section: escalate_question registered only under FOREMAN_CREW=1 (index.ts:1149) -> writePendingQuestion -> state awaiting_decision -> resume({answer}) folds into state.resolvedDecisions (index.ts:1512). Reusable pause/resume channel.
7. Gate pipeline + DoD section: .pi/foreman.json gates (kind command|judge|action from gates.ts:13, stage per-round|pre-ship|release from gates.ts:14), exit code = ground truth, strict DoD requires clean reviewer APPROVE with no force-ship bypass (done.ts:45-98, index.ts ~1547).
8. Extension recipes section ('to add X, touch Y'): new founder-context formatter in planner.ts + re-attach beside formatResolvedDecisions in loop AND testerTask; new timeout-guarded role via AGENT_TIMEOUTS + runAgentWithTimeout; new gate declared in .pi/foreman.json.
9. NEVER-do boundaries section: append-only crew system prompts via --append-system-prompt (index.ts:258), never --system-prompt; planner/gates/etc stay pure/node-builtin-only (headlessly testable); commit gate stages only filesChanged + ledger, never git add -A (ship.ts:114 rejects -A); extractJsonBlock must tolerate prose marker mentions (index.ts:486).
10. Re-read every cited anchor to confirm accuracy; downgrade brittle line numbers to function-name anchors where the function is easy to grep.
11. If it fits naturally, add a single one-line pointer to INTERNALS.md in CHARTER.md's 'Docs structure' section (CHARTER.md:86-88).
12. Run the per-round command gate to confirm the headless suite still passes unchanged (doc-only change).

## Files likely
- `extensions/foreman/docs/INTERNALS.md`
- `extensions/foreman/docs/CHARTER.md`

## Risks
- Line numbers in index.ts (~2121 lines) can drift with future edits; mitigate by preferring function-name anchors over exact lines wherever the symbol is greppable, and cite ranges as approximate.
- CHARTER.md edit is conditional/optional per the task; will add only a single non-disruptive pointer line in the 'Docs structure' section, and skip it if it does not fit the one-concept-per-section rule.
- Hard constraint: must NOT modify index.ts (or any code) and must NOT touch AGENTS.md; this plan creates only the markdown doc (+ optional one-line CHARTER pointer).
- Accuracy risk if anchors are guessed; every file:line / function reference will be verified against the actual code before inclusion.
- No unit test exists for a markdown doc; correctness is judged by the reviewer against the code, so anchor accuracy and agent-usefulness are the real acceptance bar.

## Requirements
- (none detected)

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
