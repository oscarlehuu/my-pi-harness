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
import {
	type Handoff,
	type LedgerState,
	type SuccessState,
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

type AgentRole = "developer" | "tester";

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
	fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
	fs.writeFileSync(transcriptPath, "", { flag: "a" });
	let written = fs.statSync(transcriptPath).size;
	return (event) => {
		if (written >= PER_TASK_OUTPUT_CAP) return;
		const line = `${JSON.stringify({ t: new Date().toISOString(), ...event })}\n`;
		const lineBytes = byteLength(line);
		if (written + lineBytes > PER_TASK_OUTPUT_CAP) return;
		fs.appendFileSync(transcriptPath, line);
		written += lineBytes;
	};
}

function transcriptFilePath(cwd: string, slug: string, role: AgentRole, round: number, sessionId: string): string {
	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	const fpath = path.join(transcriptsDir(cwd, slug), `${ts}__${role}-r${round}__${sessionId}.jsonl`);
	fs.mkdirSync(path.dirname(fpath), { recursive: true });
	fs.writeFileSync(fpath, "", { flag: "a" });
	return fpath;
}

/** Run the verify command directly. Exit code is GROUND TRUTH for pass/fail (decision B). */
function runVerify(command: string, cwd: string, signal?: AbortSignal): Promise<{ exitCode: number; output: string }> {
	return new Promise((resolve) => {
		const proc = spawn(command, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"] });
		let output = "";
		proc.stdout.on("data", (d) => {
			output += d.toString();
		});
		proc.stderr.on("data", (d) => {
			output += d.toString();
		});
		proc.on("close", (code) => resolve({ exitCode: code ?? 0, output: output.slice(-8000) }));
		proc.on("error", (e) => resolve({ exitCode: 1, output: String(e) }));
		if (signal) signal.addEventListener("abort", () => proc.kill("SIGTERM"));
	});
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
		const proc = spawn(inv.command, inv.args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
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

const LoopParams = {
	type: "object",
	properties: {
		task: { type: "string", description: "The task for the developer to implement." },
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

export default function (pi: ExtensionAPI) {
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
				state = initLedger(cwd, params.task, maxRounds, params.verifyCommand, sessionId);
			}

			const slug = state.slug;
			const developer = loadAgent("developer");
			const tester = loadAgent("tester");
			const transcript: string[] = [];
			const emit = (line: string) => {
				transcript.push(line);
				onUpdate?.({ content: [{ type: "text", text: transcript.join("\n") }] });
			};
			const verifyCommand = state.verifyCommand ?? params.verifyCommand;

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
					state.gate1Approved = true;
					state.state = "in_progress";
					writeState(cwd, state);
					appendLog(cwd, slug, { type: "gate1_approved" });
					emit("Plan approved. Starting dev->test->fix rounds.");
				} else {
					const plan = [
						`# Plan: ${state.task}`,
						"",
						`- Working directory: ${cwd}`,
						`- Verify command: ${verifyCommand ?? "(developer/tester will infer the project's tests)"}`,
						`- Developer: ${developer.model ?? "default"} implements; controller runs verify (exit code = ground truth).`,
						`- Tester: ${tester.model ?? "default"} judges intent and catches cheats.`,
						`- Up to ${state.maxRounds} fix rounds, then escalate.`,
						"",
					].join("\n");
					fs.writeFileSync(path.join(taskDir(cwd, slug), "plan.md"), `${plan}\n`);
					state.state = "planning";
					writeState(cwd, state);
					appendLog(cwd, slug, { type: "gate1_awaiting" });
					emit(
						`\n=== GATE 1 / PLAN — approval needed ===\n${plan}\n` +
							`Approve:  foreman({ resume: true, approve: true })\n` +
							`Revise:   foreman({ resume: true, reject: "<what to change>" })`,
					);
					return done();
				}
			}

			let devContext = `Implement this task in ${cwd}:\n${state.task}`;
			if (verifyCommand) devContext += `\n\nVerify with: ${verifyCommand}`;

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
				const devRun = await runAgent(developer, devContext, cwd, {
					role: "developer",
					round,
					transcriptPath: devTranscript,
					signal,
				});
				stopSpinner();
				const devBlock = extractJsonBlock(devRun.text, "---DEV-JSON---", "---END-DEV-JSON---");
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

				// ---- VERIFY (controller runs it; exit code = GROUND TRUTH) ----
				const verifyCmd: string | undefined = verifyCommand ?? devBlock?.howToVerify;
				let verifyExit: number | null = null;
				let verifyOutput = "";
				writeActivity(cwd, slug, {
					round,
					phase: "verify",
					activeTranscript: null,
					note: verifyCmd ? `running ${verifyCmd}` : "skipped (no verify command)",
					pid: process.pid,
					ownerSessionId: sessionId,
				});
				pushStatus();
				if (verifyCmd) {
					emit(`Round ${round}: verify \`${verifyCmd}\`...`);
					startSpinner();
					const v = await runVerify(verifyCmd, cwd, signal);
					stopSpinner();
					verifyExit = v.exitCode;
					verifyOutput = v.output;
					appendLog(cwd, slug, { type: "verify_ran", round, command: verifyCmd, exitCode: verifyExit });
				}

				// ---- TESTER (judges intent; cannot override a non-zero exit into success) ----
				emit(`Round ${round}: tester...`);
				const verifyInfo =
					verifyExit === null
						? "No verify command was provided; run the project's tests yourself to check."
						: `The verify command \`${verifyCmd}\` already ran. Exit code: ${verifyExit} (0 = passed).\nOutput:\n${verifyOutput.slice(-3000)}`;
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
					// command passed; tester may still flag fail/partial/blocked on intent grounds
					successState = judged === "success" || parsedFrom === "no-verdict-token" ? "success" : judged;
				} else {
					// no verify command ran; rely on tester judgment
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
					verification: verifyExit === null ? undefined : { commandsRun: [{ command: verifyCmd!, exitCode: verifyExit, observation: verifyOutput.slice(-500) }] },
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
					// ---- GATE 2: SHIP APPROVAL (verification passed; founder OKs before done) ----
					state.state = "awaiting_ship";
					writeState(cwd, state);
					appendLog(cwd, slug, { type: "gate2_awaiting", round });
					emit(
						`\n=== GATE 2 / SHIP — approval needed (round ${round}) ===\n` +
							`Verification passed and the tester judged the work satisfies: ${state.task}\n` +
							`Summary: ${testHandoff.summary}\n` +
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
				// fail -> feed verify output + tester diagnosis back to developer for next round
				devContext =
					`Continue task in ${cwd}: ${state.task}\n\n` +
					`Round ${round} FAILED.` +
					(verifyExit !== null ? ` Verify \`${verifyCmd}\` exited ${verifyExit}.\nOutput:\n${verifyOutput.slice(-1500)}\n\n` : "\n\n") +
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
