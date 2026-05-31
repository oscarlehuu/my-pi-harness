# Plan: Polish the per-choice note DISPLAY in extensions/AskUserQuestion/index.ts. Current behavior (index.ts around lines 263-281): the per-choice note line renders when (focused || selected || hasNote || editing), so a selected/focused option shows a Per-choice note placeholder even when no note text exists. The underlying DATA is already correct (empty notes are not stored/returned). Change ONLY the display rule: show the per-choice note line ONLY when the note actually has non-empty text OR the user is currently editing that note (focusState mode choice-note for that option index). Do NOT show the placeholder just because an option is focused or selected. When editing with empty text it must still show the input so the user can type. Keep the whole-question note section behavior unchanged. Do not change any stored data or the return shape. If feasible add a headless assertion in extensions/AskUserQuestion/test/logic_test.sh that the render decision for a per-choice note is false when the note is empty and not editing (extract the predicate into a pure exported function like shouldRenderChoiceNote(hasText, editing) and unit-test it).

- Working directory: /Users/a1241968/Desktop/Oscar/my-pi-harness
- Verify command: bash extensions/AskUserQuestion/test/logic_test.sh
- Developer: openai-codex/gpt-5.5:xhigh implements; controller runs verify (exit code = ground truth).
- Tester: cliproxy/claude-opus-4-8:high judges intent and catches cheats.
- Up to 3 fix rounds, then escalate.

