# Plan: Implement a doc-er documentation stage in Foreman that runs after the pre-ship reviewer APPROVEs and before Gate 2, writing/refreshing the repo's code & architecture docs to reflect the shipped change. It is SOFT (never blocks ship) and backed by a HARD drift-detector that always surfaces likely-stale docs to the founder.

FIRST read extensions/foreman/docs/INTERNALS.md — it is the code map (control flow, the pre-ship success block, the awaiting_ship transition, runAgentWithTimeout, AGENT_TIMEOUTS, formatIntentContract/readPersistedPlannerDraft, ship.ts staging, the NEVER-do list). Follow its extension recipes.

FOUNDER-APPROVED DECISIONS (implement exactly; do not re-litigate):
- doc-er model = cliproxy/claude-opus-4-8:high (NOT xhigh). Run it through runAgentWithTimeout with a new "doc-er" timeout role.
- doc-er writes ONLY under docs/ and extensions/*/docs/. It MUST NOT edit code and MUST NOT touch AGENTS.md (owned by continual-learning).
- SOFT: doc-er error/timeout/no-op -> log + flag + PROCEED to Gate 2; never add a hard DoD blocker. Mirror the reviewer-timeout graceful degradation.
- Update-in-place; create a new doc only when there is no existing home.

IMPLEMENT:
1. extensions/foreman/crew/doc-er.md — new crew agent, mirror reviewer.md structure, append-only system prompt. Frontmatter: name: doc-er, model: cliproxy/claude-opus-4-8:high, tools: read, grep, find, ls, bash, edit, write. Prompt: job = after approval, update code/architecture docs under docs/ and extensions/*/docs/ to reflect the shipped change, agent-friendly first (stable headers, file:line/function anchors, invariants, NEVER-do) then human-friendly; it receives the task + dev handoff (summary, filesChanged) + founder-approved intent contract; update-in-place; HARD BOUNDARIES (never edit code, never AGENTS.md, write nothing if nothing needs documenting); end with a machine line `DOC-ER: UPDATED <paths>` or `DOC-ER: NONE <reason>`.
2. index.ts — wire the stage in the success branch AFTER the pre-ship reviewer APPROVE and BEFORE `state.state = "awaiting_ship"`. Run via runAgentWithTimeout timeoutRole "doc-er"; on timeout/error/non-zero exit degrade gracefully (appendLog a doc_er_* event + writeActivity note, mark flagged for Gate 2, never block). Pass task + dev handoff summary/filesChanged + intent contract (reuse formatIntentContract + readPersistedPlannerDraft). Parse the DOC-ER: line; record updated doc paths so the release commit stages them with the task.
3. extensions/foreman/agent-timeouts.ts — add "doc-er" to AgentTimeoutRole, DEFAULT_AGENT_TIMEOUTS_MS (idle 180000 / max 720000), and ROLE_ENV_PREFIX ("DOC_ER"). Keep pure/node-builtin-only.
4. Drift-detector — a pure, headlessly-testable helper (small new module e.g. docdrift.ts, or an existing pure module) that takes the task's changed code paths + the repo's doc files and flags docs likely gone stale: a changed code path is referenced by a doc that the doc-er did NOT update this task. Advisory only, but ALWAYS surfaced.
5. Gate 2 surfacing — include doc-er outcome (UPDATED <paths> / NONE / TIMED-OUT) and any drift warning ("docs may be stale: <files>") in the Gate 2 emit and the ledger, so the founder sees doc status in the ship decision. Do NOT make it a hard DoD blocker.

TESTS (headless pure-data; ensure they run under the per-round verify gate):
- agent-timeouts: resolveAgentTimeouts(env,"doc-er") default 180000/720000 + FOREMAN_DOC_ER_IDLE_MS/_MAX_MS overrides.
- drift-detector: changed code path referenced by an un-updated doc -> flagged; updated doc -> not flagged; unreferenced -> not flagged.
- grep-guard on index.ts: doc-er invoked via runAgentWithTimeout in the pre-ship success path with graceful degradation; doc-er.md has model high + the docs-only / never-AGENTS.md / never-code boundaries.
- Preserve ALL existing tests (extractJsonBlock regression, intent injection, model-line greps, planner/reviewer budgets).

CONSTRAINTS:
- SOFT: never block ship; drift-detector advisory only.
- Quota safety: doc-er is cliproxy -> append-only system prompt (--append-system-prompt), never --system-prompt.
- planner.ts/gates.ts/agent-timeouts.ts and any new helper stay pure/node-builtin-only.
- Do not touch models.json. doc-er docs-only enforced via tools allowlist + prompt boundaries (guard already treats .md/docs as no-impact).
- Commit gate stages only the task's filesChanged + doc-er doc paths + ledger; never git add -A.

