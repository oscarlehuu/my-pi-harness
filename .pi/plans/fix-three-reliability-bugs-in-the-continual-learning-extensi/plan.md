# Plan: Fix three reliability bugs in the `continual-learning` extension (extensions/continual-learning/) that make learning "sometimes work, sometimes not". Keep changes minimal and faithful to the existing port; do not add features beyond the three fixes. Both test scripts must pass after the change:
  - bash extensions/continual-learning/test/cadence_test.sh
  - bash extensions/continual-learning/test/learn_test.sh

ROOT CAUSE CONTEXT (already diagnosed):
The cadence GATE is deterministic, but transcripts get marked "processed" in the index even when their lessons were never actually mined, and updater failures are silent. So whether a given correction is learned depends on timing/order/luck.

FIX 1 — Only mark transcripts that were actually mined (learn.ts):
- Today runLearningPass pre-writes the index for ALL deltas (`deltas.map(...)`), but buildUpdaterTask only sends the first MAX_TRANSCRIPTS_PER_RUN (8) / MAX_DIGEST_CHARS (60k) to the updater. Deltas 9+ are marked processed but never read, and selectDeltaTranscripts keys off mtime so they are never re-picked → lessons lost forever.
- Change buildUpdaterTask to also RETURN which transcripts it actually included in the digest (the sliced/under-cap set), e.g. return { task, included }. Always include at least the first transcript even if it alone exceeds MAX_DIGEST_CHARS, so a single big transcript still makes progress.
- runLearningPass must refresh the index for ONLY the `included` transcripts (not all deltas). deltaCount should reflect included.length. The remaining over-cap deltas then naturally re-appear on the next pass and drain over time.

FIX 2 — Failure must NOT advance the index, and must be surfaced (learn.ts + index.ts):
- Move the index refresh (writeJsonFile(indexFile, refreshIndex(...))) to AFTER the updater returns, and only do it when result.exitCode === 0. On non-zero exit (crash, unavailable model, rate limit), leave the index untouched so the same deltas retry next pass. Remove the old "pre-write so tracking survives a crash" pre-write — that behavior was backwards.
- Extend LearnRunOutcome with `ok: boolean` (clean exit) and optional `stderr`. Set reason to include a trailing slice of stderr on failure. ensureLearnedScaffold should still run before the updater.
- In index.ts, update both the cadence-triggered path and the /continual-learning command to surface failures: when outcome.ran && !outcome.ok, notify a warning like "Continual learning: updater failed (<reason>)" instead of staying silent. Keep the existing success/no-updates messages. Update the `outcome.ran &&` success guard to also require outcome.ok.

FIX 3 — Make the cadence actually fire in normal use (cadence.ts + README):
- The default gate requires turns>=10 AND minutes>=120 AND mtime advanced, which rarely fires in normal sessions. Lower the DEFAULT_MIN_MINUTES from 120 to 30 (keep DEFAULT_MIN_TURNS=10). Do NOT change the AND semantics or the trial-mode logic. Update the cadence_test.sh expectations only where the 120 default is asserted (the env-parsing default-min-minutes assertion expects 120 → update to 30; the minutes-gate test uses explicit opts() so it stays valid, but verify it still passes and adjust the "121 minutes" comment/threshold only if it depends on the default — it uses opts() minMinutes:120 explicitly so it should be fine). Update README.md trigger-cadence section to say 30 minutes instead of 120.

Update learn_test.sh if needed so it still passes: the stub updater returns exitCode 0, so the index should still be written; add/keep an assertion that a non-zero exitCode stub does NOT write/advance the index (this directly covers Fix 2). Keep all existing assertions green.

Do not touch Foreman or unrelated extensions. Plain, minimal edits.

