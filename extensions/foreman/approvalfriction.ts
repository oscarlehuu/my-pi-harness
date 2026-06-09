/**
 * Gate 2 approval friction policy.
 *
 * Pure / node-builtin-only: decides whether a pending ship needs deliberate founder confirmation
 * from caller-supplied changed/at-risk paths and high-risk path globs. No filesystem, pi SDK,
 * process, or model imports live here so it stays headlessly testable.
 */

import { globMatches } from "./scorer.ts";

export type ApprovalFrictionLevel = "normal" | "elevated";

export interface ApprovalFrictionInput {
	/** Paths or path-like blast-radius entries supplied by the orchestrator (plan + developer handoff). */
	changedPaths?: string[];
	/** Repo-configured high-risk path globs, loaded by the orchestrator. */
	highRiskPaths?: string[];
}

export interface ApprovalFrictionDecision {
	level: ApprovalFrictionLevel;
	matchedPaths: string[];
	reason: string;
}

function cleanString(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function cleanStringList(values: string[] | undefined): string[] {
	if (!Array.isArray(values)) return [];
	return values.filter((value): value is string => typeof value === "string").map(cleanString).filter(Boolean);
}

function stripPathPunctuation(value: string): string {
	return value.replace(/^[`'"<]+/g, "").replace(/[`'">.,;:]+$/g, "").trim();
}

function stripPathAnchor(value: string): string {
	return value.replace(/[?#].*$/, "").replace(/(?::\d+){1,2}$/, "");
}

function normalizePathish(value: string): string {
	return stripPathAnchor(stripPathPunctuation(value))
		.replace(/\\/g, "/")
		.replace(/^\.\//, "")
		.trim();
}

function unique(values: string[]): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const value of values) {
		const normalized = normalizePathish(value);
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);
		out.push(normalized);
	}
	return out;
}

function candidatePathVariants(value: string): string[] {
	const cleaned = normalizePathish(value);
	if (!cleaned) return [];
	const variants = [cleaned];
	for (const token of cleaned.split(/[\s,()[\]{}]+/)) {
		const normalized = normalizePathish(token);
		if (normalized && !variants.includes(normalized)) variants.push(normalized);
	}
	return variants;
}

/** Decide whether Gate 2 should keep one-tap approval or require an elevated confirm token. */
export function decideApprovalFriction(input: ApprovalFrictionInput): ApprovalFrictionDecision {
	const highRiskPaths = cleanStringList(input.highRiskPaths);
	const candidates = unique(cleanStringList(input.changedPaths).flatMap(candidatePathVariants));
	if (!highRiskPaths.length) {
		return { level: "normal", matchedPaths: [], reason: "No highRiskPaths configured." };
	}
	if (!candidates.length) {
		return { level: "normal", matchedPaths: [], reason: "No changed or at-risk paths supplied." };
	}

	const matchedPaths: string[] = [];
	const seen = new Set<string>();
	for (const candidate of candidates) {
		if (!highRiskPaths.some((pattern) => globMatches(pattern, candidate))) continue;
		if (seen.has(candidate)) continue;
		seen.add(candidate);
		matchedPaths.push(candidate);
	}

	if (matchedPaths.length) {
		return {
			level: "elevated",
			matchedPaths,
			reason: `High-risk path glob matched ${matchedPaths.join(", ")}.`,
		};
	}
	return { level: "normal", matchedPaths: [], reason: "No changed or at-risk paths matched highRiskPaths." };
}
