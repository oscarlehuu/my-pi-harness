/**
 * Generic Foreman gate pipeline engine.
 *
 * Pure / node-builtin-only so projects can unit-test gate resolution and command execution
 * headlessly. The engine is intentionally dumb: it validates declared gate shape and runs command
 * gates in order, but it does not assign domain meaning to names like "unit", "e2e", or "mobile".
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export type GateKind = "command" | "judge" | "action";
export type GateStage = "per-round" | "pre-ship" | "release";

export interface Gate {
	name: string;
	kind: GateKind;
	stage: GateStage;
	command?: string;
	agent?: string;
	action?: string;
	/** Optional pathspec override for release action gates such as `commit`. */
	paths?: string[];
}

export type RequirementCategory = "env" | "tools" | "services";

export interface Requirement {
	name: string;
	reason?: string;
}

export interface TaskRequirements {
	env: Requirement[];
	tools: Requirement[];
	services: Requirement[];
}

export interface CommandGateResult {
	name: string;
	command: string;
	exitCode: number;
	output: string;
}

export interface CommandGateRunResult {
	passed: boolean;
	results: CommandGateResult[];
}

const OUTPUT_TAIL_CHARS = 8000;
const VALID_KINDS = new Set<GateKind>(["command", "judge", "action"]);
const VALID_STAGES = new Set<GateStage>(["per-round", "pre-ship", "release"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isGateKind(value: unknown): value is GateKind {
	return typeof value === "string" && VALID_KINDS.has(value as GateKind);
}

function isGateStage(value: unknown): value is GateStage {
	return typeof value === "string" && VALID_STAGES.has(value as GateStage);
}

function normalizePaths(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const paths = value.filter(isNonEmptyString).map((p) => p.trim()).filter(Boolean);
	return paths.length ? paths : undefined;
}

function emptyRequirements(): TaskRequirements {
	return { env: [], tools: [], services: [] };
}

export function normalizeRequirement(value: unknown): Requirement | null {
	if (!isRecord(value) || !isNonEmptyString(value.name)) return null;
	const name = value.name.trim();
	const reason = isNonEmptyString(value.reason) ? value.reason.trim() : undefined;
	return reason ? { name, reason } : { name };
}

export function normalizeRequirements(value: unknown): TaskRequirements {
	if (!isRecord(value)) return emptyRequirements();
	return {
		env: Array.isArray(value.env) ? value.env.map(normalizeRequirement).filter((requirement): requirement is Requirement => requirement !== null) : [],
		tools: Array.isArray(value.tools) ? value.tools.map(normalizeRequirement).filter((requirement): requirement is Requirement => requirement !== null) : [],
		services: Array.isArray(value.services) ? value.services.map(normalizeRequirement).filter((requirement): requirement is Requirement => requirement !== null) : [],
	};
}

export function requirementsEmpty(requirements: TaskRequirements): boolean {
	return requirements.env.length === 0 && requirements.tools.length === 0 && requirements.services.length === 0;
}

function normalizeGate(value: unknown): Gate | null {
	if (!isRecord(value)) return null;
	const { name, kind, stage } = value;
	if (!isNonEmptyString(name) || !isGateKind(kind) || !isGateStage(stage)) return null;

	if (kind === "command") {
		if (!isNonEmptyString(value.command)) return null;
		return { name, kind, stage, command: value.command };
	}
	if (kind === "judge") {
		if (!isNonEmptyString(value.agent)) return null;
		return { name, kind, stage, agent: value.agent };
	}
	if (!isNonEmptyString(value.action)) return null;
	const paths = normalizePaths(value.paths);
	return paths ? { name, kind, stage, action: value.action, paths } : { name, kind, stage, action: value.action };
}

/**
 * Resolve the ordered gate declaration for a repo.
 *
 * Backward compatibility: when no .pi/foreman.json exists, a legacy verifyCommand becomes the
 * single per-round command gate named "verify". If the file exists but is malformed, only valid
 * entries are returned (bad JSON returns []) and no legacy fallback is synthesized.
 */
export function loadGates(cwd: string, fallbackVerifyCommand?: string): Gate[] {
	const configPath = path.join(cwd, ".pi", "foreman.json");
	if (!fs.existsSync(configPath)) {
		return isNonEmptyString(fallbackVerifyCommand)
			? [{ name: "verify", kind: "command", stage: "per-round", command: fallbackVerifyCommand }]
			: [];
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(configPath, "utf-8"));
	} catch {
		return [];
	}

	if (!isRecord(parsed) || !Array.isArray(parsed.gates)) return [];
	return parsed.gates.map(normalizeGate).filter((gate): gate is Gate => gate !== null);
}

export function loadRequirements(cwd: string): TaskRequirements {
	const configPath = path.join(cwd, ".pi", "foreman.json");
	if (!fs.existsSync(configPath)) return emptyRequirements();

	try {
		const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8"));
		return isRecord(parsed) ? normalizeRequirements(parsed.requirements) : emptyRequirements();
	} catch {
		return emptyRequirements();
	}
}

export function gatesForStage(gates: Gate[], stage: GateStage): Gate[] {
	return gates.filter((gate) => gate.stage === stage);
}

export function hasStage(gates: Gate[], stage: GateStage): boolean {
	return gates.some((gate) => gate.stage === stage);
}

function tailOutput(output: string): string {
	return output.length > OUTPUT_TAIL_CHARS ? output.slice(-OUTPUT_TAIL_CHARS) : output;
}

function runOneCommandGate(gate: Gate, cwd: string, signal?: AbortSignal): Promise<CommandGateResult> {
	const command = gate.command ?? "";
	return new Promise((resolve) => {
		if (signal?.aborted) {
			resolve({ name: gate.name, command, exitCode: 1, output: "Aborted before command started." });
			return;
		}

		let output = "";
		let settled = false;
		let proc: ReturnType<typeof spawn>;
		const finish = (exitCode: number, extraOutput = "") => {
			if (settled) return;
			settled = true;
			if (extraOutput) output += extraOutput;
			resolve({ name: gate.name, command, exitCode, output: tailOutput(output) });
		};

		try {
			proc = spawn(command, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"] });
		} catch (error) {
			finish(1, String(error));
			return;
		}

		const onData = (data: Buffer) => {
			output += data.toString();
			// Keep memory bounded while still preserving the final tail returned to callers.
			if (output.length > OUTPUT_TAIL_CHARS * 2) output = output.slice(-OUTPUT_TAIL_CHARS);
		};
		proc.stdout.on("data", onData);
		proc.stderr.on("data", onData);
		proc.on("close", (code) => finish(code ?? (signal?.aborted ? 1 : 0)));
		proc.on("error", (error) => finish(1, String(error)));
		if (signal) signal.addEventListener("abort", () => proc.kill("SIGTERM"), { once: true });
	});
}

/**
 * Run all command-kind gates for a stage in declaration order.
 *
 * Deliberately does NOT stop on first failure: later gate output can be useful diagnostic context.
 * A non-zero exit from any gate makes the aggregate result fail; command exit code remains the
 * source of truth.
 */
export async function runCommandGates(
	gates: Gate[],
	stage: GateStage,
	cwd: string,
	signal?: AbortSignal,
): Promise<CommandGateRunResult> {
	const commandGates = gatesForStage(gates, stage).filter((gate) => gate.kind === "command" && isNonEmptyString(gate.command));
	const results: CommandGateResult[] = [];
	for (const gate of commandGates) {
		results.push(await runOneCommandGate(gate, cwd, signal));
		if (signal?.aborted) break;
	}
	return {
		passed: results.length === commandGates.length && results.every((result) => result.exitCode === 0),
		results,
	};
}
