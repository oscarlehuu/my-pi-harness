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
