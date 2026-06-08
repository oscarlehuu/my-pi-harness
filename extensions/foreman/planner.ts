/**
 * Gate 1 planner helpers.
 *
 * Pure / node-builtin-only: validates the planner agent's PLAN-JSON block, builds the deterministic
 * fallback plan, renders the founder-facing markdown, and decides whether a proposed .pi/foreman.json
 * should be written after Gate 1 approval. No filesystem or pi imports live here so this stays
 * headlessly unit-testable.
 */

import {
	normalizeRequirements,
	requirementsEmpty,
	type Gate,
	type GateKind,
	type GateStage,
	type RequirementCategory,
	type TaskRequirements,
} from "./gates.ts";
import {
	decideAgentTimeout,
	resolveAgentTimeouts,
	type AgentTimeoutDecision,
	type AgentTimeoutEnv,
	type AgentTimeoutReason,
	type AgentTimeouts,
} from "./agent-timeouts.ts";

export const PLAN_JSON_START = "---PLAN-JSON---";
export const PLAN_JSON_END = "---END-PLAN-JSON---";

export type PlannerSource = "planner" | "fallback" | "persisted";

export interface ForemanManifest {
	gates: Gate[];
	requirements?: TaskRequirements;
}

export interface PlannerPlan {
	summary: string;
	steps: string[];
	filesLikely: string[];
	risks: string[];
	proposedGates: Gate[];
	requirements: TaskRequirements;
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
	requirementChecks?: RequirementCheck[];
}

export type Presence = "present" | "missing" | "unknown";

export interface RequirementCheck {
	category: RequirementCategory;
	name: string;
	reason?: string;
	presence: Presence;
}

export type PlannerTimeoutReason = AgentTimeoutReason;
export type PlannerTimeoutDecision = AgentTimeoutDecision;
export type PlannerTimeouts = AgentTimeouts;
export type PlannerTimeoutEnv = AgentTimeoutEnv;

export interface ManifestDecision {
	shouldWrite: boolean;
	reason: string;
	manifest?: ForemanManifest;
}

const VALID_KINDS = new Set<GateKind>(["command", "judge", "action"]);
const VALID_STAGES = new Set<GateStage>(["per-round", "pre-ship", "release"]);
const REQUIREMENT_CATEGORIES: RequirementCategory[] = ["env", "tools", "services"];
export function resolvePlannerTimeouts(env: PlannerTimeoutEnv): PlannerTimeouts {
	return resolveAgentTimeouts(env, "planner");
}

/** Backward-compatible planner alias for the generalized crew timeout decision. */
export function decidePlannerTimeout(input: {
	now: number;
	startedAt: number;
	lastActivityAt: number;
	idleMs: number;
	maxMs: number;
}): PlannerTimeoutDecision {
	return decideAgentTimeout(input);
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
		requirements: normalizeRequirements(value.requirements),
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
		requirements: normalizeRequirements(undefined),
	};
}

export function decideManifestWrite(input: {
	manifestExists: boolean;
	proposedGates?: unknown;
	requirements?: unknown;
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
	const requirements = normalizeRequirements(input.requirements);
	const hasRequirements = !requirementsEmpty(requirements);
	if (gates.length === 0 && !hasRequirements) {
		return { shouldWrite: false, reason: "No valid proposed gates or requirements are available to write to .pi/foreman.json." };
	}
	return {
		shouldWrite: true,
		manifest: { gates, ...(hasRequirements ? { requirements } : {}) },
		reason: "Will write proposed .pi/foreman.json gates/requirements only after Gate 1 approval.",
	};
}

export function evaluateRequirementPresence(input: {
	requirements: TaskRequirements;
	env: Record<string, string | undefined>;
	toolPresent: (name: string) => boolean;
}): RequirementCheck[] {
	const requirements = normalizeRequirements(input.requirements);
	return REQUIREMENT_CATEGORIES.flatMap((category) =>
		requirements[category].map((requirement) => {
			let presence: Presence;
			if (category === "env") {
				presence = isNonEmptyString(input.env[requirement.name]) ? "present" : "missing";
			} else if (category === "tools") {
				presence = input.toolPresent(requirement.name) ? "present" : "missing";
			} else {
				presence = "unknown";
			}
			return { category, name: requirement.name, reason: requirement.reason, presence };
		}),
	);
}

export function summarizeRequirementChecks(checks: RequirementCheck[]): {
	present: RequirementCheck[];
	missing: RequirementCheck[];
	unknown: RequirementCheck[];
	hasGaps: boolean;
} {
	const present = checks.filter((check) => check.presence === "present");
	const missing = checks.filter((check) => check.presence === "missing");
	const unknown = checks.filter((check) => check.presence === "unknown");
	return { present, missing, unknown, hasGaps: missing.length > 0 || unknown.length > 0 };
}

function gatePayload(gate: Gate): string {
	if (gate.kind === "command") return gate.command ? ` — command: \`${gate.command}\`` : "";
	if (gate.kind === "judge") return gate.agent ? ` — agent: ${gate.agent}` : "";
	return gate.action ? ` — action: \`${gate.action}\`` : "";
}

function formatGate(gate: Gate): string {
	return `- ${gate.name} (${gate.stage} ${gate.kind})${gatePayload(gate)}`;
}

function categoryHeading(category: RequirementCategory): string {
	if (category === "env") return "Env vars/secrets";
	if (category === "tools") return "CLI tools/binaries";
	return "Services/runtimes";
}

function presenceMarker(presence: Presence): string {
	if (presence === "present") return "✓";
	if (presence === "missing") return "✗";
	return "?";
}

function unknownRequirementChecks(requirements: TaskRequirements): RequirementCheck[] {
	const normalized = normalizeRequirements(requirements);
	return REQUIREMENT_CATEGORIES.flatMap((category) =>
		normalized[category].map((requirement) => ({
			category,
			name: requirement.name,
			reason: requirement.reason,
			presence: "unknown" as const,
		})),
	);
}

function renderRequirementChecks(checks: RequirementCheck[]): string[] {
	if (!checks.length) return ["- (none detected)"];
	const lines: string[] = [];
	for (const category of REQUIREMENT_CATEGORIES) {
		const categoryChecks = checks.filter((check) => check.category === category);
		if (!categoryChecks.length) continue;
		lines.push(`### ${categoryHeading(category)}`);
		lines.push(
			...categoryChecks.map((check) =>
				`- ${presenceMarker(check.presence)} ${check.name}${check.reason ? ` — ${check.reason}` : ""}`,
			),
		);
	}
	return lines;
}

export function renderFounderPlan(plan: PlannerPlan, context: PlannerContext): string {
	const decision = decideManifestWrite({
		manifestExists: context.manifestExists === true,
		proposedGates: plan.proposedGates,
		requirements: plan.requirements,
		allowWrite: context.manifestWriteEligible ?? (context.plannerSource === "planner"),
	});
	const filesLikely = plan.filesLikely.length ? plan.filesLikely.map((file) => `- \`${file}\``) : ["- (not identified by planner)"];
	const risks = plan.risks.length ? plan.risks : ["None identified yet."];
	const requirementChecks = context.requirementChecks ?? unknownRequirementChecks(plan.requirements);
	const requirements = renderRequirementChecks(requirementChecks);
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
		"## Requirements",
		...requirements,
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
