/**
 * Anti-rubber-stamp calibration helpers.
 *
 * Pure / node-builtin-only: summarizes caller-supplied scorer flag observations and extracts
 * observations from caller-supplied ledger events/log lines. No filesystem, pi SDK, model, process,
 * or AGENTS.md writes live here; calibration is advisory and human-gated only.
 */

export type CalibrationRoute = "founder" | "team" | "self";
export type CalibrationRisk = "low" | "medium" | "high";

export interface FlagObservation {
	slug: string;
	assumptionText?: string;
	route: CalibrationRoute;
	risk: CalibrationRisk;
	/** True only for explicit founder reject-with-correction feedback on this task. */
	wasRejectedWithCorrection: boolean;
}

export interface CalibrationBucketStats {
	totalFlags: number;
	worthItCount: number;
	neutralCount: number;
	worthItRatio: number;
}

export interface CalibrationCategoryStats extends CalibrationBucketStats {
	kind: "route" | "risk" | "route+risk";
	key: string;
	label: string;
	route?: CalibrationRoute;
	risk?: CalibrationRisk;
}

export interface CalibrationStats extends CalibrationBucketStats {
	byRoute: Record<CalibrationRoute, CalibrationBucketStats>;
	byRisk: Record<CalibrationRisk, CalibrationBucketStats>;
	perCategory: CalibrationCategoryStats[];
}

export interface CalibrationProposal {
	lines: string[];
}

export interface CalibrationTaskEvents {
	slug: string;
	events: Array<Record<string, unknown>>;
}

export interface CalibrationTaskLogLines {
	slug: string;
	lines: string[] | string;
}

export const CALIBRATION_MIN_SAMPLE_SIZE = 5;
export const CALIBRATION_LOW_WORTH_IT_RATIO = 0.2;

const ROUTES: CalibrationRoute[] = ["founder", "team", "self"];
const RISKS: CalibrationRisk[] = ["high", "medium", "low"];

function emptyBucket(): CalibrationBucketStats {
	return { totalFlags: 0, worthItCount: 0, neutralCount: 0, worthItRatio: 0 };
}

function cloneBucket(bucket: CalibrationBucketStats): CalibrationBucketStats {
	return {
		totalFlags: bucket.totalFlags,
		worthItCount: bucket.worthItCount,
		neutralCount: bucket.neutralCount,
		worthItRatio: bucket.worthItRatio,
	};
}

function finalizeBucket(bucket: CalibrationBucketStats): CalibrationBucketStats {
	bucket.neutralCount = Math.max(0, bucket.totalFlags - bucket.worthItCount);
	bucket.worthItRatio = bucket.totalFlags > 0 ? bucket.worthItCount / bucket.totalFlags : 0;
	return bucket;
}

function addObservation(bucket: CalibrationBucketStats, observation: FlagObservation): void {
	bucket.totalFlags += 1;
	if (observation.wasRejectedWithCorrection) bucket.worthItCount += 1;
}

function isRoute(value: unknown): value is CalibrationRoute {
	return value === "founder" || value === "team" || value === "self";
}

function isRisk(value: unknown): value is CalibrationRisk {
	return value === "low" || value === "medium" || value === "high";
}

function cleanString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.replace(/\s+/g, " ").trim();
	return trimmed || undefined;
}

function bucketLabel(kind: CalibrationCategoryStats["kind"], route?: CalibrationRoute, risk?: CalibrationRisk): string {
	if (kind === "route" && route) return `route=${route}`;
	if (kind === "risk" && risk) return `risk=${risk}`;
	if (kind === "route+risk" && route && risk) return `route=${route}, risk=${risk}`;
	return "unknown category";
}

function category(
	kind: CalibrationCategoryStats["kind"],
	key: string,
	bucket: CalibrationBucketStats,
	route?: CalibrationRoute,
	risk?: CalibrationRisk,
): CalibrationCategoryStats {
	return {
		kind,
		key,
		label: bucketLabel(kind, route, risk),
		...cloneBucket(bucket),
		...(route ? { route } : {}),
		...(risk ? { risk } : {}),
	};
}

