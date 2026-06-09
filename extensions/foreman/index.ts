/**
 * Loop workflow — deterministic dev -> test -> fix.
 *
 * Reuses the Phase 1 crew (developer, tester agents) by spawning `pi` subprocesses
 * the same way the subagent extension does. Adds what stock subagent lacks:
 *   - verdict-driven retry with a hard round cap (stock chain stops at first failure)
 *   - on-disk ledger (.pi/plans/<task>/) for resume across sessions/machines
 *   - controller-owned handoffs (decision #11): the controller ALWAYS writes the
 *     handoff file, parsing the agent's machine block when present, falling back to
 *     a "blocked" handoff when it is missing/malformed.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { classifyToolCall } from "./guard.ts";
import {
	type Handoff,
	type LedgerState,
	type PendingQuestion,
	type ResolvedDecision,
	type SuccessState,
	type Track,
	appendLog,
	clearPendingQuestion,
	configureMirror,
	initLedger,
	resolveResumable,
	listHandoffs,
	readPendingQuestion,
	readState,
	restoreFromMirror,
	taskDir,
	transcriptsDir,
	writeActivity,
	writeHandoff,
	writePendingQuestion,
	writeState,
} from "./ledger.ts";
import { ForemanDashboard } from "./dashboard/view.ts";
import { buildStatuslineModel, formatStatusLine } from "./dashboard/reader.ts";
import { devFallbackReason, workingTreeSnapshot } from "./fallback.ts";
import {
	type CommandGateResult,
	type Gate,
	gatesForStage,
	loadGates,
	loadRequirements,
	runCommandGates,
} from "./gates.ts";
import {
	type PlannerPlan,
	type PlannerSource,
	type RequirementCheck,
	PLAN_JSON_END,
	PLAN_JSON_START,
	decideManifestWrite,
	evaluateRequirementPresence,
	fallbackPlannerPlan,
	formatIntentContract,
	renderFounderPlan,
	serializePlannerPlan,
	summarizeRequirementChecks,
	validatePlannerPlan,
} from "./planner.ts";
import {
	decideAgentTimeout,
	decideAgentTimeoutDegradation,
	formatAgentTimeoutNote,
	resolveAllAgentTimeouts,
	timeoutLogType,
	type AgentTimeoutOutcome,
	type AgentTimeoutReason,
	type AgentTimeoutRole,
	type AgentTimeouts,
} from "./agent-timeouts.ts";
import { decideReviewOutcome, parseReviewVerdict, type ReviewVerdict } from "./reviewer.ts";
import { evaluateDoneness, extractDonenessInputs, renderDoneChecklist } from "./done.ts";
import { buildCommitMessage, decideShipCommit, resolveStagePaths } from "./ship.ts";
import { detectLikelyStaleDocs, isForemanDocumentationPath, type DocumentationFile } from "./docdrift.ts";
import { repoEngagementActive, setRepoEngagement } from "./engagement.ts";

// Stronger model the frontend track falls back to when Gemini fails to drive the tools.
const UI_FALLBACK_MODEL = "cliproxy/claude-opus-4-8:xhigh";
const AGENT_TIMEOUTS = resolveAllAgentTimeouts(process.env);

// Durable out-of-tree ledger mirror: survives `git clean`/reset/crash inside any target repo.
// Resolve the location from pi's agent dir and publish it via env so the ledger module finds it even
// if the loader instantiates that module separately (jiti moduleCache:false).
if (!process.env.FOREMAN_LEDGER_MIRROR && process.env.FOREMAN_DISABLE_MIRROR !== "1") {
	configureMirror(path.join(getAgentDir(), "foreman", "ledger-mirror"));
}

const STATUS_KEY = "foreman";

interface AgentDef {
	name: string;
	model?: string;
	tools?: string[];
	systemPrompt: string;
}

function loadAgent(name: string): AgentDef {
	const file = path.join(getAgentDir(), "agents", `${name}.md`);
	const content = fs.readFileSync(file, "utf-8");
	const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
	const tools = frontmatter.tools
		?.split(",")
		.map((t) => t.trim())
		.filter(Boolean);
	return { name, model: frontmatter.model, tools: tools?.length ? tools : undefined, systemPrompt: body };
}

function piInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtual = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtual && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName)) return { command: process.execPath, args };
	return { command: "pi", args };
}

interface RunResult {
	text: string;
	exitCode: number;
	stderr: string;
}

type AgentRole = "planner" | "developer" | "tester" | "reviewer" | "doc-er";

interface RunAgentOptions {
	role: AgentRole;
	round: number;
	transcriptPath: string;
	signal?: AbortSignal;
	onActivity?: () => void;
	/** Task slug this agent serves. Threaded to the crew subprocess so escalate_question can record against it. */
	slug?: string;
}

const PER_TASK_OUTPUT_CAP = 50 * 1024;
const TRANSCRIPT_ARGS_CAP = 4 * 1024;
const TRANSCRIPT_PREVIEW_CAP = 4 * 1024;
const TRANSCRIPT_TEXT_CAP = 8 * 1024;
const TRANSCRIPT_TASK_CAP = 8 * 1024;

function byteLength(s: string): number {
	return Buffer.byteLength(s, "utf8");
}

function truncateUtf8(s: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	if (byteLength(s) <= maxBytes) return s;
	const suffix = "…[truncated]";
	const suffixBytes = byteLength(suffix);
	const limit = Math.max(0, maxBytes - suffixBytes);
	let out = s.slice(0, limit);
	while (byteLength(out) > limit) out = out.slice(0, -1);
	return limit > 0 ? `${out}${suffix}` : s.slice(0, maxBytes);
}

function safeStringify(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function truncateTranscriptValue(value: unknown, maxBytes: number): unknown {
	const encoded = safeStringify(value);
	if (byteLength(encoded) <= maxBytes) return value;
	return truncateUtf8(encoded, maxBytes);
}

function contentPreview(value: unknown): string {
	if (value == null) return "";
	if (typeof value === "string") return value;
	if (Array.isArray(value)) {
		return value
			.map((part) => {
				if (typeof part === "string") return part;
				if (part?.type === "text" && typeof part.text === "string") return part.text;
				return safeStringify(part);
			})
			.join("\n");
	}
	if (typeof value === "object" && value && "content" in value) return contentPreview((value as any).content);
	return safeStringify(value);
}

function makeTranscriptWriter(transcriptPath: string): (event: Record<string, unknown>) => void {
	// Transcripts are best-effort telemetry. They are written from stream `data` handlers (not awaited,
	// not inside a try/catch), so a throw here becomes an uncaughtException that kills ALL of pi. The
	// task dir can legitimately vanish mid-run (a concurrent `git clean`/reset, or another session
	// wiping the tree). NEVER let a transcript write crash the orchestrator — swallow every fs error.
	let disabled = false;
	let written = 0;
	try {
		fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
		fs.writeFileSync(transcriptPath, "", { flag: "a" });
		written = fs.statSync(transcriptPath).size;
	} catch {
		disabled = true;
	}
	return (event) => {
		if (disabled || written >= PER_TASK_OUTPUT_CAP) return;
		const line = `${JSON.stringify({ t: new Date().toISOString(), ...event })}\n`;
		const lineBytes = byteLength(line);
		if (written + lineBytes > PER_TASK_OUTPUT_CAP) return;
		try {
			fs.appendFileSync(transcriptPath, line);
			written += lineBytes;
		} catch {
			// Task dir disappeared (concurrent clean / wipe) or disk error. Stop writing; keep the loop alive.
			disabled = true;
		}
	};
}

function transcriptFilePath(cwd: string, slug: string, role: AgentRole, round: number, sessionId: string): string {
	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	const fpath = path.join(transcriptsDir(cwd, slug), `${ts}__${role}-r${round}__${sessionId}.jsonl`);
	fs.mkdirSync(path.dirname(fpath), { recursive: true });
	fs.writeFileSync(fpath, "", { flag: "a" });
	return fpath;
}

/** Spawn one agent subprocess, collect final text output. Append-only system prompt (quota-safe). */
async function runAgent(agent: AgentDef, task: string, cwd: string, options: RunAgentOptions): Promise<RunResult> {
	const args = ["--mode", "json", "-p", "--no-session"];
	if (agent.model) args.push("--model", agent.model);
	if (agent.tools?.length) args.push("--tools", agent.tools.join(","));

	const writeTranscript = makeTranscriptWriter(options.transcriptPath);
	const appendTranscript = (event: Record<string, unknown>) => {
		writeTranscript(event);
	};
	appendTranscript({
		kind: "agent_start",
		role: options.role,
		round: options.round,
		model: agent.model ?? "default",
		task: truncateUtf8(task, TRANSCRIPT_TASK_CAP),
	});

	let tmpDir: string | null = null;
	if (agent.systemPrompt.trim()) {
		tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-loop-"));
		const pf = path.join(tmpDir, `prompt-${agent.name}.md`);
		await fs.promises.writeFile(pf, agent.systemPrompt, { mode: 0o600 });
		args.push("--append-system-prompt", pf);
	}
	args.push(`Task: ${task}`);

	const texts: string[] = [];
	const seenToolCallIds = new Set<string>();
	const seenToolResultIds = new Set<string>();
	let currentAssistantTextCaptured = false;
	let lastStopReason: string | undefined;
	let stderr = "";
	let wasAborted = false;
	const exitCode = await new Promise<number>((resolve) => {
		const inv = piInvocation(args);
		const proc = spawn(inv.command, inv.args, {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
				FOREMAN_CREW: "1",
				// Let the crew-only escalate_question tool record against the right task/round.
				...(options.slug ? { FOREMAN_TASK_SLUG: options.slug, FOREMAN_TASK_CWD: cwd, FOREMAN_TASK_ROUND: String(options.round) } : {}),
			},
		});
		let buffer = "";

		const recordToolCall = (id: unknown, name: unknown, toolArgs: unknown) => {
			const callId = typeof id === "string" ? id : undefined;
			if (callId) {
				if (seenToolCallIds.has(callId)) return;
				seenToolCallIds.add(callId);
			}
			appendTranscript({
				kind: "tool_call",
				name: String(name ?? "unknown"),
				args: truncateTranscriptValue(toolArgs ?? {}, TRANSCRIPT_ARGS_CAP),
			});
		};

		const recordToolResult = (id: unknown, name: unknown, ok: boolean, result: unknown) => {
			const resultId = typeof id === "string" ? id : undefined;
			if (resultId) {
				if (seenToolResultIds.has(resultId)) return;
				seenToolResultIds.add(resultId);
			}
			appendTranscript({
				kind: "tool_result",
				name: String(name ?? "unknown"),
				ok,
				preview: truncateUtf8(contentPreview(result), TRANSCRIPT_PREVIEW_CAP),
			});
		};

		const onLine = (line: string) => {
			if (!line.trim()) return;
			let ev: any;
			try {
				ev = JSON.parse(line);
			} catch {
				return;
			}
			options.onActivity?.();

			if (ev.type === "message_start" && ev.message?.role === "assistant") {
				currentAssistantTextCaptured = false;
			}

			if (ev.type === "message_update") {
				const assistantEvent = ev.assistantMessageEvent;
				if (assistantEvent?.type === "text_delta" && typeof assistantEvent.delta === "string") {
					currentAssistantTextCaptured = true;
					appendTranscript({ kind: "text", text: truncateUtf8(assistantEvent.delta, TRANSCRIPT_TEXT_CAP) });
				}
			}

			if (ev.type === "message_end" && ev.message?.role === "assistant") {
				const content = ev.message.content ?? [];
				for (const c of content) {
					if (c.type === "text") {
						texts.push(c.text);
						if (!currentAssistantTextCaptured) appendTranscript({ kind: "text", text: truncateUtf8(c.text, TRANSCRIPT_TEXT_CAP) });
					}
					if (c.type === "toolCall") recordToolCall(c.id, c.name, c.arguments ?? c.args ?? c.input);
				}
				currentAssistantTextCaptured = false;

				const usage = ev.message.usage;
				if (usage) {
					const cost = typeof usage.cost === "number" ? usage.cost : usage.cost?.total;
					appendTranscript({
						kind: "usage",
						input: usage.input ?? 0,
						output: usage.output ?? 0,
						cost: cost ?? 0,
						contextTokens: usage.totalTokens ?? usage.contextTokens ?? 0,
					});
				}
				if (ev.message.stopReason) lastStopReason = ev.message.stopReason;
			}

			if (ev.type === "tool_execution_start") {
				recordToolCall(ev.toolCallId, ev.toolName, ev.args ?? ev.input);
			}

			if (ev.type === "tool_execution_end") {
				recordToolResult(ev.toolCallId, ev.toolName, !ev.isError, ev.result);
			}

			if (ev.type === "tool_result_end" && ev.message) {
				recordToolResult(
					ev.toolCallId ?? ev.message.toolCallId,
					ev.toolName ?? ev.message.toolName ?? ev.message.name,
					!(ev.isError ?? ev.message.isError),
					ev.message.content ?? ev.message.result,
				);
			}

			if (ev.type === "agent_end" && ev.stopReason) lastStopReason = ev.stopReason;
		};
		proc.stdout.on("data", (d) => {
			buffer += d.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const l of lines) onLine(l);
		});
		proc.stderr.on("data", (d) => {
			stderr += d.toString();
		});
		proc.on("close", (code) => {
			if (buffer.trim()) onLine(buffer);
			const finalCode = code ?? 0;
			appendTranscript({ kind: "agent_end", stopReason: wasAborted ? "aborted" : (lastStopReason ?? "unknown"), exitCode: finalCode });
			resolve(finalCode);
		});
		proc.on("error", () => {
			appendTranscript({ kind: "agent_end", stopReason: "error", exitCode: 1 });
			resolve(1);
		});
		if (options.signal) {
			let killTimer: ReturnType<typeof setTimeout> | undefined;
			const abortProc = () => {
				if (wasAborted) return;
				wasAborted = true;
				proc.kill("SIGTERM");
				killTimer = setTimeout(() => proc.kill("SIGKILL"), 5_000);
				(killTimer as any).unref?.();
			};
			proc.on("close", () => {
				if (killTimer) clearTimeout(killTimer);
				options.signal?.removeEventListener("abort", abortProc);
			});
			if (options.signal.aborted) abortProc();
			else options.signal.addEventListener("abort", abortProc, { once: true });
		}
	});
	if (tmpDir) await fs.promises.rm(tmpDir, { recursive: true, force: true });
	return { text: texts.join("\n").trim(), exitCode, stderr };
}

