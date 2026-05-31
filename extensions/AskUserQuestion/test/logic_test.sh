#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
export ROOT_DIR

INDEX_TS="${ROOT_DIR}/extensions/AskUserQuestion/index.ts"
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

let state = logic.createInitialSelectionState(single);
assert.equal(state.focusedIndex, 0, "initial focus starts on first option");
assert.deepEqual(state.selectedIndexes, [], "initial single selection is empty");
assert.deepEqual(state.choiceNotes, {}, "initial per-choice notes are empty");

state = logic.moveFocus(single, state, 1);
state = logic.toggleFocusedOption(single, state);
assert.deepEqual(state.selectedIndexes, [1], "single select chooses focused option");

state = logic.moveFocus(single, state, 1);
state = logic.toggleFocusedOption(single, state);
assert.deepEqual(state.selectedIndexes, [2], "single select replaces prior option");

state = logic.setNote(state, "Needs founder sign-off");
state = logic.setChoiceNote(single, state, 2, "Only after changelog lands");
assert.deepEqual(logic.buildQuestionAnswer(single, state), {
  selected: "Later",
  note: "Needs founder sign-off",
  choiceNotes: { Later: "Only after changelog lands" },
});
assert.deepEqual(logic.buildStructuredResult([single], [state]).answers, {
  Approval: {
    selected: "Later",
    note: "Needs founder sign-off",
    choiceNotes: { Later: "Only after changelog lands" },
  },
}, "structured return shape includes per-choice notes keyed by option label");

state = logic.setChoiceNote(single, state, 2, "   ");
assert.deepEqual(logic.buildQuestionAnswer(single, state), {
  selected: "Later",
  note: "Needs founder sign-off",
}, "blank per-choice note clears it from the result");

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

multiState = logic.moveFocus(multi, multiState, -1);
multiState = logic.toggleFocusedOption(multi, multiState);
assert.deepEqual(multiState.selectedIndexes, [1], "multi select toggles focused choice off");
assert.deepEqual(logic.buildQuestionAnswer(multi, multiState), {
  selected: ["UI"],
  choiceNotes: { UI: "Make the dialog obvious" },
}, "notes for unselected choices are not returned");

multiState = logic.setChoiceNote(multi, multiState, 1, "");
multiState = logic.setNote(multiState, "UI first");
assert.deepEqual(logic.buildQuestionAnswer(multi, multiState), {
  selected: ["UI"],
  note: "UI first",
}, "per-choice note can be cleared while whole-question note remains");

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
navigation = logic.setQuestionState([single, multi], navigation, 0, state);
navigation = logic.moveQuestion([single, multi], navigation, 1);
assert.equal(navigation.currentQuestionIndex, 1, "navigation can move forward");
navigation = logic.setQuestionState([single, multi], navigation, 1, multiState);
navigation = logic.moveQuestion([single, multi], navigation, -1);
assert.equal(navigation.currentQuestionIndex, 0, "navigation can move back to revise an earlier answer");
assert.deepEqual(logic.buildQuestionAnswer(single, navigation.states[0]), {
  selected: "Later",
  note: "Needs founder sign-off",
}, "going back preserves earlier answer state");
navigation = logic.moveQuestion([single, multi], navigation, 1);
assert.equal(navigation.currentQuestionIndex, 1, "navigation can move forward again after revision");

const highlightedMultiState = logic.setFocusedIndex(multi, navigation.states[1], 1);
let focus = logic.createInitialFocusState();
assert.deepEqual(focus, { mode: "options", activeChoiceNoteIndex: null }, "dialog focus starts on option list");
focus = logic.cycleFocusMode(multi, highlightedMultiState, focus);
assert.deepEqual(focus, { mode: "choice-note", activeChoiceNoteIndex: 1 }, "Tab first focuses the highlighted option note");
focus = logic.cycleFocusMode(multi, highlightedMultiState, focus);
assert.deepEqual(focus, { mode: "question-note", activeChoiceNoteIndex: null }, "second Tab focuses the whole-question note");
focus = logic.cycleFocusMode(multi, highlightedMultiState, focus);
assert.deepEqual(focus, { mode: "options", activeChoiceNoteIndex: null }, "third Tab returns to the option list");
assert.deepEqual(
  logic.normalizeFocusState(multi, highlightedMultiState, { mode: "choice-note", activeChoiceNoteIndex: 99 }),
  { mode: "choice-note", activeChoiceNoteIndex: 1 },
  "focus normalization falls back to the highlighted option for stale choice-note indexes",
);
assert.deepEqual(logic.returnFocusToOptions(), { mode: "options", activeChoiceNoteIndex: null }, "Escape from note fields returns focus to options");

const structured = logic.buildStructuredResult([single, multi], navigation.states);
assert.equal(structured.uiAvailable, true);
assert.equal(structured.unavailable, false);
assert.equal(structured.cancelled, false);
assert.deepEqual(structured.answers, {
  Approval: { selected: "Later", note: "Needs founder sign-off" },
  Scope: { selected: ["UI"], note: "UI first" },
});

const fallback = logic.createHeadlessFallback([single, multi]);
assert.equal(fallback.uiAvailable, false, "headless result reports UI unavailable");
assert.equal(fallback.unavailable, true, "headless result has unavailable flag");
assert.equal(fallback.cancelled, false, "headless fallback is not a user cancel");
assert.match(fallback.reason, /UI is unavailable/i);
assert.deepEqual(fallback.answers, {}, "headless fallback has no answers");
assert.deepEqual(fallback.questions.map((q) => q.header), ["Approval", "Scope"]);

console.log("AskUserQuestion pure logic tests passed");
NODE
