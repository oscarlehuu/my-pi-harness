/**
 * Gate 1 planner helpers.
 *
 * Pure / node-builtin-only: validates the planner agent's PLAN-JSON block, builds the deterministic
 * fallback plan, renders the founder-facing markdown, and decides whether a proposed .pi/foreman.json
 * should be written after Gate 1 approval. No filesystem or pi imports live here so this stays
 * headlessly unit-testable.
 */

import type { Gate, GateKind, GateStage } from "./gates.ts";

export const PLAN_JSON_START = "---PLAN-JSON---";
export const PLAN_JSON_END = "---END-PLAN-JSON---";

export type PlannerSource = "planner" | "fallback" | "persisted";

export interface ForemanManifest {
	gates: Gate[];
}

export interface PlannerPlan {
	summary: string;
	steps: string[];
	filesLikely: string[];
	risks: string[];
	proposedGates: Gate[];
}

export interface PlannerContext {
	task: string;
	cwd: string;
	track: "backend" | "frontend" | string;
	maxRounds: number;
	verifyCommand?: string;
	developerLabel?: string;
	developerModel?: string;
	testerModel?: string;
	manifestExists?: boolean;
	existingGates?: Gate[];
	plannerSource?: PlannerSource;
	/** True only for a valid parsed planner PLAN-JSON; fallback/template plans must pass false. */
	manifestWriteEligible?: boolean;
}

export type PlannerTimeoutReason = "idle" | "max";

export interface PlannerTimeoutDecision {
	abort: boolean;
	reason: PlannerTimeoutReason | null;
}

export interface PlannerTimeouts {
	idleMs: number;
	maxMs: number;
}

export type PlannerTimeoutEnv = Record<string, string | undefined>;

export interface ManifestDecision {
	shouldWrite: boolean;
	reason: string;
	manifest?: ForemanManifest;
}

const VALID_KINDS = new Set<GateKind>(["command", "judge", "action"]);
const VALID_STAGES = new Set<GateStage>(["per-round", "pre-ship", "release"]);
const DEFAULT_PLANNER_IDLE_MS = 90_000;
const DEFAULT_PLANNER_MAX_MS = 300_000;
const MIN_PLANNER_IDLE_MS = 1_000;

function parsePlannerTimeoutMs(value: string | undefined, fallback: number): number {
	if (value == null || value.trim() === "") return fallback;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? Math.floor(parsed) : fallback;
}

export function resolvePlannerTimeouts(env: PlannerTimeoutEnv): PlannerTimeouts {
	const idleSource = env.FOREMAN_PLANNER_IDLE_MS ?? env.FOREMAN_PLANNER_TIMEOUT_MS;
	const idleMs = Math.max(MIN_PLANNER_IDLE_MS, parsePlannerTimeoutMs(idleSource, DEFAULT_PLANNER_IDLE_MS));
	const requestedMaxMs = parsePlannerTimeoutMs(env.FOREMAN_PLANNER_MAX_MS, DEFAULT_PLANNER_MAX_MS);
	const maxMs = Math.max(idleMs, requestedMaxMs);
	return { idleMs, maxMs };
}

/**
 * Decide whether the planner should be aborted. If both limits are exceeded, the absolute max
 * backstop wins over the idle limit so a pathological long run is reported as "max".
 */
