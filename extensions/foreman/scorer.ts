/**
 * Gate 1 assumption risk scorer.
 *
 * Pure / node-builtin-only: ranks planner assumptions by risk using plain data supplied by the
 * orchestrator. No filesystem, pi SDK, model, or process imports live here so the scorer stays
 * headlessly testable and can later feed a team-question channel without changing Gate 1 data shape.
 */

export type RiskBand = "low" | "medium" | "high";
export type AssumptionRoute = "self" | "founder" | "team";
export type AssumptionKind = "domain-fact" | "preference" | "unknown";
export type AssumptionConfidence = "low" | "medium" | "high";

export interface AssumptionForScoring {
	text: string;
	confidence?: AssumptionConfidence;
}

export interface ScoredAssumption {
	text: string;
	confidence?: AssumptionConfidence;
	risk: RiskBand;
	route: AssumptionRoute;
	kind: AssumptionKind;
	cost: RiskBand;
	reasons: string[];
}

export type AssumptionCostHints = Array<RiskBand | undefined> | Record<string, RiskBand | undefined>;

export interface AssumptionScoringContext {
	highRiskPaths?: string[];
	blastRadius?: string[];
	filesLikely?: string[];
	/** Optional plan-level cost hint from a caller/model/heuristic that ran outside this pure module. */
	costHint?: RiskBand;
	/** Optional per-assumption hints, keyed by index string, exact assumption text, or array index. */
	costHints?: AssumptionCostHints;
}

export interface ScoreAssumptionInput {
	assumption: AssumptionForScoring | string;
	ctx?: AssumptionScoringContext;
	index?: number;
	/** Optional per-call hint; wins over ctx.costHint/costHints when present. */
	costHint?: RiskBand;
}

const RISK_VALUE: Record<RiskBand, number> = { low: 1, medium: 2, high: 3 };

const HIGH_COST_KEYWORDS: Array<{ label: string; pattern: RegExp }> = [
	{ label: "payment/billing", pattern: /\b(?:payments?|billing|invoice|invoices|checkout|stripe|subscription|refunds?)\b/i },
	{ label: "auth/security", pattern: /\b(?:auth|authentication|authorization|login|oauth|permission|permissions|roles?|access\s+control|security)\b/i },
	{ label: "migration/destructive change", pattern: /\b(?:migrations?|schema|drop|delete|deletes|deleted|deleting|destroy|erase|purge|truncate|data\s+loss|irreversible|destructive)\b/i },
	{ label: "secret/credential", pattern: /\b(?:secrets?|credentials?|tokens?|api\s*keys?|private\s+keys?)\b/i },
	{ label: "production/deploy", pattern: /\b(?:prod|production|deploy|deployment|release)\b/i },
];

const MEDIUM_COST_KEYWORDS: Array<{ label: string; pattern: RegExp }> = [
	{ label: "database/state", pattern: /\b(?:database|db|table|state|persisted|cache|queue|job|worker)\b/i },
	{ label: "external API/integration", pattern: /\b(?:api|webhook|integration|third[-\s]?party|service|endpoint)\b/i },
	{ label: "configuration/routing", pattern: /\b(?:config|configuration|routing|route|session|feature\s+flag)\b/i },
];

function cleanString(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function cleanStringList(values: string[] | undefined): string[] {
	if (!Array.isArray(values)) return [];
	return values.filter((value): value is string => typeof value === "string").map(cleanString).filter(Boolean);
}

function normalizeBand(value: unknown): RiskBand | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = cleanString(value).toLowerCase();
	return normalized === "low" || normalized === "medium" || normalized === "high" ? normalized : undefined;
}

function normalizeConfidence(value: unknown): AssumptionConfidence | undefined {
	return normalizeBand(value) as AssumptionConfidence | undefined;
}

function normalizeAssumption(value: AssumptionForScoring | string): AssumptionForScoring {
	if (typeof value === "string") return { text: cleanString(value) };
	return {
		text: cleanString(typeof value.text === "string" ? value.text : ""),
		...(normalizeConfidence(value.confidence) ? { confidence: normalizeConfidence(value.confidence) } : {}),
	};
}

