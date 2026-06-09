/**
 * FOREMAN INTEGRATION SEAM
 *
 * This extension replaces the default pi footer via ctx.ui.setFooter().
 *
 * To avoid losing foreman/continual-learning status line outputs, we preserve
 * the extension statuses line by querying `footerData.getExtensionStatuses()`,
 * sorting them alphabetically, and rendering them on Line 2+.
 *
 * This allows foreman (or any other extension) to update the status line
 * dynamically via `ctx.ui.setStatus("foreman", <text>)` without creating a hard
 * compile-time or import dependency between statusline and foreman.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AssistantMessage } from "@earendil-works/pi-ai";

function sanitizeStatusText(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

function fmt(n: number): string {
	if (n < 1000) {
		return `${n}`;
	}
	return `${(n / 1000).toFixed(1)}k`;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsub = typeof footerData?.onBranchChange === "function"
				? footerData.onBranchChange(() => tui.requestRender())
				: undefined;

			return {
				dispose() {
					if (unsub) {
						unsub();
					}
				},
				invalidate() {},
				render(width: number): string[] {
					const lines: string[] = [];

					// a) Context bar + %
					let contextUsageStr: string | undefined;
					const contextUsage = ctx.getContextUsage?.();
					const contextWindow = contextUsage?.contextWindow;
					
					if (contextWindow) {
						const percent = contextUsage?.percent;
						if (percent === null || percent === undefined) {
							contextUsageStr = "?";
						} else {
							const filledCount = Math.max(0, Math.min(12, Math.round((percent / 100) * 12)));
							const bar = "▰".repeat(filledCount) + "▱".repeat(12 - filledCount);
							const text = `${bar} ${Math.round(percent)}%`;
							const color = percent > 90 ? "error" : percent > 70 ? "warning" : "success";
							contextUsageStr = theme.fg(color, text);
						}
					}

					// b) Git branch
					const branch = footerData?.getGitBranch?.();

					// c) Cost/tokens
					let input = 0;
					let output = 0;
					let cost = 0;
					const branchEntries = ctx.sessionManager?.getBranch?.() || [];
					if (Array.isArray(branchEntries)) {
						for (const entry of branchEntries) {
							if (entry?.type === "message" && entry?.message?.role === "assistant") {
								const m = entry.message as AssistantMessage;
								if (m?.usage) {
									if (typeof m.usage.input === "number") input += m.usage.input;
									if (typeof m.usage.output === "number") output += m.usage.output;
									if (typeof m.usage.cost?.total === "number") cost += m.usage.cost.total;
								}
							}
						}
					}

					// LAYOUT
					// Line 1: left group = [context bar, "⎇ branch", cost/tokens] present-only, joined by "  "; wrap muted parts in theme.fg("dim", ...)
					const leftParts: string[] = [];
					if (contextUsageStr) {
						leftParts.push(contextUsageStr);
					}
					if (branch) {
						leftParts.push(theme.fg("dim", `⎇ ${branch}`));
					}
					leftParts.push(theme.fg("dim", `↑${fmt(input)} ↓${fmt(output)} $${cost.toFixed(3)}`));
					
					const left = leftParts.join("  ");
					const right = theme.fg("dim", ctx.model?.id || "no-model");
					
					const pad = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)));
					lines.push(truncateToWidth(left + pad + right, width));

					// Line 2+ (CRITICAL no-regression): const m = footerData.getExtensionStatuses(); if (m.size > 0) sort [...m.entries()] by key alphabetically, map to the status text, join by " ", push truncateToWidth(line, width, theme.fg("dim","…")).
					const extensionStatuses = footerData?.getExtensionStatuses?.();
					if (extensionStatuses && extensionStatuses.size > 0) {
						const sortedStatuses = Array.from(extensionStatuses.entries())
							.sort(([a], [b]) => a.localeCompare(b))
							.map(([, text]) => sanitizeStatusText(text));
						const statusLine = sortedStatuses.join(" ");
						lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "…")));
					}

					return lines;
				}
			};
		});
	});
}
