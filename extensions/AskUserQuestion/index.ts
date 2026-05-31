/**
 * AskUserQuestion Tool
 *
 * Claude Code-compatible AskUserQuestion primitive for pi.
 * UI primitives relied on:
 * - ctx.ui.custom(...) to mount the interactive all-questions dialog.
 * - Container/Text/Input from @earendil-works/pi-tui to render the dialog,
 *   explanatory text, per-choice notes, and the whole-question note field.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Input, Key, matchesKey, Spacer, Text, type Focusable } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	buildStructuredResult,
	createHeadlessFallback,
	createInitialFocusState,
	createInitialNavigationState,
	cycleFocusMode,
	getChoiceNote,
	hasSelection,
	moveFocus,
	moveQuestion,
	returnFocusToOptions,
	setChoiceNote,
	setNote,
	setQuestionState,
	toggleFocusedOption,
	type AskUserQuestionFocusState,
	type AskUserQuestionItem,
	type AskUserQuestionNavigationState,
	type AskUserQuestionStructuredResult,
	type SelectionState,
} from "./logic.ts";

const OptionSchema = Type.Object({
	label: Type.String({ description: "Display label for this option." }),
	description: Type.String({ description: "Short description shown under the label." }),
});

const QuestionSchema = Type.Object({
	header: Type.String({ description: "Short header used as the key in the returned result mapping." }),
	question: Type.String({ description: "Question text to show to the user." }),
	multiSelect: Type.Boolean({ description: "If true, user may toggle multiple options. If false, exactly one option is selected." }),
	options: Type.Array(OptionSchema, { description: "Options the user can choose from." }),
});

const AskUserQuestionParams = Type.Object({
	questions: Type.Array(QuestionSchema, { description: "Questions to ask the user in sequence." }),
});

type ThemeLike = {
	fg: (color: string, text: string) => string;
	bg: (color: string, text: string) => string;
	bold: (text: string) => string;
};

type TuiLike = { requestRender: () => void };

type DialogResult = { states: SelectionState[] } | null;

function formatDetailsForContent(details: AskUserQuestionStructuredResult): string {
	if (details.unavailable) {
		return JSON.stringify({ unavailable: true, reason: details.reason, answers: details.answers }, null, 2);
	}
	if (details.cancelled) {
		return JSON.stringify({ cancelled: true, reason: details.reason, answers: details.answers }, null, 2);
	}
	return JSON.stringify(details.answers, null, 2);
}

function nonInteractiveResult(questions: AskUserQuestionItem[]) {
	const details = createHeadlessFallback(questions);
	return {
		content: [{ type: "text" as const, text: `UI unavailable: ${details.reason}\n${formatDetailsForContent(details)}` }],
		details,
	};
}

function cancelledResult(questions: AskUserQuestionItem[], states: Array<SelectionState | undefined>, reason: string) {
	const details = buildStructuredResult(questions, states, { cancelled: true, reason });
	return {
		content: [{ type: "text" as const, text: `AskUserQuestion cancelled: ${reason}\n${formatDetailsForContent(details)}` }],
		details,
	};
}

class AskUserQuestionDialog extends Container implements Focusable {
	private readonly questions: AskUserQuestionItem[];
	private readonly tui: TuiLike;
	private readonly theme: ThemeLike;
	private readonly done: (result: DialogResult) => void;
	private navigation: AskUserQuestionNavigationState;
	private focusState: AskUserQuestionFocusState = createInitialFocusState();
	private readonly noteInput = new Input();
	private statusMessage = "";
	private _focused = false;

	constructor(
		questions: AskUserQuestionItem[],
		initialNavigation: AskUserQuestionNavigationState,
		tui: TuiLike,
		theme: ThemeLike,
		done: (result: DialogResult) => void,
	) {
		super();
		this.questions = questions;
		this.navigation = initialNavigation;
		this.tui = tui;
		this.theme = theme;
		this.done = done;
		this.noteInput.onEscape = () => this.saveActiveNoteAndReturnToOptions();
		this.noteInput.onSubmit = () => {
			this.saveActiveNoteFromInput();
			this.submitIfComplete();
		};
		this.updateInputFocus();
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.updateInputFocus();
	}

	override invalidate(): void {
		super.invalidate();
		this.noteInput.invalidate();
	}

	handleInput(data: string): void {
		if (this.focusState.mode !== "options") {
			if (matchesKey(data, Key.tab)) {
				this.cycleFocusedArea();
				return;
			}

			if (matchesKey(data, Key.escape)) {
				this.saveActiveNoteAndReturnToOptions();
				return;
			}

			if (matchesKey(data, Key.enter)) {
				this.saveActiveNoteFromInput();
				this.submitIfComplete();
				return;
			}

			this.noteInput.handleInput(data);
			if (this.focusState.mode !== "options") {
				this.saveActiveNoteFromInput();
				this.refresh();
			}
			return;
		}

		if (matchesKey(data, Key.up)) {
			this.updateCurrentState(moveFocus(this.currentQuestion(), this.currentState(), -1));
			this.statusMessage = "";
			this.refresh();
			return;
		}

		if (matchesKey(data, Key.down)) {
			this.updateCurrentState(moveFocus(this.currentQuestion(), this.currentState(), 1));
			this.statusMessage = "";
			this.refresh();
			return;
		}

		if (matchesKey(data, Key.left)) {
			this.switchQuestionTab(-1);
			return;
		}

		if (matchesKey(data, Key.right)) {
			this.switchQuestionTab(1);
			return;
		}

		if (matchesKey(data, Key.tab)) {
			this.cycleFocusedArea();
			return;
		}

		if (matchesKey(data, Key.space) || data === " ") {
			this.updateCurrentState(toggleFocusedOption(this.currentQuestion(), this.currentState()));
			this.statusMessage = "";
			this.refresh();
			return;
		}

		if (matchesKey(data, Key.enter)) {
			this.submitIfComplete();
		}
	}

	override render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		this.clear();

		const question = this.currentQuestion();
		const state = this.currentState();

		this.addText(this.theme.fg("accent", "─".repeat(safeWidth)));
		this.renderQuestionTabs();
		this.addText(this.theme.fg("accent", "─".repeat(safeWidth)));
		this.addChild(new Spacer(1));
		this.addText(this.theme.fg("text", question.question));
		this.addChild(new Spacer(1));

		if (question.options.length === 0) {
			this.addText(this.theme.fg("warning", "No options were provided for this question."));
		} else {
			this.renderOptions(question, state);
		}

		this.addChild(new Spacer(1));
		this.renderQuestionNote(state);

		if (this.statusMessage) {
			this.addChild(new Spacer(1));
			this.addText(this.theme.fg("warning", this.statusMessage));
		}

		this.addChild(new Spacer(1));
		this.addText(this.helpText());
		this.addText(this.theme.fg("accent", "─".repeat(safeWidth)));

		return super.render(safeWidth);
	}

	private renderQuestionTabs(): void {
		const tabs = this.questions.map((question, index) => {
			const label = `[${index + 1}. ${question.header || "Question"}]`;
			if (index === this.navigation.currentQuestionIndex) {
				return this.theme.bg("selectedBg", this.theme.fg("text", this.theme.bold(label)));
			}

			return this.theme.fg(hasSelection(this.navigation.states[index]) ? "success" : "muted", label);
		});

		this.addText(tabs.join(" "));
	}

	private renderOptions(question: AskUserQuestionItem, state: SelectionState): void {
		for (let index = 0; index < question.options.length; index++) {
			const option = question.options[index];
			const focused = index === state.focusedIndex;
			const selected = state.selectedIndexes.includes(index);
			const cursor = focused && this.focusState.mode === "options" ? this.theme.fg("accent", ">") : " ";
			const marker = question.multiSelect ? (selected ? "[x]" : "[ ]") : selected ? "(●)" : "( )";
			const color = focused ? "accent" : selected ? "success" : "text";
			this.addText(`${cursor} ${this.theme.fg(color, `${marker} ${option.label}`)}`);

			const description = option.description ?? "";
			if (description.trim()) {
				this.addText(this.theme.fg("muted", `    ${description}`));
			}

			const hasNote = getChoiceNote(question, state, index).trim() !== "";
			const editing = this.focusState.mode === "choice-note" && this.focusState.activeChoiceNoteIndex === index;
			if (focused || selected || hasNote || editing) {
				this.renderChoiceNote(question, state, index);
			}
		}
	}

	private renderChoiceNote(question: AskUserQuestionItem, state: SelectionState, optionIndex: number): void {
		const editing = this.focusState.mode === "choice-note" && this.focusState.activeChoiceNoteIndex === optionIndex;
		if (editing) {
			this.addText(this.theme.fg("muted", "    Per-choice note:"));
			this.addChild(this.noteInput);
			return;
		}

		const note = getChoiceNote(question, state, optionIndex).trim();
		if (note) {
			this.addText(this.theme.fg("muted", `    Per-choice note: ${note}`));
			return;
		}

		if (optionIndex === state.focusedIndex) {
			this.addText(this.theme.fg("muted", "    Per-choice note: (Tab to edit)"));
		}
	}

	private renderQuestionNote(state: SelectionState): void {
		if (this.focusState.mode === "question-note") {
			this.addText(this.theme.fg("muted", "Question note:"));
			this.addChild(this.noteInput);
			return;
		}

		const note = state.note.trim();
		this.addText(this.theme.fg("muted", note ? `Question note: ${note}` : "Question note: (Tab twice to edit)"));
	}

	private currentQuestion(): AskUserQuestionItem {
		return this.questions[this.navigation.currentQuestionIndex];
	}

	private currentState(): SelectionState {
		return this.navigation.states[this.navigation.currentQuestionIndex];
	}

	private updateCurrentState(state: SelectionState): void {
		this.navigation = setQuestionState(this.questions, this.navigation, this.navigation.currentQuestionIndex, state);
	}

	private cycleFocusedArea(): void {
		this.saveActiveNoteFromInput();
		this.focusState = cycleFocusMode(this.currentQuestion(), this.currentState(), this.focusState);
		this.prepareNoteInputForFocus();
		this.statusMessage = "";
		this.refresh();
	}

	private prepareNoteInputForFocus(): void {
		if (this.focusState.mode === "choice-note" && this.focusState.activeChoiceNoteIndex !== null) {
			this.noteInput.setValue(getChoiceNote(this.currentQuestion(), this.currentState(), this.focusState.activeChoiceNoteIndex));
			return;
		}

		if (this.focusState.mode === "question-note") {
			this.noteInput.setValue(this.currentState().note);
		}
	}

	private saveActiveNoteFromInput(): void {
		const value = this.noteInput.getValue();
		if (this.focusState.mode === "question-note") {
			this.updateCurrentState(setNote(this.currentState(), value));
			return;
		}

		if (this.focusState.mode === "choice-note" && this.focusState.activeChoiceNoteIndex !== null) {
			this.updateCurrentState(setChoiceNote(this.currentQuestion(), this.currentState(), this.focusState.activeChoiceNoteIndex, value));
		}
	}

	private saveActiveNoteAndReturnToOptions(): void {
		this.saveActiveNoteFromInput();
		this.focusState = returnFocusToOptions();
		this.statusMessage = "";
		this.refresh();
	}

	private switchQuestionTab(delta: number): void {
		const targetIndex = this.navigation.currentQuestionIndex + delta;
		if (targetIndex < 0 || targetIndex >= this.questions.length) {
			this.statusMessage = delta < 0 ? "Already at the first question tab." : "Already at the last question tab.";
			this.refresh();
			return;
		}

		this.navigation = moveQuestion(this.questions, this.navigation, delta);
		this.focusState = returnFocusToOptions();
		this.statusMessage = "";
		this.refresh();
	}

	private submitIfComplete(): void {
		const missingIndex = this.navigation.states.findIndex((state) => !hasSelection(state));
		if (missingIndex >= 0) {
			this.navigation = moveQuestion(this.questions, this.navigation, missingIndex - this.navigation.currentQuestionIndex);
			this.focusState = returnFocusToOptions();
			this.statusMessage = "Answer each question before submitting all questions.";
			this.refresh();
			return;
		}

		this.done({ states: this.navigation.states });
	}

	private helpText(): string {
		return this.theme.fg(
			"dim",
			"←/→ tabs • ↑/↓ options • Space select/toggle • Tab per-choice note → question note → options • Enter submit all • Esc note→options",
		);
	}

	private addText(text: string): void {
		this.addChild(new Text(text, 0, 0));
	}

	private refresh(): void {
		this.updateInputFocus();
		this.invalidate();
		this.tui.requestRender();
	}

	private updateInputFocus(): void {
		this.noteInput.focused = this._focused && this.focusState.mode !== "options";
	}
}

export default function AskUserQuestion(pi: ExtensionAPI) {
	pi.registerTool({
		name: "AskUserQuestion",
		label: "Ask User Question",
		description:
			"Ask the user one or more Claude Code-style questions with labeled options, optional multi-select, per-choice notes, and an optional whole-question note. Returns answers keyed by question header.",
		promptSnippet: "Ask the user a structured multiple-choice question and return selected option labels plus any notes.",
		promptGuidelines: [
			"Use AskUserQuestion when progress depends on a user decision that should be captured as structured selected option labels and optional notes.",
		],
		parameters: AskUserQuestionParams,

		async execute(_toolCallId, params: { questions: AskUserQuestionItem[] }, signal, _onUpdate, ctx) {
			const questions = params.questions ?? [];

			if (!ctx.hasUI) {
				return nonInteractiveResult(questions);
			}

			if (questions.length === 0) {
				return cancelledResult(questions, [], "No questions were provided.");
			}

			const missingOptions = questions.find((question) => question.options.length === 0);
			if (missingOptions) {
				return cancelledResult(questions, [], `Question \"${missingOptions.header}\" has no options.`);
			}

			if (signal?.aborted) {
				return cancelledResult(questions, [], "AskUserQuestion was aborted.");
			}

			const initialNavigation = createInitialNavigationState(questions);
			const result = await ctx.ui.custom<DialogResult>((tui, theme, _keybindings, done) => {
				return new AskUserQuestionDialog(questions, initialNavigation, tui, theme, done);
			});

			if (!result) {
				return cancelledResult(questions, initialNavigation.states, "User cancelled AskUserQuestion.");
			}

			const details = buildStructuredResult(questions, result.states);
			return {
				content: [{ type: "text" as const, text: `AskUserQuestion result:\n${formatDetailsForContent(details)}` }],
				details,
			};
		},

		renderCall(args, theme, _context) {
			const questions = Array.isArray(args.questions) ? (args.questions as AskUserQuestionItem[]) : [];
			const headers = questions.map((question) => question.header).filter(Boolean);
			let text = theme.fg("toolTitle", theme.bold("AskUserQuestion "));
			text += theme.fg("muted", `${questions.length} question${questions.length === 1 ? "" : "s"}`);
			if (headers.length > 0) text += theme.fg("dim", ` (${headers.join(", ")})`);
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as AskUserQuestionStructuredResult | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			if (details.unavailable) {
				return new Text(theme.fg("warning", `UI unavailable: ${details.reason ?? "headless mode"}`), 0, 0);
			}
			if (details.cancelled) {
				return new Text(theme.fg("warning", `Cancelled: ${details.reason ?? "user cancelled"}`), 0, 0);
			}

			const lines = Object.entries(details.answers).map(([header, answer]) => {
				const selected = Array.isArray(answer.selected) ? answer.selected.join(", ") : answer.selected;
				const choiceNotes = answer.choiceNotes
					? Object.entries(answer.choiceNotes)
							.map(([label, note]) => `${label}: ${note}`)
							.join("; ")
					: "";
				const noteParts = [
					answer.note ? `note: ${answer.note}` : "",
					choiceNotes ? `choice notes: ${choiceNotes}` : "",
				].filter(Boolean);
				const notes = noteParts.length > 0 ? theme.fg("muted", ` — ${noteParts.join("; ")}`) : "";
				return `${theme.fg("success", "✓ ")}${theme.fg("accent", header)}: ${selected}${notes}`;
			});
			return new Text(lines.join("\n") || theme.fg("muted", "No answers"), 0, 0);
		},
	});
}
