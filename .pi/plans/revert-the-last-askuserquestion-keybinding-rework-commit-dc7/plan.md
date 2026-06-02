# Plan: Revert the last AskUserQuestion keybinding rework (commit dc7d213) in extensions/AskUserQuestion/index.ts ONLY (do NOT modify logic.ts — its exports are covered by logic_test.sh), then add a small enhancement. UI wiring only.

CONTEXT / WHY:
- Commit dc7d213 changed the dialog keys to: Tab = next question, e = open per-choice note, and REMOVED ←/→ question-tab switching. The founder wants to revert to the prior scheme where Tab toggles the per-choice note and ←/→ switch question tabs.
- There is also an UNCOMMITTED working-tree change that adds "Esc closes the whole dialog" in options mode (this.done(null)) plus a helpText tweak. PRESERVE the Esc-closes-dialog behavior; do not drop it.
- After reverting, fix the original bottleneck (←/→ "keeps moving" / only moves one char while editing a note) by making ←/→ move the text cursor WORD-BY-WORD inside the note input while in note-edit mode.

TARGET BEHAVIOR (final):
OPTIONS mode:
- ↑/↓ → move option focus (unchanged)
- ←/→ → switch question tabs: left = switchQuestionTab(-1), right = switchQuestionTab(1) (RESTORED from pre-rework)
- Tab → cycleFocusedArea() (toggle into the per-choice note for the focused real option; on the Custom answer row it stays in options, same as pre-rework cycleFocusMode)
- Space → toggle select (unchanged)
- Enter → handleOptionListEnter() (next question / submit on last — unchanged)
- Esc → this.done(null) to CLOSE the dialog (KEEP the uncommitted change)
- typing on the Custom answer row → inline custom input (unchanged)

