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
	type SuccessState,
	type Track,
	appendLog,
	configureMirror,
	initLedger,
	resolveResumable,
	listHandoffs,
	readState,
	restoreFromMirror,
	taskDir,
	transcriptsDir,
	writeActivity,
	writeHandoff,
	writeState,
} from "./ledger.ts";
import { ForemanDashboard } from "./dashboard/view.ts";
import { buildStatuslineModel, formatStatusline } from "./dashboard/reader.ts";
import { devFallbackReason, workingTreeSnapshot } from "./fallback.ts";
import {
	type CommandGateResult,
	type Gate,
	gatesForStage,
	loadGates,
	runCommandGates,
} from "./gates.ts";
import {
	type PlannerPlan,
	type PlannerSource,
	PLAN_JSON_END,
	PLAN_JSON_START,
	decideManifestWrite,
	fallbackPlannerPlan,
	renderFounderPlan,
	serializePlannerPlan,
	validatePlannerPlan,
} from "./planner.ts";
import { decideReviewOutcome, parseReviewVerdict, type ReviewVerdict } from "./reviewer.ts";

// Stronger model the frontend track falls back to when Gemini fails to drive the tools.
const UI_FALLBACK_MODEL = "cliproxy/claude-opus-4-8:xhigh";
const PLANNER_TIMEOUT_MS = Math.max(1000, Number(process.env.FOREMAN_PLANNER_TIMEOUT_MS ?? 30000) || 30000);

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

type AgentRole = "planner" | "developer" | "tester";

interface RunAgentOptions {
	role: AgentRole;
	round: number;
	transcriptPath: string;
	signal?: AbortSignal;
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

	const appendTranscript = makeTranscriptWriter(options.transcriptPath);
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
			env: { ...process.env, FOREMAN_CREW: "1" },
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
			options.signal.addEventListener("abort", () => {
				wasAborted = true;
				proc.kill("SIGTERM");
			});
		}
	});
	if (tmpDir) await fs.promises.rm(tmpDir, { recursive: true, force: true });
	return { text: texts.join("\n").trim(), exitCode, stderr };
}

function extractJsonBlock(text: string, startMarker: string, endMarker: string): any | null {
	const s = text.indexOf(startMarker);
	const e = text.indexOf(endMarker);
	if (s === -1 || e === -1 || e < s) return null;
	try {
		return JSON.parse(text.slice(s + startMarker.length, e).trim());
	} catch {
		return null;
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

function foremanManifestPath(cwd: string): string {
	return path.join(cwd, ".pi", "foreman.json");
}

function hasForemanManifest(cwd: string): boolean {
	return fs.existsSync(foremanManifestPath(cwd));
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
		"Return a concise plan and exactly one PLAN-JSON block with keys summary, steps, filesLikely, risks, proposedGates. Propose only commands you verified actually exist in this repo; if no .pi/foreman.json exists and no real command is detectable, proposedGates must be empty. Do not copy the legacy verify command into proposedGates unless you verified it is a real repo command. If .pi/foreman.json exists, reflect existing gates and do not propose overwriting it.",
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
	const controller = new AbortController();
	let timedOut = false;
	let finalActivityNote = "planner finished";
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, PLANNER_TIMEOUT_MS);
	const abortPlanner = () => controller.abort();
	input.signal?.addEventListener("abort", abortPlanner, { once: true });
	try {
		const run = await runAgent(planner, plannerTaskFor(input), input.cwd, {
			role: "planner",
			round: 0,
			transcriptPath,
			signal: controller.signal,
		});
		if (timedOut) {
			const note = `planner timed out after ${PLANNER_TIMEOUT_MS}ms`;
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
		clearTimeout(timer);
		input.signal?.removeEventListener("abort", abortPlanner);
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
		source: draft.source,
	});
	if (!decision.shouldWrite || !decision.manifest) return { wrote: false, reason: decision.reason };
	const manifestPath = foremanManifestPath(cwd);
	fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
	fs.writeFileSync(manifestPath, `${JSON.stringify(decision.manifest, null, 2)}\n`);
	return { wrote: true, reason: decision.reason };
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
	},
	required: [],
} as const;

let dashboardOpen = false;
let directMode = false;

