# Plan: Rework the AskUserQuestion dialog keybindings in extensions/AskUserQuestion/index.ts (UI wiring only; do NOT change logic.ts exports, which are still covered by tests).

Goal: stop using ←/→ to move between question tabs (it "keeps moving" while the user is trying to position the text cursor in a note), and make note-editing use a dedicated key.

New keymap for the dialog:
- Tab → move to the NEXT question. It cycles forward and wraps (last question → first question). Tab must work both in options mode AND while editing a note (save the active note first, then advance).
- e → add/edit the per-choice note for the currently focused option. Only when the focused row is a real option (NOT the Custom answer row — on the Custom answer row, 'e' must type normally into the inline custom input). Opening the note enters choice-note focus mode for that option index.
- Esc → save the active note and return to options (this is the ONLY way to leave the note editor now). Do not bind Enter to leave the note; remove the noteInput.onSubmit handler so Enter no longer cycles focus out of the note.
- ↑/↓ → move option focus (unchanged).
- Space → select/toggle focused option (unchanged).
- Enter (in options mode) → next question / submit on last (unchanged behavior via decideOptionListEnterAction).
- Remove ←/→ question-tab switching entirely. ←/→ are now free for text-cursor movement inside the note input.

Concrete edits already drafted (apply these):
1. Imports from "./logic.ts": remove `cycleFocusMode`; add `setCurrentQuestionIndex`.
2. Constructor: remove the `this.noteInput.onSubmit = ...` assignment (keep `onEscape` calling saveActiveNoteAndReturnToOptions).
3. handleInput, note-mode branch (when focusState.mode !== "options"): handle Esc → saveActiveNoteAndReturnToOptions; handle Tab → goToNextQuestion; otherwise pass to noteInput. Remove the Enter→cycle and Tab→cycle handling.
4. handleInput, options-mode branch: remove the Key.left → switchQuestionTab(-1) and Key.right → switchQuestionTab(1) blocks; remove the Key.tab → cycleFocusedArea block. Add: Tab → goToNextQuestion; and `e` (matchesKey(data, "e")) when NOT customFocused → openFocusedChoiceNote. Keep Space/Enter/custom-typing as-is.
5. Replace the cycleFocusedArea() method with two methods:
   - goToNextQuestion(): saveActiveNoteFromInput(); if more than one question, set currentQuestionIndex to (current+1) % length via setCurrentQuestionIndex; focusState = returnFocusToOptions(); prepareCustomInputForFocus(); clear status; refresh().
   - openFocusedChoiceNote(): if focusedIndex is a real option (>=0 and < options.length): saveActiveNoteFromInput(); focusState = { mode: "choice-note", activeChoiceNoteIndex: focusedIndex }; prepareNoteInputForFocus(); clear status; refresh(). Otherwise no-op.
6. switchQuestionTab is now only referenced by handleOptionListEnter (the Enter "advance" path). Keep switchQuestionTab for that advance/submit flow, OR repoint handleOptionListEnter's "advance" to goToNextQuestion — but preserve the existing submit-on-last behavior and the "Answer each question before submitting" completeness check. Pick whichever keeps Enter's submit semantics intact; do not break submitIfComplete.
7. Update helpText() to: "Tab next question • ↑/↓ move • Space select/toggle • e add note • Enter next (submit on last) • Esc exit note • type on Custom answer".

Keep everything else (rendering, custom-answer inline input, multi-select, structured result) unchanged.

## Summary (planner)
Rework AskUserQuestion dialog keybindings in extensions/AskUserQuestion/index.ts (UI wiring only): Tab now advances to the next question and wraps (works in options mode and while editing a note, saving first); 'e' opens the per-choice note for a focused real option (not on the Custom answer row, where 'e' types normally); Esc is the only way to leave the note editor; ←/→ question-tab switching is removed so arrows are free for cursor movement in the note; ↑/↓, Space, and Enter behavior preserved. logic.ts is NOT modified (its exports remain covered by logic_test.sh).

