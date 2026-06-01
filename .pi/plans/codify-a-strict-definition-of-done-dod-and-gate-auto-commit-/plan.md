# Plan: Codify a strict Definition of Done (DoD) and gate auto-commit on it; then activate auto-commit in this repo. (repo: my-pi-harness, extension: extensions/foreman)

WHY: Phase D made Gate 2 approval auto-commit (release action gate). But "done" is currently just "founder approved" — there is no codified rule. Now that done COMMITS CODE, it must be a single machine-checked rule. The founder's decision: STRICT — when a reviewer gate is declared, the task is DONE (and may auto-commit) only if the reviewer cleanly APPROVED. An inconclusive/unknown reviewer verdict means NOT done: withhold the commit and surface it.

CONTEXT — READ FIRST (real recon):
- extensions/foreman/index.ts — the Gate 2 approve path at the `else if (params.approve)` branch under `state.state === "awaiting_ship"` (around index.ts:1177-1189). Today it sets state="done", logs gate2_approved + task_done, then runs release action gates unconditionally. Also note: the per-round loop already guarantees only green-or-yellow tasks REACH awaiting_ship (a tester `fail` retries; a pre-ship command-gate failure or reviewer REQUEST-CHANGES reopens a dev round). So at Gate 2 the hard checks are already satisfied EXCEPT the reviewer-UNKNOWN case, which currently proceeds "flagged".
- How verdicts are recorded in log.jsonl (read these event types): `verdict` (per-round tester: has successState), `verify_ran` (per-round command gates: has exitCode/gates[]), `pre_ship_command_gates_ran` (has passed + gates[]), `pre_ship_reviewer_verdict` (has decision: approve|request-changes|unknown, gate, agent), `pre_ship_passed`, `pre_ship_failed`, `gate1_approved`. The DoD evaluator reads the ledger state + the latest relevant log events — do NOT add new ledger schema fields.
- extensions/foreman/reviewer.ts (parseReviewVerdict/decideReviewOutcome) and gates.ts (gatesForStage, Gate kinds/stages) and ship.ts (decideShipCommit) — the pure-helper pattern to mirror. The DoD helper is pure and headless-testable like these.
- extensions/foreman/ledger.ts — LedgerState shape (gate1Approved, gate2Approved, state, round, verifyCommand). readState/appendLog/taskDir helpers.

DELIVERABLES:

