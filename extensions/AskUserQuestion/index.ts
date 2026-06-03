/**
 * AskUserQuestion Tool
 *
 * Claude Code-compatible AskUserQuestion primitive for pi.
 * UI primitives relied on:
 * - ctx.ui.custom(...) to mount the interactive all-questions dialog.
 * - Container/Text/Input from @earendil-works/pi-tui to render the dialog,
 *   explanatory text, per-choice notes, and custom free-text answers.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	Container,
	Input,
	Key,
	matchesKey,
	Spacer,
	Text,
	visibleWidth,
	type Component,
	type Focusable,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	buildStructuredResult,
	CUSTOM_ANSWER_LABEL,
	createHeadlessFallback,
	createInitialFocusState,
	createInitialNavigationState,
	createInitialSelectionState,
	cycleFocusMode,
	decideOptionListEnterAction,
	getChoiceNote,
	getCustomOptionIndex,
	hasSelection,
	isCustomOption,
	moveFocus,
	moveQuestion,
	normalizeSelectionState,
	returnFocusToOptions,
	setChoiceNote,
	setCustomText,
	setQuestionState,
	shouldRenderChoiceNote,
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

type SocketLike = {
	readyState: number;
	send: (data: string) => void;
	close: (code?: number, reason?: string) => void;
	addEventListener?: (event: string, handler: (ev?: unknown) => void) => void;
	onopen?: () => void;
	onmessage?: (ev: unknown) => void;
	onclose?: () => void;
	onerror?: () => void;
};

type ExecuteContextLike = {
	sessionManager?: { getSessionFile?: () => string | undefined };
};

type RemoteDialogResult =
	| { type: "answered"; states: SelectionState[] }
	| { type: "dismissed"; reason: string }
	| { type: "unavailable"; reason: string };

type RemoteAskAnswerItem = {
	selected?: unknown;
	custom?: unknown;
	choiceNotes?: unknown;
};

type RemoteAskAnswer = Record<string, RemoteAskAnswerItem>;

type RemoteDialogHandle = {
	promise: Promise<RemoteDialogResult>;
	cancel: (reason: string) => void;
};

type LocalDialogHandle = {
	promise: Promise<DialogResult>;
	initialStates: SelectionState[];
	cancel: () => void;
};

const HANDSHAKE_PATH = join(homedir(), ".pi", "pimote", "daemon.json");
const WS_OPEN = 1;
const REMOTE_CONNECT_TIMEOUT_MS = 1_500;

class InlineInputLine implements Component {
	constructor(
		private readonly prefix: string,
		private readonly input: Input,
	) {}

	render(width: number): string[] {
		const inputWidth = Math.max(1, width - visibleWidth(this.prefix));
		const [line = ""] = this.input.render(inputWidth);
		return [`${this.prefix}${line}`];
	}

	invalidate(): void {
		this.input.invalidate();
	}
}

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

function answeredResult(questions: AskUserQuestionItem[], states: Array<SelectionState | undefined>) {
	const details = buildStructuredResult(questions, states);
	return {
		content: [{ type: "text" as const, text: `AskUserQuestion result:\n${formatDetailsForContent(details)}` }],
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
	private readonly customAnswerInput = new Input();
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
			this.cycleFocusedArea();
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
		this.customAnswerInput.invalidate();
	}

	handleInput(data: string): void {
		if (this.focusState.mode !== "options") {
			if (matchesKey(data, Key.escape)) {
				this.saveActiveNoteAndReturnToOptions();
				return;
			}

			if (matchesKey(data, Key.tab)) {
				this.cycleFocusedArea();
				return;
			}

			if (matchesKey(data, Key.enter)) {
				this.cycleFocusedArea();
				return;
			}

			// Translate left/right arrows to Alt+b/Alt+f so noteInput moves word-by-word
			if (matchesKey(data, Key.left)) {
				data = "\x1bb";
			} else if (matchesKey(data, Key.right)) {
				data = "\x1bf";
			}

			this.noteInput.handleInput(data);
			if (this.focusState.mode !== "options") {
				this.saveActiveNoteFromInput();
				this.refresh();
			}
			return;
		}

		const question = this.currentQuestion();
		const state = this.currentState();
		const customFocused = isCustomOption(question, state.focusedIndex);

		if (matchesKey(data, Key.escape)) {
			this.done(null);
			return;
		}

		if (matchesKey(data, Key.up)) {
			this.updateCurrentState(moveFocus(question, state, -1));
			this.prepareCustomInputForFocus();
			this.statusMessage = "";
			this.refresh();
			return;
		}

		if (matchesKey(data, Key.down)) {
			this.updateCurrentState(moveFocus(question, state, 1));
			this.prepareCustomInputForFocus();
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

		if ((matchesKey(data, Key.space) || data === " ") && !customFocused) {
			this.updateCurrentState(toggleFocusedOption(question, state));
			this.statusMessage = "";
			this.refresh();
			return;
		}

		if (matchesKey(data, Key.enter)) {
			this.handleOptionListEnter();
			return;
		}

		if (customFocused) {
			this.customAnswerInput.handleInput(data);
			this.updateCurrentState(setCustomText(question, this.currentState(), this.customAnswerInput.getValue()));
			this.statusMessage = "";
			this.refresh();
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
		this.renderOptions(question, state);

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

			return this.theme.fg(hasSelection(question, this.navigation.states[index]) ? "success" : "muted", label);
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
			if (shouldRenderChoiceNote(hasNote, editing)) {
				this.renderChoiceNote(question, state, index);
			}
		}

		this.renderCustomOption(question, state);
	}

	private renderCustomOption(question: AskUserQuestionItem, state: SelectionState): void {
		const index = getCustomOptionIndex(question);
		const focused = index === state.focusedIndex;
		const selected = state.selectedIndexes.includes(index) && state.customText.trim() !== "";
		const cursor = focused && this.focusState.mode === "options" ? this.theme.fg("accent", ">") : " ";
		const marker = question.multiSelect ? (selected ? "[x]" : "[ ]") : selected ? "(●)" : "( )";
		const color = focused ? "accent" : selected ? "success" : "text";
		const label = `${marker} ${CUSTOM_ANSWER_LABEL}`;

		if (focused && this.focusState.mode === "options") {
			const prefix = `${cursor} ${this.theme.fg(color, `${label} `)}`;
			this.addChild(new InlineInputLine(prefix, this.customAnswerInput));
			return;
		}

		const customText = state.customText.trim();
		const suffix = customText ? ` ${customText}` : "";
		this.addText(`${cursor} ${this.theme.fg(color, `${label}${suffix}`)}`);
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
		}
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
		this.prepareCustomInputForFocus();
		this.statusMessage = "";
		this.refresh();
	}

	private prepareNoteInputForFocus(): void {
		if (this.focusState.mode === "choice-note" && this.focusState.activeChoiceNoteIndex !== null) {
			this.noteInput.setValue(getChoiceNote(this.currentQuestion(), this.currentState(), this.focusState.activeChoiceNoteIndex));
		}
	}

	private prepareCustomInputForFocus(): void {
		if (this.focusState.mode === "options" && isCustomOption(this.currentQuestion(), this.currentState().focusedIndex)) {
			this.customAnswerInput.setValue(this.currentState().customText);
		}
	}

	private saveActiveNoteFromInput(): void {
		const value = this.noteInput.getValue();
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

		this.saveActiveNoteFromInput();
		this.navigation = moveQuestion(this.questions, this.navigation, delta);
		this.focusState = returnFocusToOptions();
		this.prepareCustomInputForFocus();
		this.statusMessage = "";
		this.refresh();
	}

	private handleOptionListEnter(): void {
		const action = decideOptionListEnterAction(this.navigation.currentQuestionIndex, this.questions.length);
		if (action === "advance") {
			this.switchQuestionTab(1);
			return;
		}

		this.submitIfComplete();
	}

	private submitIfComplete(): void {
		const missingIndex = this.navigation.states.findIndex((state, index) => {
			const question = this.questions[index];
			return !question || !hasSelection(question, state);
		});
		if (missingIndex >= 0) {
			this.navigation = moveQuestion(this.questions, this.navigation, missingIndex - this.navigation.currentQuestionIndex);
			this.focusState = returnFocusToOptions();
			this.prepareCustomInputForFocus();
			this.statusMessage = "Answer each question before submitting all questions.";
			this.refresh();
			return;
		}

		this.done({ states: this.navigation.states });
	}

	private helpText(): string {
		return this.theme.fg(
			"dim",
			"←/→ tabs (word-move in note) • ↑/↓ options • Space select/toggle • Tab note⇄options • Enter next (submit on last) • Esc close (exit note) • type on Custom answer",
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
		const customFocused =
			this.navigation.currentQuestionIndex >= 0 &&
			this.focusState.mode === "options" &&
			isCustomOption(this.currentQuestion(), this.currentState().focusedIndex);
		this.noteInput.focused = this._focused && this.focusState.mode === "choice-note";
		this.customAnswerInput.focused = this._focused && customFocused;
	}
}

function startLocalDialog(
	ctx: { ui: { custom: <T>(renderer: (tui: TuiLike, theme: ThemeLike, keybindings: unknown, done: (result: T) => void) => Component) => Promise<T> } },
	questions: AskUserQuestionItem[],
): LocalDialogHandle {
	const initialNavigation = createInitialNavigationState(questions);
	let doneFn: ((result: DialogResult) => void) | undefined;
	let cancelled = false;
	const promise = ctx.ui.custom<DialogResult>((tui, theme, _keybindings, done) => {
		doneFn = done;
		if (cancelled) queueMicrotask(() => done(null));
		return new AskUserQuestionDialog(questions, initialNavigation, tui, theme, done);
	});

	return {
		promise,
		initialStates: initialNavigation.states,
		cancel: () => {
			cancelled = true;
			try {
				doneFn?.(null);
			} catch {
				// TUI teardown must never affect the tool result.
			}
		},
	};
}

function startRemoteDialog(questions: AskUserQuestionItem[], ctx: ExecuteContextLike, signal?: AbortSignal): RemoteDialogHandle {
	const requestId = createRequestId();
	const sessionFile = safeSessionFile(ctx);
	let socket: SocketLike | undefined;
	let connectTimer: ReturnType<typeof setTimeout> | undefined;
	let settled = false;
	let resolveResult: (result: RemoteDialogResult) => void = () => undefined;

	const settle = (result: RemoteDialogResult) => {
		if (settled) return;
		settled = true;
		if (connectTimer) clearTimeout(connectTimer);
		connectTimer = undefined;
		try {
			signal?.removeEventListener?.("abort", onAbort);
		} catch {
			// Ignore abort listener cleanup failures.
		}
		try {
			if (socket?.readyState === WS_OPEN && sessionFile) {
				socket.send(JSON.stringify({ op: "ext_unregister", sessionFile }));
			}
		} catch {
			// Ignore unregister failures.
		}
		try {
			socket?.close();
		} catch {
			// Ignore close failures.
		}
		resolveResult(result);
	};

	const sendCancel = (reason: string) => {
		try {
			if (socket?.readyState === WS_OPEN && sessionFile) {
				socket.send(JSON.stringify({ op: "ask_cancel", sessionFile, requestId, reason }));
			}
		} catch {
			// Ignore best-effort remote cancellation failures.
		}
	};

	const onAbort = () => {
		sendCancel("AskUserQuestion was aborted.");
		settle({ type: "dismissed", reason: "AskUserQuestion was aborted." });
	};

	const promise = new Promise<RemoteDialogResult>((resolve) => {
		resolveResult = resolve;
		if (!sessionFile) {
			settle({ type: "unavailable", reason: "No pi session file is available for Pimote routing." });
			return;
		}
		if (signal?.aborted) {
			onAbort();
			return;
		}
		try {
			signal?.addEventListener?.("abort", onAbort, { once: true });
		} catch {
			// Ignore abort listener setup failures; execute() still handles pre-aborted signals.
		}

		void connectRemoteDialog({
			questions,
			sessionFile,
			requestId,
			settle,
			isSettled: () => settled,
			setSocket: (ws) => {
				socket = ws;
			},
			setConnectTimer: (timer) => {
				connectTimer = timer;
			},
			clearConnectTimer: () => {
				if (connectTimer) clearTimeout(connectTimer);
				connectTimer = undefined;
			},
		}).catch((err) => {
			settle({ type: "unavailable", reason: `Pimote remote setup failed: ${errMsg(err)}` });
		});
	});

	return {
		promise,
		cancel: (reason: string) => {
			sendCancel(reason);
			settle({ type: "dismissed", reason });
		},
	};
}

async function connectRemoteDialog(args: {
	questions: AskUserQuestionItem[];
	sessionFile: string;
	requestId: string;
	settle: (result: RemoteDialogResult) => void;
	isSettled: () => boolean;
	setSocket: (ws: SocketLike) => void;
	setConnectTimer: (timer: ReturnType<typeof setTimeout>) => void;
	clearConnectTimer: () => void;
}): Promise<void> {
	let handshake: { port: number; token: string };
	try {
		handshake = await readHandshake();
	} catch (err) {
		args.settle({ type: "unavailable", reason: `Pimote daemon handshake unavailable: ${errMsg(err)}` });
		return;
	}
	if (args.isSettled()) return;

	const WebSocketCtor = (globalThis as unknown as { WebSocket?: new (url: string) => SocketLike }).WebSocket;
	if (!WebSocketCtor) {
		args.settle({ type: "unavailable", reason: "WebSocket is unavailable in this pi runtime." });
		return;
	}

	let ws: SocketLike;
	try {
		ws = new WebSocketCtor(`ws://127.0.0.1:${handshake.port}/?token=${encodeURIComponent(handshake.token)}`);
	} catch (err) {
		args.settle({ type: "unavailable", reason: `Pimote daemon connection failed: ${errMsg(err)}` });
		return;
	}
	if (args.isSettled()) {
		try {
			ws.close();
		} catch {
			// Ignore close failures after a local winner cancelled the remote path.
		}
		return;
	}

	args.setSocket(ws);
	args.setConnectTimer(
		setTimeout(() => {
			args.settle({ type: "unavailable", reason: "Pimote daemon connection timed out." });
		}, REMOTE_CONNECT_TIMEOUT_MS),
	);

	onSocket(ws, "open", () => {
		args.clearConnectTimer();
		if (args.isSettled()) return;
		try {
			ws.send(JSON.stringify({ op: "ext_register", role: "ask", sessionFile: args.sessionFile }));
			ws.send(JSON.stringify({ op: "ask_start", sessionFile: args.sessionFile, requestId: args.requestId, questions: args.questions }));
		} catch (err) {
			args.settle({ type: "unavailable", reason: `Pimote remote question send failed: ${errMsg(err)}` });
		}
	});
	onSocket(ws, "message", (ev) => {
		let frame: { op?: string; sessionFile?: unknown; requestId?: unknown; answers?: unknown; reason?: unknown };
		try {
			const raw = messageDataToString(ev);
			if (!raw) return;
			frame = JSON.parse(raw) as typeof frame;
		} catch {
			return;
		}
		if (frame.requestId !== args.requestId) return;

		if (frame.op === "ask_answer") {
			args.settle({ type: "answered", states: remoteAnswerToStates(args.questions, frame.answers) });
			return;
		}
		if (frame.op === "ask_dismiss") {
			const reason = typeof frame.reason === "string" && frame.reason ? frame.reason : "Dismissed from Pimote.";
			args.settle(remoteDismissIsUnavailable(reason) ? { type: "unavailable", reason } : { type: "dismissed", reason });
		}
	});
	onSocket(ws, "close", () => {
		args.settle({ type: "unavailable", reason: "Pimote daemon connection closed before an answer." });
	});
	onSocket(ws, "error", () => {
		args.settle({ type: "unavailable", reason: "Pimote daemon connection failed before an answer." });
	});
}

function remoteAnswerToStates(questions: AskUserQuestionItem[], rawAnswers: unknown): SelectionState[] {
	const answers = isRecord(rawAnswers) ? (rawAnswers as RemoteAskAnswer) : {};
	return questions.map((question) => {
		const raw = isRecord(answers[question.header]) ? answers[question.header] : {};
		const selectedIndexes: number[] = [];
		const customCandidates: string[] = [];

		for (const label of remoteSelectedLabels(raw.selected)) {
			const index = question.options.findIndex((option) => option.label === label);
			if (index >= 0) {
				selectedIndexes.push(index);
			} else {
				customCandidates.push(label);
			}
		}

		const explicitCustom = typeof raw.custom === "string" && raw.custom.trim() ? raw.custom : "";
		const customText = explicitCustom || customCandidates.join(", ");
		if (customText.trim()) selectedIndexes.push(getCustomOptionIndex(question));

		const choiceNotes: Record<number, string> = {};
		if (isRecord(raw.choiceNotes)) {
			for (const [label, note] of Object.entries(raw.choiceNotes)) {
				if (typeof note !== "string") continue;
				const index = question.options.findIndex((option) => option.label === label);
				if (index >= 0) choiceNotes[index] = note;
			}
		}

		return normalizeSelectionState(question, {
			...createInitialSelectionState(question),
			focusedIndex: selectedIndexes[0] ?? 0,
			selectedIndexes,
			customText,
			choiceNotes,
		});
	});
}

function remoteSelectedLabels(value: unknown): string[] {
	const values = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
	return values.filter((item): item is string => typeof item === "string" && item !== CUSTOM_ANSWER_LABEL);
}

function remoteDismissIsUnavailable(reason: string): boolean {
	const lower = reason.toLowerCase();
	return lower.includes("no pimote client") || lower.includes("all pimote clients") || lower.includes("unavailable");
}

async function readHandshake(): Promise<{ port: number; token: string }> {
	const parsed = JSON.parse(await readFile(HANDSHAKE_PATH, "utf8")) as { port?: unknown; token?: unknown };
	if (typeof parsed.port !== "number" || !Number.isInteger(parsed.port) || typeof parsed.token !== "string" || !parsed.token) {
		throw new Error("invalid Pimote daemon handshake");
	}
	return { port: parsed.port, token: parsed.token };
}

function safeSessionFile(ctx: ExecuteContextLike): string | undefined {
	try {
		const value = ctx.sessionManager?.getSessionFile?.();
		return typeof value === "string" && value ? value : undefined;
	} catch {
		return undefined;
	}
}

function createRequestId(): string {
	return `ask-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function onSocket(ws: SocketLike, event: "open" | "message" | "close" | "error", handler: (ev?: unknown) => void): void {
	try {
		if (ws.addEventListener) ws.addEventListener(event, handler);
		else if (event === "open") ws.onopen = () => handler();
		else if (event === "message") ws.onmessage = (ev) => handler(ev);
		else if (event === "close") ws.onclose = () => handler();
		else if (event === "error") ws.onerror = () => handler();
	} catch {
		// Ignore event wiring failures; the timeout/close handling will recover.
	}
}

function messageDataToString(ev: unknown): string | undefined {
	const data = typeof ev === "object" && ev !== null && "data" in ev ? (ev as { data?: unknown }).data : ev;
	if (typeof data === "string") return data;
	if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
	if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
	return undefined;
}

function errMsg(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export default function AskUserQuestion(pi: ExtensionAPI) {
	pi.registerTool({
		name: "AskUserQuestion",
		label: "Ask User Question",
		description:
			"Ask the user one or more Claude Code-style questions with labeled options, optional multi-select, per-choice notes, and custom free-text answers. Returns answers keyed by question header.",
		promptSnippet: "Ask the user a structured multiple-choice question and return selected option labels/custom answers plus per-choice notes.",
		promptGuidelines: [
			"Use AskUserQuestion when progress depends on a user decision that should be captured as structured selected option labels/custom answers and optional per-choice notes.",
		],
		parameters: AskUserQuestionParams,

		async execute(_toolCallId, params: { questions: AskUserQuestionItem[] }, signal, _onUpdate, ctx) {
			const questions = params.questions ?? [];

			if (questions.length === 0) {
				return cancelledResult(questions, [], "No questions were provided.");
			}

			if (signal?.aborted) {
				return cancelledResult(questions, [], "AskUserQuestion was aborted.");
			}

			const remote = startRemoteDialog(questions, ctx, signal);

			if (!ctx.hasUI) {
				const remoteResult = await remote.promise;
				if (remoteResult.type === "answered") return answeredResult(questions, remoteResult.states);
				if (remoteResult.type === "dismissed") {
					return cancelledResult(questions, createInitialNavigationState(questions).states, remoteResult.reason);
				}
				return nonInteractiveResult(questions);
			}

			const local = startLocalDialog(ctx, questions);
			const first = await Promise.race([
				local.promise.then((result) => ({ source: "local" as const, result })),
				remote.promise.then((result) => ({ source: "remote" as const, result })),
			]);

			if (first.source === "remote") {
				if (first.result.type === "unavailable") {
					const localResult = await local.promise;
					if (!localResult) return cancelledResult(questions, local.initialStates, "User cancelled AskUserQuestion.");
					return answeredResult(questions, localResult.states);
				}

				local.cancel();
				if (first.result.type === "answered") return answeredResult(questions, first.result.states);
				return cancelledResult(questions, local.initialStates, first.result.reason);
			}

			remote.cancel("Answered in the local terminal.");
			if (!first.result) {
				return cancelledResult(questions, local.initialStates, "User cancelled AskUserQuestion.");
			}
			return answeredResult(questions, first.result.states);
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
				const notes = choiceNotes ? theme.fg("muted", ` — choice notes: ${choiceNotes}`) : "";
				return `${theme.fg("success", "✓ ")}${theme.fg("accent", header)}: ${selected}${notes}`;
			});
			return new Text(lines.join("\n") || theme.fg("muted", "No answers"), 0, 0);
		},
	});
}
