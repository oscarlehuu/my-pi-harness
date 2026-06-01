#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
export ROOT_DIR

INDEX_TS="${ROOT_DIR}/extensions/AskUserQuestion/index.ts"
LOGIC_TS="${ROOT_DIR}/extensions/AskUserQuestion/logic.ts"
ALLOWED_THEME_BG='^(selectedBg|userMessageBg|customMessageBg|toolPendingBg|toolSuccessBg|toolErrorBg)$'
BG_CALLS="$(grep -nEo 'theme\.bg\("[^"]+"' "${INDEX_TS}" || true)"
INVALID_BG_CALLS="$(
  while IFS= read -r call; do
    [[ -z "${call}" ]] && continue
    source_line="${call#*:}"
    color="${source_line#theme.bg(\"}"
    color="${color%%\"*}"
    if [[ ! "${color}" =~ ${ALLOWED_THEME_BG} ]]; then
      printf '%s\n' "${call}"
    fi
  done <<< "${BG_CALLS}"
)"
if [[ -n "${INVALID_BG_CALLS}" ]]; then
  echo "Invalid theme.bg color(s) in ${INDEX_TS}:" >&2
  echo "${INVALID_BG_CALLS}" >&2
  echo "Allowed ThemeBg names: selectedBg, userMessageBg, customMessageBg, toolPendingBg, toolSuccessBg, toolErrorBg" >&2
  exit 1
fi
echo "AskUserQuestion theme.bg allowed-color guard passed"

REMOVED_NOTE_REFERENCES="$(grep -nE 'question-note|Question note|whole-question|setNote|answer\.note|noteParts' "${INDEX_TS}" "${LOGIC_TS}" || true)"
if [[ -n "${REMOVED_NOTE_REFERENCES}" ]]; then
  echo "Whole-question note references should be removed:" >&2
  echo "${REMOVED_NOTE_REFERENCES}" >&2
  exit 1
fi
echo "AskUserQuestion whole-question note removal guard passed"

node --input-type=module <<'NODE'
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const logic = await import(pathToFileURL(`${process.env.ROOT_DIR}/extensions/AskUserQuestion/logic.ts`).href);

const single = {
  header: "Approval",
  question: "Ship it?",
  multiSelect: false,
  options: [
    { label: "Yes", description: "Ship now" },
    { label: "No", description: "Hold" },
    { label: "Later", description: "Wait" },
  ],
};

assert.equal(logic.CUSTOM_ANSWER_LABEL, "Custom answer:");
assert.equal(logic.getCustomOptionIndex(single), 3, "custom option is after real options");
assert.equal(logic.isCustomOption(single, 3), true, "custom option is recognized by index");
assert.equal(logic.isCustomOption(single, 2), false, "real options are not custom");
assert.equal("setNote" in logic, false, "whole-question note setter is not exported");

let state = logic.createInitialSelectionState(single);
assert.equal(state.focusedIndex, 0, "initial focus starts on first option");
assert.deepEqual(state.selectedIndexes, [], "initial single selection is empty");
assert.equal(state.customText, "", "initial custom text is empty");
assert.deepEqual(state.choiceNotes, {}, "initial per-choice notes are empty");
assert.equal(Object.hasOwn(state, "note"), false, "selection state has no whole-question note field");
assert.equal(
  logic.shouldRenderChoiceNote(false, false),
  false,
  "empty per-choice note does not render when it is not being edited",
);
assert.equal(
  logic.shouldRenderChoiceNote(false, true),
  true,
  "empty per-choice note still renders while editing so the user can type",
);
assert.equal(
  logic.shouldRenderChoiceNote(true, false),
  true,
  "non-empty per-choice note renders outside edit mode",
);

state = logic.moveFocus(single, state, 1);
state = logic.toggleFocusedOption(single, state);
assert.deepEqual(state.selectedIndexes, [1], "single select chooses focused option");
assert.equal(logic.resolveSelected(single, state), "No", "single selected value resolves to selected label");

state = logic.moveFocus(single, state, 1);
state = logic.toggleFocusedOption(single, state);
assert.deepEqual(state.selectedIndexes, [2], "single select replaces prior option");
state = logic.setChoiceNote(single, state, 2, "Only after changelog lands");
assert.deepEqual(logic.buildQuestionAnswer(single, state), {
  selected: "Later",
  choiceNotes: { Later: "Only after changelog lands" },
});
assert.deepEqual(logic.buildStructuredResult([single], [state]).answers, {
  Approval: {
    selected: "Later",
    choiceNotes: { Later: "Only after changelog lands" },
  },
}, "structured return shape includes per-choice notes keyed by option label and no whole-question note");
assert.equal(Object.hasOwn(logic.buildQuestionAnswer(single, state), "note"), false, "answer has no whole-question note field");

