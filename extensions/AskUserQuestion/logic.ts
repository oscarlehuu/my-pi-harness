/**
 * Pure selection/result logic for the AskUserQuestion extension.
 *
 * This module intentionally has no pi/TUI imports so it can be exercised from
 * unit tests without a live terminal.
 */

export const CUSTOM_ANSWER_LABEL = "Custom answer:";

export interface AskUserQuestionOption {
	label: string;
	description: string;
}

export interface AskUserQuestionItem {
	header: string;
	question: string;
	multiSelect: boolean;
	options: AskUserQuestionOption[];
}

export interface SelectionState {
	focusedIndex: number;
	selectedIndexes: number[];
	/** Inline free-text answer for the always-present custom option. */
	customText: string;
	/** Per-choice notes keyed by real option index. Only selected notes are returned. */
	choiceNotes: Record<number, string>;
}

export interface AskUserQuestionNavigationState {
	currentQuestionIndex: number;
	states: SelectionState[];
}

export type AskUserQuestionFocusMode = "options" | "choice-note";

export interface AskUserQuestionFocusState {
	mode: AskUserQuestionFocusMode;
	activeChoiceNoteIndex: number | null;
}

export interface AskUserQuestionAnswer {
	selected: string | string[];
	/** Per-choice notes keyed by selected option label. */
	choiceNotes?: Record<string, string>;
}

export interface AskUserQuestionSummary {
	header: string;
	question: string;
	multiSelect: boolean;
	options: string[];
}

export interface AskUserQuestionStructuredResult {
	uiAvailable: boolean;
	unavailable: boolean;
	cancelled: boolean;
	reason?: string;
	questions: AskUserQuestionSummary[];
	answers: Record<string, AskUserQuestionAnswer>;
}

export type OptionListEnterAction = "advance" | "submit";

export function shouldRenderChoiceNote(hasText: boolean, editing: boolean): boolean {
	return hasText || editing;
}

export function decideOptionListEnterAction(currentQuestionIndex: number, totalQuestions: number): OptionListEnterAction {
	return currentQuestionIndex < totalQuestions - 1 ? "advance" : "submit";
}

export function getCustomOptionIndex(question: AskUserQuestionItem): number {
	return question.options.length;
}

export function getOptionCount(question: AskUserQuestionItem): number {
	return question.options.length + 1;
}

export function isCustomOption(question: AskUserQuestionItem, optionIndex: number): boolean {
	return Number.isInteger(optionIndex) && optionIndex === getCustomOptionIndex(question);
}

export function createInitialSelectionState(question: AskUserQuestionItem): SelectionState {
	return {
		focusedIndex: getOptionCount(question) > 0 ? 0 : -1,
		selectedIndexes: [],
		customText: "",
		choiceNotes: {},
	};
}

function clampIndex(index: number, optionCount: number): number {
	if (optionCount <= 0) return -1;
	return Math.max(0, Math.min(index, optionCount - 1));
}

function normalizeChoiceNotes(question: AskUserQuestionItem, state: SelectionState): Record<number, string> {
	const optionCount = question.options.length;
	const notes: Record<number, string> = {};

	for (const [rawIndex, value] of Object.entries(state.choiceNotes ?? {})) {
		const index = Number(rawIndex);
		if (!Number.isInteger(index) || index < 0 || index >= optionCount) continue;
		if (typeof value !== "string" || value.trim() === "") continue;
		notes[index] = value;
	}

	return notes;
}

function normalizeState(question: AskUserQuestionItem, state: SelectionState): SelectionState {
	const optionCount = getOptionCount(question);
	const selectedIndexes = Array.from(new Set(state.selectedIndexes ?? []))
		.filter((index) => Number.isInteger(index) && index >= 0 && index < optionCount)
		.sort((a, b) => a - b);

	return {
		focusedIndex: clampIndex(state.focusedIndex, optionCount),
		selectedIndexes: question.multiSelect ? selectedIndexes : selectedIndexes.slice(-1),
		customText: state.customText ?? "",
		choiceNotes: normalizeChoiceNotes(question, state),
	};
}

export function normalizeSelectionState(question: AskUserQuestionItem, state: SelectionState): SelectionState {
	return normalizeState(question, state);
}

export function moveFocus(question: AskUserQuestionItem, state: SelectionState, delta: number): SelectionState {
	const current = normalizeState(question, state);
	const optionCount = getOptionCount(question);
	if (optionCount <= 0) return current;

	return {
		...current,
		focusedIndex: (current.focusedIndex + delta + optionCount) % optionCount,
	};
}

export function setFocusedIndex(question: AskUserQuestionItem, state: SelectionState, index: number): SelectionState {
	return normalizeState(question, { ...state, focusedIndex: clampIndex(index, getOptionCount(question)) });
}