function normalizePathish(value: string): string {
	return value
		.trim()
		.replace(/^[`'"<]+/g, "")
		.replace(/[`'">.,;:]+$/g, "")
		.replace(/\\/g, "/")
		.replace(/^\.\//, "")
		.trim();
}

function escapeRegexChar(char: string): string {
	return /[|\\{}()[\]^$+?.]/.test(char) ? `\\${char}` : char;
}

function globToRegExp(pattern: string): RegExp {
	const normalized = normalizePathish(pattern);
	let out = "^";
	for (let i = 0; i < normalized.length; i += 1) {
		const char = normalized[i];
		if (char === "*") {
			const next = normalized[i + 1];
			if (next === "*") {
				const after = normalized[i + 2];
				if (after === "/") {
					out += "(?:.*/)?";
					i += 2;
				} else {
					out += ".*";
					i += 1;
				}
			} else {
				out += "[^/]*";
			}
			continue;
		}
		if (char === "?") {
			out += "[^/]";
			continue;
		}
		out += escapeRegexChar(char);
	}
	out += "$";
	return new RegExp(out);
}

/** Minimal glob matcher: supports `*`, `?`, and `**` over normalized slash paths. */
export function globMatches(pattern: string, value: string): boolean {
	const normalizedPattern = normalizePathish(pattern);
	const normalizedValue = normalizePathish(value);
	if (!normalizedPattern || !normalizedValue) return false;
	return globToRegExp(normalizedPattern).test(normalizedValue);
}

function candidateVariants(value: string): string[] {
	const cleaned = normalizePathish(value);
	if (!cleaned) return [];
	const variants = [cleaned];
	for (const token of cleaned.split(/[\s,()\[\]{}]+/)) {
		const normalized = normalizePathish(token);
		if (normalized && !variants.includes(normalized)) variants.push(normalized);
	}
	return variants;
}

function firstHighRiskPathMatch(ctx: AssumptionScoringContext | undefined): { pattern: string; value: string } | null {
	const patterns = cleanStringList(ctx?.highRiskPaths);
	const candidates = cleanStringList([...(ctx?.blastRadius ?? []), ...(ctx?.filesLikely ?? [])]);
	for (const pattern of patterns) {
		for (const rawCandidate of candidates) {
			for (const candidate of candidateVariants(rawCandidate)) {
				if (globMatches(pattern, candidate)) return { pattern, value: candidate };
			}
		}
	}
	return null;
}

function lookupCostHint(input: ScoreAssumptionInput, assumption: AssumptionForScoring): RiskBand | undefined {
	const direct = normalizeBand(input.costHint);
	if (direct) return direct;
	const hints = input.ctx?.costHints;
	if (Array.isArray(hints) && typeof input.index === "number") return normalizeBand(hints[input.index]);
	if (hints && !Array.isArray(hints)) {
		const byIndex = typeof input.index === "number" ? normalizeBand(hints[String(input.index)]) : undefined;
		if (byIndex) return byIndex;
		const byText = normalizeBand(hints[assumption.text]);
		if (byText) return byText;
	}
	return normalizeBand(input.ctx?.costHint);
}

function keywordCost(texts: string[]): { cost: RiskBand; reason?: string } {
	const haystack = texts.filter(Boolean).join("\n");
	for (const keyword of HIGH_COST_KEYWORDS) {
		if (keyword.pattern.test(haystack)) return { cost: "high", reason: `keyword signal (${keyword.label})` };
	}
	for (const keyword of MEDIUM_COST_KEYWORDS) {
		if (keyword.pattern.test(haystack)) return { cost: "medium", reason: `keyword signal (${keyword.label})` };
	}
	return { cost: "low" };
}

function maxBand(...bands: Array<RiskBand | undefined>): RiskBand {
	let best: RiskBand = "low";
	for (const band of bands) {
		if (band && RISK_VALUE[band] > RISK_VALUE[best]) best = band;
	}
	return best;
}

export function probabilityFromConfidence(confidence: AssumptionConfidence | undefined): RiskBand {
	if (confidence === "high") return "low";
	if (confidence === "low") return "high";
	return "medium";
}

export function combineRisk(probabilityWrong: RiskBand, cost: RiskBand): RiskBand {
	if (cost === "low") return "low";
	if (cost === "high") return probabilityWrong === "low" ? "medium" : "high";
	if (cost === "medium") return probabilityWrong === "high" ? "high" : probabilityWrong === "medium" ? "medium" : "low";
	return "low";
}

export function classifyAssumptionKind(text: string): AssumptionKind {
	const cleaned = cleanString(text).toLowerCase();
	if (!cleaned) return "unknown";
	if (/\b(?:founder|preference|prefers?|taste|priority|scope|out\s+of\s+scope|non[-\s]?goals?|mvp|nice[-\s]?to[-\s]?have|acceptable|okay|ok|desired|wants?)\b/.test(cleaned)) {
		return "preference";
	}
	if (/\b(?:app|application|system|service|api|backend|frontend|client|server|database|db|schema|table|endpoint|route|component|workflow|job|queue|cache|session|auth|payment|billing|tenant|account|repository|repo|domain)\b/.test(cleaned)) {
		return "domain-fact";
	}
	if (/\b(?:currently|already|returns?|stores?|requires?|depends?|supports?|handles?|reads?|writes?|uses?|configured|runs?|loads?|persists?)\b/.test(cleaned)) {
		return "domain-fact";
	}
	return "unknown";
}

function computeCost(input: ScoreAssumptionInput, assumption: AssumptionForScoring): { cost: RiskBand; reasons: string[] } {
	const reasons: string[] = [];
	const pathMatch = firstHighRiskPathMatch(input.ctx);
	const pathCost: RiskBand | undefined = pathMatch ? "high" : undefined;
	if (pathMatch) reasons.push(`highRiskPaths matched ${pathMatch.pattern} -> ${pathMatch.value}`);

	const hint = lookupCostHint(input, assumption);
	if (hint) reasons.push(`caller cost hint: ${hint}`);

	const keyword = keywordCost([assumption.text, ...(input.ctx?.blastRadius ?? []), ...(input.ctx?.filesLikely ?? [])]);
	if (keyword.reason) reasons.push(`${keyword.reason}: ${keyword.cost}`);

	const cost = maxBand(pathCost, hint, keyword.cost);
	if (cost === "low") reasons.push("no high-cost path, hint, or keyword signal");
	return { cost, reasons };
}

function routeFor(kind: AssumptionKind, risk: RiskBand): AssumptionRoute {
	if (risk === "low") return "self";
	return kind === "domain-fact" ? "team" : "founder";
}

export function scoreAssumption(input: ScoreAssumptionInput): ScoredAssumption {
	const assumption = normalizeAssumption(input.assumption);
	const confidence = normalizeConfidence(assumption.confidence);
	const probabilityWrong = probabilityFromConfidence(confidence);
	const kind = classifyAssumptionKind(assumption.text);
	const { cost, reasons: costReasons } = computeCost(input, assumption);
	const risk = combineRisk(probabilityWrong, cost);
	const route = routeFor(kind, risk);
	const confidenceLabel = confidence ?? "missing";
	return {
		text: assumption.text,
		...(confidence ? { confidence } : {}),
		risk,
		route,
		kind,
		cost,
		reasons: [
			`confidence ${confidenceLabel} -> ${probabilityWrong} P(wrong)`,
			...costReasons,
			`risk ${risk}: ${probabilityWrong} P(wrong) x ${cost} cost`,
			`kind ${kind} -> route ${route}`,
		],
	};
}

export function scoreAssumptions(
	assumptions: Array<AssumptionForScoring | string> | undefined,
	ctx: AssumptionScoringContext = {},
): ScoredAssumption[] {
	return (assumptions ?? [])
		.map((assumption, index) => ({ index, score: scoreAssumption({ assumption, ctx, index }) }))
		.filter(({ score }) => score.text.length > 0)
		.sort((a, b) => {
			const riskDelta = RISK_VALUE[b.score.risk] - RISK_VALUE[a.score.risk];
			if (riskDelta !== 0) return riskDelta;
			const costDelta = RISK_VALUE[b.score.cost] - RISK_VALUE[a.score.cost];
			if (costDelta !== 0) return costDelta;
			return a.index - b.index;
		})
		.map(({ score }) => score);
}