state = logic.setChoiceNote(single, state, 2, "   ");
assert.deepEqual(logic.buildQuestionAnswer(single, state), {
  selected: "Later",
}, "blank per-choice note clears it from the result");

let customSingle = logic.setFocusedIndex(single, state, logic.getCustomOptionIndex(single));
customSingle = logic.setCustomText(single, customSingle, "Ship after smoke tests");
assert.deepEqual(customSingle.selectedIndexes, [logic.getCustomOptionIndex(single)], "typing custom selects the custom option for single select");
assert.equal(
  logic.resolveSelected(single, customSingle),
  "Ship after smoke tests",
  "single-select custom replaces the real option selection with the custom text",
);
assert.deepEqual(logic.buildQuestionAnswer(single, customSingle), {
  selected: "Ship after smoke tests",
}, "single-select custom text becomes the selected value");

let emptyCustomSingle = logic.createInitialSelectionState(single);
emptyCustomSingle = logic.setFocusedIndex(single, emptyCustomSingle, logic.getCustomOptionIndex(single));
emptyCustomSingle = logic.toggleFocusedOption(single, emptyCustomSingle);
assert.equal(logic.resolveSelected(single, emptyCustomSingle), "", "empty single-select custom contributes no selected value");
assert.equal(logic.hasSelection(single, emptyCustomSingle), false, "empty single-select custom does not satisfy required answer check");
assert.deepEqual(logic.buildStructuredResult([single], [emptyCustomSingle]).answers, {}, "empty single-select custom is omitted from structured answers");

const multi = {
  header: "Scope",
  question: "Which areas should change?",
  multiSelect: true,
  options: [
    { label: "API", description: "Server contract" },
    { label: "UI", description: "Screens" },
    { label: "Docs", description: "Documentation" },
  ],
};

let multiState = logic.createInitialSelectionState(multi);
multiState = logic.toggleFocusedOption(multi, multiState);
multiState = logic.setFocusedChoiceNote(multi, multiState, "Keep response shape stable");
multiState = logic.moveFocus(multi, multiState, 1);
multiState = logic.toggleFocusedOption(multi, multiState);
multiState = logic.setFocusedChoiceNote(multi, multiState, "Make the dialog obvious");
assert.deepEqual(multiState.selectedIndexes, [0, 1], "multi select toggles additional choices on");
assert.deepEqual(logic.getSelectedChoiceNotes(multi, multiState), {
  API: "Keep response shape stable",
  UI: "Make the dialog obvious",
}, "multi-select returns notes keyed by each selected option label");
assert.deepEqual(logic.buildQuestionAnswer(multi, multiState), {
  selected: ["API", "UI"],
  choiceNotes: {
    API: "Keep response shape stable",
    UI: "Make the dialog obvious",
  },
}, "per-choice notes are still captured without whole-question notes");

multiState = logic.setFocusedIndex(multi, multiState, logic.getCustomOptionIndex(multi));
multiState = logic.setCustomText(multi, multiState, "CLI");
assert.deepEqual(
  logic.resolveSelected(multi, multiState),
  ["API", "UI", "CLI"],
  "multi-select custom text is appended alongside real toggled options",
);
assert.deepEqual(logic.buildQuestionAnswer(multi, multiState), {
  selected: ["API", "UI", "CLI"],
  choiceNotes: {
    API: "Keep response shape stable",
    UI: "Make the dialog obvious",
  },
});

let emptyCustomMulti = logic.createInitialSelectionState(multi);
emptyCustomMulti = logic.toggleFocusedOption(multi, emptyCustomMulti);
emptyCustomMulti = logic.setFocusedIndex(multi, emptyCustomMulti, logic.getCustomOptionIndex(multi));
emptyCustomMulti = logic.setCustomText(multi, emptyCustomMulti, "   ");
assert.deepEqual(
  logic.resolveSelected(multi, emptyCustomMulti),
  ["API"],
  "empty multi-select custom contributes nothing while real selections remain",
);
emptyCustomMulti = logic.setFocusedIndex(multi, logic.createInitialSelectionState(multi), logic.getCustomOptionIndex(multi));
emptyCustomMulti = logic.toggleFocusedOption(multi, emptyCustomMulti);
assert.deepEqual(logic.resolveSelected(multi, emptyCustomMulti), [], "empty custom-only multi-select resolves to an empty array");
assert.equal(logic.hasSelection(multi, emptyCustomMulti), false, "empty custom-only multi-select does not satisfy required answer check");

multiState = logic.setFocusedIndex(multi, multiState, 0);
multiState = logic.toggleFocusedOption(multi, multiState);
assert.deepEqual(
  logic.resolveSelected(multi, multiState),
  ["UI", "CLI"],
  "multi select toggles focused real choice off while preserving custom text",
);
assert.deepEqual(logic.buildQuestionAnswer(multi, multiState), {
  selected: ["UI", "CLI"],
  choiceNotes: { UI: "Make the dialog obvious" },
}, "notes for unselected choices are not returned");