VERIFY: the .pi/foreman.json per-round gate runs the full headless suite; new tests must run in that path and all stay green.

## Summary (planner)
Add a SOFT doc-er documentation stage to Foreman that runs after pre-ship reviewer APPROVE and before Gate 2 (index.ts:2073). It refreshes docs under docs/ and extensions/*/docs/ via a new crew agent (cliproxy/claude-opus-4-8:high) through runAgentWithTimeout with a new 'doc-er' timeout role, mirroring reviewer graceful degradation so timeout/error/no-op logs+flags and proceeds, never blocking ship or adding a DoD blocker. A pure docdrift.ts helper flags docs that reference changed code paths but weren't updated this task; doc-er outcome + drift warning surface in the Gate 2 emit and ledger. Updated doc paths are recorded so the release commit stages them path-scoped with the task. New headless tests are added to the per-round verify gate.

## Steps
1. agent-timeouts.ts: add 'doc-er' to AgentTimeoutRole, AGENT_TIMEOUT_ROLES, DEFAULT_AGENT_TIMEOUTS_MS (idle 180000 / max 720000), ROLE_ENV_PREFIX ('DOC_ER'), and resolveAllAgentTimeouts; keep pure/node-builtin-only. doc-er has no degradation mapping (SOFT proceed), so decideAgentTimeoutDegradation falls through to a benign default.
2. crew/doc-er.md: new agent mirroring reviewer.md structure with append-only prompt. Frontmatter name: doc-er, model: cliproxy/claude-opus-4-8:high, tools: read, grep, find, ls, bash, edit, write. Prompt: job = after approval, update code/architecture docs under docs/ and extensions/*/docs/ to reflect the shipped change; agent-friendly first (stable headers, file:line/function anchors, invariants, NEVER-do) then human-friendly; receives task + dev handoff (summary, filesChanged) + founder-approved intent contract; update-in-place, create only when no existing home; HARD BOUNDARIES never edit code / never AGENTS.md / write nothing if nothing needs documenting; end with machine line 'DOC-ER: UPDATED <paths>' or 'DOC-ER: NONE <reason>'.
3. docdrift.ts: new pure module (node-builtin-only, no pi imports). Export a parser for the DOC-ER line and a detectDocDrift(changedCodePaths, docFilesWithRefs, updatedDocPaths) that flags docs referencing a changed code path that doc-er did NOT update this task; advisory-only output (list of stale doc files).
4. index.ts: add a doc-er task builder (reusing formatIntentContract + readPersistedPlannerDraft for the intent contract and readShipHandoffContext/dev handoff for summary+filesChanged) near reviewerTaskFor (index.ts:591).
5. index.ts: wire the stage in the pre-ship success branch AFTER the judge loop completes (no reopen) and the pre_ship_passed log, BEFORE state.state = 'awaiting_ship' (index.ts:2073-2075). Run loadAgent('doc-er') via runAgentWithTimeout with role 'doc-er'; wrap in try/catch + stopSpinner finally; on timeout/error/non-zero exit appendLog a doc_er_* event + writeActivity flag note and PROCEED (never reopen, never block). Parse the DOC-ER line; appendLog the updated paths.
6. index.ts: run detectDocDrift over the task's changed code paths and repo doc files vs doc-er's updated paths; appendLog a doc_drift event with any stale-doc list.
7. index.ts: surface doc-er outcome (UPDATED <paths> / NONE / TIMED-OUT) and any drift warning ('docs may be stale: <files>') in the Gate 2 emit (index.ts:2078-2090) and in the gate2_awaiting ledger event; do NOT add a DoD blocker in done.ts.
8. index.ts: extend readShipHandoffContext (index.ts:927) to fold doc-er updated paths (from the doc_er log event) into filesChanged so resolveStagePaths stages them path-scoped at release; preserve never-whole-tree semantics.
9. test/planner_timeout_test.sh: extend with resolveAgentTimeouts(env,'doc-er') default 180000/720000 and FOREMAN_DOC_ER_IDLE_MS/_MAX_MS overrides (already in verify path).
10. test/docdrift_test.sh: new headless test — changed code path referenced by an un-updated doc -> flagged; updated doc -> not flagged; unreferenced -> not flagged; plus DOC-ER line parsing.
11. test/doc_er_test.sh: new headless grep-guard — index.ts invokes doc-er via runAgentWithTimeout in the pre-ship success path with graceful degradation and before awaiting_ship; doc-er.md has model high, docs-only tools allowlist, never-AGENTS.md / never-code boundaries, and the DOC-ER machine line.
12. Extend the .pi/foreman.json verify gate command to also run docdrift_test.sh and doc_er_test.sh so the new tests run under the per-round gate; preserve all existing test invocations and greps (xhigh planner model line, planner/gates/reviewer/guard/fallback/ledger/reader).
13. Run the full verify suite headlessly to confirm all existing + new tests stay green (extractJsonBlock regression, intent injection, model-line greps, planner/reviewer budgets).