interface RunAgentWithTimeoutResult {
	result: RunResult;
	timeout: AgentTimeoutOutcome;
}

async function runAgentWithTimeout(
	agent: AgentDef,
	task: string,
	cwd: string,
	agentOptions: RunAgentOptions,
	timeoutRole: AgentTimeoutRole = agentOptions.role === "reviewer" ? "reviewer" : agentOptions.role,
	timeouts: AgentTimeouts = AGENT_TIMEOUTS[timeoutRole],
): Promise<RunAgentWithTimeoutResult> {
	const controller = new AbortController();
	const startedAt = Date.now();
	let lastActivityAt = startedAt;
	let timeoutReason: AgentTimeoutReason | null = null;
	let idleTimer: ReturnType<typeof setTimeout> | undefined;
	let maxTimer: ReturnType<typeof setTimeout> | undefined;
	const upstreamActivity = agentOptions.onActivity;
	const parentSignal = agentOptions.signal;

	function abortForTimeout() {
		if (timeoutReason || controller.signal.aborted) return;
		const decision = decideAgentTimeout({ now: Date.now(), startedAt, lastActivityAt, idleMs: timeouts.idleMs, maxMs: timeouts.maxMs });
		if (!decision.abort || !decision.reason) {
			scheduleIdleTimer();
			return;
		}
		timeoutReason = decision.reason;
		controller.abort();
	}

	function scheduleIdleTimer() {
		if (idleTimer) clearTimeout(idleTimer);
		if (timeoutReason || controller.signal.aborted) return;
		idleTimer = setTimeout(abortForTimeout, Math.max(0, lastActivityAt + timeouts.idleMs - Date.now()));
	}

	function recordActivity() {
		upstreamActivity?.();
		if (timeoutReason) return;
		lastActivityAt = Date.now();
		scheduleIdleTimer();
	}

	const abortFromParent = () => controller.abort();
	scheduleIdleTimer();
	maxTimer = setTimeout(abortForTimeout, timeouts.maxMs);
	if (parentSignal?.aborted) abortFromParent();
	else parentSignal?.addEventListener("abort", abortFromParent, { once: true });

	try {
		const result = await runAgent(agent, task, cwd, { ...agentOptions, signal: controller.signal, onActivity: recordActivity });
		return { result, timeout: { timedOut: timeoutReason !== null, reason: timeoutReason } };
	} finally {
		if (idleTimer) clearTimeout(idleTimer);
		if (maxTimer) clearTimeout(maxTimer);
		parentSignal?.removeEventListener("abort", abortFromParent);
	}
}

function recordAgentTimeout(cwd: string, slug: string, role: AgentTimeoutRole, round: number, outcome: AgentTimeoutOutcome, extra: Record<string, unknown> = {}): string | null {
	if (!outcome.timedOut || !outcome.reason) return null;
	const note = formatAgentTimeoutNote(role, outcome.reason, AGENT_TIMEOUTS[role]);
	appendLog(cwd, slug, { type: timeoutLogType(role), round, reason: outcome.reason, note, ...extra });
	return note;
}

function extractJsonBlock(text: string, startMarker: string, endMarker: string): any | null {
	// A crew message can contain the markers more than once: agents reasoning ABOUT the contract
	// (e.g. a task that edits the PLAN-JSON contract itself) mention the markers in prose before the
	// real block. Don't assume the first start..first end pair is the payload — scan every start
	// marker against the next end marker after it and return the first slice that actually parses as
	// JSON. This makes the parser robust to prose mentions while still preferring the earliest valid block.
	let from = 0;
	while (true) {
		const s = text.indexOf(startMarker, from);
		if (s === -1) return null;
		const contentStart = s + startMarker.length;
		const e = text.indexOf(endMarker, contentStart);
		if (e === -1) return null;
		try {
			return JSON.parse(text.slice(contentStart, e).trim());
		} catch {
			// Not the real block (prose mention); advance past this start marker and try the next one.
			from = contentStart;
		}
	}
}

/** Parse the tester's `VERDICT: <STATE>` token. Deterministic; falls back to blocked. */
function parseVerdict(text: string): { successState: SuccessState; parsedFrom: string } {
	const m = text.match(/VERDICT:\s*(SUCCESS|PASSED|PASS|FAILED|FAIL|PARTIAL|BLOCKED)\b/i);
	if (m) {
		const tok = m[1].toUpperCase();
		const map: Record<string, SuccessState> = {
			SUCCESS: "success",
			PASS: "success",
			PASSED: "success",
			FAIL: "fail",
			FAILED: "fail",
			PARTIAL: "partial",
			BLOCKED: "blocked",
		};
		return { successState: map[tok], parsedFrom: "verdict-token" };
	}
	return { successState: "blocked", parsedFrom: "no-verdict-token" };
}

function commandGateLabel(gate: Gate): string {
	return gate.command ? `${gate.name} (\`${gate.command}\`)` : gate.name;
}

/**
 * Founder decisions that resolved earlier crew escalations, rendered for the developer/tester prompt.
 * This is what lets the tester know a literal value was founder-approved (not a hardcoded guess), and
 * keeps the decision in front of the developer on later rounds. Empty string when there are none.
 */
function formatResolvedDecisions(decisions: ResolvedDecision[] | undefined): string {
	if (!decisions?.length) return "";
	const lines = decisions.map((d) => (d.question ? `- Q: ${d.question}\n  Founder decision: ${d.decision}` : `- Founder decision: ${d.decision}`));
	return (
		`Founder decisions already made for this task (authoritative — these were chosen by the founder via the ` +
		`escalation channel, so implementing them exactly is CORRECT, not a guess or a hardcoded cheat):\n${lines.join("\n")}`
	);
}

/** Founder-facing prompt when a crew member escalates a decision (state = awaiting_decision). */
function formatDecisionPrompt(round: number, q: PendingQuestion): string {
	const optionLines = q.options?.length ? `\nOptions:\n${q.options.map((o) => `  - ${o}`).join("\n")}` : "";
	const contextLine = q.context ? `\nContext: ${q.context}` : "";
	return (
		`\n=== CREW DECISION NEEDED (round ${round}) ===\n` +
		`The ${q.askedBy} is blocked and needs a decision before it can continue:\n\n` +
		`  ${q.question}` +
		contextLine +
		optionLines +
		`\n\nAnswer it (from context if you can, otherwise ask the founder), then resume:\n` +
		`  foreman({ resume: true, answer: "<the decision>" })\n` +
		`Or send it back without answering:\n` +
		`  foreman({ resume: true, reject: "<new direction>" })`
	);
}

function formatCommandGateResults(results: CommandGateResult[], outputCapPerGate = 1500): string {
	return results
		.map((result) => {
			const output = result.output.trim() ? result.output.slice(-outputCapPerGate) : "(no output)";
			return [`[${result.name}] \`${result.command}\``, `Exit code: ${result.exitCode}`, "Output:", output].join("\n");
		})
		.join("\n\n");
}

function formatReviewItems(items: string[], empty = "- (none)"): string {
	return items.length ? items.map((item) => `- ${item}`).join("\n") : empty;
}

function reviewSuccessState(review: ReviewVerdict): SuccessState {
	if (review.decision === "approve") return "success";
	if (review.decision === "request-changes") return "fail";
	return "blocked";
}

function reviewSummaryLine(gate: Gate, review: ReviewVerdict): string {
	if (review.decision === "approve") {
		return `- ${gate.name}: APPROVE${review.nits.length ? ` (${review.nits.length} nit${review.nits.length === 1 ? "" : "s"})` : ""}`;
	}
	if (review.decision === "request-changes") {
		return `- ${gate.name}: REQUEST-CHANGES (${review.blocking.length} blocking)`;
	}
	return `- ${gate.name}: INCONCLUSIVE (could not parse REVIEW line; founder must decide)`;
}

function reviewerTaskFor(context: {
	cwd: string;
	task: string;
	round: number;
	gate: Gate;
	testerSummary: string;
	preShipCommandSummary?: string;
}): string {
	return [
		`Run pre-ship code review gate "${context.gate.name}" for this task in ${context.cwd}.`,
		`Task: ${context.task}`,
		`Round: ${context.round}`,
		"The work already passed per-round command gates and tester judgment. Do not rerun the test suite.",
		`Tester summary: ${context.testerSummary}`,
		context.preShipCommandSummary
			? `Pre-ship command gates already passed:\n${context.preShipCommandSummary}`
			: "No pre-ship command gates ran before this review.",
		"",
		"Use `git diff --stat` and `git diff` to inspect the changed code. Review for correctness beyond tests, security, maintainability, architecture consistency, scope creep, and missing real-boundary error handling.",
		"You are read-only: do not edit files, do not install dependencies, and do not mutate the repo.",
		"Emit exactly one REVIEW line: `REVIEW: APPROVE` or `REVIEW: REQUEST-CHANGES`. If requesting changes, include a BLOCKING section with file:line bullets. Put nits in a separate NITS section.",
	].join("\n");
}

interface DocErMachineLine {
	status: "UPDATED" | "NONE";
	updatedPaths: string[];
	reason?: string;
	raw?: string;
}

interface DocErStageReport {
	status: "UPDATED" | "NONE" | "TIMED-OUT";
	updatedPaths: string[];
	reason?: string;
	flagged: boolean;
	summaryLine: string;
	driftDocs: string[];
	driftLine?: string;
}

const DOC_TEXT_EXTENSIONS = new Set([".md", ".mdx", ".txt", ".rst", ".adoc"]);

