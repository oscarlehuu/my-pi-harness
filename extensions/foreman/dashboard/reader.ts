/**
 * Pure ledger reader for the Foreman dashboard.
 *
 * This module intentionally has no pi/TUI imports. It is a defensive, read-only
 * view over .pi/plans/<slug>/ so it can be unit-tested headlessly.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface ForemanTaskSummary {
	slug: string;
	task: string;
	state: string;
	round: number;
	maxRounds: number;
	gate1Approved: boolean;
	gate2Approved: boolean;
	updatedAt: string;
	verifyCommand?: string;
	ownerSessionId?: string;
}

export type ActivityPhase = "developer" | "verify" | "tester" | "idle" | string;

export interface ForemanActivity {
	updatedAt: string;
	round: number;
	phase: ActivityPhase;
	activeTranscript: string | null;
	note: string;
	pid?: number;
	ownerSessionId?: string;
}

export interface ForemanRunInfo {
	file: string;
	role: string;
	round: number;
	sessionId: string;
}

interface TranscriptBaseEvent {
	t?: string;
	kind: string;
}

export interface AgentStartEvent extends TranscriptBaseEvent {
	kind: "agent_start";
	role: string;
	round: number;
	model: string;
	task: string;
}

export interface ToolCallEvent extends TranscriptBaseEvent {
	kind: "tool_call";
	name: string;
	args: unknown;
}

export interface ToolResultEvent extends TranscriptBaseEvent {
	kind: "tool_result";
	name: string;
	ok: boolean;
	preview: string;
}

export interface TextEvent extends TranscriptBaseEvent {
	kind: "text";
	text: string;
}

export interface UsageEvent extends TranscriptBaseEvent {
	kind: "usage";
	input: number;
	output: number;
	cost: number;
	contextTokens: number;
}

export interface AgentEndEvent extends TranscriptBaseEvent {
	kind: "agent_end";
	stopReason: string;
	exitCode: number;
}

export type TranscriptEvent = AgentStartEvent | ToolCallEvent | ToolResultEvent | TextEvent | UsageEvent | AgentEndEvent;

export type RootRowKind = "developer" | "verify" | "tester";

export interface RootRow {
	round: number;
	kind: RootRowKind;
	status: string;
	summary: string;
	live: boolean;
	transcriptFile?: string;
}

type JsonRecord = Record<string, unknown>;

type InternalRow = RootRow & { order: number };

function plansRoot(cwd: string): string {
	return path.join(cwd, ".pi", "plans");
}

function taskPath(cwd: string, slug: string): string {
	return path.join(plansRoot(cwd), slug);
}

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeReadText(filePath: string): string | null {
	try {
		return fs.readFileSync(filePath, "utf-8");
	} catch {
		return null;
	}
}

function safeReadDir(dirPath: string): string[] {
	try {
		return fs.readdirSync(dirPath);
	} catch {
		return [];
	}
}

function safeParseJson(text: string): unknown | null {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

function safeReadJson(filePath: string): unknown | null {
	const text = safeReadText(filePath);
	return text === null ? null : safeParseJson(text);
}

function toString(value: unknown, fallback = ""): string {
	return typeof value === "string" ? value : fallback;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function toNumber(value: unknown, fallback = 0): number {
	const numberValue = Number(value);
	return Number.isFinite(numberValue) ? numberValue : fallback;
}

function toBoolean(value: unknown): boolean {
	return value === true;
}

function parseTime(value: string): number {
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

function readJsonl(filePath: string): JsonRecord[] {
	const text = safeReadText(filePath);
	if (text === null) return [];
	const events: JsonRecord[] = [];
	for (const line of text.split(/\r?\n/)) {
		if (!line.trim()) continue;
		const parsed = safeParseJson(line);
		if (isRecord(parsed)) events.push(parsed);
	}
	return events;
}

function parseRunFilename(file: string): ForemanRunInfo | null {
	const match = file.match(/^.+__([A-Za-z][A-Za-z0-9_-]*)-r(\d+)__(.+)\.jsonl$/);
	if (!match) return null;
	return {
		file,
		role: match[1],
		round: Number.parseInt(match[2], 10),
		sessionId: match[3],
	};
}

function transcriptForRun(runs: ForemanRunInfo[], role: string, round: number, sessionId?: string): string | undefined {
	if (sessionId) {
		const exact = runs.find((run) => run.role === role && run.round === round && run.sessionId === sessionId);
		if (exact) return exact.file;
	}
	return runs.find((run) => run.role === role && run.round === round)?.file;
}

function normalizeTranscriptEvent(value: unknown): TranscriptEvent | null {
	if (!isRecord(value)) return null;
	const t = optionalString(value.t);
	switch (value.kind) {
		case "agent_start":
			return {
				t,
				kind: "agent_start",
				role: toString(value.role, "unknown"),
				round: toNumber(value.round),
				model: toString(value.model, "default"),
				task: toString(value.task),
			};
		case "tool_call":
			return { t, kind: "tool_call", name: toString(value.name, "unknown"), args: value.args ?? {} };
		case "tool_result":
			return {
				t,
				kind: "tool_result",
				name: toString(value.name, "unknown"),
				ok: value.ok === true,
				preview: toString(value.preview),
			};
		case "text":
			return { t, kind: "text", text: toString(value.text) };
		case "usage":
			return {
				t,
				kind: "usage",
				input: toNumber(value.input),
				output: toNumber(value.output),
				cost: toNumber(value.cost),
				contextTokens: toNumber(value.contextTokens),
			};
		case "agent_end":
			return {
				t,
				kind: "agent_end",
				stopReason: toString(value.stopReason, "unknown"),
				exitCode: toNumber(value.exitCode),
			};
		default:
			return null;
	}
}

function rowKey(kind: RootRowKind, round: number): string {
	return `${round}:${kind}`;
}

function mergeRow(rows: Map<string, InternalRow>, patch: RootRow, order: number): void {
	const key = rowKey(patch.kind, patch.round);
	const existing = rows.get(key);
	rows.set(key, {
		round: patch.round,
		kind: patch.kind,
		status: patch.status || existing?.status || "",
		summary: patch.summary || existing?.summary || "",
		live: Boolean(existing?.live || patch.live),
		transcriptFile: patch.transcriptFile ?? existing?.transcriptFile,
		order: existing ? Math.min(existing.order, order) : order,
	});
}

function kindOrder(kind: RootRowKind): number {
	if (kind === "developer") return 0;
	if (kind === "verify") return 1;
	return 2;
}

function logSummary(event: JsonRecord): string {
	return toString(event.summary) || toString(event.command) || toString(event.note);
}

function verifyStatus(event: JsonRecord): string {
	if (event.exitCode === null || event.exitCode === undefined) return "done";
	return `exit ${toNumber(event.exitCode)}`;
}

function successStatus(value: unknown): string {
	const status = toString(value);
	return status || "done";
}

function activityKind(phase: ActivityPhase): RootRowKind | null {
	if (phase === "developer" || phase === "verify" || phase === "tester") return phase;
	return null;
}

/** Scan task state.json files under .pi/plans, sorted newest-updated first. Includes done tasks. */
export function listTasks(cwd: string): ForemanTaskSummary[] {
	try {
		const tasks: ForemanTaskSummary[] = [];
		for (const slugDir of safeReadDir(plansRoot(cwd))) {
			const statePath = path.join(plansRoot(cwd), slugDir, "state.json");
			const raw = safeReadJson(statePath);
			if (!isRecord(raw)) continue;
			const slug = toString(raw.slug, slugDir);
			const updatedAt = toString(raw.updatedAt) || toString(raw.createdAt);
			tasks.push({
				slug,
				task: toString(raw.task, slug),
				state: toString(raw.state, "unknown"),
				round: toNumber(raw.round),
				maxRounds: toNumber(raw.maxRounds),
				gate1Approved: toBoolean(raw.gate1Approved),
				gate2Approved: toBoolean(raw.gate2Approved),
				updatedAt,
				...(typeof raw.verifyCommand === "string" ? { verifyCommand: raw.verifyCommand } : {}),
				...(typeof raw.ownerSessionId === "string" ? { ownerSessionId: raw.ownerSessionId } : {}),
			});
		}
		return tasks.sort((a, b) => parseTime(b.updatedAt) - parseTime(a.updatedAt) || a.slug.localeCompare(b.slug));
	} catch {
		return [];
	}
}

