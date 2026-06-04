# Plan: In extensions/foreman/dashboard/view.ts, standardize the dashboard's back-navigation title marker to a literal "<" so it is consistent across all screens.

Two changes, both in the header `borderTitle(...)` calls inside the render methods:

1. Root/task screen (renderRoot, around line 510): the title currently has NO back marker. Change the left title from `"FOREMAN"` to a back marker form `"< FOREMAN"`.
   - Current: `this.borderTitle("FOREMAN", `task: ${task?.slug ?? view.slug}`, width),`
   - New: `this.borderTitle(`< FOREMAN`, `task: ${task?.slug ?? view.slug}`, width),`

2. Agent/transcript screen (renderAgent, around line 545): the left title currently begins with the arrow glyph `←`. Replace that leading `←` with a literal `<`.
   - Current: `this.borderTitle(`← ${view.role} · round ${view.round}`, `${start?.model ?? "model?"}   ${running}`, width),`
   - New: `this.borderTitle(`< ${view.role} · round ${view.round}`, `${start?.model ?? "model?"}   ${running}`, width),`

Do NOT change:
- The picker (top-level) screen title `borderTitle("FOREMAN", ...)` at ~line 480 — it is the root screen with nowhere to go back to.
- The footer key-hint lines that mention `←/Esc` (these describe the physical arrow key, not a title marker).
- The transcript tool-result line that prefixes output with `← ` (~line 626) — unrelated.

Net effect: the root/task screen title reads `< FOREMAN`, and the agent screen title reads `< <role> · round N`, matching the same `<` back-marker convention.

## Summary (planner)
Standardize the dashboard back-navigation title marker to a literal '<' in extensions/foreman/dashboard/view.ts: add '< ' to the root/task header title (view.ts:510, 'FOREMAN' -> '< FOREMAN') and replace the leading '←' glyph with '<' in the agent/transcript header title (view.ts:545). Leave the picker root title (view.ts:480), footer '←/Esc' key hints, and the tool-result '← ' prefix (view.ts:626) unchanged.

## Steps
1. Read view.ts around lines 470-560 to confirm exact text of the two target borderTitle calls (already inspected; renderRoot at 510, renderAgent at 545).
2. Edit view.ts:510 in renderRoot: change this.borderTitle("FOREMAN", `task: ${task?.slug ?? view.slug}`, width) to this.borderTitle(`< FOREMAN`, `task: ${task?.slug ?? view.slug}`, width).
3. Edit view.ts:545 in renderAgent: change the leading '←' to '<' so it reads this.borderTitle(`< ${view.role} · round ${view.round}`, `${start?.model ?? "model?"} ${running}`, width).
4. Confirm the picker title at view.ts:480, footer '←/Esc' hints, and the tool_result '← ' preview prefix at view.ts:626 remain unchanged.
5. Verify: run the existing 'verify' gate command from .pi/foreman.json (test suite incl. dashboard reader_test.sh); additionally spot-check with grep that exactly two borderTitle calls now begin with '< ' and no borderTitle call still begins with '←'.

## Files likely
- `extensions/foreman/dashboard/view.ts`

## Risks
- Multibyte glyph: the '←' at view.ts:545 is a multibyte UTF-8 char; the edit must replace the glyph itself, not a stray byte, to avoid corrupting the string.
- Over-reach: must NOT touch the picker title (view.ts:480), footer '←/Esc' hints, or the tool-result '← ' prefix (view.ts:626); these share similar tokens but are out of scope.
- No type-check gate available: there is no extensions/foreman/tsconfig.json or root tsconfig/package.json, so the legacy command's 'npx tsc --noEmit -p extensions/foreman' would fail and is intentionally not proposed; correctness is covered by the existing bash/node test suite.
- These are template-literal string edits only (no logic change), so the existing tests assert behavior/reader output, not the literal title strings; the title change itself is validated by the grep spot-check rather than an existing assertion.
- Assumption: '<' is intended as a plain ASCII literal (not an escaped/HTML entity), consistent with the task description.

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