1) NEW pure module extensions/foreman/done.ts (node-builtins only, NO pi imports, headless-testable):
   - export interface DoneCheck { name: string; status: "pass" | "fail" | "warn" | "n/a"; detail: string }
   - export interface DonenessResult { done: boolean; blockers: string[]; checklist: DoneCheck[] }
   - export function evaluateDoneness(input: {
       gate1Approved: boolean;
       gate2Approved: boolean;                 // founder approval (may be the in-flight approval being evaluated)
       latestTesterState?: "success"|"partial"|"blocked"|"fail";   // from the last `verdict` event
       perRoundCommandGatesPassed?: boolean;   // last verify_ran exitCode===0 (undefined if none ran)
       preShipCommandGatesPassed?: boolean;    // last pre_ship_command_gates_ran.passed (undefined if none declared)
       reviewerGateDeclared: boolean;          // is there a stage:pre-ship kind:judge gate?
       reviewerDecision?: "approve"|"request-changes"|"unknown";   // latest pre_ship_reviewer_verdict.decision (undefined if none)
     }): DonenessResult
     RULES (STRICT) — done=true ONLY if ALL hard checks pass:
       - gate1Approved must be true (else blocker "plan not approved").
       - perRoundCommandGatesPassed: if defined it must be true; if undefined that's status "n/a" (no command gates) — not a blocker by itself (tester judgment covers it).
       - latestTesterState must be "success" (anything else => blocker). 
       - preShipCommandGatesPassed: if defined must be true; undefined => "n/a".
       - reviewer: if reviewerGateDeclared is true, reviewerDecision MUST be "approve" (status pass). "request-changes" => blocker (shouldn't reach here, but treat as not-done). "unknown"/undefined-while-declared => status "warn" AND a blocker "reviewer verdict inconclusive — strict DoD requires a clean APPROVE". If reviewerGateDeclared is false => reviewer check status "n/a", not a blocker.
       - gate2Approved must be true (founder sign-off) for done.
     Build the checklist with one DoneCheck per dimension (plan, per-round gates, tester, pre-ship gates, review, founder approval), in that order. blockers = the human-readable reasons any hard check failed. done = blockers.length===0.
   - export function renderDoneChecklist(result: DonenessResult): string — a compact multi-line "Definition of Done" block (✓/✗/⚠/– per check + the blockers list) for the Gate 2 message.
   - Optionally a small helper to extract the DoD inputs from log events, BUT keep it pure: e.g. export function extractDonenessInputs(events: Array<Record<string,unknown>>, opts:{ gate1Approved:boolean; gate2Approved:boolean; reviewerGateDeclared:boolean }) that scans the events array (already-parsed log.jsonl lines) for the LAST `verdict`.successState, last `verify_ran`.exitCode, last `pre_ship_command_gates_ran`.passed, last `pre_ship_reviewer_verdict`.decision and returns the evaluateDoneness input object. Pure over an array — the controller reads log.jsonl and passes the parsed array in.

2) WIRE into index.ts Gate 2 approve path (minimal, surgical):
   - When params.approve at awaiting_ship: BEFORE committing, compute DonenessResult by reading the task's log.jsonl (parse lines into an array) + state flags + whether a reviewer gate is declared (gatesForStage(gates,"pre-ship").some(g=>g.kind==="judge")) + treating gate2Approved as true (the founder is approving now). 
   - If result.done === true: proceed exactly as today — set state="done", log gate2_approved/task_done, run release action gates (auto-commit). ADD the DoD checklist to the SHIPPED emit and a `done_evaluated` log event { done:true, blockers:[] }.
   - If result.done === false (i.e. a reviewer-UNKNOWN or some hard check unexpectedly unmet): DO NOT mark done, DO NOT run release/commit. Instead set state back to awaiting_ship (remain at the gate), log `done_blocked` { blockers }, and emit the DoD checklist + the blockers + an explicit instruction that the founder can either send it back (reject with feedback) or, to override, RE-RUN the live reviewer by reopening (since strict mode has no silent force — the founder must resolve the inconclusive review, not bypass it). Make the message clear and actionable. The commit must be WITHHELD in this case.
   - Keep everything else identical. Backward compat: a repo with NO reviewer gate and NO command gates but tester=success + gate1 + founder approval => done=true (reviewer check n/a) => behaves exactly like today (and gate_flow_test.sh must still pass).

3) ACTIVATE auto-commit + version the gate config in THIS repo:
   - Update .pi/.gitignore so .pi/foreman.json is NOT ignored (add `!foreman.json` after the `*` ignore, alongside the existing `!plans/` re-includes). Verify `git check-ignore .pi/foreman.json` returns nothing after the change.
   - Update .pi/foreman.json (it currently has the single per-round "verify" command gate) to ALSO declare: a pre-ship reviewer judge gate { name:"review", kind:"judge", stage:"pre-ship", agent:"reviewer" } AND a release commit action gate { name:"commit", kind:"action", stage:"release", action:"commit" }. Keep the existing per-round verify gate. This activates the full pipeline (per-round verify -> pre-ship review -> ship commit) for this repo.

