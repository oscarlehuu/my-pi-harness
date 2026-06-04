/**
 * Updater runner — spawns the `agents-memory-updater` subagent in a headless pi subprocess.
 *
 * Mirrors Foreman's `runAgent`: `pi --mode json -p --no-session --model <m> --tools <csv>
 * --append-system-prompt <file> "<task>"`, collecting the final assistant text. The append-only
 * system prompt preserves pi's Claude Code marker (Max-subscription quota, not credits).
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export interface UpdaterAgentDef {
	model?: string;
	tools?: string[];
	systemPrompt: string;
}

/** Load the updater agent markdown from this extension's crew dir (installed into ~/.pi/agent/agents). */
export function loadUpdaterAgent(): UpdaterAgentDef {
	// Prefer the installed agents dir; fall back to the in-repo crew copy for tests/dev.
	const candidates = [
		path.join(getAgentDir(), "agents", "agents-memory-updater.md"),
		path.join(import.meta.dirname ?? __dirname, "crew", "agents-memory-updater.md"),
	];
	for (const file of candidates) {
		if (!fs.existsSync(file)) continue;
		const content = fs.readFileSync(file, "utf-8");
		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
		const tools = frontmatter.tools?.split(",").map((t) => t.trim()).filter(Boolean);
		return { model: frontmatter.model, tools: tools?.length ? tools : undefined, systemPrompt: body };
	}
	throw new Error("agents-memory-updater.md not found");
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

export interface RunUpdaterResult {
	text: string;
	exitCode: number;
	stderr: string;
}

/** Spawn the updater subagent once and return its final assistant text. */
export async function runUpdater(agent: UpdaterAgentDef, task: string, cwd: string, signal?: AbortSignal): Promise<RunUpdaterResult> {
	const args = ["--mode", "json", "-p", "--no-session"];
	if (agent.model) args.push("--model", agent.model);
	if (agent.tools?.length) args.push("--tools", agent.tools.join(","));

	let tmpDir: string | null = null;
	if (agent.systemPrompt.trim()) {
		tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "continual-learning-"));
		const pf = path.join(tmpDir, "updater-prompt.md");
		await fs.promises.writeFile(pf, agent.systemPrompt, { mode: 0o600 });
		args.push("--append-system-prompt", pf);
	}
	args.push(task);

	const texts: string[] = [];
	let stderr = "";
	try {
		const exitCode = await new Promise<number>((resolve) => {
			const inv = piInvocation(args);
			const proc = spawn(inv.command, inv.args, {
				cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				// Mark the child as crew so a Foreman tool_call guard in the same repo won't gate its edits.
				env: { ...process.env, FOREMAN_CREW: "1", CONTINUAL_LEARNING_CREW: "1" },
			});
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
					for (const block of ev.message.content ?? []) {
						if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
					}
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
			proc.on("close", (code) => {
				if (buffer.trim()) onLine(buffer);
				resolve(code ?? 0);
			});
			proc.on("error", () => resolve(1));
			if (signal) signal.addEventListener("abort", () => proc.kill("SIGTERM"), { once: true });
		});
		return { text: texts.join("\n").trim(), exitCode, stderr };
	} finally {
		if (tmpDir) await fs.promises.rm(tmpDir, { recursive: true, force: true });
	}
}
