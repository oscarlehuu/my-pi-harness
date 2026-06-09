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
import { scoreAssumptions, type AssumptionCostHints, type RiskBand, type ScoredAssumption } from "./scorer.ts";

export const PLAN_JSON_START = "---PLAN-JSON---";
export const PLAN_JSON_END = "---END-PLAN-JSON---";

export type PlannerSource = "planner" | "fallback" | "persisted";

export interface ForemanManifest {
	gates: Gate[];
	requirements?: TaskRequirements;
	highRiskPaths?: string[];
}

export type PlannerAssumptionConfidence = "low" | "medium" | "high";

export interface PlannerAssumption {
	text: string;
	confidence?: PlannerAssumptionConfidence;
}

export interface PlannerAlternative {
	approach: string;
	rejectedReason: string;
}

export interface PlannerPlan {
	summary: string;
	understanding?: string;
	assumptions?: PlannerAssumption[];
	nonGoals?: string[];
	alternatives?: PlannerAlternative[];
	blastRadius?: string[];
	steps: string[];
	filesLikely: string[];
	risks: string[];
	proposedGates: Gate[];
	requirements: TaskRequirements;
}

export interface PersistedPlannerDraft {
	source: Extract<PlannerSource, "planner" | "fallback">;
	plan: PlannerPlan;
	note?: string;
}

