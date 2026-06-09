# Plan: Add a pure "assumption scorer" to Foreman that ranks Gate-1 planner assumptions by RISK so the founder's attention (and, later, a team-question channel) is directed only at the assumptions that actually matter. This is Task A of the scorer/team work: build the BRAIN + surface it at Gate 1. Do NOT build the team channel or rubber-stamp tiers here — keep scope to scoring + Gate-1 surfacing.

Read extensions/foreman/docs/INTERNALS.md first (module map, Gate-1 flow, the pure-helper + headless-test pattern, NEVER-do). Mirror the pure-module style of reviewer.ts / docdrift.ts / agent-timeouts.ts.

CONCEPT (founder-approved; implement, do not re-litigate):
- Route each planner assumption by RISK = P(wrong) x cost(if wrong), on TWO axes:
  - RISK axis = should anyone be bothered? (P x cost)
  - KIND axis = if bothered, who? domain-fact -> team (LATER); preference/scope/taste -> founder. In THIS task, since the team channel does not exist yet, "team" routing degrades to "founder" (surface to founder). Leave a clear seam (the kind classification) for Task B to use.
- P(wrong) proxy: the planner assumption's confidence (low=high P, medium, high=low P). Missing confidence is treated as medium.
- cost proxy = BOTH (founder-approved "cả hai"):
  1. declared high-risk path globs from .pi/foreman.json (a new optional "highRiskPaths": string[] field), matched against the plan's blastRadius / filesLikely entries;
  2. an LLM/heuristic signal — for this pure module, accept a caller-provided cost hint (e.g. derived from blastRadius keywords like payment/auth/migration/delete/secret) so the module stays pure and testable; the glob match is the authoritative high-cost signal, the keyword heuristic is the backstop.

IMPLEMENT:
1. New pure module extensions/foreman/scorer.ts (node-builtin-only, no pi/fs imports beyond what gates.ts-style pure code uses — actually NO fs; caller passes data in). Exports:
   - types: RiskBand = "low"|"medium"|"high"; AssumptionRoute = "self"|"founder"|"team"; ScoredAssumption { text; confidence?; risk: RiskBand; route: AssumptionRoute; kind: "domain-fact"|"preference"|"unknown"; cost: RiskBand; reasons: string[] }.
   - a pure scoreAssumption(input) and scoreAssumptions(assumptions, ctx) where ctx carries { highRiskPaths: string[]; blastRadius: string[]; filesLikely: string[] } and any precomputed cost hints.
   - the P-from-confidence mapping, the cost computation (glob match on highRiskPaths against blastRadius/filesLikely -> high; keyword heuristic backstop -> medium/high; else low), and the risk = combine(P, cost) matrix (e.g. high P x high cost -> high risk -> route; low P x low cost -> self).
   - a kind classifier (heuristic: assumptions about how the app/domain behaves -> "domain-fact"; about scope/priority/preference -> "preference"; default "unknown") — used only to set route (domain-fact+risky -> "team"; else risky -> "founder"; low risk -> "self").
   - a glob matcher helper (simple, pure; reuse a minimal pattern match — do not pull a dependency).
   - IMPORTANT: in this task, when route would be "team", ALSO expose it but the Gate-1 surfacing treats team-or-founder both as "ask the founder" (team channel lands in Task B). Keep the "team" value in the data so Task B can light it up.
2. gates.ts: add optional highRiskPaths to the manifest read — a loadHighRiskPaths(cwd): string[] (mirror loadRequirements/loadGates; tolerate missing/malformed -> []). Pure.
3. index.ts / planner.ts surfacing: at Gate-1 plan render (renderFounderPlan in planner.ts, or where the plan is emitted in index.ts), use scoreAssumptions to reorder/annotate the Assumptions section so HIGH-risk assumptions are shown first with a marker (e.g. "[!] verify this") and a one-line reason, and low-risk ones are de-emphasized. This must be ADVISORY and additive — do not remove the existing assumptions content, do not block, do not change PLAN-JSON schema. If there are no assumptions or no scorer signal, render exactly as today (back-compat).
   - Pass real data: highRiskPaths from gates.loadHighRiskPaths(cwd), plus the plan's blastRadius/filesLikely.
4. Keep the scorer OUT of the dev/test/review loop and DoD — it only informs the Gate-1 founder view in this task.

TESTS (headless pure-data; add a scorer_test.sh and wire it into the .pi/foreman.json verify gate command):
- scoreAssumption: high-confidence + no high-risk path -> risk low -> route self; low-confidence + blastRadius matches a highRiskPaths glob -> risk high -> route founder/team; medium cases; missing confidence -> medium P.
- kind classifier: a domain-fact-style assumption routes "team"; a preference/scope one routes "founder".
- glob matcher: matches and non-matches.
- loadHighRiskPaths: missing file -> []; malformed -> []; valid -> parsed globs.
- a grep-guard that renderFounderPlan/index.ts calls scoreAssumptions for the Gate-1 assumptions surfacing.
- Preserve ALL existing tests.

CONSTRAINTS:
- scorer.ts and gates.ts stay pure/node-builtin-only and headlessly testable.
- ADVISORY ONLY: no blocking, no DoD change, no PLAN-JSON schema change; Gate-1 content is reordered/annotated, never removed.
- Do not build the team channel, the paste-back flow, assume-unless-vetoed, or any rubber-stamp calibration here (later tasks). Just leave the "team" route value in the data as a seam.
- Do not touch models.json or the crew model assignments.

VERIFY: the .pi/foreman.json per-round gate runs the full headless suite incl. the new scorer_test.sh; keep everything green. The pre-ship reviewer + soft doc-er run at the end as usual.

