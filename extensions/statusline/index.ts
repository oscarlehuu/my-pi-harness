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
import { execFile } from "node:child_process";

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
			let git = { unstaged: 0, staged: 0, ahead: 0, behind: 0 };
			let refreshing = false;

			const refreshGit = () => {
				if (refreshing) return;
				refreshing = true;

				const gitCwd = ctx.sessionManager?.getCwd?.() || ctx.cwd || process.cwd();

				const p1 = new Promise<string>((resolve, reject) => {
					execFile("git", ["--no-optional-locks", "status", "--porcelain=v1"], { cwd: gitCwd, timeout: 1500 }, (error, stdout) => {
						if (error) reject(error);
						else resolve(stdout || "");
					});
				});

				const p2 = new Promise<string>((resolve, reject) => {
					execFile("git", ["--no-optional-locks", "rev-list", "--left-right", "--count", "HEAD...@{upstream}"], { cwd: gitCwd, timeout: 1500 }, (error, stdout) => {
						if (error) reject(error);
						else resolve(stdout || "");
					});
				});

				Promise.allSettled([p1, p2]).then(([r1, r2]) => {
					try {
						let newUnstaged = 0;
						let newStaged = 0;
						let newAhead = 0;
						let newBehind = 0;

						if (r1.status === "fulfilled") {
							const lines = r1.value.split("\n");
							for (const line of lines) {
								if (line.length >= 2) {
									const c0 = line[0];
									const c1 = line[1];
									if (c0 !== " " && c0 !== "?") {
										newStaged++;
									}
									if (c1 !== " ") {
										newUnstaged++;
									}
								}
							}
						}

						if (r2.status === "fulfilled") {
							const parts = r2.value.trim().split(/\s+/);
							if (parts.length >= 2) {
								newAhead = parseInt(parts[0], 10) || 0;
								newBehind = parseInt(parts[1], 10) || 0;
							}
						}

						if (
							newUnstaged !== git.unstaged ||
							newStaged !== git.staged ||
							newAhead !== git.ahead ||
							newBehind !== git.behind
						) {
							git = {
								unstaged: newUnstaged,
								staged: newStaged,
								ahead: newAhead,
								behind: newBehind
							};
							tui.requestRender?.();
						}
					} catch (e) {
						// Swallow
					} finally {
						refreshing = false;
					}
				});
			};

			const unsub = typeof footerData?.onBranchChange === "function"
				? footerData.onBranchChange(() => {
					refreshGit();
					tui.requestRender?.();
				})
				: undefined;

			refreshGit();
			const gitTimer = setInterval(refreshGit, 2500);

			return {
				dispose() {
					clearInterval(gitTimer);
					if (unsub) {
						unsub();
					}
				},
				invalidate() {},
				render(width: number): string[] {
					const lines: string[] = [];
					const NARROW = 60;

					// LINE 1 (context/location group): [✎ session-name (accent)]  [⎇ branch (+warning git indicators)]  [cwd (dim)]
					const line1Parts: string[] = [];
					const name = ctx.sessionManager?.getSessionName?.();
					if (name) {
						line1Parts.push(theme.fg("accent", `✎ ${name}`));
					}

					const branch = footerData?.getGitBranch?.();
					let branchText = "";
					if (branch) {
						const indicators: string[] = [];
						if (git.unstaged > 0) {
							indicators.push(`${git.unstaged}`);
						}
						if (git.staged > 0) {
							indicators.push(`+${git.staged}`);
						}
						if (git.ahead > 0) {
							indicators.push(`${git.ahead}↑`);
						}
						if (git.behind > 0) {
							indicators.push(`${git.behind}↓`);
						}

						const branchPart = theme.fg("dim", `⎇ ${branch}`);
						if (indicators.length > 0) {
							branchText = branchPart + " " + theme.fg("warning", `(${indicators.join(", ")})`);
						} else {
							branchText = branchPart;
						}
					}
					if (branchText) {
						line1Parts.push(branchText);
					}

					const home = process.env.HOME || process.env.USERPROFILE || "";
					let cwd = ctx.sessionManager?.getCwd?.() || ctx.cwd || "";
					if (cwd) {
						if (home && cwd.startsWith(home)) {
							cwd = "~" + cwd.slice(home.length);
						}
						if (width >= NARROW) {
							line1Parts.push(theme.fg("dim", cwd));
						}
					}

					const line1 = line1Parts.join("  ");
					lines.push(truncateToWidth(line1, width));

					// LINE 2 (stats group): [context bar+% (themed)]  [↑in ↓out (dim)]  [$cost (dim)]   ...right-aligned... [model (+ • thinking) (dim)]
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

					const tokensPart = theme.fg("dim", `↑${fmt(input)} ↓${fmt(output)}`);
					const costPart = theme.fg("dim", `$${cost.toFixed(3)}`);

					const modelId = ctx.model?.id || "no-model";
					let rightText = modelId;
					if (ctx.model?.reasoning) {
						const lvl = (typeof pi.getThinkingLevel === "function" ? pi.getThinkingLevel() : undefined) || "off";
						rightText = lvl === "off" ? `${modelId} • thinking off` : `${modelId} • ${lvl}`;
					}
					const right = theme.fg("dim", rightText);

					let showCost = true;
					let showTokens = true;

					const getLeft = () => {
						const parts: string[] = [];
						if (contextUsageStr) {
							parts.push(contextUsageStr);
						}
						if (showTokens) {
							parts.push(tokensPart);
						}
						if (showCost) {
							parts.push(costPart);
						}
						return parts.join("  ");
					};

					if (showCost) {
						const left = getLeft();
						if (visibleWidth(left) + 2 + visibleWidth(right) > width) {
							showCost = false;
						}
					}
					if (showTokens) {
						const left = getLeft();
						if (visibleWidth(left) + 2 + visibleWidth(right) > width) {
							showTokens = false;
						}
					}

					const left = getLeft();
					const pad = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)));
					lines.push(truncateToWidth(left + pad + right, width));

					// Line 3+ (CRITICAL no-regression): const m = footerData.getExtensionStatuses(); if (m.size > 0) sort [...m.entries()] by key alphabetically, map to the status text, join by " ", push truncateToWidth(line, width, theme.fg("dim","…")).
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
