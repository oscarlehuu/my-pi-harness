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
import { StringEnum } from "@earendil-works/pi-ai";
import {
	type Handoff,
	type LedgerState,
	type SuccessState,
	appendLog,
	findResumable,
	initLedger,
	listHandoffs,
	readState,
	taskDir,
	writeHandoff,
	writeState,
} from "./ledger.ts";

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
async function runAgent(agent: AgentDef, task: string, cwd: string, signal?: AbortSignal): Promise<RunResult> {
	const args = ["--mode", "json", "-p", "--no-session"];
	if (agent.model) args.push("--model", agent.model);
	if (agent.tools?.length) args.push("--tools", agent.tools.join(","));

	let tmpDir: string | null = null;
	if (agent.systemPrompt.trim()) {
		tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-loop-"));
		const pf = path.join(tmpDir, `prompt-${agent.name}.md`);
		await fs.promises.writeFile(pf, agent.systemPrompt, { mode: 0o600 });
		args.push("--append-system-prompt", pf);
	}
	args.push(`Task: ${task}`);

	const texts: string[] = [];
	let stderr = "";
	const exitCode = await new Promise<number>((resolve) => {
		const inv = piInvocation(args);
		const proc = spawn(inv.command, inv.args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
		let buffer = "";
		const onLine = (line: string) => {
			if (!line.trim()) return;
			let ev: any;
			try {
				ev = JSON.parse(line);
			} catch {
				return;
			}
			if (ev.type === "message_end" && ev.message?.role === "assistant") {
				for (const c of ev.message.content ?? []) if (c.type === "text") texts.push(c.text);
			}
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
		proc.on("close", (code) => resolve(code ?? 0));
		proc.on("error", () => resolve(1));
		if (signal) signal.addEventListener("abort", () => proc.kill("SIGTERM"));
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
		approve: { type: "boolean", description: "Approve the current gate (plan at start, ship after success) and continue." },
		reject: { type: "string", description: "Reject the current gate with feedback; the task is halted for revision." },
	},
	required: [],
} as const;

export default function (pi: ExtensionAPI) {
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
			"or revise with { resume: true, reject: '<feedback>' }. Drives the developer + tester crew agents",
			"(the CTO can also use scout via the subagent tool for recon before starting a task).",
		].join(" "),
		parameters: LoopParams as any,

		async execute(_id: string, params: any, signal: AbortSignal, onUpdate: any, ctx: any) {
			const cwd: string = params.cwd ?? ctx.cwd;
			const maxRounds: number = params.maxRounds ?? 3;

			let state: LedgerState;
			if (params.resume) {
				const found = findResumable(cwd);
				if (!found) {
					return { content: [{ type: "text", text: "No resumable task found in this repo." }] };
				}
				state = found;
			} else {
				if (!params.task) {
					return { content: [{ type: "text", text: "Provide `task` to start, or `resume: true`." }] };
				}
				state = initLedger(cwd, params.task, maxRounds, params.verifyCommand);
			}

			const slug = state.slug;
			const developer = loadAgent("developer");
			const tester = loadAgent("tester");
			const transcript: string[] = [];
			const emit = (line: string) => {
				transcript.push(line);
				onUpdate?.({ content: [{ type: "text", text: transcript.join("\n") }] });
			};
			const done = () => ({ content: [{ type: "text", text: transcript.join("\n") }] });
			const verifyCommand = state.verifyCommand ?? params.verifyCommand;

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
				const devRun = await runAgent(developer, devContext, cwd, signal);
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
				if (verifyCmd) {
					emit(`Round ${round}: verify \`${verifyCmd}\`...`);
					const v = await runVerify(verifyCmd, cwd, signal);
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
				const testRun = await runAgent(tester, testerTask, cwd, signal);
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

				emit(`Round ${round}: ${successState.toUpperCase()} (verify exit=${verifyExit ?? "n/a"}) — ${testHandoff.summary}`);

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