export function shouldReusePersistedDraft(draft: PersistedPlannerDraft | null | undefined): draft is PersistedPlannerDraft & { source: "planner" };
export function shouldReusePersistedDraft(draft: { source?: unknown } | null | undefined): boolean;
export function shouldReusePersistedDraft(draft: { source?: unknown } | null | undefined): boolean {
	return draft?.source === "planner";
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
	/** Presence means Gate 1 should use the advisory assumption scorer; empty array is valid. */
	highRiskPaths?: string[];
	/** Optional plan-level assumption cost hint, supplied by callers without changing PLAN-JSON. */
	assumptionCostHint?: RiskBand;
	/** Optional per-assumption cost hints, supplied by callers without changing PLAN-JSON. */
	assumptionCostHints?: AssumptionCostHints;
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
const VALID_CONFIDENCES = new Set<PlannerAssumptionConfidence>(["low", "medium", "high"]);
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

function cleanOptionalString(value: unknown): string | undefined {
	return isNonEmptyString(value) ? cleanString(value) : undefined;
}

function normalizePlannerAssumptionConfidence(value: unknown): PlannerAssumptionConfidence | undefined {
	if (typeof value !== "string") return undefined;
	const confidence = cleanString(value).toLowerCase();
	return VALID_CONFIDENCES.has(confidence as PlannerAssumptionConfidence) ? (confidence as PlannerAssumptionConfidence) : undefined;
}

function normalizePlannerAssumption(value: unknown): PlannerAssumption | null {
	if (!isRecord(value) || !isNonEmptyString(value.text)) return null;
	const text = cleanString(value.text);
	const confidence = normalizePlannerAssumptionConfidence(value.confidence);
	return confidence ? { text, confidence } : { text };
}

function normalizePlannerAssumptions(value: unknown): PlannerAssumption[] {
	if (!Array.isArray(value)) return [];
	return value.map(normalizePlannerAssumption).filter((assumption): assumption is PlannerAssumption => assumption !== null);
}

function normalizePlannerAlternative(value: unknown): PlannerAlternative | null {
	if (!isRecord(value) || !isNonEmptyString(value.approach) || !isNonEmptyString(value.rejectedReason)) return null;
	return { approach: cleanString(value.approach), rejectedReason: cleanString(value.rejectedReason) };
}

function normalizePlannerAlternatives(value: unknown): PlannerAlternative[] {
	if (!Array.isArray(value)) return [];
	return value.map(normalizePlannerAlternative).filter((alternative): alternative is PlannerAlternative => alternative !== null);
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
	const understanding = cleanOptionalString(value.understanding);

	return {
		summary: cleanString(value.summary),
		...(understanding ? { understanding } : {}),
		assumptions: normalizePlannerAssumptions(value.assumptions),
		nonGoals: cleanStringList(value.nonGoals),
		alternatives: normalizePlannerAlternatives(value.alternatives),
		blastRadius: cleanStringList(value.blastRadius),
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
		assumptions: [],
		nonGoals: [],
		alternatives: [],
		blastRadius: [],
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

function hasContent<T>(lines: T[] | undefined): lines is T[] {
	return Array.isArray(lines) && lines.length > 0;
}

function renderOptionalSection(heading: string, lines: string[]): string[] {
	return lines.length ? ["", `## ${heading}`, ...lines] : [];
}

export function formatIntentContract(plan: PlannerPlan): string {
	const understanding = cleanOptionalString(plan.understanding);
	const assumptions = normalizePlannerAssumptions(plan.assumptions);
	const nonGoals = cleanStringList(plan.nonGoals);
	const sections: string[] = [];
	if (understanding) sections.push("Understanding:", `- ${understanding}`);
	if (assumptions.length) {
		sections.push(
			"Assumptions:",
			...assumptions.map((assumption) => `- ${assumption.text}${assumption.confidence ? ` (confidence: ${assumption.confidence})` : ""}`),
		);
	}
	if (nonGoals.length) sections.push("Non-goals:", ...nonGoals.map((nonGoal) => `- ${nonGoal}`));
	return sections.join("\n");
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

function hasAssumptionScorerSignal(context: PlannerContext): boolean {
	return (
		Object.prototype.hasOwnProperty.call(context, "highRiskPaths") ||
		context.assumptionCostHint !== undefined ||
		context.assumptionCostHints !== undefined
	);
}

function primaryAssumptionReason(scored: ScoredAssumption): string {
	return (
		scored.reasons.find((reason) => /highRiskPaths|keyword signal|caller cost hint/.test(reason)) ??
		scored.reasons.find((reason) => reason.startsWith("risk ")) ??
		scored.reasons[0] ??
		"scored by risk"
	);
}

function renderScoredAssumption(scored: ScoredAssumption): string {
	const confidence = scored.confidence ? `confidence: ${scored.confidence}` : "confidence: missing";
	const route = scored.route === "team" ? "team→founder for now" : scored.route;
	const meta = `${confidence}; risk: ${scored.risk}; cost: ${scored.cost}; kind: ${scored.kind}; route: ${route}`;
	if (scored.risk === "high") return `- [!] verify this: ${scored.text} _(${meta})_ — ${primaryAssumptionReason(scored)}`;
	if (scored.risk === "medium") return `- [?] check if uncertain: ${scored.text} _(${meta})_ — ${primaryAssumptionReason(scored)}`;
	return `- (low risk) ${scored.text} _(${meta})_`;
}

function renderAssumptions(plan: PlannerPlan, context: PlannerContext): string[] {
	if (!hasContent(plan.assumptions)) return [];
	if (!hasAssumptionScorerSignal(context)) {
		return plan.assumptions.map((assumption) => `- ${assumption.text}${assumption.confidence ? ` _(confidence: ${assumption.confidence})_` : ""}`);
	}
	return scoreAssumptions(plan.assumptions, {
		highRiskPaths: context.highRiskPaths ?? [],
		blastRadius: plan.blastRadius ?? [],
		filesLikely: plan.filesLikely ?? [],
		costHint: context.assumptionCostHint,
		costHints: context.assumptionCostHints,
	}).map(renderScoredAssumption);
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
	const understanding = plan.understanding ? [plan.understanding] : [];
	const assumptions = renderAssumptions(plan, context);
	const nonGoals = (plan.nonGoals ?? []).map((nonGoal) => `- ${nonGoal}`);
	const alternatives = hasContent(plan.alternatives)
		? plan.alternatives.map((alternative) => `- ${alternative.approach} — rejected because ${alternative.rejectedReason}`)
		: [];
	const blastRadius = (plan.blastRadius ?? []).map((item) => `- ${item}`);
	const plannerSource = context.plannerSource ? ` (${context.plannerSource})` : "";
	return [
		`# Plan: ${context.task}`,
		"",
		`## Summary${plannerSource}`,
		plan.summary,
		...renderOptionalSection("Understanding", understanding),
		...renderOptionalSection("Assumptions", assumptions),
		...renderOptionalSection("Non-goals", nonGoals),
		...renderOptionalSection("Alternatives considered", alternatives),
		...renderOptionalSection("Blast radius", blastRadius),
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
