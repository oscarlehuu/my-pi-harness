/**
 * Release/ship helpers for Foreman.
 *
 * Pure / node-builtin-only: commit-message synthesis, safe stage path resolution, and release
 * commit decisions. The orchestrator owns all git/process I/O; this module stays headlessly
 * unit-testable.
 */

export type CommitType = "feat" | "fix" | "chore";

export interface BuildCommitMessageInput {
	task: string;
	slug: string;
	track: string;
	filesChanged?: string[];
	reviewerSummary?: string;
	doneSummary?: string;
}

export interface ResolveStagePathsInput {
	gatePaths?: string[];
	filesChanged?: string[];
	ledgerRelDir: string;
}

export interface ShipCommitDecisionInput {
	isGitRepo: boolean;
	hasReleaseCommitGate: boolean;
	stagedCount: number;
}

export interface ShipCommitDecision {
	commit: boolean;
	reason: string;
}

const SUBJECT_MAX = 72;
const FALLBACK_SUMMARY = "ship foreman task";

function cleanOneLine(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function meaningfulTaskLine(task: string): string {
	const line = task
		.split(/\r?\n/)
		.map(cleanOneLine)
		.find(Boolean);
	return line || FALLBACK_SUMMARY;
}

function shorten(value: string, maxChars: number): string {
	const cleaned = cleanOneLine(value);
	if (cleaned.length <= maxChars) return cleaned;
	if (maxChars <= 3) return cleaned.slice(0, maxChars);
	return `${cleaned.slice(0, maxChars - 3).replace(/[\s:;,.!?-]+$/g, "")}...`;
}

function uniqueCleanStrings(values: string[] | undefined): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const value of values ?? []) {
		if (typeof value !== "string") continue;
		const cleaned = cleanOneLine(value);
		if (!cleaned || seen.has(cleaned)) continue;
		seen.add(cleaned);
		out.push(cleaned);
	}
	return out;
}

export function inferCommitType(task: string): CommitType {
	if (/\b(?:bugfix(?:es)?|bugs?|fix(?:e[sd])?|crash(?:es|ed|ing)?)\b/i.test(task)) return "fix";
	if (/\b(?:adds?|added|implement(?:s|ed|ing)?|features?|new|creates?|created|introduce(?:s|d|ing)?)\b/i.test(task)) return "feat";
	return "chore";
}

export function buildCommitMessage(input: BuildCommitMessageInput): string {
	const type = inferCommitType(input.task);
	const prefix = `${type}(foreman-task): `;
	const summary = shorten(meaningfulTaskLine(input.task), Math.max(1, SUBJECT_MAX - prefix.length));
	const subject = `${prefix}${summary}`;
	const files = uniqueCleanStrings(input.filesChanged);
	const bodyLines: string[] = ["Files changed:"];
	if (files.length) {
		bodyLines.push(...files.map((file) => `- ${file}`));
	} else {
		bodyLines.push("- (none reported by developer handoff)");
	}
	bodyLines.push("", `Shipped via Foreman (slug: ${input.slug}, track: ${input.track || "backend"}).`);
	const reviewerSummary = cleanOneLine(input.reviewerSummary ?? "");
	if (reviewerSummary) bodyLines.push(`Reviewer summary: ${reviewerSummary}`);
	const doneSummary = input.doneSummary ?? "";
	if (doneSummary.trim()) bodyLines.push("", doneSummary);
	return `${subject}\n\n${bodyLines.join("\n")}`;
}

function stripWrappingPunctuation(value: string): string {
	return value.replace(/^[`'"<]+/g, "").replace(/[`'">]+$/g, "").trim();
}

function leadingPathToken(entry: string): string {
	let cleaned = entry.replace(/^\s*(?:[-*•]\s+|\d+[.)]\s+)/, "").trim();
	const separatedDescription = cleaned.match(/^(.*?)\s+-\s+.+$/);
	if (separatedDescription) cleaned = separatedDescription[1].trim();
	else cleaned = cleaned.split(/\s+/)[0] ?? "";
	return stripWrappingPunctuation(cleaned);
}

function isUnsafeWholeTreePathspec(value: string): boolean {
	const cleaned = value.trim();
	return (
		cleaned === "" ||
		cleaned === "-A" ||
		cleaned === "--all" ||
		cleaned === "." ||
		cleaned === "./" ||
		cleaned === ":" ||
		cleaned === ":/" ||
		cleaned === "/" ||
		cleaned === "*" ||
		/^:\(top\)$/i.test(cleaned)
	);
}

function cleanPathspecs(values: string[]): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const value of values) {
		if (typeof value !== "string") continue;
		const cleaned = stripWrappingPunctuation(value.trim());
		if (isUnsafeWholeTreePathspec(cleaned) || seen.has(cleaned)) continue;
		seen.add(cleaned);
		out.push(cleaned);
	}
	return out;
}

export function resolveStagePaths(input: ResolveStagePathsInput): string[] {
	const gatePaths = cleanPathspecs(input.gatePaths ?? []);
	if ((input.gatePaths ?? []).length > 0) return gatePaths.length ? gatePaths : cleanPathspecs([input.ledgerRelDir]);

	const derived = cleanPathspecs((input.filesChanged ?? []).map(leadingPathToken));
	const withLedger = cleanPathspecs([...derived, input.ledgerRelDir]);
	return withLedger.length ? withLedger : [input.ledgerRelDir];
}

export function decideShipCommit(input: ShipCommitDecisionInput): ShipCommitDecision {
	if (!input.hasReleaseCommitGate) return { commit: false, reason: "no release commit gate declared" };
	if (!input.isGitRepo) return { commit: false, reason: "not a git repo" };
	if (input.stagedCount <= 0) return { commit: false, reason: "nothing to stage" };
	return { commit: true, reason: "release commit gate declared with staged changes" };
}