/** Aggregate calibration observations. Straight approves remain neutral, never negative evidence. */
export function summarizeCalibration(observations: FlagObservation[]): CalibrationStats {
	const total = emptyBucket();
	const byRoute: Record<CalibrationRoute, CalibrationBucketStats> = {
		founder: emptyBucket(),
		team: emptyBucket(),
		self: emptyBucket(),
	};
	const byRisk: Record<CalibrationRisk, CalibrationBucketStats> = {
		high: emptyBucket(),
		medium: emptyBucket(),
		low: emptyBucket(),
	};
	const byRouteRisk: Record<CalibrationRoute, Record<CalibrationRisk, CalibrationBucketStats>> = {
		founder: { high: emptyBucket(), medium: emptyBucket(), low: emptyBucket() },
		team: { high: emptyBucket(), medium: emptyBucket(), low: emptyBucket() },
		self: { high: emptyBucket(), medium: emptyBucket(), low: emptyBucket() },
	};

	for (const observation of Array.isArray(observations) ? observations : []) {
		if (!isRoute(observation.route) || !isRisk(observation.risk)) continue;
		addObservation(total, observation);
		addObservation(byRoute[observation.route], observation);
		addObservation(byRisk[observation.risk], observation);
		addObservation(byRouteRisk[observation.route][observation.risk], observation);
	}

	finalizeBucket(total);
	for (const route of ROUTES) finalizeBucket(byRoute[route]);
	for (const risk of RISKS) finalizeBucket(byRisk[risk]);
	for (const route of ROUTES) for (const risk of RISKS) finalizeBucket(byRouteRisk[route][risk]);

	const perCategory: CalibrationCategoryStats[] = [];
	for (const route of ROUTES) perCategory.push(category("route", route, byRoute[route], route));
	for (const risk of RISKS) perCategory.push(category("risk", risk, byRisk[risk], undefined, risk));
	for (const route of ROUTES) {
		for (const risk of RISKS) {
			perCategory.push(category("route+risk", `${route}:${risk}`, byRouteRisk[route][risk], route, risk));
		}
	}

	return {
		...cloneBucket(total),
		byRoute,
		byRisk,
		perCategory,
	};
}

function formatRatio(bucket: CalibrationBucketStats): string {
	return `${Math.round(bucket.worthItRatio * 100)}%`;
}

function proposalCandidates(stats: CalibrationStats): CalibrationCategoryStats[] {
	return stats.perCategory
		.filter((bucket) => bucket.route !== "self")
		.filter((bucket) => bucket.totalFlags >= CALIBRATION_MIN_SAMPLE_SIZE)
		.filter((bucket) => bucket.worthItRatio <= CALIBRATION_LOW_WORTH_IT_RATIO)
		.sort((a, b) => {
			const totalDelta = b.totalFlags - a.totalFlags;
			if (totalDelta !== 0) return totalDelta;
			const ratioDelta = a.worthItRatio - b.worthItRatio;
			if (ratioDelta !== 0) return ratioDelta;
			return a.key.localeCompare(b.key);
		});
}

/**
 * Produce conservative, human-gated scorer calibration proposals.
 * Never auto-tunes thresholds and never claims a flag was bad; silent approves are ambiguous.
 */
export function proposeCalibration(stats: CalibrationStats): string[] {
	const candidates = proposalCandidates(stats);
	if (!candidates.length) return [];
	return candidates.map(
		(bucket) =>
			`Proposal: consider reviewing whether ${bucket.label} over-flags (${bucket.totalFlags} flags; ${bucket.worthItCount} reject+correction; ${bucket.neutralCount} neutral; ${formatRatio(bucket)} worth-it). Keep any scorer change human-approved; do not auto-tune from this report.`,
	);
}

function formatBucketLine(label: string, bucket: CalibrationBucketStats): string {
	return `- ${label}: ${bucket.totalFlags} flag(s), ${bucket.worthItCount} worth-it, ${bucket.neutralCount} neutral (${formatRatio(bucket)} worth-it)`;
}

