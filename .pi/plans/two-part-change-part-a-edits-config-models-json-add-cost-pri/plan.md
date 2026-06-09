# Plan: TWO-PART change. PART A edits config/models.json (add cost pricing). PART B restructures extensions/statusline/index.ts (2-line responsive footer + accurate cost incl. cache). Keep the verify green (STATUSLINE OK).

=== PART A: cost pricing in config/models.json ===
WHY: the footer shows $0.000 because config/models.json defines no `cost` for the models, so pi-ai calculateCost() (cost = model.cost.X/1e6 * usage.X) yields 0. Tokens are correct (counted directly). User runs via cliproxy (flat-rate subscription) so real marginal cost is $0; this is an *estimated API-equivalent* cost "for looks". Use the EXACT pricing pi ships for these models (per-million-token USD):
- claude-opus-4-8: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }
- gemini-3.5-flash-low: { input: 1.5, output: 9, cacheRead: 0.15, cacheWrite: 0 }   (pi's gemini-3.5-flash pricing)
EDIT: in config/models.json, add a `cost` object (those 4 keys, numbers) to BOTH model entries under providers.cliproxy.models. Change NOTHING else (keep id/name/reasoning/thinkingLevelMap/input/contextWindow/maxTokens, key order, tabs/spaces as in the file — it uses 2-space indent). Valid JSON (no trailing commas).
NOTE: config/models.json is symlinked to ~/.pi/agent/models.json by install.sh, so editing the repo file is correct; a pi restart/reload picks it up.

=== PART B: restructure index.ts to a 2-line responsive footer ===
CURRENT: single Line 1 packs session-name, context bar, branch(+git indicators), cwd, cost/tokens, and right-aligned model+thinking — it overflows and truncic the model away (the user's whole point). Line 2+ = preserved extension statuses. Keep all existing helpers (sanitizeStatusText, fmt), the FOREMAN INTEGRATION SEAM comment, the git background poll (execFile, 2.5s interval, refreshing guard, dispose clears interval+unsub), and the Line "ext-statuses" block — UNCHANGED in behavior.

NEW LAYOUT — render() returns these lines in order:
  LINE 1 (context/location group): [✎ session-name (accent)]  [⎇ branch (+warning git indicators)]  [cwd (dim)]
  LINE 2 (stats group): [context bar+% (themed)]  [↑in ↓out (dim)]  [$cost (dim)]   ...right-aligned... [model (+ • thinking) (dim)]
  LINE 3+ : extension statuses (UNCHANGED from current code).
Rationale: the 4 must-always-show signals (context%, model+thinking, branch+dirty, tokens+cost) are split across two balanced lines so nothing gets truncated at normal widths. Only LINE 2 has a right-aligned element (model), reuse the existing pad = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right))) + truncateToWidth(left+pad+right, width) pattern for LINE 2. LINE 1 is just leftParts.join("  ") then truncateToWidth(line, width) (no right element).

RESPONSIVE (degrade gracefully as width shrinks; compute with visibleWidth against the actual `width` arg):
- Define a width threshold NARROW = 60.
- LINE 1: if width < NARROW, DROP cwd first (it's the least critical). session-name + branch stay.
- LINE 2: the must-haves are context bar, model+thinking. If, after building LINE 2 left group, (visibleWidth(left) + 2 + visibleWidth(right)) > width, drop the cost segment first, then the tokens segment, recomputing each time, until it fits or only context bar remains. Never drop context bar or the right-side model. Always finish with truncateToWidth so no line exceeds width regardless.
- Keep it simple: a small helper that assembles a left-parts array, then while it doesn't fit and there are droppable parts, pop the lowest-priority one. Priority for LINE 2 left (drop order, lowest first): cost, tokens, (context bar never dropped).
- ALWAYS keep the existing per-line truncateToWidth safety net.

COST CALC (PART B side): the current render sums only m.usage.cost.total. KEEP summing usage.cost.total (now non-zero thanks to Part A) — do NOT recompute pricing in the extension (single source of truth = models.json + pi-ai). But ALSO include cache token cost: usage.cost.total already includes cacheRead+cacheWrite per pi-ai calculateCost, so simply summing cost.total is correct and complete. Just confirm the code sums cost.total (it does) — no math change needed; the $ becomes correct once Part A lands. Leave the ↑input ↓output token display as-is (it already shows totals).

DEFENSIVE: every value optional-chained; render() never throws; git only reads cached numbers (no spawn in render). No new deps (node:child_process already imported).

DOCS: update extensions/statusline/README.md "Overview" to describe the new 2-line layout (Line 1 = identity/location: session • branch • cwd; Line 2 = stats: context% • tokens • cost • model/thinking; Line 3+ = extension statuses) and the responsive drop order (cwd on Line 1; cost then tokens on Line 2; context bar and model never dropped). Add a one-liner under cost noting the value is an estimated API-equivalent cost derived from config/models.json pricing (real cliproxy subscription cost is flat). Keep the existing "Performance: git polling" and "Foreman integration (future)" sections.

CONSTRAINTS: ESM, tabs, harness style. Do not touch install.sh. Keep extension self-contained (no cross-extension imports). The module-eval verify must still print STATUSLINE OK (it only checks load + default export is a function; Part A's JSON isn't imported by the module, but DO sanity-check models.json is valid JSON as part of the work).

## Summary (fallback)
Implement the requested task in /Users/a1241968/Desktop/Oscar/my-pi-harness using the frontend track, then verify it through Foreman's deterministic dev/test loop.

## Steps
1. Confirm the relevant files and constraints before editing.
2. UI developer implements the smallest scoped change and records a structured handoff.
3. Controller runs the resolved per-round command gates and treats their exit codes as ground truth.
4. Tester judges intent, catches cheats, and sends failures back for another bounded fix round.
5. If verification succeeds, pause at Gate 2 for founder ship approval.

## Files likely
- (not identified by planner)

## Risks
- Planner model output was unavailable or invalid, so this deterministic template plan was used.
- Repo-specific edge cases may still be discovered by the developer/tester loop.

## Requirements
- (none detected)

## Proposed gates
- verify (per-round command) — command: `grep -q "claude-opus-4-8:xhigh" extensions/foreman/crew/planner.md && bash extensions/foreman/test/planner_timeout_test.sh && bash extensions/foreman/test/planner_test.sh && bash extensions/foreman/test/gates_test.sh && bash extensions/foreman/test/reviewer_test.sh && bash extensions/foreman/test/docer_test.sh && bash extensions/foreman/test/guard_test.sh && bash extensions/foreman/test/fallback_test.sh && bash extensions/foreman/test/ledger_test.sh && bash extensions/foreman/dashboard/test/reader_test.sh`
- review (pre-ship judge) — agent: reviewer
- commit (release action) — action: `commit`

## Proposed manifest
- Existing .pi/foreman.json is present and will be preserved.

## Execution
- Working directory: /Users/a1241968/Desktop/Oscar/my-pi-harness
- Track: frontend (ui-developer; auto-fallback to Opus xhigh on tool failure)
- UI developer: cliproxy/gemini-3.5-flash-low:high implements; controller-owned gates remain ground truth.
- Tester: cliproxy/claude-opus-4-8:high judges intent and catches cheats.
- Up to 3 fix rounds, then escalate.
