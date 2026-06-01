/**
 * Definition of Done helpers for Foreman.
 *
 * Pure / node-builtin-only: evaluates ledger/log-derived facts into one strict, machine-checked
 * doneness decision. The orchestrator owns all fs/pi/agent I/O and passes parsed log events in.
 */

export type DoneStatus = "pass" | "fail" | "warn" | "n/a";
export type DoneTesterState = "success" | "partial" | "blocked" | "fail";
export type DoneReviewerDecision = "approve" | "request-changes" | "unknown";

export interface DoneCheck {
	name: string;
	status: DoneStatus;
	detail: string;
}

export interface DonenessResult {
	done: boolean;
	blockers: string[];
	checklist: DoneCheck[];
}

export interface DonenessInput {
	gate1Approved: boolean;
	gate2Approved: boolean;
	latestTesterState?: DoneTesterState;
	perRoundCommandGatesPassed?: boolean;
	preShipCommandGatesPassed?: boolean;
	reviewerGateDeclared: boolean;
	reviewerDecision?: DoneReviewerDecision;
}

const TESTER_STATES = new Set<DoneTesterState>(["success", "partial", "blocked", "fail"]);
const REVIEWER_DECISIONS = new Set<DoneReviewerDecision>(["approve", "request-changes", "unknown"]);

function pushBlocker(blockers: string[], reason: string): void {
	if (!blockers.includes(reason)) blockers.push(reason);
}

function testerLabel(value: DoneTesterState | undefined): string {
	return value ?? "missing";
}

export function evaluateDoneness(input: DonenessInput): DonenessResult {
	const blockers: string[] = [];
	const checklist: DoneCheck[] = [];

	if (input.gate1Approved) {
		checklist.push({ name: "Plan approval", status: "pass", detail: "Gate 1 plan approved." });
	} else {
		pushBlocker(blockers, "plan not approved");
		checklist.push({ name: "Plan approval", status: "fail", detail: "Gate 1 plan is not approved." });
	}

	if (input.perRoundCommandGatesPassed === undefined) {
		checklist.push({ name: "Per-round command gates", status: "n/a", detail: "No per-round command gates ran." });
	} else if (input.perRoundCommandGatesPassed) {
		checklist.push({ name: "Per-round command gates", status: "pass", detail: "Latest per-round command gates passed." });
	} else {
		pushBlocker(blockers, "per-round command gates failed");
		checklist.push({ name: "Per-round command gates", status: "fail", detail: "Latest per-round command gates failed." });
	}

	if (input.latestTesterState === "success") {
		checklist.push({ name: "Tester judgment", status: "pass", detail: "Latest tester verdict is SUCCESS." });
	} else {
		pushBlocker(blockers, `tester verdict not success (${testerLabel(input.latestTesterState)})`);
		checklist.push({
			name: "Tester judgment",
			status: "fail",
			detail: `Latest tester verdict is ${testerLabel(input.latestTesterState)}; strict DoD requires SUCCESS.`,
		});
	}

	if (input.preShipCommandGatesPassed === undefined) {
		checklist.push({ name: "Pre-ship command gates", status: "n/a", detail: "No pre-ship command gates declared or ran." });
	} else if (input.preShipCommandGatesPassed) {
		checklist.push({ name: "Pre-ship command gates", status: "pass", detail: "Latest pre-ship command gates passed." });
	} else {
		pushBlocker(blockers, "pre-ship command gates failed");
		checklist.push({ name: "Pre-ship command gates", status: "fail", detail: "Latest pre-ship command gates failed." });
	}

	if (!input.reviewerGateDeclared) {
		checklist.push({ name: "Reviewer gate", status: "n/a", detail: "No pre-ship reviewer gate declared." });
	} else if (input.reviewerDecision === "approve") {
		checklist.push({ name: "Reviewer gate", status: "pass", detail: "Latest reviewer verdict cleanly APPROVED." });
	} else if (input.reviewerDecision === "request-changes") {
		pushBlocker(blockers, "reviewer requested changes");
		checklist.push({ name: "Reviewer gate", status: "fail", detail: "Latest reviewer verdict requested changes." });
	} else {
		const reason = "reviewer verdict inconclusive — strict DoD requires a clean APPROVE";
		pushBlocker(blockers, reason);
		checklist.push({
			name: "Reviewer gate",
			status: "warn",
			detail: input.reviewerDecision === "unknown" ? "Latest reviewer verdict was UNKNOWN." : "No reviewer verdict recorded.",
		});
	}

	if (input.gate2Approved) {
		checklist.push({ name: "Founder ship approval", status: "pass", detail: "Gate 2 founder sign-off is approved." });
	} else {
		pushBlocker(blockers, "founder ship approval missing");
		checklist.push({ name: "Founder ship approval", status: "fail", detail: "Gate 2 founder sign-off is missing." });
	}

	return { done: blockers.length === 0, blockers, checklist };
}

function iconFor(status: DoneStatus): string {
	if (status === "pass") return "✓";
	if (status === "fail") return "✗";
	if (status === "warn") return "⚠";
	return "–";
}

export function renderDoneChecklist(result: DonenessResult): string {
	const lines = ["Definition of Done:"];
	for (const check of result.checklist) {
		lines.push(`${iconFor(check.status)} ${check.name}: ${check.detail}`);
	}
	if (result.blockers.length) {
		lines.push("Blockers:", ...result.blockers.map((blocker) => `- ${blocker}`));
	} else {
		lines.push("Blockers: none");
	}
	return lines.join("\n");
}

function isTesterState(value: unknown): value is DoneTesterState {
	return typeof value === "string" && TESTER_STATES.has(value as DoneTesterState);
}

function isReviewerDecision(value: unknown): value is DoneReviewerDecision {
	return typeof value === "string" && REVIEWER_DECISIONS.has(value as DoneReviewerDecision);
}

export function extractDonenessInputs(
	events: Array<Record<string, unknown>>,
	opts: { gate1Approved: boolean; gate2Approved: boolean; reviewerGateDeclared: boolean },
): DonenessInput {
	let latestTesterState: DoneTesterState | undefined;
	let perRoundCommandGatesPassed: boolean | undefined;
	let preShipCommandGatesPassed: boolean | undefined;
	let reviewerDecision: DoneReviewerDecision | undefined;

	for (const event of events) {
		if (event.type === "verdict" && isTesterState(event.successState)) {
			latestTesterState = event.successState;
		}
		if (event.type === "verify_ran" && typeof event.exitCode === "number") {
			perRoundCommandGatesPassed = event.exitCode === 0;
		}
		if (event.type === "pre_ship_command_gates_ran" && typeof event.passed === "boolean") {
			preShipCommandGatesPassed = event.passed;
		}
		if (event.type === "pre_ship_reviewer_verdict" && isReviewerDecision(event.decision)) {
			reviewerDecision = event.decision;
		}
	}

	return {
		gate1Approved: opts.gate1Approved,
		gate2Approved: opts.gate2Approved,
		latestTesterState,
		perRoundCommandGatesPassed,
		preShipCommandGatesPassed,
		reviewerGateDeclared: opts.reviewerGateDeclared,
		reviewerDecision,
	};
}
