# Plan: Tier 3 of the anti-rubber-stamp work: a calibration loop that measures whether the scorer's risk flags were actually worth raising, and SURFACES a proposal to the founder — it does NOT auto-tune the scorer and does NOT auto-write AGENTS.md. Founder-approved scope: conservative signal + human-gated proposal only.

Read extensions/foreman/docs/INTERNALS.md first (scorer.ts, the gate1_awaiting / gate1_rejected / gate2_rejected ledger events, the pure-helper + headless-test pattern, ledger.ts readers, NEVER-do).

FOUNDER-APPROVED DESIGN (implement exactly; do not re-litigate):
- MEASUREMENT SIGNAL = CLEAR ONLY. Count a scorer flag as "WORTH IT" only when there is an explicit founder reject-with-correction (gate1_rejected / gate2_rejected with feedback) on that task. An approve-straight-through is NEUTRAL — it is NOT evidence the flag was wrong (because a straight approve could be either a bad flag OR rubber-stamping; we must not punish flags on ambiguous signal). So: worth-it = had a reject+correction; neutral = approved without reject. NEVER infer "flag was wrong" from a silent approve.
- OUTPUT = SURFACE + PROPOSE, never auto-apply. Tier 3 produces a human-readable calibration report + a PROPOSAL (e.g. "the scorer routed N assumptions to founder/team across M tasks; K were followed by a reject+correction; the rest were approved straight. Consider whether <category> is over-flagging."). It writes this as a proposal the founder reviews — do NOT mutate scorer.ts thresholds and do NOT write AGENTS.md automatically. (continual-learning remains the only thing that writes AGENTS.md, and only from the main chat.)
- CROSS-TASK: the signal accrues across many tasks, so this reads the ledger history under .pi/plans/*/log.jsonl (and/or the out-of-tree mirror), not just the current task.

IMPLEMENT:
1. New pure module extensions/foreman/calibration.ts (node-builtin-only, NO fs in the pure core — caller passes parsed ledger events in; a thin fs reader wrapper may live in index.ts or a clearly-separated function, mirroring how gates.ts/ledger.ts split pure vs fs). Exports:
   - types: FlagObservation { slug; assumptionText?; route: "founder"|"team"|"self"; risk: "low"|"medium"|"high"; wasRejectedWithCorrection: boolean }, CalibrationStats { totalFlags; byRoute; byRisk; worthItCount; neutralCount; perCategory... }, CalibrationProposal { lines: string[] } or similar.
   - a pure summarizeCalibration(observations: FlagObservation[]): CalibrationStats that aggregates, and a pure proposeCalibration(stats): string[] that emits conservative advisory lines (e.g. only suggest "consider downgrading X" when a route/risk band has a high flag count AND a low worth-it ratio over a MINIMUM sample size — hardcode a sane min sample like >=5 so it never proposes from 1-2 data points).
   - NEVER claim a flag was wrong; phrase proposals as "consider reviewing whether <band> over-flags" — advisory, founder decides.
2. A reader (in index.ts or calibration.ts behind a clear fs boundary) that walks .pi/plans/*/log.jsonl, extracts per-task: the scorer flags recorded at gate1_awaiting (the scored assumptions with route founder/team), and whether that task had a gate1_rejected/gate2_rejected with feedback. Builds FlagObservation[]. Tolerate missing/malformed logs (skip, never throw).
   - PREREQUISITE CHECK: confirm gate1_awaiting actually records the scored assumptions (route/risk). If it does NOT yet persist the per-assumption route/risk, add that to the gate1_awaiting appendLog payload (additive field, e.g. scoredAssumptions: [{text,route,risk}]) so calibration has data to read. Keep it additive — do not change existing event fields.
3. Expose it via a manual command (NOT automatic, NOT in the dev/test/review loop): a foreman dashboard/CLI surface or a slash-style command (mirror how other manual surfaces are registered) e.g. a "foreman-calibration" command that prints the report + proposals for the current repo. It is founder-invoked, read-only, advisory.
4. Do NOT wire it into continual-learning automatically. The report may TELL the founder "you could add this to AGENTS.md" but Tier 3 itself does not write AGENTS.md or change the scorer.