## Steps
1. Imports from './logic.ts': remove cycleFocusMode; add setCurrentQuestionIndex. Leave moveQuestion/returnFocusToOptions imports (still used by switchQuestionTab and submitIfComplete).
2. Constructor: delete the this.noteInput.onSubmit assignment; keep noteInput.onEscape -> saveActiveNoteAndReturnToOptions.
3. handleInput note-mode branch (focusState.mode !== 'options'): handle Esc -> saveActiveNoteAndReturnToOptions; Tab -> goToNextQuestion; otherwise delegate to noteInput. Remove the Enter->cycleFocusedArea and Tab->cycleFocusedArea handling.
4. handleInput options-mode branch: remove Key.left->switchQuestionTab(-1), Key.right->switchQuestionTab(1), and Key.tab->cycleFocusedArea blocks. Add Tab->goToNextQuestion and matchesKey(data,'e') (when NOT customFocused) -> openFocusedChoiceNote. Keep ↑/↓, Space toggle, Enter->handleOptionListEnter, and custom inline typing unchanged.
5. Replace cycleFocusedArea() with goToNextQuestion(): saveActiveNoteFromInput(); if questions.length > 1 set currentQuestionIndex to (current+1)%length via setCurrentQuestionIndex; focusState = returnFocusToOptions(); prepareCustomInputForFocus(); clear statusMessage; refresh().
6. Add openFocusedChoiceNote(): if focusedIndex is a real option (>=0 and < options.length): saveActiveNoteFromInput(); focusState = { mode:'choice-note', activeChoiceNoteIndex: focusedIndex }; prepareNoteInputForFocus(); clear statusMessage; refresh(); else no-op.
7. Keep switchQuestionTab as the Enter advance/submit path in handleOptionListEnter; do not alter submitIfComplete or the 'Answer each question before submitting' completeness check.
8. Update helpText() to: 'Tab next question • ↑/↓ move • Space select/toggle • e add note • Enter next (submit on last) • Esc exit note • type on Custom answer'.
9. Verify: run bash extensions/AskUserQuestion/test/logic_test.sh (must still pass; logic.ts unchanged) and the tsc check on index.ts (no blocking TS errors).

## Files likely
- `extensions/AskUserQuestion/index.ts`

## Risks
- Automated coverage gap: logic_test.sh asserts logic.ts only (incl. cycleFocusMode/moveQuestion) and does not drive index.ts keyboard input, so the new Tab-cycle, 'e', and Esc-only behaviors are not exercised by the gate; verify manually in the TUI.
- The configured foreman 'verify' gate tests the foreman extension, not AskUserQuestion, so it will not validate this change; the relevant check is the legacy logic_test.sh + tsc fallback (verified working in recon).
- Removing cycleFocusMode from index.ts imports must be paired with deleting its only use (cycleFocusedArea) or tsc will flag an unused/undefined symbol; cycleFocusMode stays exported in logic.ts.
- 'e' must be gated on !customFocused so it still types into the inline Custom answer input; a missed guard would break custom text entry.
- Tab/Esc paths must call saveActiveNoteFromInput before leaving the note or in-progress note text is lost; goToNextQuestion and saveActiveNoteAndReturnToOptions both save first.
- logic_test.sh guards index.ts against disallowed theme.bg colors and whole-question-note patterns (setNote/question-note/etc.); new helpText and method names avoid these but must be re-checked after edits.
- tsc fallback runs via npx and downloads TypeScript (no local install); an offline environment would block that half of the check. Expected 'Cannot find module' for pi/typebox deps is filtered out.
- Keeping switchQuestionTab only for the Enter advance path is intentional to preserve submit-on-last semantics; do not repoint it in a way that changes submitIfComplete behavior.

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
- Track: frontend (ui-developer; auto-fallback to Opus xhigh on tool failure)
- UI developer: cliproxy/gemini-3.5-flash-low:high implements; controller-owned gates remain ground truth.
- Tester: cliproxy/claude-opus-4-8:high judges intent and catches cheats.
- Up to 3 fix rounds, then escalate.