function stripPathPunctuation(value: string): string {
	return value.replace(/^[`'"<]+/g, "").replace(/[`'">.,;:]+$/g, "").trim();
}

function stripPathAnchor(value: string): string {
	return value.replace(/[?#].*$/, "").replace(/(?::\d+){1,2}$/, "");
}

function cleanReportedPath(value: string): string {
	return stripPathAnchor(stripPathPunctuation(value).replace(/\\/g, "/").replace(/^\.\//, ""));
}

function leadingReportedPath(entry: string): string {
	let cleaned = entry.replace(/^\s*(?:[-*•]\s+|\d+[.)]\s+)/, "").trim();
	const separatedDescription = cleaned.match(/^(.*?)\s+-\s+.+$/);
	if (separatedDescription) cleaned = separatedDescription[1].trim();
	else cleaned = cleaned.split(/\s+/)[0] ?? "";
	return cleanReportedPath(cleaned);
}

function uniquePaths(values: string[]): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const value of values) {
		const cleaned = cleanReportedPath(value);
		if (!cleaned || seen.has(cleaned)) continue;
		seen.add(cleaned);
		out.push(cleaned);
	}
	return out;
}

function parseDocErPathList(detail: string): string[] {
	return uniquePaths(detail.split(/[\s,]+/).filter(Boolean)).filter(isForemanDocumentationPath);
}

function parseDocErMachineLine(text: string): DocErMachineLine | null {
	const matches = [...text.matchAll(/^\s*DOC-ER:\s*(UPDATED|NONE)\b(.*)$/gim)];
	if (!matches.length) return null;
	const match = matches[matches.length - 1];
	const status = match[1].toUpperCase() as "UPDATED" | "NONE";
	const detail = (match[2] ?? "").trim();
	const raw = match[0].trim();
	if (status === "NONE") return { status, updatedPaths: [], reason: detail || "no documentation updates needed", raw };
	return { status, updatedPaths: parseDocErPathList(detail), reason: detail ? undefined : "missing updated doc paths", raw };
}

function docErTaskFor(context: { cwd: string; task: string; round: number; devHandoff: Handoff; intentContract: string }): string {
	const files = uniquePaths((context.devHandoff.filesChanged ?? []).map(leadingReportedPath)).filter(Boolean);
	return [
		`Run the SOFT documentation refresh stage for this Foreman task in ${context.cwd}.`,
		`Task: ${context.task}`,
		`Round: ${context.round}`,
		`Developer handoff summary: ${context.devHandoff.summary}`,
		"Developer filesChanged:",
		files.length ? files.map((file) => `- ${file}`).join("\n") : "- (none reported)",
		context.devHandoff.howToVerify ? `Developer verification note: ${context.devHandoff.howToVerify}` : "Developer verification note: (none reported)",
		context.intentContract ? `Founder-approved intent contract:\n${context.intentContract}` : "Founder-approved intent contract: (none persisted)",
		"",
		"Update code/architecture docs to reflect the shipped change. Agent-friendly first: stable headers, file:line/function anchors, invariants, state transitions, and NEVER-do boundaries; then human-friendly prose.",
		"Hard boundaries: write ONLY under docs/ and extensions/*/docs/. NEVER edit code. NEVER edit AGENTS.md. Write nothing if nothing needs documenting.",
		"Update existing docs in place. Create a new doc only when there is no existing documentation home for this change.",
		"End with exactly one machine line: `DOC-ER: UPDATED <paths>` or `DOC-ER: NONE <reason>`.",
	].join("\n");
}

function collectDocRootFiles(cwd: string, rootRel: string, out: DocumentationFile[]): void {
	const rootAbs = path.join(cwd, rootRel);
	if (!fs.existsSync(rootAbs)) return;
	const stack = [rootRel];
	while (stack.length) {
		const relDir = stack.pop()!;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(path.join(cwd, relDir), { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const relPath = path.join(relDir, entry.name).replace(/\\/g, "/");
			if (entry.isDirectory()) {
				stack.push(relPath);
				continue;
			}
			if (!entry.isFile() || !DOC_TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
			try {
				out.push({ path: relPath, content: fs.readFileSync(path.join(cwd, relPath), "utf-8") });
			} catch {
				// Documentation drift is advisory; unreadable docs are skipped rather than blocking Gate 2.
			}
		}
	}
}

function collectRepoDocumentationFiles(cwd: string): DocumentationFile[] {
	const docs: DocumentationFile[] = [];
	const roots = new Set<string>(["docs"]);
	try {
		const extensionsDir = path.join(cwd, "extensions");
		if (fs.existsSync(extensionsDir)) {
			for (const entry of fs.readdirSync(extensionsDir, { withFileTypes: true })) {
				if (entry.isDirectory()) roots.add(`extensions/${entry.name}/docs`);
			}
		}
	} catch {
		// Best-effort discovery; the docs/ root is still checked below.
	}
	for (const root of roots) collectDocRootFiles(cwd, root, docs);
	return docs;
}

function formatDocErSummary(report: Pick<DocErStageReport, "status" | "updatedPaths" | "reason" | "flagged">): string {
	if (report.status === "UPDATED") return `Doc-er: UPDATED ${report.updatedPaths.join(", ")}`;
	if (report.status === "TIMED-OUT") return `Doc-er: TIMED-OUT${report.reason ? ` (${report.reason})` : ""}${report.flagged ? " ⚠" : ""}`;
	return `Doc-er: NONE${report.reason ? ` (${report.reason})` : ""}${report.flagged ? " ⚠" : ""}`;
}

function formatDocDriftLine(staleDocs: string[]): string | undefined {
	return staleDocs.length ? `⚠ docs may be stale: ${staleDocs.join(", ")}` : undefined;
}

function formatDocGate2Lines(report: Pick<DocErStageReport, "summaryLine" | "driftLine"> | null): string {
	if (!report) return "";
	return [report.summaryLine, report.driftLine].filter(Boolean).join("\n");
}

function latestDocGate2LinesFromEvents(events: Array<Record<string, unknown>>): string {
	let summaryLine = "";
	let driftLine: string | undefined;
	for (const event of events) {
		if (event.type === "doc_er_result") {
			const status = event.status === "UPDATED" || event.status === "TIMED-OUT" ? event.status : "NONE";
			const updatedPaths = Array.isArray(event.updatedPaths) ? event.updatedPaths.filter((p): p is string => typeof p === "string") : [];
			const reason = typeof event.reason === "string" ? event.reason : undefined;
			const flagged = event.flagged === true;
			summaryLine = formatDocErSummary({ status, updatedPaths, reason, flagged });
		}
		if (event.type === "doc_drift_checked") {
			const staleDocs = Array.isArray(event.staleDocs) ? event.staleDocs.filter((p): p is string => typeof p === "string") : [];
			driftLine = formatDocDriftLine(staleDocs);
		}
	}
	return formatDocGate2Lines(summaryLine ? { summaryLine, driftLine } : null);
}

async function runDocErStage(input: {
	cwd: string;
	slug: string;
	state: LedgerState;
	round: number;
	devHandoff: Handoff;
	intentContract: string;
	ownerSessionId?: string;
	signal?: AbortSignal;
	shouldRun: boolean;
	skipReason?: string;
	emit: (line: string) => void;
	pushStatus: () => void;
	startSpinner: () => void;
	stopSpinner: () => void;
}): Promise<DocErStageReport> {
	const changedCodePaths = uniquePaths((input.devHandoff.filesChanged ?? []).map(leadingReportedPath)).filter(
		(file) => file && !isForemanDocumentationPath(file) && !file.startsWith(".pi/"),
	);
	let report: DocErStageReport;

	if (!input.shouldRun) {
		report = { status: "NONE", updatedPaths: [], reason: input.skipReason ?? "skipped", flagged: true, summaryLine: "", driftDocs: [] };
		appendLog(input.cwd, input.slug, { type: "doc_er_skipped", round: input.round, reason: report.reason });
	} else {
		input.emit(`Round ${input.round}: doc-er documentation refresh...`);
		appendLog(input.cwd, input.slug, { type: "doc_er_started", round: input.round, changedCodePaths });
		const docSession = randomUUID();
		const docTranscript = transcriptFilePath(input.cwd, input.slug, "doc-er", input.round, docSession);
		writeActivity(input.cwd, input.slug, {
			round: input.round,
			phase: "doc-er",
			activeTranscript: path.basename(docTranscript),
			note: "doc-er running…",
			pid: process.pid,
			ownerSessionId: input.ownerSessionId,
		});
		input.pushStatus();
		input.startSpinner();
		try {
			const docEr = loadAgent("doc-er");
			const docOutcome = await runAgentWithTimeout(
				docEr,
				docErTaskFor({ cwd: input.cwd, task: input.state.task, round: input.round, devHandoff: input.devHandoff, intentContract: input.intentContract }),
				input.cwd,
				{ role: "doc-er", round: input.round, transcriptPath: docTranscript, signal: input.signal, slug: input.slug },
				"doc-er",
			);
			const docRun = docOutcome.result;
			if (docOutcome.timeout.timedOut) {
				const timeoutDegradation = decideAgentTimeoutDegradation("doc-er", docOutcome.timeout, AGENT_TIMEOUTS["doc-er"]);
				const note = recordAgentTimeout(input.cwd, input.slug, "doc-er", input.round, docOutcome.timeout) ?? timeoutDegradation.note;
				report = { status: "TIMED-OUT", updatedPaths: [], reason: note || `doc-er timed out (${docOutcome.timeout.reason ?? "unknown"})`, flagged: true, summaryLine: "", driftDocs: [] };
			} else if (docRun.exitCode !== 0) {
				report = { status: "NONE", updatedPaths: [], reason: `doc-er exited ${docRun.exitCode}`, flagged: true, summaryLine: "", driftDocs: [] };
				appendLog(input.cwd, input.slug, { type: "doc_er_failed", round: input.round, exitCode: docRun.exitCode, stderr: docRun.stderr.slice(-1000) });
			} else {
				const parsed = parseDocErMachineLine(docRun.text);
				if (!parsed) {
					report = { status: "NONE", updatedPaths: [], reason: "missing DOC-ER line", flagged: true, summaryLine: "", driftDocs: [] };
				} else if (parsed.status === "UPDATED" && parsed.updatedPaths.length === 0) {
					report = { status: "NONE", updatedPaths: [], reason: parsed.reason ?? "UPDATED line had no allowed doc paths", flagged: true, summaryLine: "", driftDocs: [] };
				} else {
					report = { status: parsed.status, updatedPaths: parsed.updatedPaths, reason: parsed.reason, flagged: parsed.status === "NONE", summaryLine: "", driftDocs: [] };
				}
			}
		} catch (error) {
			report = { status: "NONE", updatedPaths: [], reason: `doc-er failed: ${String(error)}`, flagged: true, summaryLine: "", driftDocs: [] };
			appendLog(input.cwd, input.slug, { type: "doc_er_failed", round: input.round, error: String(error) });
		} finally {
			input.stopSpinner();
		}
	}

	report.summaryLine = formatDocErSummary(report);
	const driftDocs = detectLikelyStaleDocs({ changedCodePaths, docFiles: collectRepoDocumentationFiles(input.cwd), updatedDocPaths: report.updatedPaths });
	report.driftDocs = driftDocs;
	report.driftLine = formatDocDriftLine(driftDocs);
	appendLog(input.cwd, input.slug, {
		type: "doc_er_result",
		round: input.round,
		status: report.status,
		updatedPaths: report.updatedPaths,
		reason: report.reason,
		flagged: report.flagged,
	});
	appendLog(input.cwd, input.slug, { type: "doc_drift_checked", round: input.round, changedCodePaths, updatedDocPaths: report.updatedPaths, staleDocs: driftDocs });
	writeActivity(input.cwd, input.slug, {
		round: input.round,
		phase: "idle",
		activeTranscript: null,
		note: `${report.summaryLine}${report.driftLine ? `; ${report.driftLine}` : ""}`.slice(0, 500),
		pid: process.pid,
		ownerSessionId: input.ownerSessionId,
	});
	input.pushStatus();
	return report;
}

function foremanManifestPath(cwd: string): string {
	return path.join(cwd, ".pi", "foreman.json");
}

function hasForemanManifest(cwd: string): boolean {
	return fs.existsSync(foremanManifestPath(cwd));
}

function toolOnPath(name: string): boolean {
	const executable = name.trim();
	if (!executable || path.basename(executable) !== executable) return false;
	const searchPath = process.env.PATH ?? "";
	for (const dir of searchPath.split(path.delimiter)) {
		if (!dir) continue;
		const candidate = path.join(dir, executable);
		try {
			if (!fs.statSync(candidate).isFile()) continue;
			fs.accessSync(candidate, fs.constants.X_OK);
			return true;
		} catch {
			// Keep probing PATH entries; this helper must never shell out or throw.
		}
	}
	return false;
}

function requirementCategoryLabel(category: RequirementCheck["category"]): string {
	if (category === "env") return "env";
	if (category === "tools") return "tool";
	return "service";
}

function requirementGapNames(checks: RequirementCheck[]): string[] {
	const summary = summarizeRequirementChecks(checks);
	return [...summary.missing, ...summary.unknown].map((check) => `${check.category}:${check.name}`);
}

function formatRequirementGap(check: RequirementCheck): string {
	if (check.presence === "missing") return `missing ${requirementCategoryLabel(check.category)} ${check.name}`;
	if (check.category === "services") return `confirm service ${check.name} is running`;
	return `confirm ${requirementCategoryLabel(check.category)} ${check.name}`;
}

function formatRequirementGaps(checks: RequirementCheck[]): string {
	const summary = summarizeRequirementChecks(checks);
	return [...summary.missing, ...summary.unknown].map(formatRequirementGap).join("; ");
}

function plannerPlanPath(cwd: string, slug: string): string {
	return path.join(taskDir(cwd, slug), "plan.json");
}

function plannerPlanMetaPath(cwd: string, slug: string): string {
	return path.join(taskDir(cwd, slug), "plan.meta.json");
}

interface PersistedPlannerDraft {
	source: Extract<PlannerSource, "planner" | "fallback">;
	plan: PlannerPlan;
	note?: string;
}

function isPersistedPlannerSource(value: unknown): value is PersistedPlannerDraft["source"] {
	return value === "planner" || value === "fallback";
}

function readPersistedPlannerDraft(cwd: string, slug: string): PersistedPlannerDraft | null {
	try {
		const p = plannerPlanPath(cwd, slug);
		if (!fs.existsSync(p)) return null;
		const parsed = JSON.parse(fs.readFileSync(p, "utf-8"));
		// Backward compatibility for the first planner rollout, which wrapped the plan with metadata.
		const wrappedPlan = parsed && typeof parsed === "object" && "plan" in parsed ? validatePlannerPlan((parsed as any).plan) : null;
		const plan = wrappedPlan ?? validatePlannerPlan(parsed);
		if (!plan) return null;

		let source: PersistedPlannerDraft["source"] | undefined;
		let note: string | undefined;
		if (parsed && typeof parsed === "object" && "plan" in parsed) {
			source = isPersistedPlannerSource((parsed as any).source) ? (parsed as any).source : undefined;
			note = typeof (parsed as any).note === "string" ? (parsed as any).note : undefined;
		}
		const metaPath = plannerPlanMetaPath(cwd, slug);
		if (fs.existsSync(metaPath)) {
			const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
			if (isPersistedPlannerSource(meta?.source)) source = meta.source;
			if (typeof meta?.note === "string") note = meta.note;
		}
		return { source: source ?? "fallback", plan, note };
	} catch {
		return null;
	}
}

function writePersistedPlannerDraft(cwd: string, slug: string, draft: PersistedPlannerDraft): void {
	fs.writeFileSync(plannerPlanPath(cwd, slug), `${serializePlannerPlan(draft.plan)}\n`);
	fs.writeFileSync(
		plannerPlanMetaPath(cwd, slug),
		`${JSON.stringify({ source: draft.source, note: draft.note }, null, 2)}\n`,
	);
}

function plannerTaskFor(context: {
	task: string;
	cwd: string;
	track: Track;
	verifyCommand?: string;
	manifestExists: boolean;
	existingGates: Gate[];
}): string {
	const gateLines = context.existingGates.length
		? context.existingGates.map((gate) => `- ${commandGateLabel(gate)} [${gate.stage}/${gate.kind}]`).join("\n")
		: "- (none)";
	return [
		"Draft the Foreman Gate 1 plan for this task. You are read-only; inspect the repo for structure, language, tests, and existing commands, and do not edit files.",
		`Task: ${context.task}`,
		`Working directory: ${context.cwd}`,
		`Track: ${context.track}`,
		`Legacy verify command (controller fallback only; do not propose unless verified in repo): ${context.verifyCommand ?? "(none)"}`,
		`.pi/foreman.json exists: ${context.manifestExists ? "yes" : "no"}`,
		"Currently resolved gates:",
		gateLines,
		"",
		"Return a concise plan and exactly one PLAN-JSON block with keys summary, steps, filesLikely, risks, proposedGates, requirements. Propose only commands you verified actually exist in this repo; if no .pi/foreman.json exists and no real command is detectable, proposedGates must be empty. Detect required env var names, CLI tool names, and service/runtime names; report only names and short reasons, never secret values. Do not copy the legacy verify command into proposedGates unless you verified it is a real repo command. If .pi/foreman.json exists, reflect existing gates and do not propose overwriting it.",
		"Keep recon tight (~6-10 tool calls). Your FINAL message MUST end with exactly one ---PLAN-JSON--- ... ---END-PLAN-JSON--- block containing summary, steps, filesLikely, risks, proposedGates, requirements — even if you must note assumptions in risks. Narration without the block is a failure.",
	].join("\n");
}

async function draftPlannerPlan(input: {
	cwd: string;
	slug: string;
	task: string;
	track: Track;
	maxRounds: number;
	verifyCommand?: string;
	developerModel?: string;
	testerModel?: string;
	existingGates: Gate[];
	manifestExists: boolean;
	ownerSessionId?: string;
	signal?: AbortSignal;
}): Promise<PersistedPlannerDraft> {
	const fallback = () =>
		fallbackPlannerPlan({
			task: input.task,
			cwd: input.cwd,
			track: input.track,
			maxRounds: input.maxRounds,
			verifyCommand: input.verifyCommand,
			developerModel: input.developerModel,
			testerModel: input.testerModel,
			manifestExists: input.manifestExists,
			existingGates: input.existingGates,
		});

	let planner: AgentDef;
	try {
		planner = loadAgent("planner");
	} catch (error) {
		const note = `planner agent unavailable: ${String(error)}`;
		writeActivity(input.cwd, input.slug, {
			round: 0,
			phase: "idle",
			activeTranscript: null,
			note: `planner fallback: ${note}`,
			pid: process.pid,
			ownerSessionId: input.ownerSessionId,
		});
		return { plan: fallback(), source: "fallback", note };
	}

	const plannerSession = randomUUID();
	const transcriptPath = transcriptFilePath(input.cwd, input.slug, "planner", 0, plannerSession);
	const transcriptName = path.basename(transcriptPath);
	writeActivity(input.cwd, input.slug, {
		round: 0,
		phase: "developer",
		activeTranscript: transcriptName,
		note: "planner running…",
		pid: process.pid,
		ownerSessionId: input.ownerSessionId,
	});
	let finalActivityNote = "planner finished";
	try {
		const { result: run, timeout } = await runAgentWithTimeout(planner, plannerTaskFor(input), input.cwd, {
			role: "planner",
			round: 0,
			transcriptPath,
			signal: input.signal,
		});
		if (timeout.timedOut && timeout.reason) {
			const note = recordAgentTimeout(input.cwd, input.slug, "planner", 0, timeout) ?? formatAgentTimeoutNote("planner", timeout.reason, AGENT_TIMEOUTS.planner);
			finalActivityNote = `planner fallback: ${note}`;
			return { plan: fallback(), source: "fallback", note };
		}
		if (run.exitCode !== 0) {
			const note = `planner exited ${run.exitCode}`;
			finalActivityNote = `planner fallback: ${note}`;
			return { plan: fallback(), source: "fallback", note };
		}
		const parsedJson = extractJsonBlock(run.text, PLAN_JSON_START, PLAN_JSON_END);
		const parsed = validatePlannerPlan(parsedJson);
		if (!parsed) {
			const note = "planner emitted invalid PLAN-JSON";
			finalActivityNote = `planner fallback: ${note}`;
			return { plan: fallback(), source: "fallback", note };
		}
		finalActivityNote = "planner complete";
		return { plan: parsed, source: "planner" };
	} catch (error) {
		const note = `planner failed: ${String(error)}`;
		finalActivityNote = `planner fallback: ${note}`;
		return { plan: fallback(), source: "fallback", note };
	} finally {
		writeActivity(input.cwd, input.slug, {
			round: 0,
			phase: "idle",
			activeTranscript: transcriptName,
			note: finalActivityNote,
			pid: process.pid,
			ownerSessionId: input.ownerSessionId,
		});
	}
}

function writeProposedManifestOnGate1Approval(cwd: string, draft: PersistedPlannerDraft): { wrote: boolean; reason: string } {
	const decision = decideManifestWrite({
		manifestExists: hasForemanManifest(cwd),
		proposedGates: draft.plan.proposedGates,
		requirements: draft.plan.requirements,
		source: draft.source,
	});
	if (!decision.shouldWrite || !decision.manifest) return { wrote: false, reason: decision.reason };
	const manifestPath = foremanManifestPath(cwd);
	fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
	fs.writeFileSync(manifestPath, `${JSON.stringify(decision.manifest, null, 2)}\n`);
	return { wrote: true, reason: decision.reason };
}

interface GitRunResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

interface ShipHandoffContext {
	filesChanged: string[];
	reviewerSummary?: string;
}

const GIT_OUTPUT_CAP = 20 * 1024;

function capGitOutput(value: string): string {
	return value.length > GIT_OUTPUT_CAP ? value.slice(-GIT_OUTPUT_CAP) : value;
}

function runGit(cwd: string, args: string[], signal?: AbortSignal): Promise<GitRunResult> {
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let settled = false;
		let proc: ReturnType<typeof spawn>;
		let removeAbortListener: (() => void) | undefined;
		const finish = (exitCode: number) => {
			if (settled) return;
			settled = true;
			removeAbortListener?.();
			resolve({ exitCode, stdout: capGitOutput(stdout), stderr: capGitOutput(stderr) });
		};

		try {
			proc = spawn("git", args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
		} catch (error) {
			resolve({ exitCode: 1, stdout: "", stderr: String(error) });
			return;
		}

		proc.stdout.on("data", (data: Buffer) => {
			stdout = capGitOutput(stdout + data.toString());
		});
		proc.stderr.on("data", (data: Buffer) => {
			stderr = capGitOutput(stderr + data.toString());
		});
		proc.on("close", (code) => finish(code ?? (signal?.aborted ? 1 : 0)));
		proc.on("error", (error) => {
			stderr += String(error);
			finish(1);
		});
		if (signal) {
			const onAbort = () => proc.kill("SIGTERM");
			signal.addEventListener("abort", onAbort, { once: true });
			removeAbortListener = () => signal.removeEventListener("abort", onAbort);
		}
	});
}

function gitErrorSummary(command: string, result: GitRunResult): string {
	const detail = (result.stderr || result.stdout || `${command} exited ${result.exitCode}`).trim();
	return `${command} failed (exit ${result.exitCode})${detail ? `: ${detail.slice(-500)}` : ""}`;
}

function stagedFileCount(gitDiffNameOnlyOutput: string): number {
	return gitDiffNameOnlyOutput.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).length;
}

function commitMessageParts(message: string): { subject: string; body: string } {
	const lines = message.split(/\r?\n/);
	const subject = (lines.shift() ?? "").trim() || "chore(foreman-task): ship task";
	const body = lines.join("\n").trim() || "Shipped via Foreman.";
	return { subject, body };
}

function readShipHandoffContext(cwd: string, slug: string): ShipHandoffContext {
	const filesChanged: string[] = [];
	const reviewerSummaries: string[] = [];
	for (const fname of listHandoffs(cwd, slug)) {
		try {
			const handoff = JSON.parse(fs.readFileSync(path.join(taskDir(cwd, slug), "handoffs", fname), "utf-8")) as Partial<Handoff>;
			if (handoff.role === "developer" && Array.isArray(handoff.filesChanged)) {
				filesChanged.push(...handoff.filesChanged.filter((file): file is string => typeof file === "string"));
			}
			if (handoff.role === "tester" && typeof handoff.summary === "string" && handoff.summary.startsWith("[reviewer]")) {
				reviewerSummaries.push(handoff.summary);
			}
		} catch {
			// Handoffs are controller-owned but still best-effort for release metadata; skip corrupt files.
		}
	}
	for (const event of readLedgerLogEvents(cwd, slug)) {
		if (event.type !== "doc_er_result" || !Array.isArray(event.updatedPaths)) continue;
		filesChanged.push(...event.updatedPaths.filter((file): file is string => typeof file === "string" && isForemanDocumentationPath(file)));
	}
	return {
		filesChanged,
		reviewerSummary: reviewerSummaries.length ? reviewerSummaries.join("; ") : undefined,
	};
}

function isLogEvent(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readLedgerLogEvents(cwd: string, slug: string): Array<Record<string, unknown>> {
	try {
		const logPath = path.join(taskDir(cwd, slug), "log.jsonl");
		if (!fs.existsSync(logPath)) return [];
		return fs
			.readFileSync(logPath, "utf-8")
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter(Boolean)
			.map((line) => {
				try {
					return JSON.parse(line);
				} catch {
					return null;
				}
			})
			.filter(isLogEvent);
	} catch {
		return [];
	}
}

async function runReleaseCommitGate(input: {
	cwd: string;
	slug: string;
	state: LedgerState;
	track: Track;
	gate: Gate;
	doneSummary?: string;
	signal?: AbortSignal;
}): Promise<string> {
	const ledgerRelDir = path.relative(input.cwd, taskDir(input.cwd, input.slug)) || path.join(".pi", "plans", input.slug);
	const handoffContext = readShipHandoffContext(input.cwd, input.slug);
	const stagePaths = resolveStagePaths({ gatePaths: input.gate.paths, filesChanged: handoffContext.filesChanged, ledgerRelDir });
	appendLog(input.cwd, input.slug, { type: "release_commit_started", gate: input.gate.name, stagePaths });

	const logCommitResult = (payload: Record<string, unknown>) => {
		appendLog(input.cwd, input.slug, { type: "release_commit_ran", gate: input.gate.name, action: "commit", stagePaths, ...payload });
	};

	try {
		const repoCheck = await runGit(input.cwd, ["rev-parse", "--is-inside-work-tree"], input.signal);
		const isGitRepo = repoCheck.exitCode === 0 && repoCheck.stdout.trim() === "true";
		if (!isGitRepo) {
			const decision = decideShipCommit({ isGitRepo, hasReleaseCommitGate: true, stagedCount: 0 });
			logCommitResult({ decision, isGitRepo, stagedCount: 0 });
			return `- ${input.gate.name}: SKIPPED (${decision.reason})`;
		}

		const add = await runGit(input.cwd, ["add", "--", ...stagePaths], input.signal);
		if (add.exitCode !== 0) {
			const error = gitErrorSummary("git add", add);
			logCommitResult({ decision: { commit: false, reason: error }, isGitRepo, stagedCount: 0, error });
			return `- ${input.gate.name}: ERROR (${error})`;
		}

		const diff = await runGit(input.cwd, ["diff", "--cached", "--name-only"], input.signal);
		if (diff.exitCode !== 0) {
			const error = gitErrorSummary("git diff --cached --name-only", diff);
			logCommitResult({ decision: { commit: false, reason: error }, isGitRepo, stagedCount: 0, error });
			return `- ${input.gate.name}: ERROR (${error})`;
		}

		const stagedCount = stagedFileCount(diff.stdout);
		const decision = decideShipCommit({ isGitRepo, hasReleaseCommitGate: true, stagedCount });
		if (!decision.commit) {
			logCommitResult({ decision, isGitRepo, stagedCount });
			return `- ${input.gate.name}: SKIPPED (${decision.reason})`;
		}

		const message = buildCommitMessage({
			task: input.state.task,
			slug: input.slug,
			track: input.track,
			filesChanged: handoffContext.filesChanged,
			reviewerSummary: handoffContext.reviewerSummary,
			doneSummary: input.doneSummary,
		});
		const { subject, body } = commitMessageParts(message);
		const commit = await runGit(input.cwd, ["commit", "-m", subject, "-m", body], input.signal);
		if (commit.exitCode !== 0) {
			const error = gitErrorSummary("git commit", commit);
			logCommitResult({ decision, isGitRepo, stagedCount, error });
			return `- ${input.gate.name}: ERROR (${error})`;
		}

		const head = await runGit(input.cwd, ["rev-parse", "HEAD"], input.signal);
		const sha = head.exitCode === 0 ? head.stdout.trim() : undefined;
		logCommitResult({ decision, isGitRepo, stagedCount, sha });
		return `- ${input.gate.name}: COMMITTED${sha ? ` ${sha}` : " (sha unavailable)"}`;
	} catch (error) {
		const message = String(error);
		logCommitResult({ decision: { commit: false, reason: message }, stagedCount: 0, error: message });
		return `- ${input.gate.name}: ERROR (${message})`;
	}
}

async function runReleaseActionGates(input: {
	cwd: string;
	slug: string;
	state: LedgerState;
	track: Track;
	gates: Gate[];
	doneSummary?: string;
	signal?: AbortSignal;
}): Promise<string[]> {
	const results: string[] = [];
	for (const gate of input.gates) {
		if (gate.action !== "commit") {
			appendLog(input.cwd, input.slug, { type: "release_action_skipped", gate: gate.name, action: gate.action, reason: "unknown action" });
			results.push(`- ${gate.name}: SKIPPED (unknown action: ${gate.action ?? "(missing)"})`);
			continue;
		}
		results.push(await runReleaseCommitGate({ ...input, gate }));
	}
	return results;
}

const LoopParams = {
	type: "object",
	properties: {
		task: { type: "string", description: "The task for the developer to implement." },
		track: { type: "string", enum: ["backend", "frontend"], description: "Implementation track. 'frontend' routes to the ui-developer (Gemini 3.5 Flash, taste-first, with auto-fallback to Opus xhigh on tool failure); 'backend' (default) uses the gpt-5.5 developer." },
		verifyCommand: { type: "string", description: "Optional explicit command the tester should run to verify." },
		maxRounds: { type: "number", description: "Max dev->test->fix rounds (default 3)." },
		cwd: { type: "string", description: "Working directory of the target repo (default current)." },
		resume: { type: "boolean", description: "Resume a paused/in-progress task in this repo instead of starting new." },
		slug: { type: "string", description: "Target a specific task by slug (needed only when a repo has multiple open tasks from different sessions)." },
		approve: { type: "boolean", description: "Approve the current gate (plan at start, ship after success) and continue." },
		reject: { type: "string", description: "Reject the current gate with feedback; the task is halted for revision." },
		engage: { type: "boolean", description: "Persist Foreman engagement for this repo. true routes impactful main-session edits through Foreman; false allows direct edits until re-engaged." },
		answer: { type: "string", description: "Answer a crew member's escalated question (when the task is awaiting_decision) and resume the loop with it injected into the next round." },
	},
	required: [],
} as const;

const EscalateQuestionParams = {
	type: "object",
	properties: {
		question: { type: "string", description: "The specific decision you need made. Be concrete; name the fork." },
		context: { type: "string", description: "Optional: why you're blocked and what you've tried, so the founder can decide fast." },
		options: { type: "array", items: { type: "string" }, description: "Optional: the concrete choices, ideally with your recommended default first." },
	},
	required: ["question"],
} as const;

let dashboardOpen = false;

const DIRECT_STATUS_KEY = "foreman-direct";
const DIRECT_STATUS_TEXT = "⚠ foreman-direct ON (repo)";
const NON_GIT_ENGAGED_HINT =
	"No git repo was detected for this cwd. Ask the founder to choose: Init git + Foreman (run `git init`, then start the normal Foreman task) or Disable Foreman for this repo with `foreman({ engage: false })`.";

function findGitRoot(startPath: string): string | null {
	let dir = path.resolve(startPath);
	while (true) {
		if (fs.existsSync(path.join(dir, ".git"))) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

function foremanScratchDirs(): string[] {
	return [os.tmpdir(), process.env.TMPDIR, "/tmp", "/private/tmp", "/var/folders", "/private/var/folders"].filter((dir): dir is string => Boolean(dir));
}

function foremanRepoRoot(cwd: string): string {
	return findGitRoot(cwd) ?? path.resolve(cwd);
}

function setForemanDirectStatus(ctx: any, active: boolean): void {
	const setStatus = ctx?.ui?.setStatus;
	if (typeof setStatus !== "function") return;
	setStatus.call(ctx.ui, DIRECT_STATUS_KEY, active ? undefined : DIRECT_STATUS_TEXT);
}

function engagementResultText(root: string, active: boolean): string {
	return active
		? `Foreman engagement ON for ${path.resolve(root)}. Impactful main-session edits route through Foreman.`
		: `Foreman direct-edit mode ON for ${path.resolve(root)}. Impactful main-session edits are allowed until /foreman-direct or foreman({ engage: true }) re-engages this repo.`;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		const root = foremanRepoRoot(ctx.cwd);
		setForemanDirectStatus(ctx, repoEngagementActive(root));
	});

	// ---- Crew escalation channel (crew subprocesses only) ----
	// The headless developer/ui-developer cannot ask the founder directly (no AskUserQuestion, no
	// foreman in their tool allowlist). When a real decision blocks them, this records the question to
	// the task ledger and returns immediately, so the crew NEVER blocks. The parent loop detects the
	// recorded question after the round, pauses as an awaiting_decision gate, and relays it up to the
	// orchestrator (which answers from context or asks the founder). Registered only when FOREMAN_CREW
	// is set so it never appears in the founder-facing orchestrator session.
	if (process.env.FOREMAN_CREW === "1") {
		pi.registerTool({
			name: "escalate_question",
			label: "Escalate a question to the founder",
			description: [
				"Raise a blocking decision to the Foreman orchestrator (and, if needed, the founder) WITHOUT",
				"blocking. Use this only when a genuine fork — an ambiguous requirement or a product/design",
				"choice only the founder can make — stops you from proceeding correctly. Provide a specific",
				"question and your recommended default. The tool records the question and returns immediately;",
				"you should then STOP and end your turn. The orchestrator relays the answer and resumes the",
				"loop. Do NOT use this for routine implementation choices you can reasonably make yourself.",
			].join(" "),
			parameters: EscalateQuestionParams as any,
			async execute(_id: string, params: any) {
				const slug = process.env.FOREMAN_TASK_SLUG;
				const taskCwd = process.env.FOREMAN_TASK_CWD;
				const round = Number(process.env.FOREMAN_TASK_ROUND ?? "0") || 0;
				const question = typeof params?.question === "string" ? params.question.trim() : "";
				if (!question) {
					return { content: [{ type: "text", text: "escalate_question requires a non-empty `question`." }], isError: true };
				}
				if (!slug || !taskCwd) {
					// No task context: cannot record. Tell the agent to proceed rather than stall.
					return {
						content: [{ type: "text", text: "No active Foreman task context; cannot escalate. Proceed with your best assumption and note it." }],
						isError: true,
					};
				}
				const options = Array.isArray(params?.options) ? params.options.filter((o: unknown): o is string => typeof o === "string" && o.trim().length > 0) : undefined;
				const pending: PendingQuestion = {
					round,
					askedBy: "developer",
					question,
					...(typeof params?.context === "string" && params.context.trim() ? { context: params.context.trim() } : {}),
					...(options && options.length ? { options } : {}),
					createdAt: new Date().toISOString(),
				};
				try {
					writePendingQuestion(taskCwd, slug, pending);
				} catch (error) {
					return { content: [{ type: "text", text: `Failed to record escalation: ${String(error)}. Proceed with your best assumption.` }], isError: true };
				}
				return {
					content: [
						{
							type: "text",
							text: "Question recorded and escalated to the orchestrator. STOP now and end your turn; the loop will resume you with the founder's answer.",
						},
					],
				};
			},
		});
	}

	pi.on("tool_call", (event, ctx) => {
		if (process.env.FOREMAN_CREW === "1") return undefined;
		const cwdGitRoot = findGitRoot(ctx.cwd);
		const root = cwdGitRoot ?? path.resolve(ctx.cwd);
		const engagementActive = repoEngagementActive(root);
		setForemanDirectStatus(ctx, engagementActive);
		if (!engagementActive) return undefined;
		const classification = classifyToolCall(
			{ toolName: event.toolName, input: event.input },
			{ cwd: ctx.cwd, findRepoRoot: (p: string) => findGitRoot(p) ?? ctx.cwd, scratchDirs: foremanScratchDirs() },
		);
		if (!classification.gate) return undefined;
		const reason = cwdGitRoot || !classification.reason ? classification.reason : `${classification.reason}\n\n${NON_GIT_ENGAGED_HINT}`;
		return { block: true, reason };
	});

	pi.registerCommand("foreman-direct", {
		description: "Toggle persisted Foreman direct-edit escape hatch for this repo.",
		handler: async (_args, ctx) => {
			const root = foremanRepoRoot(ctx.cwd);
			const active = !repoEngagementActive(root);
			const engagement = setRepoEngagement(root, active);
			setForemanDirectStatus(ctx, engagement.active);
			ctx.ui?.notify?.(engagementResultText(root, engagement.active), active ? "info" : "warning");
		},
	});

	pi.registerShortcut("ctrl+b", {
		description: "Foreman dashboard",
		handler: async (ctx) => {
			if (!ctx.hasUI || dashboardOpen) return;
			dashboardOpen = true;
			try {
				const sessionId = ctx.sessionManager?.getSessionId?.();
				await ctx.ui.custom<void>((tui, theme, _keybindings, done) => new ForemanDashboard(ctx.cwd, tui, theme, done, { sessionId }));
			} finally {
				dashboardOpen = false;
			}
		},
	});

	// Quick-open: jump straight into the agent transcript running right now (skips picker + root).
	pi.registerShortcut("ctrl+f", {
		description: "Foreman: jump to live agent",
		handler: async (ctx) => {
			if (!ctx.hasUI || dashboardOpen) return;
			dashboardOpen = true;
			try {
				const sessionId = ctx.sessionManager?.getSessionId?.();
				await ctx.ui.custom<void>((tui, theme, _keybindings, done) => new ForemanDashboard(ctx.cwd, tui, theme, done, { openLive: true, sessionId }));
			} finally {
				dashboardOpen = false;
			}
		},
	});

	pi.registerTool({
		name: "foreman",
		label: "Foreman (gated dev-test-fix orchestrator)",
		description: [
			"Run a DETERMINISTIC developer->tester->fix loop on a task, with two human gates, a hard",
			"round cap, and an on-disk ledger (.pi/plans/<task>/) for resume. GATE 1 (plan): starting a",
			"task pauses for the founder's approval of the plan before any code runs. The dev->test->fix",
			"rounds then run (tester verdict success/partial/blocked/fail; on 'fail' the verdict is fed",
			"back and retried until success or maxRounds). GATE 2 (ship): on success it pauses again for",
			"the founder's approval before marking done. Approve a gate with { resume: true, approve: true }",
			"or revise with { resume: true, reject: '<feedback>' }; resume targets THIS session's own task, so",
			"only pass { slug } when a repo has multiple open tasks from different sessions. Drives the",
			"developer + tester crew agents (the CTO can also use scout via the subagent tool for recon).",
			"Persist route-through-Foreman engagement for the current repo with { engage: true|false }.",
		].join(" "),
		parameters: LoopParams as any,

		async execute(_id: string, params: any, signal: AbortSignal, onUpdate: any, ctx: any) {
			const cwd: string = params.cwd ?? ctx.cwd;
			if (typeof params.engage === "boolean") {
				const root = foremanRepoRoot(cwd);
				const engagement = setRepoEngagement(root, params.engage);
				setForemanDirectStatus(ctx, engagement.active);
				return { content: [{ type: "text", text: engagementResultText(root, engagement.active) }] };
			}
			const maxRounds: number = params.maxRounds ?? 3;
			const sessionId: string | undefined = ctx.sessionManager?.getSessionId?.();

			let state: LedgerState;
			if (params.resume) {
				restoreFromMirror(cwd); // self-heal a ledger wiped by git clean/reset/crash before resolving
				const resolved = resolveResumable(cwd, { slug: params.slug, sessionId });
				if (!resolved.state) {
					return { content: [{ type: "text", text: resolved.error ?? "No resumable task found in this repo." }] };
				}
				state = resolved.state;
			} else {
				if (!params.task) {
					return { content: [{ type: "text", text: "Provide `task` to start, or `resume: true`." }] };
				}
				const track: Track = params.track === "frontend" ? "frontend" : "backend";
				state = initLedger(cwd, params.task, maxRounds, params.verifyCommand, sessionId, track);
			}

			const slug = state.slug;
			const track: Track = state.track === "frontend" ? "frontend" : "backend";
			const developer = loadAgent(track === "frontend" ? "ui-developer" : "developer");
			const tester = loadAgent("tester");
			const transcript: string[] = [];
			const emit = (line: string) => {
				transcript.push(line);
				onUpdate?.({ content: [{ type: "text", text: transcript.join("\n") }] });
			};
			const verifyCommand = state.verifyCommand ?? params.verifyCommand;
			let gates: Gate[] = [];
			let perRoundCommandGates: Gate[] = [];
			let perRoundGateSummary = "";
			let isLegacyVerifyGate = false;
			const refreshGates = () => {
				gates = loadGates(cwd, state.verifyCommand ?? params.verifyCommand);
				perRoundCommandGates = gatesForStage(gates, "per-round").filter((gate) => gate.kind === "command" && gate.command);
				perRoundGateSummary = perRoundCommandGates.length
					? perRoundCommandGates.map(commandGateLabel).join(", ")
					: "(none; tester will infer the project's tests)";
				isLegacyVerifyGate = Boolean(
					verifyCommand &&
						perRoundCommandGates.length === 1 &&
						perRoundCommandGates[0].name === "verify" &&
						perRoundCommandGates[0].command === verifyCommand,
				);
			};
			const runRequirementsPreflight = () => {
				const checks = evaluateRequirementPresence({ requirements: loadRequirements(cwd), env: process.env, toolPresent: toolOnPath });
				const summary = summarizeRequirementChecks(checks);
				const requirementGaps = requirementGapNames(checks);
				appendLog(cwd, slug, {
					type: "preflight_checked",
					round: state.round,
					requirementGaps,
					requirements: checks.map((check) => ({ category: check.category, name: check.name, presence: check.presence })),
				});
				if (summary.hasGaps) emit(`ADVISORY: Preflight: ${formatRequirementGaps(checks)}.`);
			};
			refreshGates();

			const evaluateCurrentDoneness = (gate2Approved: boolean) =>
				evaluateDoneness(
					extractDonenessInputs(readLedgerLogEvents(cwd, slug), {
						gate1Approved: state.gate1Approved,
						gate2Approved,
						reviewerGateDeclared: gatesForStage(gates, "pre-ship").some((gate) => gate.kind === "judge"),
					}),
				);

			// Push this session's Foreman tasks to pi's additive footer status line. No-op when there's no
			// interactive status API (headless/print/RPC); direct-edit footer status stays separate.
			let statusFrame = 0;
			const pushStatus = () => {
				const setStatus = ctx?.ui?.setStatus;
				if (typeof setStatus !== "function") return;
				const theme = ctx.ui?.theme;
				const color = typeof theme?.fg === "function" ? (token: string, text: string) => theme.fg(token, text) : undefined;
				const bg = typeof theme?.bg === "function" ? (token: string, text: string) => theme.bg(token, text) : undefined;
				const model = buildStatuslineModel(cwd, { sessionId, now: Date.now() });
				const line = formatStatusLine(model, { color, bg, frame: statusFrame, maxWidth: 160, now: Date.now() });
				setStatus.call(ctx.ui, STATUS_KEY, line || undefined);
			};
			const clearStatus = () => {
				const setStatus = ctx?.ui?.setStatus;
				if (typeof setStatus === "function") setStatus.call(ctx.ui, STATUS_KEY, undefined);
			};
			// Animate the live spinner/elapsed footer while an agent is spawning (interactive only).
			let spinnerTimer: ReturnType<typeof setInterval> | null = null;
			const startSpinner = () => {
				if (spinnerTimer || typeof ctx?.ui?.setStatus !== "function") return;
				spinnerTimer = setInterval(() => {
					statusFrame += 1;
					pushStatus();
				}, 120);
			};
			const stopSpinner = () => {
				if (spinnerTimer) {
					clearInterval(spinnerTimer);
					spinnerTimer = null;
				}
			};
			const done = () => {
				stopSpinner();
				clearStatus();
				return { content: [{ type: "text", text: transcript.join("\n") }] };
			};
			pushStatus();

			emit(`Loop: "${state.task}" (slug=${slug}, maxRounds=${state.maxRounds})`);

			// ---- GATE 1: PLAN APPROVAL (before any code runs) ----
			if (!state.gate1Approved) {
				if (params.reject) {
					state.state = "escalated";
					writeState(cwd, state);
					appendLog(cwd, slug, { type: "gate1_rejected", feedback: params.reject });
					emit(`Plan rejected: ${params.reject}\nTask halted. Start a new task with the revised intent.`);
					return done();
				}
				if (params.approve) {
					const persistedDraft = readPersistedPlannerDraft(cwd, slug);
					let manifestResult: { wrote: boolean; reason: string } | null = null;
					if (persistedDraft) {
						manifestResult = writeProposedManifestOnGate1Approval(cwd, persistedDraft);
					}
					state.gate1Approved = true;
					state.state = "in_progress";
					writeState(cwd, state);
					appendLog(cwd, slug, {
						type: "gate1_approved",
						manifest: manifestResult ? { wrote: manifestResult.wrote, reason: manifestResult.reason } : undefined,
					});
					refreshGates();
					emit(
						manifestResult?.wrote
							? "Plan approved. Wrote proposed .pi/foreman.json. Starting dev->test->fix rounds."
							: `Plan approved. Starting dev->test->fix rounds.${manifestResult ? ` (${manifestResult.reason})` : ""}`,
					);
				} else {
					const persisted = readPersistedPlannerDraft(cwd, slug);
					const manifestExists = hasForemanManifest(cwd);
					const drafted = persisted
						? persisted
						: await draftPlannerPlan({
								cwd,
								slug,
								task: state.task,
								track,
								maxRounds: state.maxRounds,
								verifyCommand,
								developerModel: developer.model,
								testerModel: tester.model,
								existingGates: gates,
								manifestExists,
								ownerSessionId: sessionId,
								signal,
							});
					writePersistedPlannerDraft(cwd, slug, drafted);
					const requirementChecks = evaluateRequirementPresence({ requirements: drafted.plan.requirements, env: process.env, toolPresent: toolOnPath });
					const plan = renderFounderPlan(drafted.plan, {
						task: state.task,
						cwd,
						track,
						maxRounds: state.maxRounds,
						verifyCommand,
						developerLabel: track === "frontend" ? "UI developer" : "Developer",
						developerModel: developer.model,
						testerModel: tester.model,
						manifestExists,
						existingGates: gates,
						plannerSource: drafted.source,
						manifestWriteEligible: drafted.source === "planner",
						requirementChecks,
					});
					fs.writeFileSync(path.join(taskDir(cwd, slug), "plan.md"), `${plan}\n`);
					state.state = "planning";
					writeState(cwd, state);
					appendLog(cwd, slug, {
						type: "gate1_awaiting",
						planner: drafted.source,
						note: drafted.note,
						perRoundGates: perRoundGateSummary,
						requirementGaps: requirementGapNames(requirementChecks),
					});
					emit(
						`\n=== GATE 1 / PLAN — approval needed ===\n${plan}\n` +
							`Await founder approval; do not auto-approve this gate.\n` +
							`Approve:  foreman({ resume: true, approve: true })\n` +
							`Revise:   foreman({ resume: true, reject: "<what to change>" })`,
					);
					return done();
				}
			}

			if (state.gate1Approved) runRequirementsPreflight();

			const persistedIntentDraft = state.gate1Approved ? readPersistedPlannerDraft(cwd, slug) : null;
			const intentContract = persistedIntentDraft?.plan ? formatIntentContract(persistedIntentDraft.plan) : "";
			const intentForDev = intentContract ? `Founder-approved intent (build to THIS):\n${intentContract}` : "";
			const intentForTester = intentContract ? `Founder-approved intent (judge against THIS; do not FAIL deliberately omitted non-goals):\n${intentContract}` : "";

			let devContext = `Implement this task in ${cwd}:\n${state.task}`;
			if (isLegacyVerifyGate) {
				// Legacy no-foreman.json path: keep the developer prompt compatible with the old model.
				devContext += `\n\nVerify with: ${verifyCommand}`;
			} else if (perRoundCommandGates.length) {
				devContext += `\n\nPer-round command gates:\n${perRoundCommandGates.map((gate) => `- ${gate.name}: ${gate.command}`).join("\n")}`;
			}

			// ---- CREW DECISION resume: orchestrator/founder answers a question the crew raised ----
			if (state.state === "awaiting_decision") {
				const pending = state.pendingDecision;
				if (params.reject) {
					state.state = "in_progress";
					state.pendingDecision = undefined;
					writeState(cwd, state);
					appendLog(cwd, slug, { type: "crew_question_redirected", round: state.round, feedback: params.reject });
					emit(`Decision redirected: ${params.reject}\nReopening the developer round with new direction.`);
					devContext =
						`Continue task in ${cwd}: ${state.task}\n\n` +
						(pending ? `You earlier asked: ${pending.question}\n\n` : "") +
						`The founder redirected instead of answering directly:\n${params.reject}\n\nProceed on this basis. Do not re-ask the same question.`;
					// fall through into the round loop
				} else if (typeof params.answer === "string" && params.answer.trim()) {
					const answer = params.answer.trim();
					state.state = "in_progress";
					state.pendingDecision = undefined;
					// Persist the decision so it survives across rounds/restarts and reaches the tester too.
					state.resolvedDecisions = [
						...(state.resolvedDecisions ?? []),
						{ round: pending?.round ?? state.round, ...(pending?.question ? { question: pending.question } : {}), decision: answer, createdAt: new Date().toISOString() },
					];
					writeState(cwd, state);
					appendLog(cwd, slug, { type: "crew_question_answered", round: state.round, answer });
					emit(`Decision delivered. Resuming the developer round with the answer.`);
					devContext =
						`Continue task in ${cwd}: ${state.task}\n\n` +
						(pending ? `You asked: ${pending.question}\n` : "") +
						`The founder's decision: ${answer}\n\nApply this and continue. Do not re-ask; if a further fork appears, escalate a NEW specific question.`;
					// fall through into the round loop
				} else {
					emit(pending ? formatDecisionPrompt(pending.round, pending) : "This task is awaiting a crew decision. Provide `answer` to resume.");
					return done();
				}
			}

			// ---- GATE 2 resume: founder decides on a task that already passed verification ----
			if (state.state === "awaiting_ship") {
				const docGate2Lines = latestDocGate2LinesFromEvents(readLedgerLogEvents(cwd, slug));
				const docGate2Block = docGate2Lines ? `Documentation:\n${docGate2Lines}\n` : "";
				if (params.reject) {
					state.state = "in_progress";
					writeState(cwd, state);
					appendLog(cwd, slug, { type: "gate2_rejected", feedback: params.reject });
					emit(`Ship rejected: ${params.reject}\nReopening for another round.`);
					devContext =
						`Continue task in ${cwd}: ${state.task}\n\n` +
						`The work passed verification but the founder asked for changes:\n${params.reject}\n\nApply these.`;
					// fall through into the round loop
				} else if (params.approve) {
					const doneness = evaluateCurrentDoneness(true);
					const doneChecklist = renderDoneChecklist(doneness);
					if (!doneness.done) {
						state.state = "awaiting_ship";
						writeState(cwd, state);
						appendLog(cwd, slug, { type: "done_blocked", blockers: doneness.blockers });
						emit(
							`\n=== GATE 2 / SHIP — Definition of Done blocked ===\n${docGate2Block}${doneChecklist}\n\n` +
								`Commit withheld. The task remains at Gate 2; it was NOT marked done.\n` +
								`Resolve the blockers, then approve again. To send it back, run: foreman({ resume: true, reject: "<what to change>" })\n` +
								`If the only blocker is an inconclusive reviewer verdict, reopen with reject feedback asking for a live reviewer rerun; strict mode has no force-ship bypass and requires REVIEW: APPROVE before commit.`,
						);
						return done();
					}

					state.gate2Approved = true;
					state.state = "done";
					writeState(cwd, state);
					appendLog(cwd, slug, { type: "gate2_approved" });
					appendLog(cwd, slug, { type: "done_evaluated", done: true, blockers: doneness.blockers, checklist: doneness.checklist });
					appendLog(cwd, slug, { type: "task_done", round: state.round });
					const releaseActionGates = gatesForStage(gates, "release").filter((gate) => gate.kind === "action");
					const releaseResults = releaseActionGates.length
						? await runReleaseActionGates({ cwd, slug, state, track, gates: releaseActionGates, doneSummary: doneChecklist, signal })
						: [];
					const releaseSummary = releaseResults.length ? `\nRelease actions:\n${releaseResults.join("\n")}` : "";
					emit(`SHIPPED. Task done. Ledger: ${path.relative(cwd, taskDir(cwd, slug))}\n\n${docGate2Block}${doneChecklist}${releaseSummary}`);
					return done();
				} else {
					const doneChecklist = renderDoneChecklist(evaluateCurrentDoneness(false));
					emit(
						`\n=== GATE 2 / SHIP — approval needed ===\nTask "${state.task}" passed verification and is awaiting your sign-off.\n` +
							docGate2Block +
							`${doneChecklist}\n` +
							`Approve:  foreman({ resume: true, approve: true })\n` +
							`Revise:   foreman({ resume: true, reject: "<what to change>" })`,
					);
					return done();
				}
			}

			while (state.round < state.maxRounds) {
				state.round += 1;
				const round = state.round;
				writeState(cwd, state);
				appendLog(cwd, slug, { type: "round_started", round });

				// ---- DEVELOPER ----
				emit(`Round ${round}: developer...`);
				const devSession = randomUUID();
				const devTranscript = transcriptFilePath(cwd, slug, "developer", round, devSession);
				writeActivity(cwd, slug, {
					round,
					phase: "developer",
					activeTranscript: path.basename(devTranscript),
					note: "running…",
					pid: process.pid,
					ownerSessionId: sessionId,
				});
				pushStatus();
				startSpinner();
				const treeBefore = track === "frontend" ? workingTreeSnapshot(cwd) : null;
				// Always re-attach founder-approved intent and decisions so a fail-retry round (which rebuilds
				// devContext) never loses them. Idempotent: resume branches may already include related prose.
				const decisionsForDev = formatResolvedDecisions(state.resolvedDecisions);
				const devContextWithIntent = intentForDev ? `${devContext}\n\n${intentForDev}` : devContext;
				const devContextWithDecisions = decisionsForDev ? `${devContextWithIntent}\n\n${decisionsForDev}` : devContextWithIntent;
				let implementerTimeout: AgentTimeoutOutcome = { timedOut: false, reason: null };
				let implementerTimeoutRole: AgentTimeoutRole = "developer";
				let devOutcome = await runAgentWithTimeout(developer, devContextWithDecisions, cwd, {
					role: "developer",
					round,
					transcriptPath: devTranscript,
					signal,
					slug,
				});
				let devRun = devOutcome.result;
				if (devOutcome.timeout.timedOut) implementerTimeout = devOutcome.timeout;
				stopSpinner();
				let devBlock = implementerTimeout.timedOut ? null : extractJsonBlock(devRun.text, "---DEV-JSON---", "---END-DEV-JSON---");

				// ---- UI-DEVELOPER FALLBACK (frontend track only) ----
				// Gemini has taste but is flaky at tool-calling; if it errored, skipped the machine block,
				// or changed nothing on disk, re-run THIS round once with a stronger model (Opus xhigh).
				// Skip the fallback when the dev escalated a question: an empty tree is then intentional
				// (it stopped to ask), not a flaky no-op, and re-running would burn Opus and likely re-ask.
				if (!implementerTimeout.timedOut && track === "frontend" && !signal.aborted && !readPendingQuestion(cwd, slug)) {
					const reason = devFallbackReason(devRun, devBlock != null, treeBefore, workingTreeSnapshot(cwd));
					if (reason) {
						appendLog(cwd, slug, { type: "ui_fallback", round, reason, from: developer.model ?? "default", to: UI_FALLBACK_MODEL });
						emit(`Round ${round}: ui-developer fallback (${reason}) -> ${UI_FALLBACK_MODEL}`);
						writeActivity(cwd, slug, {
							round,
							phase: "developer",
							activeTranscript: path.basename(devTranscript),
							note: `fallback -> ${UI_FALLBACK_MODEL} (${reason})`,
							pid: process.pid,
							ownerSessionId: sessionId,
						});
						pushStatus();
						startSpinner();
						devOutcome = await runAgentWithTimeout(
							{ ...developer, model: UI_FALLBACK_MODEL },
							devContextWithDecisions,
							cwd,
							{
								role: "developer",
								round,
								transcriptPath: devTranscript,
								signal,
								slug,
							},
							"ui-developer",
						);
						devRun = devOutcome.result;
						if (devOutcome.timeout.timedOut) {
							implementerTimeout = devOutcome.timeout;
							implementerTimeoutRole = "ui-developer";
						}
						stopSpinner();
						devBlock = implementerTimeout.timedOut ? null : extractJsonBlock(devRun.text, "---DEV-JSON---", "---END-DEV-JSON---");
					}
				}
				const implementerTimeoutDegradation = decideAgentTimeoutDegradation(
					implementerTimeoutRole,
					implementerTimeout,
					AGENT_TIMEOUTS[implementerTimeoutRole],
				);
				const implementerTimeoutNote = implementerTimeout.timedOut
					? (recordAgentTimeout(cwd, slug, implementerTimeoutRole, round, implementerTimeout) ?? implementerTimeoutDegradation.note)
					: null;
				const devHandoff: Handoff = {
					timestamp: new Date().toISOString(),
					role: "developer",
					round,
					sessionId: devSession,
					summary: devBlock?.summary ?? implementerTimeoutNote ?? "(no structured summary)",
					filesChanged: devBlock?.filesChanged,
					howToVerify: devBlock?.howToVerify,
					raw: implementerTimeoutNote ? `${implementerTimeoutNote}\n\n${devRun.text || devRun.stderr || "(no implementer output)"}` : devRun.text,
				};
				writeHandoff(cwd, slug, devHandoff);

				if (implementerTimeout.timedOut) {
					const retryNote = implementerTimeoutNote ?? `${implementerTimeoutRole} timed out (${implementerTimeout.reason ?? "unknown"})`;
					writeActivity(cwd, slug, {
						round,
						phase: "idle",
						activeTranscript: path.basename(devTranscript),
						note: `implementer timeout: ${retryNote}`.slice(0, 500),
						pid: process.pid,
						ownerSessionId: sessionId,
					});
					pushStatus();
					emit(`Round ${round}: implementer timed out (${implementerTimeout.reason ?? "unknown"}); retrying if rounds remain.`);
					devContext =
						`Continue task in ${cwd}: ${state.task}\n\n` +
						`Round ${round} FAILED before verification because the implementer timed out (${implementerTimeout.reason ?? "unknown"}).\n` +
						`${retryNote}\n\nInspect the current tree, keep any useful partial work, and finish the task.`;
					continue;
				}

				// ---- CREW ESCALATION GATE: developer raised a question it couldn't decide ----
				// The crew can't block on the founder, so it recorded a question and stopped. Pause the loop
				// (awaiting_decision) and surface it to the orchestrator, which answers from context or asks
				// the founder, then resumes with foreman({ resume: true, answer: "..." }).
				const escalated = readPendingQuestion(cwd, slug);
				if (escalated) {
					clearPendingQuestion(cwd, slug); // consumed: copy into durable state so resume survives a restart
					state.state = "awaiting_decision";
					state.pendingDecision = escalated;
					writeState(cwd, state);
					appendLog(cwd, slug, { type: "crew_question_raised", round, askedBy: escalated.askedBy, question: escalated.question });
					writeActivity(cwd, slug, {
						round,
						phase: "idle",
						activeTranscript: path.basename(devTranscript),
						note: `awaiting decision: ${escalated.question.slice(0, 200)}`,
						pid: process.pid,
						ownerSessionId: sessionId,
					});
					pushStatus();
					emit(formatDecisionPrompt(round, escalated));
					return done();
				}

				// ---- VERIFY (controller runs command gates; exit code = GROUND TRUTH) ----
				let verifyExit: number | null = null;
				let verifyOutput = "";
				let verifyResults: CommandGateResult[] = [];
				let failedGate: CommandGateResult | undefined;
				writeActivity(cwd, slug, {
					round,
					phase: "verify",
					activeTranscript: null,
					note: perRoundCommandGates.length
						? isLegacyVerifyGate
							? `running ${verifyCommand}`
							: `running gates: ${perRoundCommandGates.map((gate) => gate.name).join(", ")}`
						: "skipped (no per-round command gates)",
					pid: process.pid,
					ownerSessionId: sessionId,
				});
				pushStatus();
				if (perRoundCommandGates.length) {
					emit(
						isLegacyVerifyGate
							? `Round ${round}: verify \`${verifyCommand}\`...`
							: `Round ${round}: verify gates ${perRoundCommandGates.map((gate) => gate.name).join(", ")}...`,
					);
					startSpinner();
					const gateRun = await runCommandGates(gates, "per-round", cwd, signal);
					stopSpinner();
					verifyResults = gateRun.results;
					failedGate = verifyResults.find((result) => result.exitCode !== 0);
					verifyExit = gateRun.passed ? 0 : (failedGate?.exitCode ?? 1);
					verifyOutput = formatCommandGateResults(verifyResults, 2000);
					appendLog(cwd, slug, {
						type: "verify_ran",
						round,
						command: verifyResults.length === 1 ? verifyResults[0].command : undefined,
						exitCode: verifyExit,
						gates: verifyResults.map((result) => ({ name: result.name, command: result.command, exitCode: result.exitCode })),
					});
				}

				// ---- TESTER (judges intent; cannot override a non-zero exit into success) ----
				emit(`Round ${round}: tester...`);
				const verifyInfo =
					verifyExit === null
						? "No per-round command gates ran; run the project's tests yourself to check."
						: isLegacyVerifyGate
							? `The verify command \`${verifyCommand}\` already ran. Exit code: ${verifyExit} (0 = passed).\nOutput:\n${verifyResults[0]?.output.slice(-3000) ?? ""}`
							: `The per-round command gates already ran. Aggregate exit code: ${verifyExit} (0 = passed; non-zero = failed).\n${verifyOutput.slice(-3000)}`;
				const decisionsForTester = formatResolvedDecisions(state.resolvedDecisions);
				const testerTask =
					`Judge whether the work in ${cwd} satisfies this task: ${state.task}\n\n${verifyInfo}\n\n` +
					(intentForTester ? `${intentForTester}\n\n` : "") +
					(decisionsForTester ? `${decisionsForTester}\n\n` : "") +
					`Read the changed files to confirm the change actually fulfills the task intent (not just that ` +
					`a command exited 0 — watch for cheats like hardcoding or editing tests). Then emit your VERDICT line.` +
					(intentForTester ? ` Judge against the Founder-approved intent above; do not FAIL deliberately omitted non-goal items.` : "") +
					(decisionsForTester
						? ` A literal value that matches a founder decision above is APPROVED, not a hardcoded cheat — do not FAIL it for being hardcoded.`
						: "");
				const testSession = randomUUID();
				const testTranscript = transcriptFilePath(cwd, slug, "tester", round, testSession);
				writeActivity(cwd, slug, {
					round,
					phase: "tester",
					activeTranscript: path.basename(testTranscript),
					note: "running…",
					pid: process.pid,
					ownerSessionId: sessionId,
				});
				pushStatus();
				startSpinner();
				const testOutcome = await runAgentWithTimeout(tester, testerTask, cwd, {
					role: "tester",
					round,
					transcriptPath: testTranscript,
					signal,
					slug,
				});
				const testRun = testOutcome.result;
				const testerTimeout = testOutcome.timeout;
				const testerTimeoutDegradation = decideAgentTimeoutDegradation("tester", testerTimeout, AGENT_TIMEOUTS.tester);
				const testerTimeoutNote = testerTimeout.timedOut ? (recordAgentTimeout(cwd, slug, "tester", round, testerTimeout) ?? testerTimeoutDegradation.note) : null;
				stopSpinner();
				const { successState: judged, parsedFrom } = testerTimeout.timedOut
					? { successState: testerTimeoutDegradation.successState ?? "fail", parsedFrom: `tester-timeout-${testerTimeout.reason ?? "unknown"}` }
					: parseVerdict(testRun.text);

				// Combine ground truth (exit code) with the tester's judgment.
				let successState: SuccessState;
				if (verifyExit !== null && verifyExit !== 0) {
					successState = "fail"; // ground truth wins: a failing command is never success
				} else if (verifyExit === 0) {
					// command gates passed; tester may still flag fail/partial/blocked on intent grounds
					successState = judged === "success" || parsedFrom === "no-verdict-token" ? "success" : judged;
				} else {
					// no command gates ran; rely on tester judgment
					successState = judged;
				}

				const summaryLine = testerTimeoutNote
					? testerTimeoutNote
					: (testRun.text
							.split("\n")
							.map((l) => l.trim())
							.filter((l) => l && !/^VERDICT:/i.test(l))[0] ?? "(no summary)");
				const testHandoff: Handoff = {
					timestamp: new Date().toISOString(),
					role: "tester",
					round,
					sessionId: testSession,
					successState,
					summary: summaryLine.slice(0, 200),
					verification: verifyResults.length
						? {
								commandsRun: verifyResults.map((result) => ({
									command: result.command,
									exitCode: result.exitCode,
									observation: `[${result.name}]\n${result.output.slice(-500)}`,
								})),
							}
						: undefined,
					raw: testerTimeoutNote ? `${testerTimeoutNote}\n\n${testRun.text || testRun.stderr || "(no tester output)"}` : testRun.text,
				};
				writeHandoff(cwd, slug, testHandoff);
				appendLog(cwd, slug, { type: "verdict", round, successState, verifyExit, parsedFrom, timedOut: testerTimeout.timedOut ? true : undefined, timeoutReason: testerTimeout.reason ?? undefined });
				state.lastReviewedHandoffCount = listHandoffs(cwd, slug).length;
				writeState(cwd, state);

				const roundSummary = `${successState.toUpperCase()} (verify exit=${verifyExit ?? "n/a"}) — ${testHandoff.summary}`;
				writeActivity(cwd, slug, {
					round,
					phase: "idle",
					activeTranscript: path.basename(testTranscript),
					note: roundSummary.slice(0, 500),
					pid: process.pid,
					ownerSessionId: sessionId,
				});
				pushStatus();
				emit(`Round ${round}: ${roundSummary}`);

				// ---- DECIDE ----
				if (successState === "success") {
					const preShipGates = gatesForStage(gates, "pre-ship");
					const preShipSummaryLines: string[] = [];
					let preShipJudgeGateCount = 0;
					let preShipReviewApproved = true;

					if (preShipGates.length) {
						const preShipCommandGates = preShipGates.filter((gate) => gate.kind === "command" && gate.command);
						const preShipJudgeGates = preShipGates.filter((gate) => gate.kind === "judge" && gate.agent);
						preShipJudgeGateCount += preShipJudgeGates.length;
						const preShipActionGates = preShipGates.filter((gate) => gate.kind === "action");
						const preShipCommandSummaryLines: string[] = [];

						if (preShipActionGates.length) {
							appendLog(cwd, slug, {
								type: "pre_ship_action_gates_skipped",
								round,
								gates: preShipActionGates.map((gate) => gate.name),
							});
							preShipSummaryLines.push(
								...preShipActionGates.map((gate) => `- ${gate.name}: SKIPPED (action gates are not supported at pre-ship)`),
							);
						}

						if (preShipCommandGates.length) {
							emit(`Round ${round}: pre-ship command gates ${preShipCommandGates.map((gate) => gate.name).join(", ")}...`);
							appendLog(cwd, slug, {
								type: "pre_ship_command_gates_started",
								round,
								gates: preShipCommandGates.map((gate) => ({ name: gate.name, command: gate.command })),
							});
							writeActivity(cwd, slug, {
								round,
								phase: "verify",
								activeTranscript: null,
								note: `running pre-ship gates: ${preShipCommandGates.map((gate) => gate.name).join(", ")}`,
								pid: process.pid,
								ownerSessionId: sessionId,
							});
							pushStatus();
							startSpinner();
							const preShipCommandRun = await runCommandGates(gates, "pre-ship", cwd, signal);
							stopSpinner();
							const preShipFailedGate = preShipCommandRun.results.find((result) => result.exitCode !== 0);
							const preShipCommandOutput = formatCommandGateResults(preShipCommandRun.results, 2000);
							appendLog(cwd, slug, {
								type: "pre_ship_command_gates_ran",
								round,
								passed: preShipCommandRun.passed,
								gates: preShipCommandRun.results.map((result) => ({ name: result.name, command: result.command, exitCode: result.exitCode })),
							});

							if (!preShipCommandRun.passed) {
								const failedContext = preShipFailedGate
									? `Pre-ship command gate "${preShipFailedGate.name}" \`${preShipFailedGate.command}\` exited ${preShipFailedGate.exitCode}.\nOutput:\n${preShipFailedGate.output.slice(-1500)}`
									: `Pre-ship command gates failed.\nOutput:\n${preShipCommandOutput.slice(-1500)}`;
								appendLog(cwd, slug, { type: "pre_ship_failed", round, kind: "command", gate: preShipFailedGate?.name });
								emit(`Round ${round}: pre-ship command gate FAILED${preShipFailedGate ? ` (${preShipFailedGate.name})` : ""}; reopening developer round.`);
								devContext =
									`Continue task in ${cwd}: ${state.task}\n\n` +
									`Round ${round} passed per-round verification, but a pre-ship command gate failed.\n\n` +
									`${failedContext}\n\nFix ONLY what this pre-ship failure points to.`;
								continue;
							}

							preShipCommandSummaryLines.push(...preShipCommandRun.results.map((result) => `- ${result.name}: PASS (\`${result.command}\`)`));
							preShipSummaryLines.push(...preShipCommandSummaryLines);
							emit(`Round ${round}: pre-ship command gates passed.`);
						}

						let reopenFromPreShipReview = false;
						for (const gate of preShipJudgeGates) {
							const reviewerAgentName = gate.agent ?? "reviewer";
							emit(`Round ${round}: pre-ship judge ${gate.name} (${reviewerAgentName})...`);
							appendLog(cwd, slug, { type: "pre_ship_reviewer_started", round, gate: gate.name, agent: reviewerAgentName });
							const reviewSession = randomUUID();
							// Transcript role stays "tester": the reviewer Handoff.role is intentionally "tester"
							// (index.ts ~1969), so the dashboard's sessionId-exact transcriptForRun lookup only matches
							// a tester-roled transcript. Live reviewer detection uses the activity note/phase, not this role.
							const reviewTranscript = transcriptFilePath(cwd, slug, "tester", round, reviewSession);
							writeActivity(cwd, slug, {
								round,
								phase: "tester",
								activeTranscript: path.basename(reviewTranscript),
								note: `pre-ship judge ${gate.name} running…`,
								pid: process.pid,
								ownerSessionId: sessionId,
							});
							pushStatus();
							startSpinner();
							let reviewRun: RunResult;
							let reviewerTimeout: AgentTimeoutOutcome = { timedOut: false, reason: null };
							let reviewerTimeoutNote: string | null = null;
							try {
								const reviewAgent = loadAgent(reviewerAgentName);
								const reviewOutcome = await runAgentWithTimeout(
									reviewAgent,
									reviewerTaskFor({
										cwd,
										task: state.task,
										round,
										gate,
										testerSummary: testHandoff.summary,
										preShipCommandSummary: preShipCommandSummaryLines.join("\n"),
									}),
									cwd,
									{ role: "reviewer", round, transcriptPath: reviewTranscript, signal, slug },
								);
								reviewRun = reviewOutcome.result;
								reviewerTimeout = reviewOutcome.timeout;
								const reviewerTimeoutDegradation = decideAgentTimeoutDegradation("reviewer", reviewerTimeout, AGENT_TIMEOUTS.reviewer);
								reviewerTimeoutNote = reviewerTimeout.timedOut
									? (recordAgentTimeout(cwd, slug, "reviewer", round, reviewerTimeout, { gate: gate.name, agent: reviewerAgentName }) ?? reviewerTimeoutDegradation.note)
									: null;
							} catch (error) {
								reviewRun = { text: `Reviewer gate "${gate.name}" could not run: ${String(error)}`, exitCode: 1, stderr: String(error) };
							} finally {
								stopSpinner();
							}

							const parsedReview = parseReviewVerdict(reviewRun.text);
							const review: ReviewVerdict = reviewerTimeout.timedOut
								? { ...parsedReview, decision: "unknown" }
								: reviewRun.exitCode === 0 || parsedReview.decision === "request-changes"
									? parsedReview
									: { ...parsedReview, decision: "unknown" };
							const reviewDecision = decideReviewOutcome(review);
							// Handoff.role intentionally remains "tester" to avoid a ledger schema change;
							// the summary prefix and explicit pre_ship_reviewer_* log events distinguish reviewer output.
							const reviewHandoff: Handoff = {
								timestamp: new Date().toISOString(),
								role: "tester",
								round,
								sessionId: reviewSession,
								successState: reviewSuccessState(review),
								summary: `[reviewer] ${gate.name}: ${review.decision}${reviewDecision.flagged ? " (inconclusive)" : ""}`.slice(0, 200),
								raw: reviewerTimeoutNote
									? `${reviewerTimeoutNote}\n\n${reviewRun.text || reviewRun.stderr || "(no reviewer output)"}`
									: reviewRun.text || `(no reviewer output; stderr: ${reviewRun.stderr})`,
							};
							writeHandoff(cwd, slug, reviewHandoff);
							appendLog(cwd, slug, {
								type: "pre_ship_reviewer_verdict",
								round,
								gate: gate.name,
								agent: reviewerAgentName,
								exitCode: reviewRun.exitCode,
								decision: review.decision,
								action: reviewDecision.action,
								blocking: review.blocking,
								nits: review.nits,
								timedOut: reviewerTimeout.timedOut ? true : undefined,
								timeoutReason: reviewerTimeout.reason ?? undefined,
							});
							state.lastReviewedHandoffCount = listHandoffs(cwd, slug).length;
							writeState(cwd, state);
							if (review.decision !== "approve") preShipReviewApproved = false;

							preShipSummaryLines.push(reviewSummaryLine(gate, review));
							if (review.nits.length) preShipSummaryLines.push(`  NITS:\n${formatReviewItems(review.nits).replace(/^/gm, "  ")}`);

							if (reviewDecision.reopen) {
								appendLog(cwd, slug, { type: "pre_ship_failed", round, kind: "judge", gate: gate.name, agent: reviewerAgentName });
								emit(`Round ${round}: pre-ship reviewer requested changes; reopening developer round.`);
								devContext =
									`Continue task in ${cwd}: ${state.task}\n\n` +
									`Round ${round} passed per-round verification, but pre-ship reviewer gate "${gate.name}" requested changes.\n\n` +
									`Reviewer BLOCKING findings:\n${formatReviewItems(review.blocking)}\n` +
									(review.nits.length ? `\nReviewer NITS (non-blocking; do not reopen by themselves):\n${formatReviewItems(review.nits)}\n` : "") +
									"\nFix ONLY the blocking issues required for reviewer approval.";
								reopenFromPreShipReview = true;
								break;
							}

							if (reviewDecision.flagged) {
								// Unknown reviewer output is not approval, but reopening would burn all rounds on
								// a flaky parse/timeout. Proceed to Gate 2 flagged so the founder makes the ship decision.
								preShipSummaryLines.push(
									reviewerTimeoutNote
										? `  ⚠ Reviewer timed out (${reviewerTimeout.reason ?? "unknown"}); inspect the [reviewer] handoff before approving ship.`
										: "  ⚠ Reviewer output was inconclusive; inspect the [reviewer] handoff before approving ship.",
								);
								if (reviewerTimeoutNote) {
									writeActivity(cwd, slug, {
										round,
										phase: "idle",
										activeTranscript: path.basename(reviewTranscript),
										note: `reviewer timeout: ${reviewerTimeoutNote}`.slice(0, 500),
										pid: process.pid,
										ownerSessionId: sessionId,
									});
									pushStatus();
								}
							}
							emit(`Round ${round}: pre-ship judge ${gate.name} ${review.decision.toUpperCase()}.`);
						}
						if (reopenFromPreShipReview) continue;

						appendLog(cwd, slug, { type: "pre_ship_passed", round, summary: preShipSummaryLines });
						writeActivity(cwd, slug, {
							round,
							phase: "idle",
							activeTranscript: null,
							note: `pre-ship passed: ${preShipSummaryLines.join(" ").slice(0, 400)}`,
							pid: process.pid,
							ownerSessionId: sessionId,
						});
						pushStatus();
					}

					const docErReport = await runDocErStage({
						cwd,
						slug,
						state,
						round,
						devHandoff,
						intentContract,
						ownerSessionId: sessionId,
						signal,
						shouldRun: preShipJudgeGateCount === 0 || preShipReviewApproved,
						skipReason: "skipped until pre-ship reviewer cleanly APPROVEs",
						emit,
						pushStatus,
						startSpinner,
						stopSpinner,
					});
					emit(`Round ${round}: ${docErReport.summaryLine}${docErReport.driftLine ? `; ${docErReport.driftLine}` : ""}.`);

					// ---- GATE 2: SHIP APPROVAL (verification passed; founder OKs before done) ----
					state.state = "awaiting_ship";
					writeState(cwd, state);
					appendLog(cwd, slug, {
						type: "gate2_awaiting",
						round,
						preShipSummary: preShipSummaryLines.length ? preShipSummaryLines : undefined,
						docEr: { status: docErReport.status, updatedPaths: docErReport.updatedPaths, reason: docErReport.reason, flagged: docErReport.flagged },
						docDrift: docErReport.driftDocs,
					});
					const preShipSummary = preShipSummaryLines.length ? `Pre-ship checks:\n${preShipSummaryLines.join("\n")}\n` : "";
					const docGate2Lines = formatDocGate2Lines(docErReport);
					const docGate2Block = docGate2Lines ? `Documentation:\n${docGate2Lines}\n` : "";
					const doneChecklist = renderDoneChecklist(evaluateCurrentDoneness(false));
					emit(
						`\n=== GATE 2 / SHIP — approval needed (round ${round}) ===\n` +
							`Verification passed and the tester judged the work satisfies: ${state.task}\n` +
							`Summary: ${testHandoff.summary}\n` +
							preShipSummary +
							docGate2Block +
							`${doneChecklist}\n` +
							`Approve:  foreman({ resume: true, approve: true })\n` +
							`Revise:   foreman({ resume: true, reject: "<what to change>" })`,
					);
					return done();
				}
				if (successState === "partial" || successState === "blocked") {
					state.state = "escalated";
					writeState(cwd, state);
					appendLog(cwd, slug, { type: "escalated", round, successState });
					emit(`ESCALATED (${successState}). Founder input needed. See ${path.relative(cwd, taskDir(cwd, slug))}.`);
					return done();
				}
				// fail -> feed command-gate output + tester diagnosis back to developer for next round
				const failedGateContext = failedGate
					? isLegacyVerifyGate
						? ` Verify \`${failedGate.command}\` exited ${failedGate.exitCode}.\nOutput:\n${failedGate.output.slice(-1500)}\n\n`
						: ` Command gate "${failedGate.name}" \`${failedGate.command}\` exited ${failedGate.exitCode}.\nOutput:\n${failedGate.output.slice(-1500)}\n\n`
					: verifyExit !== null
						? ` Command gates exited ${verifyExit}.\nOutput:\n${verifyOutput.slice(-1500)}\n\n`
						: "\n\n";
				devContext =
					`Continue task in ${cwd}: ${state.task}\n\n` +
					`Round ${round} FAILED.` +
					failedGateContext +
					`Tester diagnosis:\n${testHandoff.raw.slice(0, 1500)}\n\nFix ONLY what these point to.`;
			}

			// rounds exhausted
			state.state = "escalated";
			writeState(cwd, state);
			appendLog(cwd, slug, { type: "rounds_exhausted", round: state.maxRounds });
			emit(`STOPPED after ${state.maxRounds} rounds without success. Escalating to founder.`);
			return done();
		},
	});
}