TESTS (headless pure-data; add calibration_test.sh wired into the verify gate):
- summarizeCalibration: counts totalFlags/worthItCount/neutralCount/byRoute/byRisk correctly from a fixture of FlagObservation[].
- proposeCalibration: proposes "consider reviewing" only above the min sample size + low worth-it ratio; emits nothing for tiny samples or healthy ratios; NEVER emits "flag was wrong".
- the ledger reader: builds correct FlagObservation[] from a fixture of log.jsonl lines incl. a task with gate1_rejected and one approved-straight; tolerates malformed lines.
- Preserve ALL existing tests.

CONSTRAINTS:
- Pure core stays node-builtin-only + headlessly testable; fs reading is a thin separated wrapper.
- ADVISORY + HUMAN-GATED: never auto-tune scorer thresholds, never auto-write AGENTS.md, never block any gate. No DoD change.
- Neutral signal discipline: a straight approve is NEVER counted as "flag was wrong" — only an explicit reject+correction counts as worth-it; everything else is neutral.
- Min sample size before any proposal (>=5) so it can't overfit 1-2 tasks.
- Do not touch models.json or crew model assignments.

VERIFY: the .pi/foreman.json per-round gate runs the full headless suite incl. calibration_test.sh; keep everything green. Pre-ship reviewer + soft doc-er run at the end.