## Files likely
- `extensions/foreman/crew/doc-er.md`
- `extensions/foreman/agent-timeouts.ts`
- `extensions/foreman/docdrift.ts`
- `extensions/foreman/index.ts`
- `extensions/foreman/test/docdrift_test.sh`
- `extensions/foreman/test/doc_er_test.sh`
- `extensions/foreman/test/planner_timeout_test.sh`
- `.pi/foreman.json`
- `extensions/foreman/docs/INTERNALS.md`

## Risks
- Gate 2 emit/ledger surfacing must be additive and advisory: do NOT touch done.ts/evaluateDoneness so doc-er/drift never becomes a hard DoD blocker (INTERNALS 07; index.ts:1541-1555).
- Retry-context footgun (INTERNALS 09): doc-er runs only on the terminal APPROVE->Gate 2 transition (post-loop), so it should NOT be injected into the per-round devContext; ensure it does not fire on reopen paths.
- Staging: doc-er paths must merge into filesChanged via readShipHandoffContext so resolveStagePaths keeps path-scoped staging; never git add -A (INTERNALS 09; ship.ts:110-145).
- Quota safety: doc-er is cliproxy -> must go through the runAgent --append-system-prompt seam (index.ts:258), never --system-prompt.
- Purity: agent-timeouts.ts and the new docdrift.ts must stay node-builtin-only with no pi SDK/TUI imports (INTERNALS 09).
- doc-er has edit/write tools; docs-only is enforced only by the tools allowlist + prompt boundaries + the guard's prose/docs no-impact rule — there is no hard runtime path-confinement, so the prompt boundaries and grep-guard test are the safeguard against editing code or AGENTS.md.
- Verify gate runs only a subset of test/*.sh; new tests are inert unless appended to the verify command, so the .pi/foreman.json command edit is required for the per-round gate to cover them.
- Assumption: doc-er runs once per ship, not per round; if multiple pre-ship judge gates exist it must run once after all approve.
- decideAgentTimeoutDegradation currently returns the reviewer branch as its default fall-through; adding 'doc-er' there needs an explicit benign 'none'/proceed mapping so a doc-er timeout is not mis-degraded as a reviewer-inconclusive.

## Requirements
### Env vars/secrets
- ✗ FOREMAN_DOC_ER_IDLE_MS — new optional override for doc-er idle timeout (default 180000)
- ✗ FOREMAN_DOC_ER_MAX_MS — new optional override for doc-er max runtime (default 720000)
- ✗ FOREMAN_CREW — existing crew-subprocess marker set by transport; doc-er runs as crew
- ✗ PI_CODING_AGENT_DIR — existing optional charter location read by crew agents
### CLI tools/binaries
- ✓ node — headless tests run via node --input-type=module importing .ts modules
- ✓ bash — test scripts and command gate are bash
- ✓ git — release commit action stages path-scoped changes incl. doc-er doc paths
- ✓ grep — verify gate greps model lines and source for guard assertions
- ✓ pi — crew subprocess transport that launches the doc-er agent
### Services/runtimes
- ? cliproxy — model routing for doc-er (cliproxy/claude-opus-4-8:high); append-only prompt required for quota safety

## Proposed gates
- verify (per-round command) — command: `grep -q "claude-opus-4-8:xhigh" extensions/foreman/crew/planner.md && bash extensions/foreman/test/planner_timeout_test.sh && bash extensions/foreman/test/planner_test.sh && bash extensions/foreman/test/gates_test.sh && bash extensions/foreman/test/reviewer_test.sh && bash extensions/foreman/test/guard_test.sh && bash extensions/foreman/test/fallback_test.sh && bash extensions/foreman/test/ledger_test.sh && bash extensions/foreman/dashboard/test/reader_test.sh && bash extensions/foreman/test/docdrift_test.sh && bash extensions/foreman/test/doc_er_test.sh`
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