const DIRECT_STATUS_KEY = "foreman-direct";

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

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", (event, ctx) => {
		if (process.env.FOREMAN_CREW === "1" || directMode) return undefined;
		const classification = classifyToolCall(
			{ toolName: event.toolName, input: event.input },
			{ cwd: ctx.cwd, findRepoRoot: findGitRoot, scratchDirs: foremanScratchDirs() },
		);
		if (!classification.gate) return undefined;
		return { block: true, reason: classification.reason };
	});

	pi.registerCommand("foreman-direct", {
		description: "Toggle Foreman direct-edit escape hatch for this session.",
		handler: async (_args, ctx) => {
			directMode = !directMode;
			if (directMode) {
				ctx.ui?.setStatus?.(DIRECT_STATUS_KEY, "⚠ foreman direct-edit mode ON");
				ctx.ui?.notify?.("Foreman direct-edit mode ON: main-session edits are allowed for this session.", "warning");
			} else {
				ctx.ui?.setStatus?.(DIRECT_STATUS_KEY, undefined);
				ctx.ui?.notify?.("Foreman direct-edit mode OFF: implementation routes through Foreman.", "info");
			}
		},
	});

	pi.registerShortcut("ctrl+b", {
		description: "Foreman dashboard",
		handler: async (ctx) => {
			if (!ctx.hasUI || dashboardOpen) return;
			dashboardOpen = true;
			try {
				await ctx.ui.custom<void>((tui, theme, _keybindings, done) => new ForemanDashboard(ctx.cwd, tui, theme, done));
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
				await ctx.ui.custom<void>((tui, theme, _keybindings, done) => new ForemanDashboard(ctx.cwd, tui, theme, done, { openLive: true }));
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
		].join(" "),
		parameters: LoopParams as any,

		async execute(_id: string, params: any, signal: AbortSignal, onUpdate: any, ctx: any) {
			const cwd: string = params.cwd ?? ctx.cwd;
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
			refreshGates();

			// Push this session's foreman tasks to the footer statusline (newest-first, with the live
			// crew agent). No-op when there's no interactive UI (headless/print/RPC).
			let statusFrame = 0;
			const pushStatus = () => {
				const setStatus = ctx?.ui?.setStatus;
				if (typeof setStatus !== "function") return;
				const theme = ctx.ui.theme;
				const color = typeof theme?.fg === "function" ? (token: string, text: string) => theme.fg(token, text) : undefined;
				const model = buildStatuslineModel(cwd, { sessionId });
				const line = formatStatusline(model, { color, frame: statusFrame });
				setStatus.call(ctx.ui, STATUS_KEY, line || undefined);
			};
			// Animate the live spinner in the footer while an agent is spawning (interactive only).
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
				pushStatus();
				return { content: [{ type: "text", text: transcript.join("\n") }] };
			};

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
					});
					fs.writeFileSync(path.join(taskDir(cwd, slug), "plan.md"), `${plan}\n`);
					state.state = "planning";
					writeState(cwd, state);
					appendLog(cwd, slug, {
						type: "gate1_awaiting",
						planner: drafted.source,
						note: drafted.note,
						perRoundGates: perRoundGateSummary,
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

			let devContext = `Implement this task in ${cwd}:\n${state.task}`;
			if (isLegacyVerifyGate) {
				// Legacy no-foreman.json path: keep the developer prompt compatible with the old model.
				devContext += `\n\nVerify with: ${verifyCommand}`;
			} else if (perRoundCommandGates.length) {
				devContext += `\n\nPer-round command gates:\n${perRoundCommandGates.map((gate) => `- ${gate.name}: ${gate.command}`).join("\n")}`;
			}

			// ---- GATE 2 resume: founder decides on a task that already passed verification ----
			if (state.state === "awaiting_ship") {
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
					state.gate2Approved = true;
					state.state = "done";
					writeState(cwd, state);
					appendLog(cwd, slug, { type: "gate2_approved" });
					appendLog(cwd, slug, { type: "task_done", round: state.round });
					emit(`SHIPPED. Task done. Ledger: ${path.relative(cwd, taskDir(cwd, slug))}`);
					return done();
				} else {
					emit(
						`\n=== GATE 2 / SHIP — approval needed ===\nTask "${state.task}" passed verification and is awaiting your sign-off.\n` +
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
				let devRun = await runAgent(developer, devContext, cwd, {
					role: "developer",
					round,
					transcriptPath: devTranscript,
					signal,
				});
				stopSpinner();
				let devBlock = extractJsonBlock(devRun.text, "---DEV-JSON---", "---END-DEV-JSON---");

				// ---- UI-DEVELOPER FALLBACK (frontend track only) ----
				// Gemini has taste but is flaky at tool-calling; if it errored, skipped the machine block,
				// or changed nothing on disk, re-run THIS round once with a stronger model (Opus xhigh).
				if (track === "frontend" && !signal.aborted) {
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
						devRun = await runAgent({ ...developer, model: UI_FALLBACK_MODEL }, devContext, cwd, {
							role: "developer",
							round,
							transcriptPath: devTranscript,
							signal,
						});
						stopSpinner();
						devBlock = extractJsonBlock(devRun.text, "---DEV-JSON---", "---END-DEV-JSON---");
					}
				}
				const devHandoff: Handoff = {
					timestamp: new Date().toISOString(),
					role: "developer",
					round,
					sessionId: devSession,
					summary: devBlock?.summary ?? "(no structured summary)",
					filesChanged: devBlock?.filesChanged,
					howToVerify: devBlock?.howToVerify,
					raw: devRun.text,
				};
				writeHandoff(cwd, slug, devHandoff);

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
				const testerTask =
					`Judge whether the work in ${cwd} satisfies this task: ${state.task}\n\n${verifyInfo}\n\n` +
					`Read the changed files to confirm the change actually fulfills the task intent (not just that ` +
					`a command exited 0 — watch for cheats like hardcoding or editing tests). Then emit your VERDICT line.`;
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
				const testRun = await runAgent(tester, testerTask, cwd, {
					role: "tester",
					round,
					transcriptPath: testTranscript,
					signal,
				});
				stopSpinner();
				const { successState: judged, parsedFrom } = parseVerdict(testRun.text);

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

				const summaryLine =
					testRun.text
						.split("\n")
						.map((l) => l.trim())
						.filter((l) => l && !/^VERDICT:/i.test(l))[0] ?? "(no summary)";
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
					raw: testRun.text,
				};
				writeHandoff(cwd, slug, testHandoff);
				appendLog(cwd, slug, { type: "verdict", round, successState, verifyExit, parsedFrom });
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

					if (preShipGates.length) {
						const preShipCommandGates = preShipGates.filter((gate) => gate.kind === "command" && gate.command);
						const preShipJudgeGates = preShipGates.filter((gate) => gate.kind === "judge" && gate.agent);
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
							try {
								const reviewAgent = loadAgent(reviewerAgentName);
								reviewRun = await runAgent(
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
									{ role: "tester", round, transcriptPath: reviewTranscript, signal },
								);
							} catch (error) {
								reviewRun = { text: `Reviewer gate "${gate.name}" could not run: ${String(error)}`, exitCode: 1, stderr: String(error) };
							} finally {
								stopSpinner();
							}

							const parsedReview = parseReviewVerdict(reviewRun.text);
							const review: ReviewVerdict =
								reviewRun.exitCode === 0 || parsedReview.decision === "request-changes" ? parsedReview : { ...parsedReview, decision: "unknown" };
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
								raw: reviewRun.text || `(no reviewer output; stderr: ${reviewRun.stderr})`,
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
							});
							state.lastReviewedHandoffCount = listHandoffs(cwd, slug).length;
							writeState(cwd, state);

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
								// a flaky parse. Proceed to Gate 2 flagged so the founder makes the ship decision.
								preShipSummaryLines.push("  ⚠ Reviewer output was inconclusive; inspect the [reviewer] handoff before approving ship.");
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

					// ---- GATE 2: SHIP APPROVAL (verification passed; founder OKs before done) ----
					state.state = "awaiting_ship";
					writeState(cwd, state);
					appendLog(cwd, slug, { type: "gate2_awaiting", round, preShipSummary: preShipSummaryLines.length ? preShipSummaryLines : undefined });
					const preShipSummary = preShipSummaryLines.length ? `Pre-ship checks:\n${preShipSummaryLines.join("\n")}\n` : "";
					emit(
						`\n=== GATE 2 / SHIP — approval needed (round ${round}) ===\n` +
							`Verification passed and the tester judged the work satisfies: ${state.task}\n` +
							`Summary: ${testHandoff.summary}\n` +
							preShipSummary +
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