NOTE-EDIT mode (focusState.mode !== "options"):
- Tab → cycleFocusedArea() (toggle back to options) [founder chose this]
- Enter → cycleFocusedArea() (back to options; restore noteInput.onSubmit in constructor)
- Esc → saveActiveNoteAndReturnToOptions() (save note, return to options)
- ←/→ → move the note text cursor WORD-BY-WORD (NEW bottleneck fix), NOT between questions and NOT one char at a time. Implement by translating the arrow before delegating to the note Input: if matchesKey(data, Key.left) set data = "\x1bb"; else if matchesKey(data, Key.right) set data = "\x1bf"; then call this.noteInput.handleInput(data) as usual. (\x1bb = alt+b and \x1bf = alt+f map to the pi-tui Input's cursorWordLeft / cursorWordRight — verified working.) Add a short comment explaining this. All other keys → this.noteInput.handleInput(data) (unchanged), then saveActiveNoteFromInput() + refresh() as before.

CONCRETE EDITS to extensions/AskUserQuestion/index.ts:
1. Imports from "./logic.ts": remove `setCurrentQuestionIndex`; add back `cycleFocusMode`.
2. Constructor: restore `this.noteInput.onSubmit = () => { this.cycleFocusedArea(); };` (keep the existing onEscape = saveActiveNoteAndReturnToOptions).
3. handleInput note-mode branch: restore Tab → cycleFocusedArea, Esc → saveActiveNoteAndReturnToOptions, Enter → cycleFocusedArea. Add the ←/→ → word-move translation described above immediately before the `this.noteInput.handleInput(data)` delegation.
4. handleInput options-mode branch: KEEP the uncommitted `if (matchesKey(data, Key.escape)) { this.done(null); return; }`. Restore `if (matchesKey(data, Key.left)) { this.switchQuestionTab(-1); return; }` and `if (matchesKey(data, Key.right)) { this.switchQuestionTab(1); return; }` and `if (matchesKey(data, Key.tab)) { this.cycleFocusedArea(); return; }`. REMOVE the `e` → openFocusedChoiceNote block and the Tab → goToNextQuestion block added by dc7d213. Keep ↑/↓, Space, Enter, and custom inline typing unchanged.
5. Methods: REMOVE goToNextQuestion() and openFocusedChoiceNote() (added by dc7d213). RESTORE the cycleFocusedArea() method exactly as in the pre-rework version: saveActiveNoteFromInput(); this.focusState = cycleFocusMode(this.currentQuestion(), this.currentState(), this.focusState); prepareNoteInputForFocus(); prepareCustomInputForFocus(); statusMessage = ""; refresh();. Keep switchQuestionTab(), handleOptionListEnter(), submitIfComplete() as they are (switchQuestionTab is used by ←/→ and the Enter advance path).
6. helpText(): set to exactly:
"←/→ tabs (word-move in note) • ↑/↓ options • Space select/toggle • Tab note⇄options • Enter next (submit on last) • Esc close (exit note) • type on Custom answer"

CONSTRAINTS:
- Do NOT touch logic.ts. Do NOT reintroduce any whole-question-note patterns (setNote/question-note/whole-question/answer.note/noteParts) — logic_test.sh guards index.ts against them. Do NOT use disallowed theme.bg colors (only selectedBg etc. are allowed).
- Keep rendering, custom-answer inline input, multi-select, and structured result unchanged.

VERIFY: run `bash extensions/AskUserQuestion/test/logic_test.sh` — it must pass (it lints index.ts for forbidden patterns/theme.bg and runs the pure logic tests). The keyboard behavior itself isn't covered by automated tests, so also sanity-check by reading the diff that ←/→ map to switchQuestionTab in options mode and to \x1bb/\x1bf word-move in note mode, and that Esc closes the dialog in options mode.

## Summary (planner)
Read-only Gate 1 plan: revert dc7d213's AskUserQuestion keybinding rework in extensions/AskUserQuestion/index.ts ONLY (restore Tab=note⇄options via cycleFocusedArea and ←/→=switchQuestionTab), PRESERVE the uncommitted options-mode 'Esc closes dialog' (this.done(null)), and add the bottleneck fix: in note-edit mode translate ←/→ to \x1bb/\x1bf (alt+b/alt+f) so the note Input moves the text cursor word-by-word. logic.ts is untouched (guarded by logic_test.sh). Verified: cycleFocusMode and setCurrentQuestionIndex both exist in logic.ts so the import swap is valid; logic_test.sh passes at baseline.

## Steps
1. Imports from './logic.ts': remove setCurrentQuestionIndex (only used by goToNextQuestion which is being deleted) and add cycleFocusMode back (used by restored cycleFocusedArea). Both verified present in logic.ts.
2. Constructor: restore this.noteInput.onSubmit = () => { this.cycleFocusedArea(); }; keep the existing this.noteInput.onEscape = () => this.saveActiveNoteAndReturnToOptions().
3. handleInput note-mode branch (focusState.mode !== 'options'): Tab -> cycleFocusedArea(); Esc -> saveActiveNoteAndReturnToOptions(); Enter -> cycleFocusedArea(). Immediately before this.noteInput.handleInput(data), add the word-move translation with a short comment: if matchesKey(data, Key.left) data = '\x1bb'; else if matchesKey(data, Key.right) data = '\x1bf'; (alt+b/alt+f map to the pi-tui Input cursorWordLeft/cursorWordRight). All other keys delegate to noteInput.handleInput(data) then saveActiveNoteFromInput() + refresh() as before.
4. handleInput options-mode branch: KEEP the uncommitted if (matchesKey(data, Key.escape)) { this.done(null); return; }. Restore left -> switchQuestionTab(-1), right -> switchQuestionTab(1), Tab -> cycleFocusedArea(). REMOVE the 'e' -> openFocusedChoiceNote block and the Tab -> goToNextQuestion block from dc7d213. Leave up/down, space/toggle, Enter -> handleOptionListEnter, and Custom-row inline typing unchanged.
5. Methods: delete goToNextQuestion() and openFocusedChoiceNote(); restore cycleFocusedArea() exactly: saveActiveNoteFromInput(); this.focusState = cycleFocusMode(this.currentQuestion(), this.currentState(), this.focusState); prepareNoteInputForFocus(); prepareCustomInputForFocus(); statusMessage=''; refresh(). Leave switchQuestionTab(), handleOptionListEnter(), submitIfComplete() unchanged.
6. helpText(): set the string to exactly '←/→ tabs (word-move in note) • ↑/↓ options • Space select/toggle • Tab note⇄options • Enter next (submit on last) • Esc close (exit note) • type on Custom answer' (keep the theme.fg('dim', ...) wrapper).
7. Verify: run `bash extensions/AskUserQuestion/test/logic_test.sh` (must pass). Then read the diff to confirm: options-mode ←/→ call switchQuestionTab(∓1); note-mode ←/→ become \x1bb/\x1bf before noteInput.handleInput; options-mode Esc calls this.done(null); no goToNextQuestion/openFocusedChoiceNote/setCurrentQuestionIndex remain; no forbidden note/theme.bg patterns introduced.

## Files likely
- `extensions/AskUserQuestion/index.ts (only edit target)`
- `extensions/AskUserQuestion/test/logic_test.sh (verifier; read-only)`
- `extensions/AskUserQuestion/logic.ts (read-only reference for cycleFocusMode signature; MUST NOT edit)`

## Risks
- pi-tui is runtime-provided (no local node_modules), so the \x1bb/\x1bf -> cursorWordLeft/cursorWordRight mapping cannot be statically verified here; task states it is pre-verified working and word-move behavior is not covered by automated tests. If Input ignored these escapes, note-mode ←/→ would no-op or insert chars — sanity-check by reading the diff and, if possible, a live dialog smoke test.
- logic_test.sh greps index.ts for forbidden literals (question-note|Question note|whole-question|setNote|answer.note|noteParts); the new word-move comment must avoid these exact strings (use wording like 'alt+b/alt+f word-move in the per-choice note input').
- logic_test.sh does NOT type-check index.ts (only greps + runs logic.ts via node), so a TS error in index.ts would pass the gate; mitigate by careful diff review (e.g. ensure setCurrentQuestionIndex import is removed to avoid an unused import and cycleFocusMode is added).
- Must not drop the uncommitted options-mode Esc->this.done(null) block during the revert; reverting dc7d213 mechanically (e.g. git checkout) would also wipe the uncommitted Esc change, so edits must be surgical/manual.
- Gate-mapping caveat: .pi/foreman.json's stored `verify` command runs the foreman extension test suite, which does NOT exercise extensions/AskUserQuestion. The task-relevant, verified per-round check for this change is `bash extensions/AskUserQuestion/test/logic_test.sh` (ran green at baseline). I am NOT proposing to overwrite foreman.json; proposedGates reflects the existing gate set but substitutes the task-appropriate verify command surfaced for the controller.

## Requirements
- (none detected)

## Proposed gates
- verify (per-round command) — command: `bash extensions/AskUserQuestion/test/logic_test.sh`
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