/** Parse activity.json, or return null when absent/malformed. */
export function readActivity(cwd: string, slug: string): ForemanActivity | null {
	try {
		const raw = safeReadJson(path.join(taskPath(cwd, slug), "activity.json"));
		if (!isRecord(raw)) return null;
		return {
			updatedAt: toString(raw.updatedAt),
			round: toNumber(raw.round),
			phase: toString(raw.phase, "idle"),
			activeTranscript: typeof raw.activeTranscript === "string" ? raw.activeTranscript : null,
			note: toString(raw.note),
			...(typeof raw.ownerSessionId === "string" ? { ownerSessionId: raw.ownerSessionId } : {}),
			...(raw.pid === undefined ? {} : { pid: toNumber(raw.pid) }),
		};
	} catch {
		return null;
	}
}

export type StatuslineGlyph = "running" | "gate" | "escalated" | "done" | "idle";

export type StatuslinePhase = "developer" | "verify" | "tester" | "planner" | "reviewer";

export type StatuslineStage = "plan" | "dev" | "test" | "fix" | "ship";

export interface StatuslineTask {
	slug: string;
	label: string;
	state: string;
	/** Live crew phase from activity.json when the task is actively running, else null. */
	phase: StatuslinePhase | null;
	/** Founder-facing stage for the fixed plan→dev→test→fix→ship footer stepper. */
	stage?: StatuslineStage;
	glyph: StatuslineGlyph;
	/** Current round, when known (0 = not started). */
	round: number;
	maxRounds: number;
	/** Short human state word for the segment (e.g. "dev", "verify", "gate", "done"). */
	detail: string;
	/** Role inferred from the active transcript/activity (e.g. planner, developer, reviewer). */
	liveRole?: string;
	/** Human current action from the last tool_call in the active transcript. */
	liveAction?: string;
	/** Number of tool_call events seen in the active transcript. */
	toolCount?: number;
	/** Latest usage.contextTokens from the active transcript. */
	ctxTokens?: number;
	/** Milliseconds since the active transcript's agent_start.t, injected from opts.now. */
	elapsedMs?: number;
	/** Milliseconds since the last tool_call.t in the active transcript, injected from opts.now. */
	lastMovementMs?: number;
}

