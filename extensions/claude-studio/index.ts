import type { BashToolDetails, EditToolDetails, ExtensionAPI, ReadToolDetails } from "@earendil-works/pi-coding-agent";
import { createBashTool, createEditTool, createReadTool, createWriteTool, keyHint } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

export default function (pi: ExtensionAPI) {
	const cwd = process.cwd();

	// --- Working indicator / Spinner ---
	try {
		const theme = pi.ui?.theme;
		if (theme) {
			pi.ui.setWorkingIndicator({
				frames: [
					theme.fg("dim", "·"),
					theme.fg("muted", "•"),
					theme.fg("accent", "●"),
					theme.fg("muted", "•")
				],
				intervalMs: 120
			});
		}
	} catch {
		// best-effort
	}

	pi.on("session_start", () => {
		try {
			const theme = pi.ui?.theme;
			if (theme) {
				pi.ui.setWorkingIndicator({
					frames: [
						theme.fg("dim", "·"),
						theme.fg("muted", "•"),
						theme.fg("accent", "●"),
						theme.fg("muted", "•")
					],
					intervalMs: 120
				});
			}
		} catch {
			// best-effort
		}
		try {
			if (typeof pi.ui?.setWorkingMessage === "function") {
				pi.ui.setWorkingMessage("cooking");
			}
		} catch {
			// best-effort
		}
	});

	// NOTE: Overriding user/assistant message rendering would go here using registerMessageRenderer if desired,
	// but is skipped for safety as core message stream rendering is not overridden this round.

	// --- Read tool ---
	const originalRead = createReadTool(cwd);
	pi.registerTool({
		name: "read",
		label: "read",
		description: originalRead.description,
		parameters: originalRead.parameters,

		async execute(toolCallId, params, signal, onUpdate) {
			return originalRead.execute(toolCallId, params, signal, onUpdate);
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("read "));
			text += theme.fg("accent", args.path ?? "");
			if (args.offset || args.limit) {
				const parts: string[] = [];
				if (args.offset) parts.push(`offset=${args.offset}`);
				if (args.limit) parts.push(`limit=${args.limit}`);
				text += theme.fg("dim", ` (${parts.join(", ")})`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme, _context) {
			try {
				if (isPartial) {
					return new Text(theme.fg("warning", "Reading..."), 0, 0);
				}

				const details = result?.details as ReadToolDetails | undefined;
				const content = result?.content?.[0];

				if (content?.type === "image") {
					return new Text(theme.fg("success", "Image loaded"), 0, 0);
				}

				if (content?.type !== "text" || typeof content?.text !== "string") {
					return new Text(theme.fg("error", "No content"), 0, 0);
				}

				const lines = content.text.split("\n");
				const lineCount = lines.length;

				let summary = theme.fg("success", `${lineCount} lines`);
				if (details?.truncation?.truncated) {
					summary += theme.fg("warning", ` (truncated from ${details.truncation.totalLines})`);
				}

				if (expanded) {
					let detailText = summary;
					const visibleLines = lines.slice(0, 15);
					for (const line of visibleLines) {
						detailText += `\n${theme.fg("dim", line)}`;
					}
					if (lineCount > 15) {
						detailText += `\n${theme.fg("muted", `... ${lineCount - 15} more lines`)}`;
					}
					return new Text(detailText, 0, 0);
				}

				// collapsed: append expand hint if there is more detail to see (e.g. lineCount > 0)
				let text = summary;
				if (lineCount > 0) {
					text += theme.fg("dim", ` (${keyHint("app.tools.expand", "expand")})`);
				}
				return new Text(text, 0, 0);
			} catch (e) {
				return new Text(theme.fg("error", "Error rendering read result"), 0, 0);
			}
		}
	});

	// --- Bash tool ---
	const originalBash = createBashTool(cwd);
	pi.registerTool({
		name: "bash",
		label: "bash",
		description: originalBash.description,
		parameters: originalBash.parameters,

		async execute(toolCallId, params, signal, onUpdate) {
			return originalBash.execute(toolCallId, params, signal, onUpdate);
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("$ "));
			const cmd = (args.command ?? "").length > 80 ? `${(args.command ?? "").slice(0, 77)}...` : (args.command ?? "");
			text += theme.fg("accent", cmd);
			if (args.timeout) {
				text += theme.fg("dim", ` (timeout: ${args.timeout}s)`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme, _context) {
			try {
				if (isPartial) {
					return new Text(theme.fg("warning", "Running..."), 0, 0);
				}

				const details = result?.details as BashToolDetails | undefined;
				const content = result?.content?.[0];
				const output = content?.type === "text" && typeof content?.text === "string" ? content.text : "";

				const exitMatch = output.match(/exit code: (\d+)/);
				const exitCode = exitMatch ? parseInt(exitMatch[1], 10) : null;
				const outputLines = output.split("\n");
				const lineCount = outputLines.filter((l) => l.trim()).length;

				let status = "";
				if (exitCode === 0 || exitCode === null) {
					status += theme.fg("success", "done");
				} else {
					status += theme.fg("error", `exit ${exitCode}`);
				}
				status += theme.fg("dim", ` (${lineCount} lines)`);

				if (details?.truncation?.truncated) {
					status += theme.fg("warning", " [truncated]");
				}

				if (expanded) {
					let detailText = status;
					const visibleLines = outputLines.slice(0, 20);
					for (const line of visibleLines) {
						detailText += `\n${theme.fg("dim", line)}`;
					}
					if (outputLines.length > 20) {
						detailText += `\n${theme.fg("muted", "... more output")}`;
					}
					return new Text(detailText, 0, 0);
				}

				// collapsed: append expand hint if there is more output to see (e.g. lineCount > 0)
				let text = status;
				if (lineCount > 0) {
					text += theme.fg("dim", ` (${keyHint("app.tools.expand", "expand")})`);
				}
				return new Text(text, 0, 0);
			} catch (e) {
				return new Text(theme.fg("error", "Error rendering bash result"), 0, 0);
			}
		}
	});

	// --- Edit tool ---
	const originalEdit = createEditTool(cwd);
	pi.registerTool({
		name: "edit",
		label: "edit",
		description: originalEdit.description,
		parameters: originalEdit.parameters,
		renderShell: "self",

		async execute(toolCallId, params, signal, onUpdate) {
			return originalEdit.execute(toolCallId, params, signal, onUpdate);
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("edit "));
			text += theme.fg("accent", args.path ?? "");
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme, _context) {
			try {
				if (isPartial) {
					return new Text(theme.fg("warning", "Editing..."), 0, 0);
				}

				const details = result?.details as EditToolDetails | undefined;
				const content = result?.content?.[0];

				if (content?.type === "text" && content.text.startsWith("Error")) {
					return new Text(theme.fg("error", content.text.split("\n")[0]), 0, 0);
				}

				if (!details?.diff) {
					return new Text(theme.fg("success", "Applied"), 0, 0);
				}

				const diffLines = details.diff.split("\n");
				let additions = 0;
				let removals = 0;
				for (const line of diffLines) {
					if (line.startsWith("+") && !line.startsWith("+++")) additions++;
					if (line.startsWith("-") && !line.startsWith("---")) removals++;
				}

				let stats = theme.fg("success", `+${additions}`);
				stats += theme.fg("dim", " / ");
				stats += theme.fg("error", `-${removals}`);

				if (expanded) {
					let detailText = stats;
					const visibleLines = diffLines.slice(0, 40);
					for (const line of visibleLines) {
						if (line.startsWith("+") && !line.startsWith("+++")) {
							detailText += `\n${theme.fg("toolDiffAdded", line)}`;
						} else if (line.startsWith("-") && !line.startsWith("---")) {
							detailText += `\n${theme.fg("toolDiffRemoved", line)}`;
						} else {
							detailText += `\n${theme.fg("toolDiffContext", line)}`;
						}
					}
					if (diffLines.length > 40) {
						detailText += `\n${theme.fg("muted", `... ${diffLines.length - 40} more diff lines`)}`;
					}
					return new Text(detailText, 0, 0);
				}

				// collapsed: append expand hint if there are changes to see
				let text = stats;
				if (additions > 0 || removals > 0) {
					text += theme.fg("dim", ` (${keyHint("app.tools.expand", "expand")})`);
				}
				return new Text(text, 0, 0);
			} catch (e) {
				return new Text(theme.fg("error", "Error rendering edit result"), 0, 0);
			}
		}
	});

	// --- Write tool ---
	const originalWrite = createWriteTool(cwd);
	pi.registerTool({
		name: "write",
		label: "write",
		description: originalWrite.description,
		parameters: originalWrite.parameters,

		async execute(toolCallId, params, signal, onUpdate) {
			return originalWrite.execute(toolCallId, params, signal, onUpdate);
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("write "));
			text += theme.fg("accent", args.path ?? "");
			const lineCount = (args.content ?? "").split("\n").length;
			text += theme.fg("dim", ` (${lineCount} lines)`);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme, _context) {
			try {
				if (isPartial) {
					return new Text(theme.fg("warning", "Writing..."), 0, 0);
				}

				const content = result?.content?.[0];
				if (content?.type === "text" && content.text.startsWith("Error")) {
					return new Text(theme.fg("error", content.text.split("\n")[0]), 0, 0);
				}

				const details = result?.details as { path?: string; size?: number; lines?: number } | undefined;
				const lines = details?.lines ?? 0;
				const size = details?.size ?? 0;

				let status = "";
				if (lines > 0) {
					status = theme.fg("success", `wrote ${lines} lines`);
				} else {
					status = theme.fg("success", "wrote");
				}

				if (expanded) {
					let detailText = status;
					if (details?.path) {
						detailText += `\n${theme.fg("dim", `Path: ${details.path}`)}`;
					}
					if (typeof size === "number") {
						detailText += `\n${theme.fg("dim", `Size: ${size} bytes`)}`;
					}
					return new Text(detailText, 0, 0);
				}

				// collapsed: append expand hint if there is path/size detail to see
				let text = status;
				if (details?.path || size > 0) {
					text += theme.fg("dim", ` (${keyHint("app.tools.expand", "expand")})`);
				}
				return new Text(text, 0, 0);
			} catch (e) {
				return new Text(theme.fg("error", "Error rendering write result"), 0, 0);
			}
		}
	});
}