export function toggleFocusedOption(question: AskUserQuestionItem, state: SelectionState): SelectionState {
	const current = normalizeState(question, state);
	if (current.focusedIndex < 0) return current;

	if (!question.multiSelect) {
		return { ...current, selectedIndexes: [current.focusedIndex] };
	}

	const selected = new Set(current.selectedIndexes);
	if (selected.has(current.focusedIndex)) {
		selected.delete(current.focusedIndex);
	} else {
		selected.add(current.focusedIndex);
	}

	return {
		...current,
		selectedIndexes: Array.from(selected).sort((a, b) => a - b),
	};
}

export function setCustomText(question: AskUserQuestionItem, state: SelectionState, customText: string): SelectionState {
	const current = normalizeState(question, state);
	const customIndex = getCustomOptionIndex(question);
	const selected = new Set(current.selectedIndexes);

	if (customText.trim() === "") {
		selected.delete(customIndex);
	} else if (question.multiSelect) {
		selected.add(customIndex);
	} else {
		selected.clear();
		selected.add(customIndex);
	}

	return normalizeState(question, {
		...current,
		customText,
		selectedIndexes: Array.from(selected),
	});
}

export function setChoiceNote(
	question: AskUserQuestionItem,
	state: SelectionState,
	optionIndex: number,
	note: string,
): SelectionState {
	const current = normalizeState(question, state);
	if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= question.options.length) return current;

	const choiceNotes = { ...current.choiceNotes };
	if (note.trim() === "") {
		delete choiceNotes[optionIndex];
	} else {
		choiceNotes[optionIndex] = note;
	}

	return { ...current, choiceNotes };
}

export function setFocusedChoiceNote(question: AskUserQuestionItem, state: SelectionState, note: string): SelectionState {
	const current = normalizeState(question, state);
	return setChoiceNote(question, current, current.focusedIndex, note);
}

export function getChoiceNote(question: AskUserQuestionItem, state: SelectionState, optionIndex: number): string {
	const current = normalizeState(question, state);
	return current.choiceNotes[optionIndex] ?? "";
}

export function getSelectedLabels(question: AskUserQuestionItem, state: SelectionState): string[] {
	const current = normalizeState(question, state);
	return current.selectedIndexes
		.filter((index) => !isCustomOption(question, index))
		.map((index) => question.options[index]?.label)
		.filter((label): label is string => typeof label === "string");
}

export function resolveSelected(question: AskUserQuestionItem, state: SelectionState): string | string[] {
	const current = normalizeState(question, state);
	const labels = getSelectedLabels(question, current);
	const customText = current.customText.trim();
	const customSelected = current.selectedIndexes.includes(getCustomOptionIndex(question));

	if (question.multiSelect) {
		return customSelected && customText ? [...labels, customText] : labels;
	}

	if (customSelected) return customText;
	return labels[0] ?? "";
}

export function hasSelection(question: AskUserQuestionItem, state: SelectionState | undefined): boolean {
	if (!state) return false;
	const selected = resolveSelected(question, state);
	return Array.isArray(selected) ? selected.length > 0 : selected !== "";
}

export function getSelectedChoiceNotes(question: AskUserQuestionItem, state: SelectionState): Record<string, string> {
	const current = normalizeState(question, state);
	const selected = new Set(current.selectedIndexes.filter((index) => !isCustomOption(question, index)));
	const notes: Record<string, string> = {};

	for (const [rawIndex, value] of Object.entries(current.choiceNotes)) {
		const index = Number(rawIndex);
		if (!selected.has(index)) continue;
		const label = question.options[index]?.label;
		const trimmed = value.trim();
		if (label && trimmed) notes[label] = trimmed;
	}

	return notes;
}

export function buildQuestionAnswer(question: AskUserQuestionItem, state: SelectionState): AskUserQuestionAnswer {
	const answer: AskUserQuestionAnswer = {
		selected: resolveSelected(question, state),
	};

	const choiceNotes = getSelectedChoiceNotes(question, state);
	if (Object.keys(choiceNotes).length > 0) answer.choiceNotes = choiceNotes;

	return answer;
}

export function summarizeQuestions(questions: AskUserQuestionItem[]): AskUserQuestionSummary[] {
	return questions.map((question) => ({
		header: question.header,
		question: question.question,
		multiSelect: question.multiSelect,
		options: [...question.options.map((option) => option.label), CUSTOM_ANSWER_LABEL],
	}));
}