multiState = logic.setChoiceNote(multi, multiState, 1, "");
assert.deepEqual(logic.buildQuestionAnswer(multi, multiState), {
  selected: ["UI", "CLI"],
}, "per-choice note can be cleared while custom selection remains");

assert.equal(
  logic.decideOptionListEnterAction(0, 2),
  "advance",
  "Enter on the option list advances when the current question is not last",
);
assert.equal(
  logic.decideOptionListEnterAction(1, 2),
  "submit",
  "Enter on the option list submits when the current question is last",
);
assert.equal(
  logic.decideOptionListEnterAction(0, 1),
  "submit",
  "a single-question option list submits on Enter because it is already last",
);

let navigation = logic.createInitialNavigationState([single, multi]);
assert.equal(navigation.currentQuestionIndex, 0, "navigation starts on first question");
navigation = logic.setQuestionState([single, multi], navigation, 0, customSingle);
navigation = logic.moveQuestion([single, multi], navigation, 1);
assert.equal(navigation.currentQuestionIndex, 1, "navigation can move forward");
navigation = logic.setQuestionState([single, multi], navigation, 1, multiState);
navigation = logic.moveQuestion([single, multi], navigation, -1);
assert.equal(navigation.currentQuestionIndex, 0, "navigation can move back to revise an earlier answer");
assert.deepEqual(logic.buildQuestionAnswer(single, navigation.states[0]), {
  selected: "Ship after smoke tests",
}, "going back preserves earlier custom answer state");
navigation = logic.moveQuestion([single, multi], navigation, 1);
assert.equal(navigation.currentQuestionIndex, 1, "navigation can move forward again after revision");

const highlightedMultiState = logic.setFocusedIndex(multi, navigation.states[1], 1);
let focus = logic.createInitialFocusState();
assert.deepEqual(focus, { mode: "options", activeChoiceNoteIndex: null }, "dialog focus starts on option list");
focus = logic.cycleFocusMode(multi, highlightedMultiState, focus);
assert.deepEqual(focus, { mode: "choice-note", activeChoiceNoteIndex: 1 }, "Tab focuses the highlighted option note");
focus = logic.cycleFocusMode(multi, highlightedMultiState, focus);
assert.deepEqual(focus, { mode: "options", activeChoiceNoteIndex: null }, "second Tab returns to the option list without a question-note mode");
assert.deepEqual(
  logic.normalizeFocusState(multi, highlightedMultiState, { mode: "choice-note", activeChoiceNoteIndex: 99 }),
  { mode: "choice-note", activeChoiceNoteIndex: 1 },
  "focus normalization falls back to the highlighted option for stale choice-note indexes",
);
const highlightedCustomState = logic.setFocusedIndex(multi, highlightedMultiState, logic.getCustomOptionIndex(multi));
assert.deepEqual(
  logic.cycleFocusMode(multi, highlightedCustomState, logic.createInitialFocusState()),
  { mode: "options", activeChoiceNoteIndex: null },
  "Tab on the custom option stays in options because custom text is edited inline",
);
assert.deepEqual(logic.returnFocusToOptions(), { mode: "options", activeChoiceNoteIndex: null }, "Escape from note fields returns focus to options");

const structured = logic.buildStructuredResult([single, multi], navigation.states);
assert.equal(structured.uiAvailable, true);
assert.equal(structured.unavailable, false);
assert.equal(structured.cancelled, false);
assert.deepEqual(structured.questions.map((q) => q.options.at(-1)), ["Custom answer:", "Custom answer:"], "question summaries include the always-present custom option");
assert.deepEqual(structured.answers, {
  Approval: { selected: "Ship after smoke tests" },
  Scope: { selected: ["UI", "CLI"] },
});
for (const answer of Object.values(structured.answers)) {
  assert.equal(Object.hasOwn(answer, "note"), false, "structured answers never include whole-question note");
}

const fallback = logic.createHeadlessFallback([single, multi]);
assert.equal(fallback.uiAvailable, false, "headless result reports UI unavailable");
assert.equal(fallback.unavailable, true, "headless result has unavailable flag");
assert.equal(fallback.cancelled, false, "headless fallback is not a user cancel");
assert.match(fallback.reason, /UI is unavailable/i);
assert.deepEqual(fallback.answers, {}, "headless fallback has no answers");
assert.deepEqual(fallback.questions.map((q) => q.header), ["Approval", "Scope"]);
assert.deepEqual(fallback.questions.map((q) => q.options.at(-1)), ["Custom answer:", "Custom answer:"], "headless summaries keep the custom option");

console.log("AskUserQuestion pure logic tests passed");
NODE