STRICT CONSTRAINTS:
- done.ts is pure (node-builtins only); do NOT change ledger schema, Handoff type, gates.ts kinds, guard.ts, reviewer.ts, planner.ts, ship.ts, the dashboard, or crew/*.md.
- The auto-commit must be WITHHELD whenever evaluateDoneness returns done=false. Strict mode: an inconclusive reviewer verdict blocks the commit — no silent force path.
- Founder approval remains required (gate2) — DoD is an ADDITIONAL machine gate on top of it, not a replacement.
- Commit best-effort safety from Phase D is unchanged (spawn argv, never reverse done) — but now it only runs when done=true.
- Keep ALL existing suites passing.

TEST (create + verify target): extensions/foreman/test/done_test.sh — headless node test (style of ship_test.sh/reviewer_test.sh) importing done.ts:
- evaluateDoneness STRICT truth table: all-hard-pass + reviewer approve => done true, no blockers. reviewer gate declared + decision "unknown" => done FALSE with the inconclusive blocker. reviewer gate declared + "request-changes" => done false. NO reviewer gate (reviewerGateDeclared false) + tester success + gate1 + gate2 => done true (review n/a). tester state "partial"/"blocked"/"fail" => done false. gate1Approved false => done false. preShip command gates passed=false => done false; undefined => n/a not a blocker. gate2Approved false => done false.
- renderDoneChecklist includes a line per check and lists blockers when present.
- extractDonenessInputs over a sample parsed-log array picks the LAST verdict.successState, last verify_ran exit, last pre_ship_command_gates_ran.passed, last pre_ship_reviewer_verdict.decision.
- Assert .pi/foreman.json now declares the review judge gate + commit action gate (grep), and that `git check-ignore .pi/foreman.json` is empty (a shell assertion in the test or verify command).
Also run ALL existing suites so nothing regressed.

End with the mandatory DEV-JSON machine block.

## Summary (planner)
Codify a strict Definition of Done as a pure headless module (extensions/foreman/done.ts) and gate the Phase-D Gate-2 auto-commit on it: at the awaiting_ship approve branch (index.ts:1177-1189), parse the task's log.jsonl, derive DoD inputs, and only set done/run the release commit action when evaluateDoneness().done===true; a reviewer-UNKNOWN (or any unmet hard check) withholds the commit, keeps state at awaiting_ship, logs done_blocked, and surfaces an actionable checklist. Add done_test.sh and activate the full pipeline in this repo by un-ignoring and extending .pi/foreman.json with a pre-ship review judge gate and a release commit action gate.

## Steps
1. Recon (read-only, done): confirmed done.ts absent, foreman.json currently git-ignored (git check-ignore returns it, exit 0), Gate-2 approve branch at index.ts:1177-1189 runs release action gates unconditionally, and log event shapes: verdict.successState, verify_ran(exitCode), pre_ship_command_gates_ran.passed, pre_ship_reviewer_verdict.decision.
2. Create pure extensions/foreman/done.ts (node-builtins only, no pi imports): DoneCheck/DonenessResult interfaces; evaluateDoneness(input) implementing STRICT rules (gate1Approved true; latestTesterState must be 'success'; perRound/preShip command gates: defined=>must be true else blocker, undefined=>'n/a'; reviewer: declared+approve=>pass, declared+request-changes=>blocker, declared+unknown/undefined=>warn+blocker 'reviewer verdict inconclusive — strict DoD requires a clean APPROVE', not-declared=>'n/a'; gate2Approved true); checklist ordered plan/per-round/tester/pre-ship/review/founder; done=blockers.length===0; renderDoneChecklist(result) compact multi-line block with ✓/✗/⚠/– + blockers; extractDonenessInputs(events[],opts) scanning for the LAST verdict.successState, verify_ran.exitCode (->passed===0), pre_ship_command_gates_ran.passed, pre_ship_reviewer_verdict.decision.
3. Wire into index.ts awaiting_ship approve branch (surgical): read+parse log.jsonl lines into an array (controller-side I/O), compute reviewerGateDeclared via gatesForStage(gates,'pre-ship').some(g=>g.kind==='judge'), call extractDonenessInputs+evaluateDoneness with gate2Approved:true. If done: keep today's path (state='done', gate2_approved+task_done logs, run release action gates) and add done_evaluated{done:true,blockers:[]} log + renderDoneChecklist on the SHIPPED emit. If not done: set state back to 'awaiting_ship', log done_blocked{blockers}, emit checklist+blockers+instruction (reject-with-feedback OR reopen to re-run the live reviewer; no silent force), and DO NOT run release/commit.
4. Update .pi/.gitignore: add '!foreman.json' after the '*' ignore (alongside the existing !plans/ re-includes); verify git check-ignore .pi/foreman.json returns nothing.
5. Update .pi/foreman.json: keep the per-round 'verify' command gate; add {name:'review',kind:'judge',stage:'pre-ship',agent:'reviewer'} and {name:'commit',kind:'action',stage:'release',action:'commit'}, preserving exact key spacing so the grep asserts ('"agent": "reviewer"', '"action": "commit"') match.
6. Create extensions/foreman/test/done_test.sh (ship_test.sh/reviewer_test.sh style, ROOT_DIR + node --input-type=module importing done.ts): strict truth table (all-pass+approve=>done; declared+unknown=>done false w/ inconclusive blocker; declared+request-changes=>false; no-reviewer-gate+tester success+gate1+gate2=>done true; tester partial/blocked/fail=>false; gate1 false=>false; preShip passed=false=>false, undefined=>n/a; gate2 false=>false), renderDoneChecklist line-per-check + blockers, extractDonenessInputs LAST-event selection, plus shell asserts that foreman.json declares review+commit gates and git check-ignore .pi/foreman.json is empty.
7. Run the full legacy verify command (done_test + gitignore/grep asserts + ship/gates/reviewer/planner_timeout/planner/guard/fallback/ledger/dashboard reader suites) and gate_flow_test.sh to confirm no regression and backward-compat (no-reviewer-gate temp repo => review n/a => done true).

## Files likely
- `extensions/foreman/done.ts`
- `extensions/foreman/index.ts`
- `extensions/foreman/test/done_test.sh`
- `/Users/a1241968/Desktop/Oscar/my-pi-harness/.pi/.gitignore`
- `/Users/a1241968/Desktop/Oscar/my-pi-harness/.pi/foreman.json`

## Risks
- The existing per-round 'verify' gate command does NOT currently run done_test.sh or ship_test.sh; if left verbatim the per-round gate won't catch done.ts regressions. Proposing to extend the verify command to append done_test.sh + ship_test.sh + the foreman.json/check-ignore assertions (the task says 'keep' the gate, which I read as keep+extend, not replace). Flagging as a judgment call.
- Gate-2 wiring requires NEW controller-side log.jsonl reading/parsing at index.ts:1177-1189; must guard per-line JSON.parse against malformed lines and keep done.ts pure (parsing array passed in). Risk of touching more of index.ts than intended — will keep it surgical to the approve branch.
- Activating the commit action gate in THIS repo means future real Gate-2 approvals will auto-commit; correctness of the done=true gate is load-bearing. Strict mode must WITHHOLD commit on reviewer-unknown with no force path.
- gate_flow_test.sh and other suites must still pass: a repo with no reviewer/command gates + tester success + gate1 + founder approval must yield done=true (review n/a) so behavior is identical to today.
- foreman.json key spacing must exactly match the grep asserts ('"agent": "reviewer"', '"action": "commit"'); a formatter could collapse spacing and break the test/verify.
- Un-ignoring foreman.json changes git tracking; verify with git check-ignore (currently returns the path, exit 0 — must become empty).

## Proposed gates
- verify (per-round command) — command: `bash extensions/foreman/test/done_test.sh && test -z "$(git -C . check-ignore .pi/foreman.json)" && grep -q '"agent": "reviewer"' .pi/foreman.json && grep -q '"action": "commit"' .pi/foreman.json && bash extensions/foreman/test/ship_test.sh && grep -q "claude-opus-4-8:xhigh" extensions/foreman/crew/planner.md && bash extensions/foreman/test/planner_timeout_test.sh && bash extensions/foreman/test/planner_test.sh && bash extensions/foreman/test/gates_test.sh && bash extensions/foreman/test/reviewer_test.sh && bash extensions/foreman/test/guard_test.sh && bash extensions/foreman/test/fallback_test.sh && bash extensions/foreman/test/ledger_test.sh && bash extensions/foreman/dashboard/test/reader_test.sh`
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
