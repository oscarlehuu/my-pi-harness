import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type ConvoMessage, generateTitle, messageText } from "./namer.ts";

function promptProducedTurn(messages: ReadonlyArray<ConvoMessage & { stopReason?: string }>): boolean {
	return messages.some((message) => message.role === "assistant" && message.stopReason !== "aborted" && message.stopReason !== "error");
}

function hasUserText(messages: ReadonlyArray<ConvoMessage>): boolean {
	return messages.some((message) => message.role === "user" && messageText(message).trim().length > 0);
}

function sessionKey(ctx: { sessionManager?: { getSessionFile?: () => string | undefined; getSessionId?: () => string | undefined } }): string {
	return ctx.sessionManager?.getSessionFile?.() ?? ctx.sessionManager?.getSessionId?.() ?? "nofile";
}

function snapshotFromSessionManager(ctx: { sessionManager?: { getBranch?: () => unknown[] } }): ConvoMessage[] {
	try {
		const entries = ctx.sessionManager?.getBranch?.();
		if (!Array.isArray(entries)) return [];
		return entries
			.filter((entry): entry is { type: string; message: ConvoMessage } => {
				if (!entry || typeof entry !== "object") return false;
				const typed = entry as { type?: unknown; message?: unknown };
				return typed.type === "message" && Boolean(typed.message) && typeof typed.message === "object";
			})
			.map((entry) => entry.message);
	} catch {
		return [];
	}
}

function crewSession(): boolean {
	return process.env.SESSION_NAMER_CREW === "1" || process.env.FOREMAN_CREW === "1" || process.env.CONTINUAL_LEARNING_CREW === "1";
}

function notify(ctx: { ui?: { notify?: (message: string, type?: "info" | "warning" | "error") => void } }, message: string, type: "info" | "warning" | "error"): void {
	try {
		ctx.ui?.notify?.(message, type);
	} catch {
		// best-effort; swallow
	}
}

export default function (pi: ExtensionAPI) {
	const namedSessions = new Set<string>();
	let naming = false;
	let latestMessages: ConvoMessage[] = [];

	pi.on("agent_end", async (event, ctx) => {
		try {
			if (crewSession()) return;

			const messages = ((event.messages ?? []) as Array<ConvoMessage & { stopReason?: string }>).slice();
			latestMessages = messages;

			if (pi.getSessionName()?.trim()) return;

			const key = sessionKey(ctx);
			if (namedSessions.has(key) || naming) return;
			if (!promptProducedTurn(messages) || !hasUserText(messages)) return;

			// Name the session inline (awaited within the handler), NOT in a detached task: pi
			// marks the extension context stale once an agent_end handler returns, and the session
			// stops persisting, so a fire-and-forget pi.setSessionName() would update memory but
			// never reach disk. The context stays valid across awaits inside the handler, so the
			// short title fetch here is safe; generateTitle is best-effort and the turn is already
			// complete, so this only delays the next prompt by the title call.
			naming = true;
			try {
				const title = await generateTitle(messages, ctx.signal);
				if (title && !pi.getSessionName()?.trim()) {
					pi.setSessionName(title);
					namedSessions.add(key);
					notify(ctx, `Session named: ${title}`, "info");
				}
			} catch {
				// best-effort; swallow
			} finally {
				naming = false;
			}
		} catch {
			// best-effort; swallow
		}
	});

	pi.registerCommand("name-session", {
		description: "Generate a concise display name for the current session now.",
		handler: async (_args, ctx) => {
			if (crewSession()) return;
			if (naming) {
				notify(ctx, "Session naming already running.", "warning");
				return;
			}

			naming = true;
			try {
				const messages = snapshotFromSessionManager(ctx);
				const snapshot = messages.length ? messages : latestMessages;
				const title = await generateTitle(snapshot, ctx.signal);
				if (!title) {
					notify(ctx, "Session naming: no title generated.", "warning");
					return;
				}
				pi.setSessionName(title);
				namedSessions.add(sessionKey(ctx));
				notify(ctx, `Session named: ${title}`, "info");
			} catch {
				notify(ctx, "Session naming failed.", "warning");
			} finally {
				naming = false;
			}
		},
	});
}