/** Human-readable report for the manual founder-invoked calibration command. */
export function formatCalibrationReport(stats: CalibrationStats, proposalLines: string[] = proposeCalibration(stats)): string {
	const lines = [
		"# Foreman scorer calibration (advisory)",
		"Clear signal only: WORTH IT means an explicit founder reject+correction; straight approvals are neutral/ambiguous.",
		"This report does not auto-tune scorer.ts and does not write AGENTS.md.",
		"",
		formatBucketLine("Overall", stats),
		"",
		"## By route",
		...ROUTES.map((route) => formatBucketLine(route, stats.byRoute[route])),
		"",
		"## By risk",
		...RISKS.map((risk) => formatBucketLine(risk, stats.byRisk[risk])),
		"",
		"## Proposal",
	];
	if (proposalLines.length) {
		lines.push(...proposalLines.map((line) => `- ${line}`));
		lines.push("- Founder decides whether any scorer threshold/category should change; no automatic mutation was made.");
	} else {
		lines.push(`- No calibration proposal: no route/risk band met the minimum sample (${CALIBRATION_MIN_SAMPLE_SIZE}) plus low worth-it ratio threshold.`);
	}
	return lines.join("\n");
}

function parseLogLine(line: string): Record<string, unknown> | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	try {
		const parsed = JSON.parse(trimmed);
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

export function parseCalibrationLedgerEventsFromLines(lines: string[] | string): Array<Record<string, unknown>> {
	const rawLines = typeof lines === "string" ? lines.split(/\r?\n/) : Array.isArray(lines) ? lines : [];
	return rawLines.map(parseLogLine).filter((event): event is Record<string, unknown> => Boolean(event));
}

function hasRejectWithCorrection(events: Array<Record<string, unknown>>): boolean {
	return events.some((event) => {
		if (event.type !== "gate1_rejected" && event.type !== "gate2_rejected") return false;
		return Boolean(cleanString(event.feedback));
	});
}

function hasStraightApprovalOutcome(events: Array<Record<string, unknown>>): boolean {
	return events.some((event) => event.type === "gate2_approved" || event.type === "task_done");
}

function latestGate1AwaitingWithScoredAssumptions(events: Array<Record<string, unknown>>): Record<string, unknown> | null {
	for (let i = events.length - 1; i >= 0; i -= 1) {
		const event = events[i];
		if (event.type === "gate1_awaiting" && Array.isArray(event.scoredAssumptions)) return event;
	}
	return null;
}

function extractFlagObservationsFromGate1(slug: string, gate1: Record<string, unknown>, wasRejectedWithCorrection: boolean): FlagObservation[] {
	const scored = Array.isArray(gate1.scoredAssumptions) ? gate1.scoredAssumptions : [];
	const observations: FlagObservation[] = [];
	for (const item of scored) {
		if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
		const route = (item as Record<string, unknown>).route;
		const risk = (item as Record<string, unknown>).risk;
		if (!isRoute(route) || !isRisk(risk)) continue;
		// Calibration measures scorer flags: founder/team routed assumptions. Self-routed items were not raised.
		if (route === "self") continue;
		const assumptionText = cleanString((item as Record<string, unknown>).text ?? (item as Record<string, unknown>).assumptionText);
		observations.push({
			slug,
			...(assumptionText ? { assumptionText } : {}),
			route,
			risk,
			wasRejectedWithCorrection,
		});
	}
	return observations;
}

/**
 * Build observations from parsed task ledger events. Missing fields, pending tasks, and malformed
 * event shapes are skipped so calibration is best-effort and never blocks Foreman.
 */
export function extractCalibrationObservationsFromLedgerEvents(tasks: CalibrationTaskEvents[]): FlagObservation[] {
	const observations: FlagObservation[] = [];
	for (const task of Array.isArray(tasks) ? tasks : []) {
		const slug = cleanString(task.slug);
		if (!slug || !Array.isArray(task.events)) continue;
		const gate1 = latestGate1AwaitingWithScoredAssumptions(task.events);
		if (!gate1) continue;
		const wasRejectedWithCorrection = hasRejectWithCorrection(task.events);
		// Approved-straight-through is neutral; in-flight/no-outcome ledgers are skipped until clearer signal exists.
		if (!wasRejectedWithCorrection && !hasStraightApprovalOutcome(task.events)) continue;
		observations.push(...extractFlagObservationsFromGate1(slug, gate1, wasRejectedWithCorrection));
	}
	return observations;
}

/** Convenience parser for log.jsonl fixtures; still pure/no filesystem. */
export function extractCalibrationObservationsFromLogLines(tasks: CalibrationTaskLogLines[]): FlagObservation[] {
	return extractCalibrationObservationsFromLedgerEvents(
		(Array.isArray(tasks) ? tasks : []).map((task) => ({
			slug: task.slug,
			events: parseCalibrationLedgerEventsFromLines(task.lines),
		})),
	);
}
