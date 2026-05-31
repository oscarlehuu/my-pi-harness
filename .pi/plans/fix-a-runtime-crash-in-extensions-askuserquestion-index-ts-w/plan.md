# Plan: Fix a runtime crash in extensions/AskUserQuestion/index.ts. When the dialog renders, pi throws: Unknown theme background color: accent — at renderQuestionTabs (index.ts:240) which calls this.theme.bg("accent", ...). The pi theme bg() only accepts these ThemeBg values: selectedBg, userMessageBg, customMessageBg, toolPendingBg, toolSuccessBg, toolErrorBg (verified in pi-src theme.ts:153). "accent" is a valid FOREGROUND (fg) color but NOT a valid background. Fix: for the ACTIVE/current question tab highlight, use a valid background color (selectedBg) instead of accent; keep inactive tabs as-is. Audit the ENTIRE file for ANY other theme.bg(...) calls using invalid color names and fix them the same way. Then add a guard to the test so this class of bug is caught headlessly: in extensions/AskUserQuestion/test/logic_test.sh, statically assert that every theme.bg("...") call in index.ts uses only the allowed ThemeBg names (grep the source and fail if any disallowed name like accent is passed to bg). Do not change behavior other than the color fix. Keep all existing features (tabs, arrow nav, space select, Tab note cycling, per-choice + whole-question notes, headless fallback).

- Working directory: /Users/a1241968/Desktop/Oscar/my-pi-harness
- Verify command: bash extensions/AskUserQuestion/test/logic_test.sh
- Developer: openai-codex/gpt-5.5:xhigh implements; controller runs verify (exit code = ground truth).
- Tester: cliproxy/claude-opus-4-8:high judges intent and catches cheats.
- Up to 3 fix rounds, then escalate.

