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
		resume: { type: "boolean", description: "Resume an in-progress task in this repo instead of starting new." },
	},
	required: [],
} as const;

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "loop",
		label: "Dev-Test-Fix Loop",
		description: [
			"Run a DETERMINISTIC developer->tester->fix loop on a task, with a hard round cap and an",
			"on-disk ledger (.pi/plans/<task>/) for resume. The tester emits a 3-valued verdict",
			"(success/partial/blocked/fail); on 'fail' the controller feeds the verdict back to the",
			"developer and retries until success or maxRounds. Use { resume: true } to continue an",
			"interrupted task. Reuses the crew agents (developer, tester).",
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
				state = initLedger(cwd, params.task, maxRounds);
			}

			const slug = state.slug;
			const developer = loadAgent("developer");
			const tester = loadAgent("tester");
			const transcript: string[] = [];
			const emit = (line: string) => {
				transcript.push(line);
				onUpdate?.({ content: [{ type: "text", text: transcript.join("\n") }] });
			};

			emit(`Loop: "${state.task}" (slug=${slug}, maxRounds=${state.maxRounds})`);

			let devContext = `Implement this task in ${cwd}:\n${state.task}`;
			if (params.verifyCommand) devContext += `\n\nVerify with: ${params.verifyCommand}`;

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

				// ---- TESTER ----
				emit(`Round ${round}: tester...`);
				const verifyCmd = params.verifyCommand ?? devBlock?.howToVerify ?? "(infer the project's test command)";
				const testerTask = `Verify the work in ${cwd} for task: ${state.task}\nRun: ${verifyCmd}\nThen emit your verdict block.`;
				const testSession = randomUUID();
				const testRun = await runAgent(tester, testerTask, cwd, signal);

				// Decision #11: controller ALWAYS writes a handoff. Parse the `VERDICT: <STATE>` token.
				const { successState, parsedFrom } = parseVerdict(testRun.text);
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
					raw: testRun.text,
				};
				writeHandoff(cwd, slug, testHandoff);
				appendLog(cwd, slug, { type: "verdict_parsed", round, parsedFrom });
				state.lastReviewedHandoffCount = listHandoffs(cwd, slug).length;
				writeState(cwd, state);

				emit(`Round ${round}: verdict = ${successState.toUpperCase()} — ${testHandoff.summary}`);

				// ---- DECIDE ----
				if (successState === "success") {
					state.state = "done";
					writeState(cwd, state);
					appendLog(cwd, slug, { type: "task_done", round });
					emit(`DONE in ${round} round(s). Ledger: ${path.relative(cwd, taskDir(cwd, slug))}`);
					return { content: [{ type: "text", text: transcript.join("\n") }] };
				}
				if (successState === "partial" || successState === "blocked") {
					state.state = "escalated";
					writeState(cwd, state);
					appendLog(cwd, slug, { type: "escalated", round, successState });
					emit(`ESCALATED (${successState}). Founder input needed. See ${path.relative(cwd, taskDir(cwd, slug))}.`);
					return { content: [{ type: "text", text: transcript.join("\n") }] };
				}
				// fail -> feed the tester's full verdict text back to developer for next round
				devContext =
					`Continue task in ${cwd}: ${state.task}\n\n` +
					`The tester returned FAIL on round ${round}. Fix ONLY what it points to:\n\n` +
					testHandoff.raw.slice(0, 2000);
			}

			// rounds exhausted
			state.state = "escalated";
			writeState(cwd, state);
			appendLog(cwd, slug, { type: "rounds_exhausted", round: state.maxRounds });
			emit(`STOPPED after ${state.maxRounds} rounds without success. Escalating to founder.`);
			return { content: [{ type: "text", text: transcript.join("\n") }] };
		},
	});
}
