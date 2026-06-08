/**
 * Crew agent timeout helpers.
 *
 * Pure / node-builtin-only: centralizes per-role idle/max defaults, env override parsing,
 * timeout decisions, and the deterministic degradation policy used when a crew subprocess
 * is aborted for idleness or max runtime.
 */

import type { SuccessState } from "./ledger.ts";
import type { ReviewDecision } from "./reviewer.ts";

export type AgentTimeoutRole = "planner" | "developer" | "ui-developer" | "tester" | "reviewer";
export type AgentTimeoutReason = "idle" | "max";

export interface AgentTimeoutDecision {
	abort: boolean;
	reason: AgentTimeoutReason | null;
}

export interface AgentTimeoutOutcome {
	timedOut: boolean;
	reason: AgentTimeoutReason | null;
}

export interface AgentTimeouts {
	idleMs: number;
	maxMs: number;
}

export type AgentTimeoutEnv = Record<string, string | undefined>;

export type AgentTimeoutDegradationAction =
	| "none"
	| "planner-fallback"
	| "retry-developer-round"
	| "fail-tester-verdict"
	| "flag-reviewer-inconclusive";

export interface AgentTimeoutDegradation {
	action: AgentTimeoutDegradationAction;
	note: string;
	successState?: SuccessState;
	reviewDecision?: ReviewDecision;
	flagged?: boolean;
}

export const AGENT_TIMEOUT_ROLES: AgentTimeoutRole[] = ["planner", "developer", "ui-developer", "tester", "reviewer"];

// Defaults are intentionally visible in one place. Developer/UI get longer budgets because they
// may edit and run local checks. The reviewer also needs a generous budget: it runs an xhigh model
// and does heavy read-only recon (reads the whole diff, traces dependents, 15+ tool calls), so it is
// bounded like the developer rather than the lightweight tester — a too-tight budget made it idle/max
// out before it could emit its REVIEW verdict, blocking ship on strict DoD.
export const DEFAULT_AGENT_TIMEOUTS_MS: Record<AgentTimeoutRole, AgentTimeouts> = {
	planner: { idleMs: 90_000, maxMs: 300_000 },
	developer: { idleMs: 180_000, maxMs: 900_000 },
	"ui-developer": { idleMs: 180_000, maxMs: 900_000 },
	tester: { idleMs: 90_000, maxMs: 300_000 },
	reviewer: { idleMs: 180_000, maxMs: 720_000 },
};

export const MIN_AGENT_IDLE_MS = 1_000;

const ROLE_ENV_PREFIX: Record<AgentTimeoutRole, string> = {
	planner: "PLANNER",
	developer: "DEVELOPER",
	"ui-developer": "UI_DEVELOPER",
	tester: "TESTER",
	reviewer: "REVIEWER",
};

function parseTimeoutMs(value: string | undefined, fallback: number): number {
	if (value == null || value.trim() === "") return fallback;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? Math.floor(parsed) : fallback;
}

export function timeoutEnvKeys(role: AgentTimeoutRole): { idle: string; max: string; legacyIdle?: string } {
	const prefix = ROLE_ENV_PREFIX[role];
	return {
		idle: `FOREMAN_${prefix}_IDLE_MS`,
		max: `FOREMAN_${prefix}_MAX_MS`,
		...(role === "planner" ? { legacyIdle: "FOREMAN_PLANNER_TIMEOUT_MS" } : {}),
	};
}

export function resolveAgentTimeouts(env: AgentTimeoutEnv, role: AgentTimeoutRole): AgentTimeouts {
	const defaults = DEFAULT_AGENT_TIMEOUTS_MS[role];
	const keys = timeoutEnvKeys(role);
	const idleSource = env[keys.idle] ?? (keys.legacyIdle ? env[keys.legacyIdle] : undefined);
	const idleMs = Math.max(MIN_AGENT_IDLE_MS, parseTimeoutMs(idleSource, defaults.idleMs));
	const requestedMaxMs = parseTimeoutMs(env[keys.max], defaults.maxMs);
	const maxMs = Math.max(idleMs, requestedMaxMs);
	return { idleMs, maxMs };
}

export function resolveAllAgentTimeouts(env: AgentTimeoutEnv): Record<AgentTimeoutRole, AgentTimeouts> {
	return {
		planner: resolveAgentTimeouts(env, "planner"),
		developer: resolveAgentTimeouts(env, "developer"),
		"ui-developer": resolveAgentTimeouts(env, "ui-developer"),
		tester: resolveAgentTimeouts(env, "tester"),
		reviewer: resolveAgentTimeouts(env, "reviewer"),
	};
}

/**
 * Decide whether a crew agent should be aborted. If both limits are exceeded, the absolute max
 * backstop wins over the idle limit so a pathological long run is reported as "max".
 */
export function decideAgentTimeout(input: {
	now: number;
	startedAt: number;
	lastActivityAt: number;
	idleMs: number;
	maxMs: number;
}): AgentTimeoutDecision {
	if (input.now - input.startedAt >= input.maxMs) return { abort: true, reason: "max" };
	if (input.now - input.lastActivityAt >= input.idleMs) return { abort: true, reason: "idle" };
	return { abort: false, reason: null };
}

export function formatAgentTimeoutNote(role: AgentTimeoutRole, reason: AgentTimeoutReason, timeouts: AgentTimeouts): string {
	return reason === "idle"
		? `${role} idle-timed-out after ${timeouts.idleMs}ms (no activity)`
		: `${role} hit max runtime ${timeouts.maxMs}ms`;
}

export function timeoutLogType(role: AgentTimeoutRole): string {
	return `${role.replace(/-/g, "_")}_timed_out`;
}

export function decideAgentTimeoutDegradation(
	role: AgentTimeoutRole,
	outcome: AgentTimeoutOutcome,
	timeouts: AgentTimeouts = DEFAULT_AGENT_TIMEOUTS_MS[role],
): AgentTimeoutDegradation {
	if (!outcome.timedOut || !outcome.reason) return { action: "none", note: "" };
	const note = formatAgentTimeoutNote(role, outcome.reason, timeouts);
	if (role === "planner") return { action: "planner-fallback", note };
	if (role === "developer" || role === "ui-developer") return { action: "retry-developer-round", note };
	if (role === "tester") return { action: "fail-tester-verdict", note, successState: "fail" };
	return { action: "flag-reviewer-inconclusive", note, reviewDecision: "unknown", flagged: true };
}
