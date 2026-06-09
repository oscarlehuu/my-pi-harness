/**
 * Gate 1 team question packet formatter.
 *
 * Pure / node-builtin-only: turns already-scored planner assumptions into a compact markdown
 * relay packet. No filesystem, pi SDK, model, process, or scorer runtime imports live here; callers
 * pass scored assumptions in so Gate 1 can stay advisory-only and headlessly testable.
 */

import type { ScoredAssumption } from "./scorer.ts";

export interface TeamPacketOptions {
	/** Maximum number of questions to render. Defaults to 5 so founder relays stay small. */
	maxItems?: number;
	/** Optional heading override for tests/embedding; defaults to the founder-facing relay heading. */
	heading?: string;
}

const DEFAULT_MAX_ITEMS = 5;
const RISK_VALUE: Record<ScoredAssumption["risk"], number> = { low: 1, medium: 2, high: 3 };

function cleanString(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function cleanReasons(values: string[] | undefined): string[] {
	if (!Array.isArray(values)) return [];
	return values.filter((value): value is string => typeof value === "string").map(cleanString).filter(Boolean);
}

function normalizedMaxItems(value: number | undefined): number {
	if (value === undefined) return DEFAULT_MAX_ITEMS;
	if (!Number.isFinite(value)) return DEFAULT_MAX_ITEMS;
	return Math.max(0, Math.floor(value));
}

function riskValue(risk: ScoredAssumption["risk"]): number {
	return RISK_VALUE[risk] ?? 0;
}

function confidenceLabel(scored: ScoredAssumption): string {
	return scored.confidence ? scored.confidence : "missing";
}

function reasonLabel(scored: ScoredAssumption): string {
	const reasons = cleanReasons(scored.reasons);
	return reasons.length ? reasons.join("; ") : "scorer did not provide a reason";
}

function punctuatedAssumption(text: string): string {
	return /[.!?]$/.test(text) ? text : `${text}.`;
}

/**
 * Build a paste-able team relay packet from scorer output.
 *
 * Advisory only: only `route: "team"` medium/high-risk assumptions are included, and approval of
 * Gate 1 still means proceed on these unless a teammate vetoes/corrects one out-of-band.
 */
export function buildTeamPacket(scored: ScoredAssumption[] | undefined, opts: TeamPacketOptions = {}): string {
	const maxItems = normalizedMaxItems(opts.maxItems);
	if (maxItems <= 0 || !Array.isArray(scored)) return "";

	const candidates = scored
		.map((assumption, index) => ({ assumption, index }))
		.filter(({ assumption }) => {
			const text = typeof assumption?.text === "string" ? cleanString(assumption.text) : "";
			return assumption?.route === "team" && (assumption.risk === "high" || assumption.risk === "medium") && text.length > 0;
		})
		.sort((a, b) => {
			const riskDelta = riskValue(b.assumption.risk) - riskValue(a.assumption.risk);
			return riskDelta !== 0 ? riskDelta : a.index - b.index;
		});

	const selected = candidates.slice(0, maxItems);
	if (!selected.length) return "";

	const heading = cleanString(opts.heading ?? "## Questions for your team (relay these)");
	const lines = [
		heading,
		"",
		"Paste into your team channel. Gate 1 can proceed on these unless someone vetoes/corrects one; reply format: `yes` or `no — <correction>`.",
	];
	if (candidates.length > selected.length) {
		lines.push(`_Showing top ${selected.length} of ${candidates.length} team-routed medium/high-risk assumptions by risk._`);
	}
	lines.push("");

	selected.forEach(({ assumption }, index) => {
		const text = punctuatedAssumption(cleanString(assumption.text));
		lines.push(
			`${index + 1}. Yes/no: I'm assuming ${text} Is that correct? _(confidence: ${confidenceLabel(assumption)}; risk: ${assumption.risk})_ Evidence/why risky: ${reasonLabel(assumption)}.`,
		);
	});

	return lines.join("\n");
}
