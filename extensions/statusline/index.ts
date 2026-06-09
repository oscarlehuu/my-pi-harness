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

const hexToRgb = (h: string) => {
	const n = parseInt(h.slice(1), 16);
	return [n >> 16 & 255, n >> 8 & 255, n & 255];
};
const FG = (h: string) => {
	const [r, g, b] = hexToRgb(h);
	return `\x1b[38;2;${r};${g};${b}m`;
};
const BG = (h: string) => {
	const [r, g, b] = hexToRgb(h);
	return `\x1b[48;2;${r};${g};${b}m`;
};
const RST = "\x1b[0m";

const CLAY = "#d97757";
const DARK = "#1a1815";
const SEL = "#2a2620";
const TOOL = "#211e19";
const OKBG = "#1e231a";
const CREAM = "#e8e6e3";
const SLATE = "#87867f";
const GOLD = "#d9a866";
const CORAL = "#d97066";
const SAGE = "#9bab7a";

class Powerline {
	private segments: { bg: string; fg: string; text: string }[] = [];
	add(bg: string, fg: string, text: string) {
		if (text) {
			this.segments.push({ bg, fg, text });
		}
		return this;
	}
	render(ascii: boolean): string {
		if (this.segments.length === 0) return "";
		if (ascii) {
			return this.segments.map(s => `${BG(s.bg)}${FG(s.fg)} ${s.text} ${RST}`).join(" ");
		} else {
			let result = "";
			for (let i = 0; i < this.segments.length; i++) {
				const s = this.segments[i];
				result += `${BG(s.bg)}${FG(s.fg)} ${s.text} `;
				if (i < this.segments.length - 1) {
					const next = this.segments[i + 1];
					result += `${BG(next.bg)}${FG(s.bg)}\uE0B0`;
				} else {
					result += `${RST}${FG(s.bg)}\uE0B0${RST}`;
				}
			}
			return result;
		}
	}
}

function shortenPath(p: string): string {
	if (!p) return "";
	const isHomeRelative = p.startsWith("~/");
	const parts = p.split(/[/\\]/).filter(Boolean);
	if (parts.length <= (isHomeRelative ? 2 : 1)) {
		return p;
	}
	const last = parts[parts.length - 1];
	return isHomeRelative ? `~/…/${last}` : `${p.startsWith("/") ? "/" : ""}…/${last}`;
}

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
					const isAscii = process.env.PI_STATUSLINE_ASCII === "1";

					if (width < 60) {
						// collapse to 2 plain lines (NO glyphs/bg, ASCII style regardless of env)
						const name = ctx.sessionManager?.getSessionName?.();
						const nameText = name ? `✎ ${name}` : "π pi";
						const branch = footerData?.getGitBranch?.();
						const branchPart = branch ? ` · ⎇ ${branch}` : "";
						const line1 = `${nameText}${branchPart}`;

						let percentText = "";
						const contextUsage = ctx.getContextUsage?.();
						const percent = contextUsage?.percent;
						if (percent !== null && percent !== undefined) {
							percentText = `${Math.round(percent)}% · `;
						}

						const modelId = ctx.model?.id || "no-model";
						let thinkingStr = "";
						if (ctx.model?.reasoning) {
							const lvl = (typeof pi.getThinkingLevel === "function" ? pi.getThinkingLevel() : undefined) || "off";
							thinkingStr = lvl === "off" ? " • thinking off" : ` • ${lvl}`;
						}
						const line2 = `${percentText}${modelId}${thinkingStr}`;

						lines.push(truncateToWidth(line1, width));
						lines.push(truncateToWidth(line2, width));
					} else {
						// LINE 1
						const pl1 = new Powerline();
						const name = ctx.sessionManager?.getSessionName?.();
						const nameText = name ? `✎ ${name}` : "π pi";
						pl1.add(CLAY, DARK, nameText);
						lines.push(truncateToWidth(pl1.render(isAscii), width));

						// LINE 2
						const pl2 = new Powerline();
						const branch = footerData?.getGitBranch?.();
						if (branch) {
							const indicators: string[] = [];
							if (git.unstaged > 0) indicators.push(`${git.unstaged}`);
							if (git.staged > 0) indicators.push(`+${git.staged}`);
							if (git.ahead > 0) indicators.push(`${git.ahead}↑`);
							if (git.behind > 0) indicators.push(`${git.behind}↓`);

							let branchText = `⎇ ${branch}`;
							if (indicators.length > 0) {
								// Indicators pop in GOLD for scan-by-color, then restore the segment's CREAM.
								branchText += ` ${FG(GOLD)}(${indicators.join(", ")})${FG(CREAM)}`;
							}
							pl2.add(SEL, CREAM, branchText);
						}

						const home = process.env.HOME || process.env.USERPROFILE || "";
						let cwd = ctx.sessionManager?.getCwd?.() || ctx.cwd || "";
						if (cwd) {
							if (home && cwd.startsWith(home)) {
								cwd = "~" + cwd.slice(home.length);
							}
							if (width < 90) {
								cwd = shortenPath(cwd);
								pl2.add(TOOL, SLATE, cwd);
							} else {
								pl2.add(TOOL, SLATE, `📁 ${cwd}`);
							}
						}
						lines.push(truncateToWidth(pl2.render(isAscii), width));

						// LINE 3
						const pl3 = new Powerline();
						const modelId = ctx.model?.id || "no-model";
						let modelText = modelId;
						if (ctx.model?.reasoning) {
							const lvl = (typeof pi.getThinkingLevel === "function" ? pi.getThinkingLevel() : undefined) || "off";
							modelText = lvl === "off" ? `${modelId} • thinking off` : `${modelId} • ${lvl}`;
						}
						const modelPrefix = (width >= 90) ? "🤖 " : "";
						pl3.add("#3a2a1f", CLAY, `${modelPrefix}${modelText}`);

						const contextUsage = ctx.getContextUsage?.();
						const percent = contextUsage?.percent;
						if (percent !== null && percent !== undefined) {
							const filledCount = Math.max(0, Math.min(12, Math.round((percent / 100) * 12)));
							const bar = "▰".repeat(filledCount) + "▱".repeat(12 - filledCount);
							const barText = `${bar} ${Math.round(percent)}%`;
							const barColor = percent > 90 ? CORAL : percent > 70 ? GOLD : SAGE;
							pl3.add(OKBG, barColor, barText);
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
						pl3.add(SEL, SLATE, `↑${fmt(input)} ↓${fmt(output)}`);
						pl3.add(SEL, GOLD, `$${cost.toFixed(3)}`);

						lines.push(truncateToWidth(pl3.render(isAscii), width));
					}

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
