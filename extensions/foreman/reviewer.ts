/**
 * Pre-ship reviewer helpers.
 *
 * Pure / node-builtin-only: parses the reviewer agent's REVIEW block and maps it to the
 * orchestrator's pre-ship decision. Unknown output is intentionally not approval; the controller
 * proceeds to Gate 2 flagged for the founder instead of looping forever on a flaky parse.
 */

export type ReviewDecision = "approve" | "request-changes" | "unknown";
export type ReviewGateAction = "proceed" | "reopen" | "proceed-but-flagged";

export interface ReviewVerdict {
	decision: ReviewDecision;
	blocking: string[];
	nits: string[];
}

export interface ReviewGateDecision {
	action: ReviewGateAction;
	reopen: boolean;
	proceedToGate2: boolean;
	flagged: boolean;
	reason: string;
}

function cleanSectionItem(line: string): string | null {
	const cleaned = line
		.replace(/^\s*(?:[-*•]\s*|\d+[.)]\s*)/, "")
		.trim()
		.replace(/^`+|`+$/g, "")
		.trim();
	if (!cleaned) return null;
	if (/^(?:none|n\/a|no\s+(?:blocking\s+)?issues?|no\s+nits?)$/i.test(cleaned)) return null;
	return cleaned;
}

function sectionName(line: string): "blocking" | "nits" | null {
	const m = line.match(/^\s*(BLOCKING|NITS?|NON[-\s]?BLOCKING)\s*:\s*(.*)$/i);
	if (!m) return null;
	return /^BLOCKING$/i.test(m[1]) ? "blocking" : "nits";
}

function inlineSectionItem(line: string): string | null {
	const m = line.match(/^\s*(?:BLOCKING|NITS?|NON[-\s]?BLOCKING)\s*:\s*(.*)$/i);
	return m ? cleanSectionItem(m[1]) : null;
}

function isOtherSectionHeader(line: string): boolean {
	if (sectionName(line)) return false;
	return /^\s*[A-Za-z][A-Za-z0-9 _/-]{1,40}\s*:\s*$/.test(line);
}

function collectSections(text: string): Pick<ReviewVerdict, "blocking" | "nits"> {
	const sections: Pick<ReviewVerdict, "blocking" | "nits"> = { blocking: [], nits: [] };
	let current: "blocking" | "nits" | null = null;

	for (const line of text.split(/\r?\n/)) {
		const next = sectionName(line);
		if (next) {
			current = next;
			const inline = inlineSectionItem(line);
			if (inline) sections[current].push(inline);
			continue;
		}
		if (!current) continue;
		if (/^\s*REVIEW\s*:/i.test(line) || isOtherSectionHeader(line)) {
			current = null;
			continue;
		}
		const item = cleanSectionItem(line);
		if (item) sections[current].push(item);
	}

	return sections;
}

export function parseReviewVerdict(text: string): ReviewVerdict {
	const sections = collectSections(text);
	const m = text.match(/^\s*REVIEW:\s*(APPROVE|REQUEST(?:[-_\s]+CHANGES)?)\b/im);
	if (!m) return { decision: "unknown", ...sections };

	const token = m[1].toUpperCase().replace(/[\s_]+/g, "-");
	if (token === "APPROVE") return { decision: "approve", ...sections };
	if (token === "REQUEST-CHANGES") return { decision: "request-changes", ...sections };
	return { decision: "unknown", ...sections };
}

export function decideReviewOutcome(review: ReviewVerdict): ReviewGateDecision {
	if (review.decision === "request-changes") {
		return {
			action: "reopen",
			reopen: true,
			proceedToGate2: false,
			flagged: false,
			reason: "reviewer requested blocking changes",
		};
	}
	if (review.decision === "approve") {
		return {
			action: "proceed",
			reopen: false,
			proceedToGate2: true,
			flagged: false,
			reason: "reviewer approved",
		};
	}
	return {
		action: "proceed-but-flagged",
		reopen: false,
		proceedToGate2: true,
		flagged: true,
		reason: "reviewer verdict was inconclusive",
	};
}