export function decidePlannerTimeout(input: {
	now: number;
	startedAt: number;
	lastActivityAt: number;
	idleMs: number;
	maxMs: number;
}): PlannerTimeoutDecision {
	if (input.now - input.startedAt >= input.maxMs) return { abort: true, reason: "max" };
	if (input.now - input.lastActivityAt >= input.idleMs) return { abort: true, reason: "idle" };
	return { abort: false, reason: null };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function cleanString(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function cleanStringList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter(isNonEmptyString).map(cleanString).filter(Boolean);
}

function isGateKind(value: unknown): value is GateKind {
	return typeof value === "string" && VALID_KINDS.has(value as GateKind);
}

function isGateStage(value: unknown): value is GateStage {
	return typeof value === "string" && VALID_STAGES.has(value as GateStage);
}

export function normalizePlannerGate(value: unknown): Gate | null {
	if (!isRecord(value)) return null;
	const { name, kind, stage } = value;
	if (!isNonEmptyString(name) || !isGateKind(kind) || !isGateStage(stage)) return null;

	if (kind === "command") {
		if (!isNonEmptyString(value.command)) return null;
		return { name: cleanString(name), kind, stage, command: value.command.trim() };
	}
	if (kind === "judge") {
		if (!isNonEmptyString(value.agent)) return null;
		return { name: cleanString(name), kind, stage, agent: value.agent.trim() };
	}
	if (!isNonEmptyString(value.action)) return null;
	return { name: cleanString(name), kind, stage, action: value.action.trim() };
}

export function normalizePlannerGates(value: unknown): Gate[] {
	if (!Array.isArray(value)) return [];
	return value.map(normalizePlannerGate).filter((gate): gate is Gate => gate !== null);
}

/** Validate untrusted planner JSON. Invalid gates are dropped; invalid core fields reject the plan. */
export function validatePlannerPlan(value: unknown): PlannerPlan | null {
	if (!isRecord(value) || !isNonEmptyString(value.summary)) return null;
	if (!Array.isArray(value.steps) || !Array.isArray(value.filesLikely) || !Array.isArray(value.risks) || !Array.isArray(value.proposedGates)) {
		return null;
	}

	const steps = cleanStringList(value.steps);
	if (!steps.length) return null;

	return {
		summary: cleanString(value.summary),
		steps,
		filesLikely: cleanStringList(value.filesLikely),
		risks: cleanStringList(value.risks),
		proposedGates: normalizePlannerGates(value.proposedGates),
	};
}

export function parsePlannerPlanJson(text: string): PlannerPlan | null {
	const start = text.indexOf(PLAN_JSON_START);
	const end = text.indexOf(PLAN_JSON_END);
	if (start === -1 || end === -1 || end < start) return null;
	try {
		return validatePlannerPlan(JSON.parse(text.slice(start + PLAN_JSON_START.length, end).trim()));
	} catch {
		return null;
	}
}

export function serializePlannerPlan(plan: PlannerPlan): string {
	return JSON.stringify(plan, null, 2);
}

export function fallbackPlannerPlan(context: PlannerContext): PlannerPlan {
	const gates = context.existingGates?.length
		? context.existingGates
		: isNonEmptyString(context.verifyCommand)
			? [{ name: "verify", kind: "command", stage: "per-round", command: context.verifyCommand.trim() }]
			: [];
	const implementer = context.track === "frontend" ? "UI developer" : "Developer";
	return {
		summary: `Implement the requested task in ${context.cwd} using the ${context.track || "backend"} track, then verify it through Foreman's deterministic dev/test loop.`,
		steps: [
			"Confirm the relevant files and constraints before editing.",
			`${implementer} implements the smallest scoped change and records a structured handoff.`,
			gates.length ? "Controller runs the resolved per-round command gates and treats their exit codes as ground truth." : "No per-round command gate is declared; tester will inspect and run appropriate read-only checks.",
			"Tester judges intent, catches cheats, and sends failures back for another bounded fix round.",
			"If verification succeeds, pause at Gate 2 for founder ship approval.",
		],
		filesLikely: [],
		risks: [
			"Planner model output was unavailable or invalid, so this deterministic template plan was used.",
			"Repo-specific edge cases may still be discovered by the developer/tester loop.",
		],
		proposedGates: gates,
	};
}

export function decideManifestWrite(input: {
	manifestExists: boolean;
	proposedGates?: unknown;
	source?: PlannerSource;
	allowWrite?: boolean;
}): ManifestDecision {
	if (input.manifestExists) {
		return { shouldWrite: false, reason: "Existing .pi/foreman.json is present and will be preserved." };
	}
	const eligible = input.allowWrite ?? (input.source === "planner");
	if (!eligible) {
		return { shouldWrite: false, reason: "Planner fallback/invalid output is not eligible to create .pi/foreman.json." };
	}
	const gates = normalizePlannerGates(input.proposedGates);
	if (gates.length === 0) {
		return { shouldWrite: false, reason: "No valid proposed gates are available to write to .pi/foreman.json." };
	}
	return {
		shouldWrite: true,
		manifest: { gates },
		reason: "Will write proposed .pi/foreman.json only after Gate 1 approval.",
	};
}

function gatePayload(gate: Gate): string {
	if (gate.kind === "command") return gate.command ? ` — command: \`${gate.command}\`` : "";
	if (gate.kind === "judge") return gate.agent ? ` — agent: ${gate.agent}` : "";
	return gate.action ? ` — action: \`${gate.action}\`` : "";
}

function formatGate(gate: Gate): string {
	return `- ${gate.name} (${gate.stage} ${gate.kind})${gatePayload(gate)}`;
}

export function renderFounderPlan(plan: PlannerPlan, context: PlannerContext): string {
	const decision = decideManifestWrite({
		manifestExists: context.manifestExists === true,
		proposedGates: plan.proposedGates,
		allowWrite: context.manifestWriteEligible ?? (context.plannerSource === "planner"),
	});
	const filesLikely = plan.filesLikely.length ? plan.filesLikely.map((file) => `- \`${file}\``) : ["- (not identified by planner)"];
	const risks = plan.risks.length ? plan.risks : ["None identified yet."];
	const gates = plan.proposedGates.length ? plan.proposedGates.map(formatGate) : ["- (none proposed)"];
	const plannerSource = context.plannerSource ? ` (${context.plannerSource})` : "";
	return [
		`# Plan: ${context.task}`,
		"",
		`## Summary${plannerSource}`,
		plan.summary,
		"",
		"## Steps",
		...plan.steps.map((step, index) => `${index + 1}. ${step}`),
		"",
		"## Files likely",
		...filesLikely,
		"",
		"## Risks",
		...risks.map((risk) => `- ${risk}`),
		"",
		"## Proposed gates",
		...gates,
		"",
		"## Proposed manifest",
		`- ${decision.reason}`,
		"",
		"## Execution",
		`- Working directory: ${context.cwd}`,
		`- Track: ${context.track}${context.track === "frontend" ? " (ui-developer; auto-fallback to Opus xhigh on tool failure)" : ""}`,
		`- ${context.developerLabel ?? (context.track === "frontend" ? "UI developer" : "Developer")}: ${context.developerModel ?? "default"} implements; controller-owned gates remain ground truth.`,
		`- Tester: ${context.testerModel ?? "default"} judges intent and catches cheats.`,
		`- Up to ${context.maxRounds} fix rounds, then escalate.`,
	].join("\n");
}
