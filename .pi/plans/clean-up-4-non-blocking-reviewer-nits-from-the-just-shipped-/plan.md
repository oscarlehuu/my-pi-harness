# Plan: Clean up 4 NON-blocking reviewer nits from the just-shipped Foreman engagement feature (commit ac8068). These are cosmetic/quality polish ONLY — do not change any runtime behavior, the engagement semantics, the guard contract, the persisted file format, or any test's pass/fail meaning. The full suite must stay green.

Files: extensions/foreman/engagement.ts, extensions/foreman/index.ts, extensions/foreman/test/guard_test.sh.

NIT 1 — engagement.ts top-of-file doc comment:
Add a top-of-file block doc comment matching the style/voice of the sibling pure modules gates.ts, planner.ts, and ledger.ts (read those first to match tone). It should explain that engagement.ts is the pure / node-builtin-only persisted per-repo Foreman engagement store (out-of-tree at <agentDir>/foreman/engagement.json, only OFF overrides stored, default ON), with NO pi imports so it is headlessly unit-testable. Keep it concise (a short paragraph, like the others). Place it above the imports.

NIT 2 — engagement.ts setRepoEngagement signature/JSDoc:
setRepoEngagement currently returns RepoEngagement while the original spec text said ": void". KEEP the RepoEngagement return type (the guard_test.sh assertions and index.ts both rely on reading the post-write state — changing it to void would break the test). Instead, RECONCILE the inconsistency by adding a short JSDoc above setRepoEngagement documenting that it persists the change and RETURNS the freshly-read RepoEngagement for the repo (so callers can reflect the new state without a second read). Do not change its behavior or callers.

NIT 3 — guard_test.sh env/temp cleanup:
At the end of the engagement portion of guard_test.sh, EXPLICITLY clean up: delete process.env.FOREMAN_ENGAGEMENT_STORE (unset it) after the engagement assertions, and prefer creating the temp store dir under os.tmpdir() (e.g. fs.mkdtempSync(path.join(os.tmpdir(), "foreman-engagement-"))) rather than under os.homedir(), and remove that temp dir at the end (fs.rmSync(..., { recursive: true, force: true })). The existing assertions and their meaning must be unchanged; this only makes cleanup explicit and keeps tmp out of HOME. Confirm guard_test.sh still passes.

NIT 4 — index.ts redundant per-call I/O in the tool_call handler:
Currently every tool_call (including read-only tools) calls setForemanDirectStatus(ctx, root) — which does a findGitRoot tree-walk + engagement store read — and then repoEngagementActive(root) is read AGAIN on the next line, so the store is read twice per call. Tighten this WITHOUT changing behavior: compute engagement once per call (a single repoEngagementActive/readRepoEngagement read for the resolved root) and reuse that one value both for the status-line update and the gating decision, so the handler does a single store read instead of two. Keep the crew bypass (FOREMAN_CREW==="1") first, keep the status-line update behavior identical (still reflects current engagement), keep the cwd-fallback findRepoRoot and the NON_GIT hint logic identical. Do not regress the session_start or /foreman-direct or engage-param paths. Keep the helper functions usable; if setForemanDirectStatus is now redundant with the inlined read, you may refactor it to accept the already-known active boolean (e.g. setForemanDirectStatus(ctx, active)) and update its other callers (session_start, /foreman-direct, engage param) to pass the value they already computed — but only if it stays clean and all call sites remain correct.

CONSTRAINTS:
- Pure cosmetic/quality changes only. NO behavior change to engagement resolution, gating, persistence format, or status text.
- engagement.ts stays pure node/fs, no pi import.
- Do not touch guard.ts.
- Quota safety: do not touch the append-only system-prompt mechanism.
- The per-round verify gate runs the full suite (guard_test.sh included); all suites must pass. The reviewer gate must be able to APPROVE.

## Summary (planner)
Apply 4 non-blocking cosmetic/quality nits to the shipped Foreman engagement feature (commit ac8068): add a top-of-file doc comment to engagement.ts matching sibling pure modules; add JSDoc to setRepoEngagement explaining it returns the freshly-read RepoEngagement (keep the return type); make guard_test.sh tmp/env cleanup explicit and tmpdir-based; and collapse the duplicate engagement store read in index.ts's tool_call handler to a single read reused for status + gating. No runtime behavior, engagement semantics, guard contract, persisted format, or test pass/fail meaning changes. Full suite stays green.

## Steps
1. NIT 1: In extensions/foreman/engagement.ts, add a concise block doc comment above the imports, matching the gates.ts/planner.ts/ledger.ts voice ('Pure / node-builtin-only', 'headlessly unit-testable'): pure per-repo persisted engagement store at <agentDir>/foreman/engagement.json, only OFF overrides stored, default ON, no pi imports.
2. NIT 2: Add a short JSDoc above setRepoEngagement (engagement.ts:96) documenting it persists the change and returns the freshly-read RepoEngagement for the repo; keep the RepoEngagement return type and body unchanged.
3. NIT 3: In extensions/foreman/test/guard_test.sh, replace fs.mkdtempSync(path.join(os.homedir(), '.foreman-engagement-test.')) with fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-engagement-')); add delete process.env.FOREMAN_ENGAGEMENT_STORE after the engagement assertions; add explicit fs.rmSync(engagementTmp, { recursive: true, force: true }) at the end. Keep all existing assertions and their meaning unchanged.
4. NIT 4: In extensions/foreman/index.ts tool_call handler (lines ~1024-1036), compute repoEngagementActive(root) once and reuse it for both the status-line update and the gating decision (single store read). Refactor setForemanDirectStatus(ctx, root) to setForemanDirectStatus(ctx, active) and update the other 3 call sites (session_start, /foreman-direct, engage param) to pass the active value they already computed. Keep crew bypass first, status text, cwd-fallback findRepoRoot, and NON_GIT hint identical.
5. Run the resolved verify gate (full suite incl. guard_test.sh) and confirm green; visually confirm no behavior/format/status-text change.

## Files likely
- `extensions/foreman/engagement.ts`
- `extensions/foreman/index.ts`
- `extensions/foreman/test/guard_test.sh`

## Risks
- NIT 4 has the highest regression risk: setForemanDirectStatus is called from 4 sites (session_start:1021, tool_call:1028, /foreman-direct:1045, engage param:1101). If the signature changes to accept active:boolean, every call site must pass the correct post-write value or status text will desync — guard_test.sh asserts exact status text ('⚠ foreman-direct ON (repo)' vs undefined) across all paths. Mitigation: reuse setRepoEngagement's returned RepoEngagement (NIT 2) at the write sites; keep tool_call's single computed active.
- NIT 2 must NOT change the return type to void — guard_test.sh deepEquals setRepoEngagement(...) return values and index.ts reads post-write state; only add JSDoc.
- NIT 3: must keep FOREMAN_ENGAGEMENT_STORE set during the assertion blocks that need it; only unset AFTER engagement assertions, else later index.ts-driven assertions (indexStorePath) would break. Final rmSync must cover the tmpdir-based dir.
- Constraint adherence: do not touch guard.ts, the append-only system-prompt mechanism, or the persisted file format; engagement.ts must stay pi-import-free.
- Verify gate is heavy (greps planner.md + 8 shell suites + dashboard reader); a flaky/unrelated suite failure would block the round though changes are cosmetic.

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