## Summary (planner)
Task A: add a pure, headless assumption scorer (scorer.ts) that ranks Gate-1 planner assumptions by RISK = P(wrong) x cost, classify a KIND seam (domain-fact->team, preference->founder, with team degrading to founder for now), add a tolerant gates.loadHighRiskPaths(cwd) loader, and surface scores advisorily in renderFounderPlan (reorder + annotate high/medium, byte-identical when no signal). Add scorer_test.sh and wire it into the existing per-round verify gate. Advisory only: no blocking, no DoD change, no PLAN-JSON schema change; team channel/rubber-stamp tiers are out of scope.

## Steps
1. Create extensions/foreman/scorer.ts (pure, node-builtin-only, NO fs): export RiskBand, AssumptionRoute, ScoredAssumption{text,confidence?,risk,route,kind,cost,reasons}; pure scoreAssumption(input) and scoreAssumptions(assumptions, ctx{highRiskPaths,blastRadius,filesLikely,costHints?}); P-from-confidence (low=highP, medium, high=lowP, missing=medium); cost (glob match of highRiskPaths against blastRadius/filesLikely => high authoritative; keyword heuristic backstop payment/auth/migration/delete/secret => medium/high; else low); risk=combine(P,cost) matrix; kind classifier (domain-fact|preference|unknown); route (domain-fact+risky=>team, risky=>founder, low=>self) keeping team in data; minimal pure glob matcher helper.
2. gates.ts: add loadHighRiskPaths(cwd): string[] mirroring loadRequirements/loadGates (read optional highRiskPaths:string[] from .pi/foreman.json; missing/malformed => []). Stay pure/node-builtin-only.
3. planner.ts: add optional highRiskPaths to PlannerContext; in renderFounderPlan call scoreAssumptions({highRiskPaths: ctx.highRiskPaths ?? [], blastRadius: plan.blastRadius ?? [], filesLikely: plan.filesLikely}); stable-sort risk-desc and annotate high/medium assumptions with a '[!] verify this' marker + one-line reason while leaving low-risk lines in original format/order. Additive only: never remove assumptions content; when no assumptions or all-low (no signal), render exactly as today.
4. index.ts: compute gates.loadHighRiskPaths(cwd) and pass it into the renderFounderPlan PlannerContext at the Gate-1 render call (index.ts:1705).
5. Add extensions/foreman/test/scorer_test.sh (headless node --input-type=module) covering: high-confidence+no high-risk path => risk low/route self; low-confidence+blastRadius matches highRiskPaths glob => risk high/route founder|team; medium and missing-confidence(=medium P) cases; kind classifier (domain-fact=>team, preference/scope=>founder); glob matcher match/non-match; loadHighRiskPaths missing/malformed/valid; and a grep-guard asserting planner.ts/index.ts wire scoreAssumptions + loadHighRiskPaths.
6. Wire scorer_test.sh into the .pi/foreman.json per-round verify gate command (append to the existing chain; do not overwrite other gates). Keep scorer out of dev/test/review loop and DoD.
7. Run the per-round verify gate (full headless suite incl. scorer_test.sh) and keep all existing tests green; pre-ship reviewer + soft doc-er run at the end as usual (INTERNALS.md module-map row for scorer.ts left to the doc-er stage).

## Files likely
- `extensions/foreman/scorer.ts`
- `extensions/foreman/gates.ts`
- `extensions/foreman/planner.ts`
- `extensions/foreman/index.ts`
- `extensions/foreman/test/scorer_test.sh`
- `.pi/foreman.json`
- `extensions/foreman/docs/INTERNALS.md`

## Risks
- Back-compat: planner_test.sh:351 asserts the Assumptions section text/order; the annotate+reorder must be a no-op when there is no scorer signal (no highRiskPaths, all-low risk) so existing renders stay byte-identical. Mitigate with stable risk-desc sort + original line format for low risk.
- scorer_test.sh does not exist yet; it is a deliverable of this task. The extended verify gate will fail until the file is created, which is expected during implementation.
- Keeping scorer.ts strictly fs-free requires threading highRiskPaths through PlannerContext (computed in index.ts), not reading inside planner.ts; otherwise planner.ts purity (NEVER add fs/pi imports to pure helpers) is violated.
- Editing .pi/foreman.json verify command risks clobbering the existing chain; only append scorer_test.sh and leave review/commit gates untouched.
- Scope creep risk: must NOT build the team channel, paste-back, assume-unless-vetoed, or rubber-stamp tiers; only leave the 'team' route value as a seam.
- Reorder must remain advisory: do not change PLAN-JSON schema, do not block Gate 1/2, do not touch DoD or models.json/crew model assignments.

## Requirements
### CLI tools/binaries
- ✓ node — headless tests run via `node --input-type=module` importing the .ts pure modules directly
- ✓ bash — test scripts and the verify gate command are bash
- ✓ git — release commit action gate stages changed paths

## Proposed gates
- verify (per-round command) — command: `grep -q "claude-opus-4-8:xhigh" extensions/foreman/crew/planner.md && bash extensions/foreman/test/planner_timeout_test.sh && bash extensions/foreman/test/planner_test.sh && bash extensions/foreman/test/gates_test.sh && bash extensions/foreman/test/reviewer_test.sh && bash extensions/foreman/test/docer_test.sh && bash extensions/foreman/test/guard_test.sh && bash extensions/foreman/test/fallback_test.sh && bash extensions/foreman/test/ledger_test.sh && bash extensions/foreman/dashboard/test/reader_test.sh && bash extensions/foreman/test/scorer_test.sh`
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
