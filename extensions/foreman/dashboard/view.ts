/** Foreman dashboard TUI component. Read-only over the Phase A ledger. */

import * as os from "node:os";
import { getMarkdownTheme, type Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { Container, Key, type KeyId, Markdown, matchesKey, truncateToWidth, visibleWidth, type Focusable, type TUI } from "@earendil-works/pi-tui";
import {
	buildRootRows,
	buildStatuslineModel,
	formatElapsed,
	listRuns,
	listTasks,
	readActivity,
	readTranscript,
	sortForPicker,
	type ForemanActivity,
	type ForemanRunInfo,
	type ForemanTaskSummary,
	type RootRow,
	type StatuslineTask,
	type TranscriptEvent,
} from "./reader.ts";

type PickerView = { type: "picker" };
type RootView = { type: "root"; slug: string };
type AgentView = { type: "agent"; slug: string; file: string; role: string; round: number };
type DashboardView = PickerView | RootView | AgentView;

type ToolArgs = Record<string, unknown>;

const POLL_INTERVAL_MS = 600;

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(value, max));
}

function asRecord(value: unknown): ToolArgs {
	if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as ToolArgs;
	if (typeof value === "string") {
		try {
			const parsed = JSON.parse(value);
			if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as ToolArgs;
		} catch {
			/* use _raw below */
		}
		return { _raw: value };
	}
	return {};
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(event: Extract<TranscriptEvent, { kind: "usage" }>): string {
	const parts: string[] = [];
	if (event.input) parts.push(`↑${formatTokens(event.input)}`);
	if (event.output) parts.push(`↓${formatTokens(event.output)}`);
	if (event.cost) parts.push(`$${event.cost.toFixed(4)}`);
	if (event.contextTokens) parts.push(`ctx:${formatTokens(event.contextTokens)}`);
	return parts.join(" ");
}

function formatToolCall(
	toolName: string,
	args: ToolArgs,
	themeFg: (color: ThemeColor, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "grep ") + themeFg("accent", `/${pattern}/`) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

export class ForemanDashboard extends Container implements Focusable {
	private readonly cwd: string;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly done: (result: void) => void;
	private readonly sessionId?: string;
	private stack: DashboardView[] = [{ type: "picker" }];
	private allTasks: ForemanTaskSummary[] = [];
	private tasks: ForemanTaskSummary[] = [];
	private statusTasks: StatuslineTask[] = [];
	private rows: RootRow[] = [];
	private runs: ForemanRunInfo[] = [];
	private activity: ForemanActivity | null = null;
	private transcript: TranscriptEvent[] = [];
	private selectedTaskIndex = 0;
	private selectedRootIndex = 0;
	private mineOnly = false;
	private agentScroll = 0;
	/** In the agent view: keep retargeting to the live transcript + stick to the tail as it grows. */
	private followLive = true;
	/** True while the agent view is scrolled to the bottom (so new lines auto-reveal). */
	private agentAtBottom = true;
	private statusMessage = "";
	private snapshot = "";
	private pollTimer: ReturnType<typeof setInterval> | null = null;
	private _focused = false;
	private closed = false;

	constructor(cwd: string, tui: TUI, theme: Theme, done: (result: void) => void, options?: { openLive?: boolean; sessionId?: string }) {
		super();
		this.cwd = cwd;
		this.tui = tui;
		this.theme = theme;
		this.done = done;
		this.sessionId = options?.sessionId;
		this.reloadModel();
		if (options?.openLive) this.jumpToLiveAgent();
		this.snapshot = this.computeSnapshot();
		this.pollTimer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
	}

	/**
	 * Navigate straight to the agent transcript that is running right now (newest task whose
	 * activity.json points at a live transcript). Falls back to that task's root view, or the
	 * picker when nothing is live. Used by the "jump to live" shortcut.
	 */
	private jumpToLiveAgent(): void {
		for (const task of this.tasks) {
			const activity = readActivity(this.cwd, task.slug);
			if (!activity?.activeTranscript) continue;
			const runs = listRuns(this.cwd, task.slug);
			const liveRun = runs.find((r) => r.file === activity.activeTranscript);
			if (!liveRun) continue;
			this.stack = [
				{ type: "picker" },
				{ type: "root", slug: task.slug },
				{ type: "agent", slug: task.slug, file: liveRun.file, role: liveRun.role, round: liveRun.round },
			];
			this.selectedTaskIndex = Math.max(0, this.tasks.findIndex((t) => t.slug === task.slug));
			this.followLive = true;
			this.agentAtBottom = true;
			this.agentScroll = Number.MAX_SAFE_INTEGER;
			this.reloadModel();
			return;
		}
		// Nothing live: open the most-recently-updated task's root view if there is one.
		if (this.tasks.length > 0) {
			this.stack = [{ type: "picker" }, { type: "root", slug: this.tasks[0].slug }];
			this.reloadModel();
		}
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
	}

	dispose(): void {
		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = null;
		}
	}

	handleInput(data: string): void {
		// The same keys that open the dashboard also close it (toggle), so you don't reach for Esc.
		// Terminals encode Ctrl+B/Ctrl+F as Kitty CSI-u sequences (e.g. ESC[98;5u), not raw \x02/\x06,
		// so match by key id exactly as registerShortcut does for opening.
		if (matchesKey(data, "ctrl+b" as KeyId) || matchesKey(data, "ctrl+f" as KeyId)) {
			this.close();
			return;
		}
		const view = this.currentView();
		if (view.type === "picker") {
			this.handlePickerInput(data);
			return;
		}
		if (view.type === "root") {
			this.handleRootInput(data);
			return;
		}
		this.handleAgentInput(data);
	}

	override invalidate(): void {
		super.invalidate();
	}

	override render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const view = this.currentView();
		const lines =
			view.type === "picker" ? this.renderPicker(safeWidth) : view.type === "root" ? this.renderRoot(safeWidth, view) : this.renderAgent(safeWidth, view);
		return this.limitScreen(lines, safeWidth);
	}

	private handlePickerInput(data: string): void {
		if (matchesKey(data, Key.up)) {
			this.selectedTaskIndex = clamp(this.selectedTaskIndex - 1, 0, Math.max(0, this.tasks.length - 1));
			this.statusMessage = "";
			this.requestRender();
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.selectedTaskIndex = clamp(this.selectedTaskIndex + 1, 0, Math.max(0, this.tasks.length - 1));
			this.statusMessage = "";
			this.requestRender();
			return;
		}
		if (matchesKey(data, Key.right) || matchesKey(data, Key.enter)) {
			const task = this.tasks[this.selectedTaskIndex];
			if (!task) return;
			this.stack = [{ type: "picker" }, { type: "root", slug: task.slug }];
			this.selectedRootIndex = 0;
			this.statusMessage = "";
			this.forceRefresh();
			return;
		}
		if (data === "m") {
			this.mineOnly = !this.mineOnly;
			this.selectedTaskIndex = 0;
			this.statusMessage = "";
			this.forceRefresh();
			return;
		}
		if (matchesKey(data, Key.escape)) this.close();
	}

	private handleRootInput(data: string): void {
		if (matchesKey(data, Key.up)) {
			this.selectedRootIndex = clamp(this.selectedRootIndex - 1, 0, Math.max(0, this.rows.length - 1));
			this.statusMessage = "";
			this.requestRender();
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.selectedRootIndex = clamp(this.selectedRootIndex + 1, 0, Math.max(0, this.rows.length - 1));
			this.statusMessage = "";
			this.requestRender();
			return;
		}
		if (matchesKey(data, Key.right) || matchesKey(data, Key.enter)) {
			this.openSelectedRow();
			return;
		}
		if (matchesKey(data, Key.left) || matchesKey(data, Key.escape)) {
			this.stack = [{ type: "picker" }];
			this.statusMessage = "";
			this.forceRefresh();
			return;
		}
		if (data === "r") this.forceRefresh();
	}

	private handleAgentInput(data: string): void {
		const page = this.agentPageSize();
		// Manual upward scrolling pauses live-follow so the user can read; reaching the bottom (or G)
		// resumes following the running agent's tail.
		if (matchesKey(data, Key.up)) {
			this.agentScroll = Math.max(0, this.agentScroll - 1);
			this.followLive = false;
			this.agentAtBottom = false;
			this.requestRender();
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.agentScroll = this.agentScroll + 1;
			this.requestRender();
			return;
		}
		if (matchesKey(data, Key.pageUp)) {
			this.agentScroll = Math.max(0, this.agentScroll - page);
			this.followLive = false;
			this.agentAtBottom = false;
			this.requestRender();
			return;
		}
		if (matchesKey(data, Key.pageDown)) {
			this.agentScroll = this.agentScroll + page;
			this.requestRender();
			return;
		}
		if (data === "g") {
			this.agentScroll = 0;
			this.followLive = false;
			this.agentAtBottom = false;
			this.requestRender();
			return;
		}
		if (data === "G") {
			this.agentScroll = Number.MAX_SAFE_INTEGER;
			this.followLive = true;
			this.agentAtBottom = true;
			this.requestRender();
			return;
		}
		if (matchesKey(data, Key.left) || matchesKey(data, Key.escape)) {
			this.stack.pop();
			this.statusMessage = "";
			this.forceRefresh();
		}
	}

	private currentView(): DashboardView {
		return this.stack[this.stack.length - 1] ?? { type: "picker" };
	}

	private currentSlug(): string | null {
		const view = this.currentView();
		return view.type === "root" || view.type === "agent" ? view.slug : null;
	}

	private close(): void {
		if (this.closed) return;
		this.closed = true;
		this.dispose();
		this.done(undefined);
	}

	private poll(): void {
		if (this.closed) return;
		this.reloadModel();
		const next = this.computeSnapshot();
		if (next !== this.snapshot) {
			this.snapshot = next;
			this.requestRender();
		}
	}

	private forceRefresh(): void {
		this.reloadModel();
		this.snapshot = this.computeSnapshot();
		this.requestRender();
	}

	private reloadModel(): void {
		this.statusTasks = buildStatuslineModel(this.cwd, { now: Date.now() });
		const liveSlugs = this.statusTasks.filter((task) => task.glyph === "running").map((task) => task.slug);
		this.allTasks = sortForPicker(listTasks(this.cwd), this.sessionId, { liveSlugs });
		this.tasks = this.mineOnly ? this.allTasks.filter((task) => this.isMine(task)) : this.allTasks;
		this.selectedTaskIndex = clamp(this.selectedTaskIndex, 0, Math.max(0, this.tasks.length - 1));

		const slug = this.currentSlug();
		if (!slug) {
			this.rows = [];
			this.runs = [];
			this.activity = null;
			this.transcript = [];
			return;
		}

		this.rows = buildRootRows(this.cwd, slug);
		this.runs = listRuns(this.cwd, slug);
		this.activity = readActivity(this.cwd, slug);
		this.selectedRootIndex = clamp(this.selectedRootIndex, 0, Math.max(0, this.rows.length - 1));

		const view = this.currentView();
		if (view.type === "agent") {
			// If this open agent view is the one currently running, follow the LIVE transcript file.
			// The loop writes a NEW transcript per phase/round, so a view pinned to the file chosen at
			// open time would go stale (the old "Esc and re-enter to see updates" bug). When activity
			// points at a fresh transcript for this view's role, retarget the view to it.
			if (this.activity?.activeTranscript && this.followLive) {
				const liveRun = this.runs.find((r) => r.file === this.activity?.activeTranscript);
				if (liveRun && liveRun.role === view.role && this.activity.activeTranscript !== view.file) {
					view.file = this.activity.activeTranscript;
					view.round = liveRun.round;
				}
			}
			this.transcript = readTranscript(this.cwd, view.slug, view.file);
		} else {
			this.transcript = [];
		}
	}

	private computeSnapshot(): string {
		return JSON.stringify({
			view: this.currentView(),
			mineOnly: this.mineOnly,
			allTasks: this.allTasks,
			tasks: this.tasks,
			statusTasks: this.statusTasks,
			rows: this.rows,
			runs: this.runs,
			activity: this.activity,
			transcript: this.transcript,
		});
	}

	private requestRender(): void {
		this.invalidate();
		this.tui.requestRender();
	}

	private isMine(task: ForemanTaskSummary): boolean {
		return Boolean(this.sessionId && task.ownerSessionId === this.sessionId);
	}

	private sessionBadge(ownerSessionId: string | undefined): string {
		if (!ownerSessionId) return this.theme.fg("dim", "—");
		if (this.sessionId && ownerSessionId === this.sessionId) return this.theme.fg("accent", "● this session");
		return this.theme.fg("dim", "○ other session");
	}

	private ownerBadge(task: ForemanTaskSummary | undefined): string {
		return this.sessionBadge(task?.ownerSessionId);
	}

	private currentStatusTask(slug: string): StatuslineTask | undefined {
		return this.statusTasks.find((task) => task.slug === slug);
	}

	private agentLiveSummary(slug: string, fallback: string): string {
		const status = this.currentStatusTask(slug);
		const parts = [fallback];
		if (status?.liveAction) parts.push(status.liveAction);
		const elapsed = formatElapsed(status?.elapsedMs);
		if (elapsed) parts.push(elapsed);
		if (status?.toolCount !== undefined) parts.push(`${status.toolCount} tool${status.toolCount === 1 ? "" : "s"}`);
		return parts.join(" · ");
	}

	private renderPicker(width: number): string[] {
		const height = this.viewportHeight();
		const thisSession = this.allTasks.filter((task) => this.isMine(task)).length;
		const taskSummary = `${this.allTasks.length} task${this.allTasks.length === 1 ? "" : "s"} · ${thisSession} this session${this.mineOnly ? " · mine only" : ""}`;
		const header = [
			this.borderTitle("FOREMAN", taskSummary, width),
			this.theme.fg("dim", `cwd: ${this.cwd}`),
			this.separator(width),
		];
		const footer = [
			this.separator(width),
			this.theme.fg("dim", "↑/↓ select   →/Enter open task   m mine/all   Esc / Ctrl+B / Ctrl+F close"),
		];
		const bodyHeight = Math.max(1, height - header.length - footer.length);
		const body: string[] = [];

		if (this.tasks.length === 0) {
			body.push(this.theme.fg("muted", this.mineOnly && this.allTasks.length > 0 ? "No Foreman tasks owned by this session." : "No Foreman ledgers found at .pi/plans."));
		} else {
			const start = this.windowStart(this.tasks.length, this.selectedTaskIndex, bodyHeight);
			for (let offset = 0; offset < bodyHeight && start + offset < this.tasks.length; offset++) {
				const index = start + offset;
				body.push(this.renderTaskRow(this.tasks[index], index === this.selectedTaskIndex, width));
			}
		}
		if (this.statusMessage) body.push(this.theme.fg("warning", this.statusMessage));
		return [...header, ...body, ...footer];
	}

	private renderRoot(width: number, view: RootView): string[] {
		const height = this.viewportHeight();
		const task = this.tasks.find((candidate) => candidate.slug === view.slug);
		const gate1 = task?.gate1Approved ? this.theme.fg("success", "✓") : this.theme.fg("muted", "·");
		const gate2 = task?.gate2Approved ? this.theme.fg("success", "✓") : this.theme.fg("muted", "·");
		const header = [
			this.borderTitle(`< FOREMAN`, `task: ${task?.slug ?? view.slug}`, width),
			`state: ${this.colorState(task?.state ?? "unknown")}   owner ${this.ownerBadge(task)}   gate1 ${gate1}   gate2 ${gate2}   round ${task?.round ?? 0}/${task?.maxRounds ?? 0}`,
			`verify: ${this.theme.fg("toolOutput", task?.verifyCommand ?? "(developer/tester inferred)")}`,
			this.separator(width),
		];
		const footer = [
			this.separator(width),
			this.theme.fg("dim", "↑/↓ select   →/Enter open agent transcript   ←/Esc tasks   r refresh"),
		];
		const bodyHeight = Math.max(1, height - header.length - footer.length);
		const body: string[] = [];

		if (this.rows.length === 0) {
			body.push(this.theme.fg("muted", "No round activity yet."));
		} else {
			const start = this.windowStart(this.rows.length, this.selectedRootIndex, bodyHeight);
			for (let offset = 0; offset < bodyHeight && start + offset < this.rows.length; offset++) {
				const index = start + offset;
				body.push(this.renderRootRow(this.rows[index], index === this.selectedRootIndex, width));
			}
		}
		if (this.statusMessage) body.push(this.theme.fg("warning", this.statusMessage));
		return [...header, ...body, ...footer];
	}

	private renderAgent(width: number, view: AgentView): string[] {
		const height = this.viewportHeight();
		const start = this.transcript.find((event): event is Extract<TranscriptEvent, { kind: "agent_start" }> => event.kind === "agent_start");
		const run = this.runs.find((candidate) => candidate.file === view.file);
		const live = this.isLiveTranscript(view.file);
		const running = live
			? this.theme.fg("accent", this.agentLiveSummary(view.slug, "● running"))
			: this.theme.fg("muted", "○ replay");
		const transcriptLabel = run ? `${run.role} r${run.round}` : "transcript";
		const header = [
			this.borderTitle(`< ${view.role} · round ${view.round}`, `${start?.model ?? "model?"}   ${running}`, width),
			this.theme.fg("dim", `${transcriptLabel} · ${this.sessionBadge(run?.sessionId)}`),
			this.separator(width),
		];
		const footer = [
			this.separator(width),
			this.theme.fg("dim", "←/Esc back   ↑/↓ scroll   PgUp/PgDn page   g/G top/bottom   G follows live"),
		];
		const content = this.renderTranscriptLines(width);
		let bodyHeight = Math.max(1, height - header.length - footer.length);
		if (content.length > bodyHeight) bodyHeight = Math.max(1, bodyHeight - 1);
		const maxScroll = Math.max(0, content.length - bodyHeight);
		// Auto-tail: while following (just opened, pressed G, or never scrolled up), stick to the
		// bottom so a live agent's new lines appear without the user touching anything.
		if (this.agentAtBottom) this.agentScroll = maxScroll;
		this.agentScroll = clamp(this.agentScroll, 0, maxScroll);
		// Re-arm follow once the user manually scrolls back to the bottom.
		if (this.agentScroll >= maxScroll) {
			this.agentAtBottom = true;
			if (live) this.followLive = true;
		}
		const body = content.slice(this.agentScroll, this.agentScroll + bodyHeight);
		const atTail = this.agentScroll >= maxScroll;
		const tailTag = live ? (atTail ? this.theme.fg("success", " following") : this.theme.fg("warning", " paused")) : "";
		const scrollInfo =
			content.length > bodyHeight
				? this.theme.fg("dim", `  lines ${this.agentScroll + 1}-${Math.min(content.length, this.agentScroll + bodyHeight)}/${content.length}`) + tailTag
				: "";
		return [...header, ...body, scrollInfo, ...footer].filter((line) => line !== "");
	}

	private renderTaskRow(task: ForemanTaskSummary, selected: boolean, width: number): string {
		const cursor = selected ? this.theme.fg("accent", "▶") : " ";
		const gate1 = task.gate1Approved ? this.theme.fg("success", "g1✓") : this.theme.fg("muted", "g1·");
		const gate2 = task.gate2Approved ? this.theme.fg("success", "g2✓") : this.theme.fg("muted", "g2·");
		const line = `${cursor} ${this.theme.fg("accent", task.slug)}  ${this.ownerBadge(task)}  ${this.colorState(task.state)}  r${task.round}/${task.maxRounds}  ${gate1} ${gate2}  ${this.theme.fg("text", task.task)}`;
		return this.selectedLine(line, selected, width);
	}

	private renderRootRow(row: RootRow, selected: boolean, width: number): string {
		const cursor = selected ? this.theme.fg("accent", "▶") : " ";
		const live = row.live ? this.theme.fg("accent", "●") : this.theme.fg("muted", " ");
		const icon = row.live ? this.theme.fg("muted", " ") : this.rowIcon(row);
		const role = this.theme.fg(row.kind === "developer" ? "accent" : row.kind === "tester" ? "warning" : "muted", row.kind.padEnd(9));
		const transcript = row.transcriptFile ? "" : this.theme.fg("dim", "  (no transcript)");
		const line = `${cursor} R${row.round}  ${live} ${icon} ${role} ${this.theme.fg("toolOutput", row.status.padEnd(10))} ${this.theme.fg("text", row.summary)}${transcript}`;
		return this.selectedLine(line, selected, width);
	}

	private renderTranscriptLines(width: number): string[] {
		if (this.transcript.length === 0) return [this.theme.fg("muted", "(transcript empty)")];
		const lines: string[] = [];
		let textBuffer = "";
		const flushText = () => {
			if (!textBuffer.trim()) {
				textBuffer = "";
				return;
			}
			const markdown = new Markdown(textBuffer.trim(), 0, 0, getMarkdownTheme());
			for (const line of markdown.render(Math.max(1, width - 2))) lines.push(`  ${line}`);
			textBuffer = "";
		};

		for (const event of this.transcript) {
			if (event.kind === "text") {
				textBuffer += event.text;
				continue;
			}
			flushText();
			if (event.kind === "agent_start") {
				lines.push(this.theme.fg("dim", `agent_start ${event.role} r${event.round} ${event.model}`));
				if (event.task) lines.push(this.theme.fg("muted", `task: ${event.task}`));
				continue;
			}
			if (event.kind === "tool_call") {
				lines.push(this.theme.fg("muted", "→ ") + formatToolCall(event.name, asRecord(event.args), this.theme.fg.bind(this.theme)));
				continue;
			}
			if (event.kind === "tool_result") {
				const marker = event.ok ? this.theme.fg("success", "✓") : this.theme.fg("error", "✗");
				const previewLines = event.preview.split(/\r?\n/);
				lines.push(`${this.theme.fg("muted", "← ")}${marker} ${this.theme.fg("accent", event.name)} ${this.theme.fg("toolOutput", previewLines[0] || "(no output)")}`);
				for (const preview of previewLines.slice(1, 4)) lines.push(this.theme.fg("toolOutput", `    ${preview}`));
				if (previewLines.length > 4) lines.push(this.theme.fg("dim", `    … ${previewLines.length - 4} more output lines`));
				continue;
			}
			if (event.kind === "usage") {
				const usage = formatUsageStats(event);
				if (usage) lines.push(this.theme.fg("dim", `usage ${usage}`));
				continue;
			}
			if (event.kind === "agent_end") {
				const ok = event.exitCode === 0;
				lines.push(`${ok ? this.theme.fg("success", "✓") : this.theme.fg("error", "✗")} ${this.theme.fg("dim", `agent_end ${event.stopReason} exit ${event.exitCode}`)}`);
			}
		}
		flushText();
		return lines.map((line) => this.fit(line, width));
	}

	private openSelectedRow(): void {
		const view = this.currentView();
		if (view.type !== "root") return;
		const row = this.rows[this.selectedRootIndex];
		if (!row?.transcriptFile) {
			this.statusMessage = "Selected row has no transcript.";
			this.requestRender();
			return;
		}
		this.stack.push({ type: "agent", slug: view.slug, file: row.transcriptFile, role: row.kind, round: row.round });
		this.agentScroll = Number.MAX_SAFE_INTEGER;
		this.followLive = true;
		this.agentAtBottom = true;
		this.statusMessage = "";
		this.forceRefresh();
	}

	private rowIcon(row: RootRow): string {
		if (row.live) return this.theme.fg("accent", "●");
		if (row.kind === "verify") {
			if (/exit\s+0\b/.test(row.status)) return this.theme.fg("success", "✓");
			if (/exit\s+[1-9]/.test(row.status)) return this.theme.fg("error", "✗");
			return this.theme.fg("muted", "◦");
		}
		if (/^(success|done|pass|passed)$/i.test(row.status)) return this.theme.fg("success", "✓");
		if (/^(fail|failed)$/i.test(row.status)) return this.theme.fg("error", "✗");
		if (/^(partial|blocked)$/i.test(row.status)) return this.theme.fg("warning", "◐");
		return this.theme.fg("muted", "◦");
	}

	private colorState(state: string): string {
		if (state === "done") return this.theme.fg("success", state);
		if (state === "escalated") return this.theme.fg("error", state);
		if (state === "awaiting_ship" || state === "awaiting_decision" || state === "planning") return this.theme.fg("warning", state);
		if (state === "in_progress") return this.theme.fg("accent", state);
		return this.theme.fg("muted", state);
	}

	private isLiveTranscript(file: string): boolean {
		return Boolean(this.activity && this.activity.phase !== "idle" && this.activity.activeTranscript === file);
	}

	private windowStart(total: number, selected: number, height: number): number {
		if (total <= height) return 0;
		const half = Math.floor(height / 2);
		return clamp(selected - half, 0, total - height);
	}

	private agentPageSize(): number {
		return Math.max(1, this.viewportHeight() - 6);
	}

	private viewportHeight(): number {
		return Math.max(8, this.tui.terminal.rows || 24);
	}

	private borderTitle(leftTitle: string, rightTitle: string, width: number): string {
		const left = `┌ ${leftTitle} `;
		const right = ` ${rightTitle} ┐`;
		const fill = "─".repeat(Math.max(0, width - visibleWidth(left) - visibleWidth(right)));
		return this.theme.fg("accent", `${left}${fill}${right}`);
	}

	private separator(width: number): string {
		return this.theme.fg("accent", "─".repeat(Math.max(1, width)));
	}

	private selectedLine(line: string, selected: boolean, width: number): string {
		const fitted = this.pad(this.fit(line, width), width);
		return selected ? this.theme.bg("selectedBg", fitted) : fitted;
	}

	private fit(line: string, width: number): string {
		return truncateToWidth(line, Math.max(1, width));
	}

	private pad(line: string, width: number): string {
		const visible = visibleWidth(line);
		return visible >= width ? line : `${line}${" ".repeat(width - visible)}`;
	}

	private limitScreen(lines: string[], width: number): string[] {
		return lines.slice(0, this.viewportHeight()).map((line) => this.fit(line, width));
	}
}