## Summary (planner)
Tier 3 anti-rubber-stamp calibration: add a pure node-builtin-only extensions/foreman/calibration.ts (FlagObservation/CalibrationStats/CalibrationProposal types, pure summarizeCalibration + conservative proposeCalibration with a hardcoded >=5 min-sample gate), a clearly-separated fs reader that walks .pi/plans/*/log.jsonl (+ out-of-tree mirror) to build FlagObservation[] keyed on whether each task had a gate1_rejected/gate2_rejected-with-feedback (worth-it) vs approved-straight (NEUTRAL, never 'wrong'), an additive scoredAssumptions:[{text,route,risk}] field on the existing gate1_awaiting appendLog payload (prerequisite: route/risk is not persisted today), a founder-invoked read-only foreman-calibration manual command that prints report+proposals, and a headless calibration_test.sh wired into the existing verify per-round gate. Advisory + human-gated only: never auto-tunes scorer.ts, never writes AGENTS.md, never blocks a gate, no DoD change.

## Steps
1. Read scorer.ts ScoredAssumption shape and planner.ts:scorePlanAssumptions() (already exported, planner.ts:453) to reuse {text,route,risk} as the calibration input contract.
2. PREREQUISITE: extend the gate1_awaiting appendLog payload at index.ts:1791-1799 with an additive scoredAssumptions:[{text,route,risk}] field computed via scorePlanAssumptions(drafted.plan, context); leave all existing fields (planner, note, perRoundGates, requirementGaps, teamQuestionPacket) untouched.
3. Create extensions/foreman/calibration.ts (pure, node-builtin-only, NO fs/SDK imports, header mirroring scorer.ts/teampacket.ts): export types FlagObservation { slug; assumptionText?; route:'founder'|'team'|'self'; risk:'low'|'medium'|'high'; wasRejectedWithCorrection:boolean }, CalibrationStats { totalFlags; byRoute; byRisk; worthItCount; neutralCount; perCategory }, CalibrationProposal { lines:string[] }.
4. Implement pure summarizeCalibration(observations): aggregate totalFlags, byRoute, byRisk, worthItCount (wasRejectedWithCorrection===true), neutralCount (everything else); never derive 'flag was wrong' from a silent approve.
5. Implement pure proposeCalibration(stats): emit conservative advisory lines worded 'consider reviewing whether <band> over-flags' ONLY when a route/risk band has high flag count AND low worth-it ratio AND sample size >= MIN_SAMPLE (hardcode 5); emit nothing for tiny samples or healthy ratios; NEVER emit 'flag was wrong'.
6. Add a clearly-separated fs reader (in index.ts behind an existing-style wrapper, mirroring readLedgerLogEvents at index.ts:1218 and reader.ts safeReadDir/readJsonl) that walks plansRoot(cwd) (+ out-of-tree mirror) per slug, parses log.jsonl, extracts gate1_awaiting.scoredAssumptions (route founder/team) and whether the same task logged gate1_rejected/gate2_rejected with non-empty feedback, and builds FlagObservation[]; tolerate missing/malformed logs (skip line, never throw).
7. Register a founder-invoked read-only pi.registerCommand('foreman-calibration', ...) mirroring foreman-direct (index.ts:1531) / continual-learning (continual-learning/index.ts:152): read observations, run summarizeCalibration + proposeCalibration, print the human-readable report + proposals via ctx.ui notify/print; it may TELL the founder they could add something to AGENTS.md but must not write it or mutate scorer.ts.
8. Write extensions/foreman/test/calibration_test.sh (headless, set -Eeuo pipefail, node --input-type=module importing calibration.ts via pathToFileURL like scorer_test.sh): assert summarizeCalibration counts totalFlags/worthItCount/neutralCount/byRoute/byRisk from a FlagObservation[] fixture; assert proposeCalibration proposes only above MIN_SAMPLE + low worth-it ratio, emits nothing for tiny/healthy samples, and NEVER emits 'flag was wrong'; assert the ledger reader builds correct FlagObservation[] from a log.jsonl fixture incl. one gate1_rejected task and one approved-straight task, and tolerates malformed lines; add a grep guard that .pi/foreman.json verify gate runs calibration_test.sh.
9. Append '&& bash extensions/foreman/test/calibration_test.sh' to the existing verify gate command in .pi/foreman.json (additive only; review and commit gates unchanged).
10. Run the full headless verify suite (all existing tests + calibration_test.sh) and keep everything green; then let the pre-ship reviewer + soft doc-er run.

## Files likely
- `extensions/foreman/calibration.ts`
- `extensions/foreman/index.ts`
- `extensions/foreman/test/calibration_test.sh`
- `.pi/foreman.json`
- `extensions/foreman/docs/INTERNALS.md`

## Risks
- PREREQUISITE confirmed real: gate1_awaiting does NOT persist per-assumption route/risk today (index.ts:1791-1799 logs only a markdown teamQuestionPacket). The additive scoredAssumptions field is required for calibration to have data, and historical logs predating this change will have no scoredAssumptions — the reader must skip them gracefully (not throw, not miscount).
- Neutral-signal discipline is the core correctness risk: a straight approve must count as NEUTRAL, never as evidence a flag was wrong; only gate1_rejected/gate2_rejected WITH non-empty feedback counts as worth-it. Tests must lock this in.
- Over-proposing from thin data: the >=5 min-sample + low-ratio gate must be enforced in proposeCalibration so 1-2 tasks can't trigger a proposal.
- Scope creep into auto-apply: must NOT mutate scorer.ts thresholds, must NOT write AGENTS.md (continual-learning remains the only AGENTS.md writer, from main chat only), must NOT block any gate or change DoD.
- Purity boundary: calibration.ts must stay node-builtin-only with zero fs/SDK imports; all fs walking stays in the index.ts reader wrapper.
- Command output: long multi-line reports via ctx.ui?.notify may render awkwardly; mirror the established manual-surface output convention (notify/print) rather than inventing a new channel.
- Cross-task read must cover both .pi/plans/*/log.jsonl and the out-of-tree mirror (ledger.ts:163) to avoid undercounting after a wipe/restore.
- Do not touch models.json or crew model assignments; the gate1_awaiting edit must keep the planner.md 'claude-opus-4-8:xhigh' grep guard in the verify gate passing.

## Requirements
### CLI tools/binaries
- ✓ node — TS-capable runtime that executes the headless tests (node --input-type=module importing .ts via pathToFileURL), including the new calibration_test.sh
- ✓ bash — test harness scripts and the verify gate command are bash
- ✓ git — existing release/commit gate; unchanged by this task

## Proposed gates
- verify (per-round command) — command: `grep -q "claude-opus-4-8:xhigh" extensions/foreman/crew/planner.md && bash extensions/foreman/test/planner_timeout_test.sh && bash extensions/foreman/test/planner_test.sh && bash extensions/foreman/test/gates_test.sh && bash extensions/foreman/test/scorer_test.sh && bash extensions/foreman/test/approvalfriction_test.sh && bash extensions/foreman/test/teampacket_test.sh && bash extensions/foreman/test/reviewer_test.sh && bash extensions/foreman/test/docer_test.sh && bash extensions/foreman/test/guard_test.sh && bash extensions/foreman/test/fallback_test.sh && bash extensions/foreman/test/ledger_test.sh && bash extensions/foreman/dashboard/test/reader_test.sh && bash extensions/foreman/test/calibration_test.sh`
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