export interface StatuslineOptions {
	/** Only include tasks owned by this session. Omit to include all tasks in the repo. */
	sessionId?: string;
	/** Activity older than this (ms) is treated as not-live for picker attention. Default 20s. */
	staleMs?: number;
	/** Keep footer liveness/stepper data for active non-done tasks this long. Default 5m. */
	livenessMs?: number;
	/** "now" injection for deterministic tests. */
	now?: number;
}

/**
 * Trim a task into a readable label. Foreman tasks usually start with a short title before the first
 * "—", ".", ":" or newline (e.g. "Pimote daemon — Slice 2: …"); prefer that head so the footer shows
 * something meaningful instead of a mid-word "…". Falls back to a word-boundary clip.
 */
function shortLabel(task: string, slug: string, max = 36): string {
	const base = (task || slug).replace(/\s+/g, " ").trim();
	const head = base.split(/\s[\u2014-]\s|[.:\n]/)[0].trim();
	const candidate = head.length >= 6 && head.length <= max ? head : base;
	if (candidate.length <= max) return candidate;
	const clipped = candidate.slice(0, max);
	const lastSpace = clipped.lastIndexOf(" ");
	return `${(lastSpace > 10 ? clipped.slice(0, lastSpace) : clipped).trimEnd()}\u2026`;
}

function livePhase(phase: ActivityPhase): StatuslinePhase | null {
	return phase === "developer" || phase === "verify" || phase === "tester" || phase === "planner" || phase === "reviewer" ? phase : null;
}

const PHASE_LABEL: Record<StatuslinePhase, string> = {
	developer: "dev",
	verify: "verify",
	tester: "test",
	planner: "plan",
	reviewer: "review",
};

interface ActiveTranscriptInfo {
	role?: string;
	liveAction?: string;
	toolCount?: number;
	ctxTokens?: number;
	elapsedMs?: number;
	lastMovementMs?: number;
}

function argsRecord(value: unknown): JsonRecord {
	if (isRecord(value)) return value;
	if (typeof value === "string") {
		const parsed = safeParseJson(value);
		if (isRecord(parsed)) return parsed;
	}
	return {};
}

function argString(args: JsonRecord, names: string[]): string | undefined {
	for (const name of names) {
		const value = args[name];
		if (typeof value === "string" && value.trim()) return value;
	}
	return undefined;
}

function basename(value: string | undefined, fallback = "..."): string {
	if (!value) return fallback;
	const base = path.basename(value);
	return base || value || fallback;
}

