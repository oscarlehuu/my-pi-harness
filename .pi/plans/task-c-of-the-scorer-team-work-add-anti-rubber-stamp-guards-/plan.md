# Plan: Task C of the scorer/team work: add anti-rubber-stamp guards so the founder can't approve high-stakes things on autopilot, and the orchestrator can't get a question waved through by inflating its importance. Scope this task to tiers 1, 2, and 4 (all cheap + pure). Tier 3 (the cross-task calibration loop) is explicitly DEFERRED to a separate later task — do NOT build it here.

Read extensions/foreman/docs/INTERNALS.md first (scorer.ts, teampacket.ts, Gate-1/Gate-2 flow, the pure-helper + headless-test pattern, NEVER-do). Mirror the pure-module style of scorer.ts / teampacket.ts.

FOUNDER-APPROVED DESIGN (implement exactly; do not re-litigate). The thesis: a verify step is theater if the founder rubber-stamps it. Three guards in THIS task:

TIER 1 — verifiable-claim discipline (prompt-level, cheap):
- The scorer/team surfacing must reject empty importance words. An assumption/question marked risky must carry CONCRETE evidence (a cite/file:line/quote OR a named concrete consequence), not just "this is important".
- Implement a pure helper (in scorer.ts or a small new module) hasVerifiableEvidence(reasons: string[], text: string): boolean — true when there is a file:line, a quoted token, a path, or a named consequence keyword (e.g. "double-charge", "data loss", "prod", "migration", "breaks"). When a risky item LACKS verifiable evidence, annotate it at Gate-1 as "[unsubstantiated — verify or downgrade]" rather than letting it ride as if proven. Advisory only.

TIER 2 — adversarial self-gate on the QUESTION (prompt-level, reuse existing stance):
- Update crew/planner.md (the agent that produces assumptions/risks) with a short "before you flag something risky, try to resolve it yourself first" instruction: read one more file / check history; only surface a team/founder question if you genuinely cannot resolve it AND it has verifiable evidence AND a busy expert could answer it in one line. This mirrors the default-refuted stance already in tester.md/reviewer.md, applied to QUESTION-RAISING. Prompt-only; no code.

