# Plan: Build a new pi extension at extensions/AskUserQuestion/ that registers a tool named exactly AskUserQuestion, with FULL parity to Claude Code AskUserQuestion. Schema: { questions: [{ header: string, question: string, multiSelect: boolean, options: [{ label: string, description: string }] }] }. Behavior: in interactive mode (ctx.hasUI true) render an interactive dialog via ctx.ui.custom that lets the user move with arrow keys, select one option (or toggle multiple when multiSelect), optionally type a free-text note, and confirm; iterate through all questions in sequence; return a structured result mapping each question header to the chosen option label(s) plus any note. In headless mode (ctx.hasUI false) do NOT hang: return a structured result indicating UI is unavailable. Also write a unit test file extensions/AskUserQuestion/test/logic_test.sh (or .ts) that tests the pure selection logic (single vs multi toggle, notes) and the headless fallback shape, runnable without a live terminal. Keep the selection logic as a pure exported function so it is unit-testable. Cite pi UI primitives you rely on (ctx.ui.custom, Container/Text/Input from pi-tui).

- Working directory: /Users/a1241968/Desktop/Oscar/my-pi-harness
- Verify command: bash extensions/AskUserQuestion/test/logic_test.sh
- Developer: openai-codex/gpt-5.5:xhigh implements; controller runs verify (exit code = ground truth).
- Tester: cliproxy/claude-opus-4-8:high judges intent and catches cheats.
- Up to 3 fix rounds, then escalate.