function truncateAction(value: string, max = 32): string {
	const compact = value.replace(/\s+/g, " ").trim();
	if (compact.length <= max) return compact;
	return `${compact.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

function actionFromToolCall(event: ToolCallEvent): string {
	const name = event.name || "tool";
	const args = argsRecord(event.args);
	switch (name) {
		case "bash":
			return `running ${truncateAction(argString(args, ["command"]) ?? "...")}`;
		case "read":
			return `reading ${basename(argString(args, ["path", "file_path"]))}`;
		case "write":
		case "edit":
			return `editing ${basename(argString(args, ["path", "file_path"]))}`;
		case "grep":
		case "find":
			return "searching";
		default:
			return name;
	}
}

function inferLiveRole(phase: ActivityPhase, transcriptRole?: string, note = ""): string | undefined {
	const role = transcriptRole?.toLowerCase();
	const normalizedNote = note.toLowerCase();
	if (role === "planner") return "planner";
	if (role === "reviewer" || normalizedNote.includes("reviewer") || normalizedNote.includes("pre-ship judge")) return "reviewer";
	if (role === "tester") return "tester";
	if (role === "developer") return "developer";
	if (phase === "planner") return "planner";
	if (phase === "reviewer") return "reviewer";
	if (phase === "verify") return "verify";
	if (phase === "tester") return "tester";
	if (phase === "developer") return "developer";
	return role || undefined;
}

function fallbackLiveAction(role?: string): string | undefined {
	if (role === "planner" || role === "tester" || role === "reviewer") return role;
	return undefined;
}

function readActiveTranscriptInfo(cwd: string, slug: string, activity: ForemanActivity, now: number): ActiveTranscriptInfo {
	try {
		if (!activity.activeTranscript) return {};
		const events = readTranscript(cwd, slug, activity.activeTranscript);
		if (events.length === 0) return {};
		let role: string | undefined;
		let startMs: number | undefined;
		let lastToolCall: ToolCallEvent | undefined;
		let toolCount = 0;
		let ctxTokens: number | undefined;
		for (const event of events) {
			if (event.kind === "agent_start") {
				if (!role) role = event.role;
				if (startMs === undefined && event.t) {
					const parsed = parseTime(event.t);
					if (parsed > 0) startMs = parsed;
				}
				continue;
			}
			if (event.kind === "tool_call") {
				toolCount += 1;
				lastToolCall = event;
				continue;
			}
			if (event.kind === "usage" && event.contextTokens > 0) ctxTokens = event.contextTokens;
		}
		const liveRole = inferLiveRole(activity.phase, role, activity.note);
		const lastToolCallMs = lastToolCall?.t ? parseTime(lastToolCall.t) : 0;
		return {
			...(liveRole ? { role: liveRole } : {}),
			...(lastToolCall ? { liveAction: actionFromToolCall(lastToolCall) } : fallbackLiveAction(liveRole) ? { liveAction: fallbackLiveAction(liveRole) } : {}),
			...(toolCount > 0 ? { toolCount } : {}),
			...(ctxTokens !== undefined ? { ctxTokens } : {}),
			...(startMs !== undefined ? { elapsedMs: Math.max(0, now - startMs) } : {}),
			...(lastToolCallMs > 0 ? { lastMovementMs: Math.max(0, now - lastToolCallMs) } : {}),
		};
	} catch {
		return {};
	}
}

const STATUSLINE_STAGES: StatuslineStage[] = ["plan", "dev", "test", "fix", "ship"];

function statuslineStage(state: string, phase: StatuslinePhase | null, role: string | undefined, round: number): StatuslineStage | undefined {
	if (state === "awaiting_ship" || state === "ship") return "ship";
	if (state === "planning") return "plan";
	if (state === "awaiting_decision") return round >= 2 ? "fix" : "dev";
	const normalizedRole = role?.toLowerCase();
	if (normalizedRole === "planner" || phase === "planner") return "plan";
	if (normalizedRole === "tester" || normalizedRole === "verify" || phase === "tester" || phase === "verify") return "test";
	if (normalizedRole === "reviewer" || phase === "reviewer") return "test";
	if (normalizedRole === "developer" || phase === "developer") return round >= 2 ? "fix" : "dev";
	return undefined;
}

/**
 * Build a compact, newest-first model of this session's foreman tasks for the footer statusline.
 * Active tasks show the crew agent currently spawning (developer/verify/tester); finished tasks
 * get a done glyph (green tick at render time). Pure: reads the ledger, no TUI imports.
 */
export function buildStatuslineModel(cwd: string, opts: StatuslineOptions = {}): StatuslineTask[] {
	const staleMs = opts.staleMs ?? 20000;
	const livenessMs = Math.max(staleMs, opts.livenessMs ?? 300000);
	const now = opts.now ?? Date.now();
	const tasks = listTasks(cwd).filter((t) => (opts.sessionId ? t.ownerSessionId === opts.sessionId : true));
	return tasks.map((t) => {
		const activity = readActivity(cwd, t.slug);
		const activityAgeMs = activity ? now - parseTime(activity.updatedAt) : Number.POSITIVE_INFINITY;
		const fresh = activity ? activityAgeMs <= staleMs : false;
		const livenessFresh = activity ? activityAgeMs <= livenessMs : false;
		const phase = activity && livenessFresh && t.state !== "done" ? livePhase(activity.phase) : null;
		const liveInfo: ActiveTranscriptInfo = activity && livenessFresh && t.state !== "done" && phase ? readActiveTranscriptInfo(cwd, t.slug, activity, now) : {};
		const liveRole = activity && livenessFresh && t.state !== "done" && phase ? (liveInfo.role ?? inferLiveRole(activity.phase, undefined, activity.note)) : undefined;
		const stage = statuslineStage(t.state, phase, liveRole, t.round);
		let glyph: StatuslineGlyph;
		if (t.state === "done") glyph = "done";
		else if (t.state === "escalated") glyph = "escalated";
		else if (t.state === "awaiting_ship" || t.state === "awaiting_decision") glyph = "gate";
		else if (fresh && phase) glyph = "running";
		else if (t.state === "planning") glyph = "gate";
		else glyph = "idle";
		return {
			slug: t.slug,
			label: shortLabel(t.task, t.slug),
			state: t.state,
			phase,
			...(stage ? { stage } : {}),
			glyph,
			round: t.round,
			maxRounds: t.maxRounds,
			detail: statusDetail(t.state, phase, liveRole),
			...(liveRole ? { liveRole } : {}),
			...(liveInfo.liveAction ? { liveAction: liveInfo.liveAction } : {}),
			...(liveInfo.toolCount !== undefined ? { toolCount: liveInfo.toolCount } : {}),
			...(liveInfo.ctxTokens !== undefined ? { ctxTokens: liveInfo.ctxTokens } : {}),
			...(liveInfo.elapsedMs !== undefined ? { elapsedMs: liveInfo.elapsedMs } : {}),
			...(liveInfo.lastMovementMs !== undefined ? { lastMovementMs: liveInfo.lastMovementMs } : {}),
		};
	});
}

/** Short human word for a task segment: the live agent when running, else the state. */
function statusDetail(state: string, phase: StatuslinePhase | null, role?: string): string {
	if (role === "planner") return "plan";
	if (role === "reviewer") return "review";
	if (phase) return PHASE_LABEL[phase];
	switch (state) {
		case "awaiting_ship":
			return "ship?";
		case "awaiting_decision":
			return "answer?";
		case "planning":
			return "plan?";
		case "escalated":
			return "stuck";
		case "done":
			return "done";
		case "in_progress":
			return "idle";
		default:
			return state;
	}
}

const GLYPHS: Record<StatuslineGlyph, string> = {
	running: "\u25B8", // ▸
	gate: "\u25C6", // ◆
	escalated: "\u26A0", // ⚠
	done: "\u2713", // ✓
	idle: "\u00B7", // ·
};

const GLYPH_COLOR: Record<StatuslineGlyph, string> = {
	running: "accent",
	gate: "warning",
	escalated: "warning",
	done: "success",
	idle: "muted",
};

export interface FormatStatusLineOptions {
	/** Visible footer budget to target before pi applies its own terminal truncation. Default 160. */
	maxWidth?: number;
	/** Colorizer (token, text) => text. Default identity (plain text, used by tests). */
	color?: (token: string, text: string) => string;
	/** Background colorizer (token, text) => text. Default identity (plain text, used by tests). */
	bg?: (token: string, text: string) => string;
	/** Animation frame for the live spinner (0..n). Lets the running task pulse. */
	frame?: number;
	/** Reserved for deterministic callers; elapsed is precomputed in the model. */
	now?: number;
}

export interface FormatStatuslineOptions extends FormatStatusLineOptions {
	/** Back-compat no-op; the footer now compacts by width instead of a task count. */
	maxTasks?: number;
}

const SPINNER = ["\u280b", "\u2819", "\u2839", "\u2838", "\u283c", "\u2834", "\u2826", "\u2827", "\u2807", "\u280f"]; // braille dots

export interface SortForPickerOptions {
	/** Slugs with fresh non-idle activity; these sort above gated/stuck work. */
	liveSlugs?: Iterable<string>;
}

function statusAttentionRank(task: StatuslineTask): number {
	if (isStatuslineLive(task)) return 0;
	if (task.glyph === "gate") return 1;
	if (task.glyph === "escalated") return 2;
	if (task.state === "done") return 4;
	return 3;
}

function pickerAttentionRank(task: ForemanTaskSummary, liveSlugs: Set<string>): number {
	if (liveSlugs.has(task.slug)) return 0;
	if (task.state === "awaiting_ship" || task.state === "awaiting_decision" || task.state === "planning") return 1;
	if (task.state === "escalated") return 2;
	if (task.state === "done") return 4;
	return 3;
}

function stageForTask(task: StatuslineTask): StatuslineStage | undefined {
	return task.stage ?? statuslineStage(task.state, task.phase, task.liveRole, task.round);
}

function isStatuslineLive(task: StatuslineTask): boolean {
	return (
		task.state !== "done" &&
		task.state !== "awaiting_ship" &&
		task.state !== "awaiting_decision" &&
		Boolean(stageForTask(task) && (task.phase || task.elapsedMs !== undefined || task.lastMovementMs !== undefined || task.glyph === "running"))
	);
}

export function formatElapsed(ms: number | undefined): string {
	if (ms === undefined || !Number.isFinite(ms)) return "";
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function stripAnsi(value: string): string {
	return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function visibleLength(value: string): number {
	return [...stripAnsi(value)].length;
}

function compactText(value: string): string {
	return value.replace(/[\n\t]+/g, " ").replace(/\s+/g, " ").replace(/\u2026/g, "").trim();
}

function wordClip(text: string, max: number, maxWords = Number.POSITIVE_INFINITY): string {
	const compact = compactText(text);
	if (!compact || max <= 0) return "";
	const words = compact.split(" ");
	const wordLimited = Number.isFinite(maxWords) ? words.slice(0, Math.max(1, maxWords)).join(" ") : compact;
	if ([...wordLimited].length <= max) return wordLimited;
	const clipped = [...wordLimited].slice(0, max).join("").trimEnd();
	const lastSpace = clipped.lastIndexOf(" ");
	return (lastSpace > 0 ? clipped.slice(0, lastSpace) : clipped).trimEnd();
}

function footerLabel(label: string, max: number, maxWords = Number.POSITIVE_INFINITY): string {
	return wordClip(label, max, maxWords) || wordClip(label, max);
}

function footerLiveAction(action: string): string {
	const clean = compactText(action);
	if (!clean) return "";
	if (clean.startsWith("running ")) return `running ${wordClip(clean.slice("running ".length), 24)}`.trim();
	return wordClip(clean, 32);
}

function stageStep(stage: StatuslineStage | undefined, candidate: StatuslineStage): "done" | "current" | "todo" {
	const currentIndex = stage ? STATUSLINE_STAGES.indexOf(stage) : -1;
	const candidateIndex = STATUSLINE_STAGES.indexOf(candidate);
	if (currentIndex < 0 || candidateIndex > currentIndex) return "todo";
	return candidateIndex === currentIndex ? "current" : "done";
}

function renderStageStepper(task: StatuslineTask, color: (token: string, text: string) => string, compact: boolean): string {
	const stage = stageForTask(task);
	if (!stage) return color("muted", "○stage");
	if (compact) return color("accent", `●${stage}`);
	return STATUSLINE_STAGES.map((candidate) => {
		const state = stageStep(stage, candidate);
		if (state === "done") return color("success", `✓${candidate}`);
		if (state === "current") return color("accent", `●${candidate}`);
		return color("muted", `○${candidate}`);
	}).join(" ");
}

function roundText(task: StatuslineTask): string {
	return `r${task.round}/${task.maxRounds || "?"}`;
}

type LivenessAlarm = "healthy" | "stalling" | "stuck";

function livenessAlarm(task: StatuslineTask): LivenessAlarm {
	if (task.lastMovementMs !== undefined && task.lastMovementMs >= 180000) return "stuck";
	if (task.lastMovementMs !== undefined && task.lastMovementMs >= 60000) return "stalling";
	return "healthy";
}

// Background tint tokens MUST be real theme bg keys (theme.bg throws "Unknown theme background
// color" otherwise). The theme registers *Bg keys only; "warning"/"error" are foreground-only.
function statuslineTintToken(task: StatuslineTask): "toolPendingBg" | "toolErrorBg" | undefined {
	if (!isStatuslineLive(task) || task.state === "awaiting_ship") return undefined;
	const alarm = livenessAlarm(task);
	if (alarm === "stuck") return "toolErrorBg";
	if (alarm === "stalling") return "toolPendingBg";
	return undefined;
}

function renderLiveness(task: StatuslineTask, color: (token: string, text: string) => string, frame: number, compact: boolean): string {
	const alarm = livenessAlarm(task);
	if (alarm === "stuck") return `${color("error", "✗")} ${color("error", "NO MOVEMENT")}`;
	const glyph = alarm === "stalling" ? color("warning", "⚠") : color("accent", SPINNER[frame % SPINNER.length]);
	const elapsed = formatElapsed(task.elapsedMs);
	const moved = formatElapsed(task.lastMovementMs);
	const parts: string[] = [];
	if (elapsed) parts.push(elapsed);
	if (moved) parts.push(compact ? `·${moved}` : `moved ${moved} ago`);
	if (parts.length === 0) parts.push("live");
	return `${glyph} ${color("muted", parts.join(compact ? " " : " · "))}`;
}

function gatePrompt(task: StatuslineTask): string {
	if (task.state === "awaiting_ship") return "awaiting ship · approve?";
	if (task.state === "awaiting_decision") return "crew question · answer?";
	return task.state === "planning" ? "planning · approve?" : "gate";
}

function renderLeadTask(
	task: StatuslineTask,
	color: (token: string, text: string) => string,
	frame: number,
	labelMax: number,
	runningTailLevel = 2,
): string {
	const label = footerLabel(task.label, labelMax);
	const compact = runningTailLevel <= 0;
	const stage = stageForTask(task);
	if (isStatuslineLive(task)) {
		const parts = [renderStageStepper(task, color, compact), color("muted", roundText(task)), renderLiveness(task, color, frame, compact)];
		if (runningTailLevel >= 1 && task.liveAction) {
			const action = footerLiveAction(task.liveAction);
			if (action) parts.push(color("text", action));
		}
		if (runningTailLevel >= 2 && label) parts.push(color("dim", label));
		return parts.join("  ");
	}
	if (task.glyph === "gate") {
		const gate = `${color("warning", "◆")} ${color("warning", gatePrompt(task))}`;
		return stage ? `${renderStageStepper(task, color, compact)}  ${color("muted", roundText(task))}  ${gate}` : `${gate} ${color("text", label)}`;
	}
	if (task.glyph === "escalated") return `${color("error", "⚠")} ${color("warning", "stuck")} ${color("text", label)}`;
	return `${color("muted", "·")} ${color("muted", "idle")} ${color("text", label)}`;
}

function renderTaskChip(task: StatuslineTask, color: (token: string, text: string) => string, labelMax: number): string {
	const label = footerLabel(task.label, labelMax, 3);
	return `${color(GLYPH_COLOR[task.glyph], GLYPHS[task.glyph])} ${color(task.glyph === "idle" ? "muted" : "text", label)}`;
}

function renderDoneChip(doneCount: number, color: (token: string, text: string) => string): string {
	return color("success", `✓${doneCount}`);
}

function orderedNonDoneTasks(model: StatuslineTask[]): StatuslineTask[] {
	return model
		.filter((task) => task.state !== "done")
		.sort((a, b) => statusAttentionRank(a) - statusAttentionRank(b) || b.round - a.round || a.label.localeCompare(b.label));
}

/**
 * Render a single rich footer status line for ctx.ui.setStatus(). It is session-scoped by the caller's
 * model, keeps the most important task readable, collapses done tasks to ✓N, and word-clips without
 * a Unicode ellipsis so pi's footer remains useful after its own terminal-width truncation.
 */
export function formatStatusLine(model: StatuslineTask[], opts: FormatStatusLineOptions = {}): string {
	const active = orderedNonDoneTasks(model);
	const color = opts.color ?? ((_token, text) => text);
	const bg = opts.bg ?? ((_token, text) => text);
	const frame = opts.frame ?? 0;
	const maxWidth = Math.max(1, Math.floor(opts.maxWidth ?? 160));
	const doneCount = model.length - active.length;
	const brand = color("accent", "FOREMAN");
	const sep = color("dim", "   ");
	if (active.length === 0) {
		const last = model[0];
		if (!last) return "";
		return `${brand}  ${color("muted", "idle · last:")} ${color("text", last.slug)} ${color("success", "✓ done")} ${color("muted", roundText(last))}`;
	}
	const tint = (line: string) => {
		const token = statuslineTintToken(active[0]);
		return token ? bg(token, line) : line;
	};
	const build = (leadLabelMax: number, chipLabelMax: number, chipCount: number, includeDone: boolean, runningTailLevel: number) => {
		const segments = [renderLeadTask(active[0], color, frame, leadLabelMax, runningTailLevel)];
		for (const task of active.slice(1, chipCount + 1)) segments.push(renderTaskChip(task, color, chipLabelMax));
		if (includeDone && doneCount > 0) segments.push(renderDoneChip(doneCount, color));
		return `${brand}  ${segments.join(sep)}`;
	};

	const leadBudgets = [64, 56, 48, 40, 32, 24, 18, 12, 8, 4];
	const chipBudgets = [22, 18, 14, 10, 6];
	for (const tailLevel of [2, 1, 0]) {
		for (const leadBudget of leadBudgets) {
			for (const chipBudget of chipBudgets) {
				for (let chipCount = active.length - 1; chipCount >= 0; chipCount -= 1) {
					const line = build(leadBudget, chipBudget, chipCount, true, tailLevel);
					if (visibleLength(line) <= maxWidth) return tint(line);
				}
			}
		}
	}
	for (const tailLevel of [2, 1, 0]) {
		for (const leadBudget of leadBudgets) {
			const line = build(leadBudget, 0, 0, false, tailLevel);
			if (visibleLength(line) <= maxWidth) return tint(line);
		}
	}
	const fallback = `${brand}  ${renderLeadTask(active[0], color, frame, Math.max(1, maxWidth - 24), 0)}`;
	if (visibleLength(fallback) <= maxWidth) return tint(fallback);
	const brandOnly = color("accent", wordClip("FOREMAN", maxWidth));
	return visibleLength(brandOnly) <= maxWidth ? brandOnly : "";
}

/** Back-compatible spelling used by older docs/tests. New code should call formatStatusLine. */
export function formatStatusline(model: StatuslineTask[], opts: FormatStatuslineOptions = {}): string {
	return formatStatusLine(model, opts);
}

/** Sort task picker rows by attention, ownership, then recency. Pure and stable for tests. */
export function sortForPicker(tasks: ForemanTaskSummary[], sessionId?: string, opts: SortForPickerOptions = {}): ForemanTaskSummary[] {
	const liveSlugs = new Set(opts.liveSlugs ?? []);
	return [...tasks].sort((a, b) => {
		const attention = pickerAttentionRank(a, liveSlugs) - pickerAttentionRank(b, liveSlugs);
		if (attention !== 0) return attention;
		const owner = (sessionId && a.ownerSessionId === sessionId ? 0 : 1) - (sessionId && b.ownerSessionId === sessionId ? 0 : 1);
		if (owner !== 0) return owner;
		return parseTime(b.updatedAt) - parseTime(a.updatedAt) || a.slug.localeCompare(b.slug);
	});
}

/** List transcript JSONL runs, parsed from filenames and sorted chronologically. */
export function listRuns(cwd: string, slug: string): ForemanRunInfo[] {
	try {
		return safeReadDir(path.join(taskPath(cwd, slug), "transcripts"))
			.filter((file) => file.endsWith(".jsonl"))
			.sort((a, b) => a.localeCompare(b))
			.map(parseRunFilename)
			.filter((run): run is ForemanRunInfo => run !== null);
	} catch {
		return [];
	}
}

/** Parse one transcript JSONL. Skips malformed/truncated lines. */
export function readTranscript(cwd: string, slug: string, file: string): TranscriptEvent[] {
	try {
		const transcriptPath = path.join(taskPath(cwd, slug), "transcripts", path.basename(file));
		const text = safeReadText(transcriptPath);
		if (text === null) return [];
		const events: TranscriptEvent[] = [];
		for (const line of text.split(/\r?\n/)) {
			if (!line.trim()) continue;
			const parsed = safeParseJson(line);
			const event = normalizeTranscriptEvent(parsed);
			if (event) events.push(event);
		}
		return events;
	} catch {
		return [];
	}
}

/** Build ordered mission-control rows from log.jsonl + handoffs/ + activity.json. */
export function buildRootRows(cwd: string, slug: string): RootRow[] {
	try {
		const rows = new Map<string, InternalRow>();
		const runs = listRuns(cwd, slug);
		const logEvents = readJsonl(path.join(taskPath(cwd, slug), "log.jsonl"));

		logEvents.forEach((event, index) => {
			const round = toNumber(event.round);
			if (round <= 0) return;
			const type = toString(event.type);
			if (type === "verify_ran") {
				mergeRow(rows, { round, kind: "verify", status: verifyStatus(event), summary: logSummary(event), live: false }, index);
				return;
			}
			if (type === "developer_handoff") {
				mergeRow(rows, { round, kind: "developer", status: "done", summary: logSummary(event), live: false }, index);
				return;
			}
			if (type === "tester_verdict" || type === "verdict") {
				mergeRow(
					rows,
					{ round, kind: "tester", status: successStatus(event.successState), summary: logSummary(event), live: false },
					index,
				);
			}
		});

		const handoffsDir = path.join(taskPath(cwd, slug), "handoffs");
		safeReadDir(handoffsDir)
			.filter((file) => file.endsWith(".json"))
			.sort((a, b) => a.localeCompare(b))
			.forEach((file, index) => {
				const raw = safeReadJson(path.join(handoffsDir, file));
				if (!isRecord(raw)) return;
				const role = toString(raw.role);
				if (role !== "developer" && role !== "tester") return;
				const round = toNumber(raw.round);
				if (round <= 0) return;
				const sessionId = toString(raw.sessionId);
				const transcriptFile = transcriptForRun(runs, role, round, sessionId);
				mergeRow(
					rows,
					{
						round,
						kind: role,
						status: role === "developer" ? "done" : successStatus(raw.successState),
						summary: toString(raw.summary),
						live: false,
						...(transcriptFile ? { transcriptFile } : {}),
					},
					logEvents.length + index,
				);
			});

		const activity = readActivity(cwd, slug);
		const liveKind = activity ? activityKind(activity.phase) : null;
		if (activity && liveKind && activity.phase !== "idle") {
			const livePatch = {
				round: activity.round,
				kind: liveKind,
				status: "running",
				summary: activity.note || "running…",
				live: true,
				...(activity.activeTranscript ? { transcriptFile: activity.activeTranscript } : {}),
			};

			let matchedByTranscript = false;
			if (activity.activeTranscript) {
				for (const [key, row] of rows) {
					if (row.transcriptFile === activity.activeTranscript) {
						rows.set(key, { ...row, ...livePatch, order: row.order });
						matchedByTranscript = true;
					}
				}
			}

			if (!matchedByTranscript) {
				mergeRow(rows, livePatch, Number.MAX_SAFE_INTEGER);
			}
		}

		return Array.from(rows.values())
			.sort((a, b) => a.round - b.round || kindOrder(a.kind) - kindOrder(b.kind) || a.order - b.order)
			.map(({ order: _order, ...row }) => row);
	} catch {
		return [];
	}
}