export function buildStructuredResult(
	questions: AskUserQuestionItem[],
	states: Array<SelectionState | undefined>,
	options: { cancelled?: boolean; reason?: string } = {},
): AskUserQuestionStructuredResult {
	const answers: Record<string, AskUserQuestionAnswer> = {};

	questions.forEach((question, index) => {
		const state = states[index];
		if (!state || !hasSelection(question, state)) return;
		answers[question.header] = buildQuestionAnswer(question, state);
	});

	return {
		uiAvailable: true,
		unavailable: false,
		cancelled: options.cancelled ?? false,
		...(options.reason ? { reason: options.reason } : {}),
		questions: summarizeQuestions(questions),
		answers,
	};
}

export function createHeadlessFallback(
	questions: AskUserQuestionItem[],
	reason = "UI is unavailable; AskUserQuestion requires interactive mode.",
): AskUserQuestionStructuredResult {
	return {
		uiAvailable: false,
		unavailable: true,
		cancelled: false,
		reason,
		questions: summarizeQuestions(questions),
		answers: {},
	};
}

export function createInitialNavigationState(questions: AskUserQuestionItem[]): AskUserQuestionNavigationState {
	return {
		currentQuestionIndex: questions.length > 0 ? 0 : -1,
		states: questions.map(createInitialSelectionState),
	};
}

function normalizeNavigationState(
	questions: AskUserQuestionItem[],
	navigation: AskUserQuestionNavigationState,
): AskUserQuestionNavigationState {
	const states = questions.map((question, index) => {
		const state = navigation.states[index] ?? createInitialSelectionState(question);
		return normalizeState(question, state);
	});

	return {
		currentQuestionIndex: clampIndex(navigation.currentQuestionIndex, questions.length),
		states,
	};
}

export function setCurrentQuestionIndex(
	questions: AskUserQuestionItem[],
	navigation: AskUserQuestionNavigationState,
	index: number,
): AskUserQuestionNavigationState {
	const current = normalizeNavigationState(questions, navigation);
	return {
		...current,
		currentQuestionIndex: clampIndex(index, questions.length),
	};
}

export function moveQuestion(
	questions: AskUserQuestionItem[],
	navigation: AskUserQuestionNavigationState,
	delta: number,
): AskUserQuestionNavigationState {
	const current = normalizeNavigationState(questions, navigation);
	return setCurrentQuestionIndex(questions, current, current.currentQuestionIndex + delta);
}

export function setQuestionState(
	questions: AskUserQuestionItem[],
	navigation: AskUserQuestionNavigationState,
	questionIndex: number,
	state: SelectionState,
): AskUserQuestionNavigationState {
	const current = normalizeNavigationState(questions, navigation);
	if (!Number.isInteger(questionIndex) || questionIndex < 0 || questionIndex >= questions.length) return current;

	const states = [...current.states];
	states[questionIndex] = normalizeState(questions[questionIndex], state);
	return { ...current, states };
}

export function getCurrentQuestionState(
	questions: AskUserQuestionItem[],
	navigation: AskUserQuestionNavigationState,
): SelectionState | undefined {
	const current = normalizeNavigationState(questions, navigation);
	if (current.currentQuestionIndex < 0) return undefined;
	return current.states[current.currentQuestionIndex];
}

export function createInitialFocusState(): AskUserQuestionFocusState {
	return { mode: "options", activeChoiceNoteIndex: null };
}

export function normalizeFocusState(
	question: AskUserQuestionItem,
	state: SelectionState,
	focus: AskUserQuestionFocusState,
): AskUserQuestionFocusState {
	const currentState = normalizeState(question, state);

	if (focus.mode === "choice-note") {
		const requestedIndex = focus.activeChoiceNoteIndex;
		let activeChoiceNoteIndex = currentState.focusedIndex;
		if (
			typeof requestedIndex === "number" &&
			Number.isInteger(requestedIndex) &&
			requestedIndex >= 0 &&
			requestedIndex < question.options.length
		) {
			activeChoiceNoteIndex = requestedIndex;
		}

		if (activeChoiceNoteIndex < 0 || activeChoiceNoteIndex >= question.options.length) {
			return createInitialFocusState();
		}

		return { mode: "choice-note", activeChoiceNoteIndex };
	}

	return createInitialFocusState();
}

export function cycleFocusMode(
	question: AskUserQuestionItem,
	state: SelectionState,
	focus: AskUserQuestionFocusState,
): AskUserQuestionFocusState {
	const currentFocus = normalizeFocusState(question, state, focus);
	const currentState = normalizeState(question, state);

	if (currentFocus.mode === "options" && currentState.focusedIndex >= 0 && currentState.focusedIndex < question.options.length) {
		return { mode: "choice-note", activeChoiceNoteIndex: currentState.focusedIndex };
	}

	return createInitialFocusState();
}

export function returnFocusToOptions(): AskUserQuestionFocusState {
	return createInitialFocusState();
}