## Summary (planner)
Fix three reliability bugs in extensions/continual-learning so learning is deterministic: (1) in learn.ts, only mark transcripts actually mined by having buildUpdaterTask return {task, included} and refreshing the index for `included` only (deltaCount=included.length, always include >=1 transcript); (2) in learn.ts move the index refresh to after the updater returns and only when exitCode===0, drop the backwards pre-write, extend LearnRunOutcome with ok+stderr and fold stderr tail into reason, and in index.ts notify a warning on outcome.ran && !outcome.ok plus require outcome.ok in the success guard; (3) in cadence.ts lower DEFAULT_MIN_MINUTES 120->30 (turns stays 10, AND/trial semantics unchanged) and update README. Update cadence_test.sh default-min-minutes assertion 120->30 and add a learn_test.sh assertion that a non-zero-exitCode stub does not advance the index. Both continual-learning test scripts must stay green. Do not touch Foreman or other extensions.

## Steps
1. Fix 1 (learn.ts): change buildUpdaterTask to return { task, included } where included is the sliced/under-cap transcript set, always including at least the first delta even if it alone exceeds MAX_DIGEST_CHARS; build the digest from `included`.
2. Fix 1 (learn.ts): in runLearningPass, destructure { task, included }; refresh the index (refreshIndex) for ONLY `included` transcripts and set deltaCount = included.length so over-cap deltas reappear next pass.
3. Fix 2 (learn.ts): remove the pre-updater writeJsonFile index pre-write; after `run(...)` returns, write the refreshed index only when result.exitCode === 0; leave index untouched on non-zero exit. Keep ensureLearnedScaffold before the updater.
4. Fix 2 (learn.ts): extend LearnRunOutcome with `ok: boolean` and optional `stderr`; set ok=(exitCode===0); on failure append a trailing slice of stderr to `reason`.
5. Fix 2 (index.ts): in the agent_end path and the /continual-learning command, when outcome.ran && !outcome.ok notify warning 'Continual learning: updater failed (<reason>)'; tighten the success notify guard to also require outcome.ok; keep existing success/no-updates messages.
6. Fix 3 (cadence.ts): change DEFAULT_MIN_MINUTES from 120 to 30; leave DEFAULT_MIN_TURNS=10, AND logic, and trial constants unchanged.
7. Fix 3 (README.md): update the Trigger cadence section text from 120 minutes to 30 minutes.
8. Tests (cadence_test.sh): change the env-parsing default-min-minutes assertion from 120 to 30; verify the explicit opts({minMinutes:120}) minutes-gate test still passes unchanged.
9. Tests (learn_test.sh): keep all existing assertions (exitCode 0 stub still writes index); add a case where a stub returning a non-zero exitCode does NOT write/advance the index and outcome.ok is false.
10. Run both scripts: bash extensions/continual-learning/test/cadence_test.sh and bash extensions/continual-learning/test/learn_test.sh; confirm both exit 0.

## Files likely
- `extensions/continual-learning/learn.ts`
- `extensions/continual-learning/index.ts`
- `extensions/continual-learning/cadence.ts`
- `extensions/continual-learning/README.md`
- `extensions/continual-learning/test/cadence_test.sh`
- `extensions/continual-learning/test/learn_test.sh`

## Risks
- buildUpdaterTask return type changes from string to { task, included }; only one caller (learn.ts:184) — must update that call site or compile/tests break.
- The existing per-round 'verify' gate in .pi/foreman.json runs Foreman's test suite, NOT continual-learning; it will pass regardless and won't catch regressions in this task. The actual acceptance check is the two continual-learning scripts (the controller's legacy verify), which I ran and confirmed pass before changes. Run those as the effective verification for this work.
- learn_test.sh asserts index.entries[...].mtimeMs after a successful (exit 0) pass; moving the refresh after the updater keeps this valid only because the stub returns exitCode 0 — ensure the new non-zero-exit case uses a separate path/file so it does not pollute the success assertions.
- The 'always include at least the first transcript even if over MAX_DIGEST_CHARS' rule is easy to drop with a naive slice/break; verify a single oversized transcript still yields included.length===1 and makes progress.
- Per-instruction .pi/foreman.json is reflected, not overwritten; proposedGates mirror the existing gates. If the controller wants the continual-learning scripts gated per-round, that is a config change outside this read-only plan.
- Tests import .ts modules directly via `node --input-type=module`, relying on Node's native TS type-stripping; a Node without TS-strip support would fail the scripts (it worked in this environment).

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