TIER 4 — cost-asymmetry approval friction (the core of this task, pure + wired):
- Build a pure module extensions/foreman/approvalfriction.ts (node-builtin-only, NO fs) exporting decideApprovalFriction(input): the input carries the set of changed/at-risk paths (e.g. plan.filesLikely/blastRadius and the dev's filesChanged) and the repo's highRiskPaths globs (reuse gates.loadHighRiskPaths + the glob matcher pattern from scorer.ts). It returns { level: "normal" | "elevated"; matchedPaths: string[]; reason: string }. "elevated" when a high-risk path is touched (payment/auth/migration/delete/secret globs), else "normal".
- Wire it into the Gate-2 SHIP relay only (not Gate 1): when level === "elevated", the Gate-2 emit must (a) show a prominent "⚠ HIGH-RISK CHANGE — review the diff before approving: <matchedPaths>" banner and (b) require a DELIBERATE confirmation rather than a one-word yes — concretely, instruct that elevated ships should be approved with an explicit phrase the founder must pass (e.g. foreman({ resume:true, approve:true, confirm:"SHIP <slug-or-token>" })), and have the foreman tool REQUIRE that confirm token when the pending task is elevated. Normal-risk ships keep the existing one-tap approve:true (no new friction for cheap changes — founder is only slowed down where it's expensive).
- This is the one place that is NOT purely advisory: an elevated ship without the confirm token should NOT proceed — re-emit the banner + the required confirm phrasing instead. Keep it minimal and deterministic. Do NOT block normal ships, do NOT change the DoD checks themselves, do NOT touch Gate 1 approval.

SCOPE — implement: approvalfriction.ts (pure), hasVerifiableEvidence helper + Gate-1 unsubstantiated annotation, the planner.md tier-2 instruction, and the Gate-2 elevated-confirm wiring in index.ts (parse params.confirm; when elevated and token missing/mismatched, re-emit and return without marking done/committing). Update INTERNALS.md (developer writes it; doc-er will also run).

TESTS (headless pure-data; add approvalfriction_test.sh + extend scorer_test.sh; wire into .pi/foreman.json verify gate):
- decideApprovalFriction: high-risk path touched -> elevated + matchedPaths; no high-risk path -> normal; glob matching correctness.
- hasVerifiableEvidence: file:line/quote/path/consequence-keyword -> true; bare "this is important" -> false.
- a grep-guard that index.ts Gate-2 requires the confirm token when elevated (parses params.confirm and re-emits when missing), and that planner.md has the tier-2 self-resolve instruction.
- Preserve ALL existing tests.

CONSTRAINTS:
- approvalfriction.ts + any new helper stay pure/node-builtin-only and headlessly testable.
- Tier 4 is the ONLY non-advisory change and it applies ONLY to elevated (high-risk-path) Gate-2 ships; normal ships are unchanged (one-tap approve). No DoD check changes, no Gate-1 friction.
- Do NOT build Tier 3 calibration / cross-task outcome tracking here (separate task).
- Quota safety: planner.md stays append-only system prompt; do not touch models.json or crew model assignments.
- Reuse gates.loadHighRiskPaths and the scorer glob matcher; do not duplicate glob logic if it can be shared cleanly (export it from scorer.ts if needed).

VERIFY: the .pi/foreman.json per-round gate runs the full headless suite incl. approvalfriction_test.sh; keep everything green. Pre-ship reviewer + soft doc-er run at the end. Manually note in the handoff how an elevated ship is confirmed so the founder knows the new phrasing.

## Summary (planner)
Add three anti-rubber-stamp guards (Tiers 1, 2, 4) — verifiable-claim discipline, a planner self-resolve stance, and a pure cost-asymmetry approval-friction module wired into the Gate-2 elevated-ship confirm path — leaving Tier 3 calibration deferred.

## Understanding
Stop autopilot approvals: risky Gate-1 items must carry concrete evidence or be flagged [unsubstantiated]; the planner must try to resolve a question itself before raising it; and high-risk-path Gate-2 ships must require a deliberate confirm token instead of one-tap approve, while normal ships stay one-tap. All advisory except Tier 4's elevated-ship gate; no Tier 3, no DoD or Gate-1 friction changes.

## Assumptions
- [?] check if uncertain: The confirm token is enforced only in the resume approve branch at index.ts:1826 (the single place a ship is consummated); the banner/required phrasing is added to the Gate-2 approval-needed emits at index.ts:1855 and index.ts:2395 and the re-emit; in-loop block at index.ts:2382 needs no enforcement since it only sets awaiting_ship. _(confidence: high; risk: medium; cost: high; kind: unknown; route: founder)_ — keyword signal (secret/credential): high
- [?] check if uncertain: Elevated friction is dormant until highRiskPaths is configured in .pi/foreman.json (repo currently has none); tests pass globs in directly so coverage does not depend on repo config. _(confidence: medium; risk: medium; cost: medium; kind: domain-fact; route: team→founder for now)_ — keyword signal (configuration/routing): medium
- (low risk) decideApprovalFriction stays fs-free and pure by taking highRiskPaths + changedPaths as input; index.ts calls gates.loadHighRiskPaths(cwd) and assembles plan.filesLikely/blastRadius + dev filesChanged, mirroring scorer.ts's caller-supplies-data contract. _(confidence: high; risk: low; cost: low; kind: unknown; route: self)_
- (low risk) hasVerifiableEvidence and the [unsubstantiated] Gate-1 annotation belong in scorer.ts + planner.ts:renderFounderPlan (advisory render layer), reusing the existing scorer signal path rather than touching index.ts Gate-1 approval. _(confidence: high; risk: low; cost: low; kind: unknown; route: self)_
- (low risk) approvalfriction_test.sh is appended to the existing .pi/foreman.json verify command chain in place; the three existing gates are otherwise unchanged and not overwritten via Gate-1 manifest write. _(confidence: high; risk: low; cost: low; kind: domain-fact; route: self)_
- (low risk) globMatches is already exported from scorer.ts, so no new glob export is needed; approvalfriction.ts imports it. _(confidence: high; risk: low; cost: low; kind: domain-fact; route: self)_

## Non-goals
- Tier 3 cross-task calibration / outcome tracking (explicitly deferred to a separate task).
- Any change to DoD checks (done.ts) or to Gate-1 approval friction.
- Adding friction to normal (non-high-risk) Gate-2 ships — they keep one-tap approve:true.
- Touching models.json, crew model assignments, or replacing planner.md's append-only system prompt.
- Duplicating glob logic or moving fs reads into the pure module.

## Alternatives considered
- Put glob matching + highRiskPaths loading inside approvalfriction.ts. — rejected because loadHighRiskPaths uses fs and globMatches already exists; the pure module must stay node-builtin/fs-free, so index.ts supplies data and the module imports globMatches.
- Enforce the confirm token in the in-loop Gate-2 block at index.ts:2382 too. — rejected because That block only sets awaiting_ship and returns; approval is always consummated via the resume branch at index.ts:1826, so a single enforcement point keeps it deterministic and minimal.
- Make Tier 1 hard-block risky items lacking evidence. — rejected because Founder-approved design says Tier 1 is advisory: annotate [unsubstantiated — verify or downgrade], do not block.

## Blast radius
- extensions/foreman/index.ts Gate-2 resume/emit paths (1826/1855/2382/2395) and LoopParams param parsing.
- extensions/foreman/planner.ts renderFounderPlan assumption surfacing (advisory annotation only).
- extensions/foreman/scorer.ts public surface (new exported helper) — must not break existing scorer_test grep guards.
- extensions/foreman/crew/planner.md system prompt (append-only).
- .pi/foreman.json verify command chain (must stay green across all existing tests).

## Steps
1. Read planner.ts:renderFounderPlan, the LoopParams/execute param area, and tester.md/reviewer.md default-refuted stance to fix exact insertion points before editing.
2. Tier 4 core: add pure extensions/foreman/approvalfriction.ts exporting decideApprovalFriction({ changedPaths, highRiskPaths }) -> { level: 'normal'|'elevated'; matchedPaths; reason }, importing globMatches from scorer.ts; node-builtin-only, no fs/SDK.
3. Tier 1: add hasVerifiableEvidence(reasons, text) to scorer.ts (true on file:line, quoted token, path, or consequence keyword e.g. double-charge/data loss/prod/migration/breaks); consume it in planner.ts:renderFounderPlan to annotate risky-but-unsubstantiated items '[unsubstantiated — verify or downgrade]' (advisory, additive — remove nothing).
4. Tier 2: append a default-refuted-style 'resolve it yourself first' self-gate to crew/planner.md (read one more file/check history; only surface a team/founder question if unresolved AND it has verifiable evidence AND a busy expert could answer in one line); prompt-only, append-only.
5. Tier 4 wiring: add confirm:string to LoopParams; in index.ts Gate-2 compute friction via loadHighRiskPaths(cwd) + readPersistedPlannerDraft (filesLikely/blastRadius) + readShipHandoffContext (filesChanged); when elevated, show the '⚠ HIGH-RISK CHANGE …' banner + required confirm phrasing in the approval-needed emits; in the resume approve branch (index.ts:1826) require a matching confirm token (e.g. 'SHIP <slug>') — when missing/mismatched, re-emit banner+phrasing and return WITHOUT marking done or committing; normal ships keep one-tap approve.
6. Tests: add extensions/foreman/test/approvalfriction_test.sh (elevated+matchedPaths on high-risk touch, normal otherwise, glob correctness) following the scorer_test.sh harness; extend scorer_test.sh with hasVerifiableEvidence cases + grep-guards that index.ts parses params.confirm and re-emits when elevated-without-token and that planner.md has the Tier-2 instruction; preserve all existing assertions.
7. Append approvalfriction_test.sh to the existing .pi/foreman.json verify command chain (in place; other gates unchanged).
8. Run the full headless suite locally; keep everything green. Update docs/INTERNALS.md (new module row, approvalfriction recipe, Gate-2 elevated-confirm + NEVER notes). Pre-ship reviewer + soft doc-er run at the end; note the elevated-confirm phrasing in the handoff.

## Files likely
- `extensions/foreman/approvalfriction.ts`
- `extensions/foreman/scorer.ts`
- `extensions/foreman/planner.ts`
- `extensions/foreman/index.ts`
- `extensions/foreman/crew/planner.md`
- `extensions/foreman/test/approvalfriction_test.sh`
- `extensions/foreman/test/scorer_test.sh`
- `extensions/foreman/docs/INTERNALS.md`
- `.pi/foreman.json`

## Risks
- Gate-2 has multiple emit/approve sites (index.ts:1826/1855/2382/2395); missing one would let an elevated ship bypass the confirm or show inconsistent phrasing — enforce only in the 1826 approve branch but mirror the banner/phrasing in every approval-needed emit.
- approvalfriction.ts must not import fs or SDK; pulling loadHighRiskPaths into it would violate the pure-module NEVER rule — keep the fs read in index.ts and pass globs in.
- Editing scorer.ts's exported surface or render strings could break existing scorer_test.sh grep guards; keep changes additive and re-run that test.
- Confirm-token matching must be deterministic (trim/normalize slug-or-token) to avoid a founder being unable to ship an elevated change; keep the phrasing emitted verbatim in the banner.
- Elevated path is untriggered until highRiskPaths is set in .pi/foreman.json, so manual repo behavior is unchanged by default — tests must inject globs to cover the elevated branch.
- planner.md must remain append-only (no --system-prompt, no model changes) per quota-safety constraint.
- Scope creep into Tier 3 must be avoided; no outcome/calibration tracking in this task.

## Requirements
### CLI tools/binaries
- ✓ node — Headless pure tests run via `node --input-type=module` importing the .ts modules directly.
- ✓ bash — Test harness scripts (approvalfriction_test.sh, scorer_test.sh) and the verify gate are bash.
- ✓ git — The release `commit` action gate stages path-scoped changes and commits.
### Services/runtimes
- ? Node.js runtime — Executes the pure helper modules and headless test suite; no DB/queue/dev-server needed for this task.

## Proposed gates
- verify (per-round command) — command: `grep -q "claude-opus-4-8:xhigh" extensions/foreman/crew/planner.md && bash extensions/foreman/test/planner_timeout_test.sh && bash extensions/foreman/test/planner_test.sh && bash extensions/foreman/test/gates_test.sh && bash extensions/foreman/test/scorer_test.sh && bash extensions/foreman/test/teampacket_test.sh && bash extensions/foreman/test/reviewer_test.sh && bash extensions/foreman/test/docer_test.sh && bash extensions/foreman/test/guard_test.sh && bash extensions/foreman/test/fallback_test.sh && bash extensions/foreman/test/ledger_test.sh && bash extensions/foreman/dashboard/test/reader_test.sh`
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
