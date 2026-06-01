/**
 * grok-x-search — X (Twitter) search powered by Grok's subscription-backed proxy.
 *
 * Mirrors the grok CLI's `x_search` tool: it routes a query through xAI's
 * server-side x_search tool on the Responses API and returns a synthesized
 * answer with real x.com post URLs. X search depends on Grok being authorised
 * (the proxy's X access rides on the logged-in xAI/X account), which is exactly
 * the "X search needs Grok authorised" behaviour the user described.
 *
 * See ../_shared/grokClient.ts for the reverse-engineered transport details.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	type Citation,
	type GrokSearchResult,
	GrokAuthError,
	formatSearchMarkdown,
	runGrokSearch,
} from "../_shared/grokClient.ts";

const ISO_DATE = "YYYY-MM-DD";

const XSearchParams = Type.Object({
	query: Type.String({ description: "What to search X (Twitter) for. Natural language; can include handles, topics, or hashtags." }),
	allowed_x_handles: Type.Optional(
		Type.Array(Type.String(), {
			description: `Restrict results to posts from these X handles (without @, e.g. ["xai", "elonmusk"]).`,
		}),
	),
	excluded_x_handles: Type.Optional(
		Type.Array(Type.String(), { description: "Exclude posts from these X handles (without @)." }),
	),
	from_date: Type.Optional(Type.String({ description: `Only include posts on/after this date (${ISO_DATE}).` })),
	to_date: Type.Optional(Type.String({ description: `Only include posts on/before this date (${ISO_DATE}).` })),
});

type XSearchInput = {
	query: string;
	allowed_x_handles?: string[];
	excluded_x_handles?: string[];
	from_date?: string;
	to_date?: string;
};

interface XSearchDetails {
	query: string;
	citations: Citation[];
	xCalls: number;
	handles?: string[];
	from?: string;
	to?: string;
	mode: GrokSearchResult["mode"];
	model: string;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "grok-x-search",
		label: "Grok X Search",
		description: [
			"Search X (Twitter) for posts using Grok's server-side X search.",
			"Returns a synthesized answer with real x.com post URLs.",
			"Use this for live sentiment, announcements, or what specific accounts are posting.",
			"Optionally filter by handles and a date range.",
			"Requires Grok to be authorised (run `grok login`); X access depends on the logged-in account.",
		].join(" "),
		promptSnippet: "Search X (Twitter) via Grok and return an answer with cited x.com post URLs.",
		parameters: XSearchParams,

		async execute(_toolCallId, params: XSearchInput, signal, onUpdate, _ctx) {
			const query = params.query?.trim();
			if (!query) {
				return {
					content: [{ type: "text", text: "grok-x-search requires a non-empty query." }],
					isError: true,
				};
			}

			for (const [label, value] of [
				["from_date", params.from_date],
				["to_date", params.to_date],
			] as const) {
				if (value && !ISO_DATE_RE.test(value)) {
					return {
						content: [{ type: "text", text: `grok-x-search: ${label} must be ${ISO_DATE} (got "${value}").` }],
						isError: true,
					};
				}
			}

			const handles = params.allowed_x_handles?.map(stripAt).filter(Boolean);
			const excluded = params.excluded_x_handles?.map(stripAt).filter(Boolean);

			try {
				const result = await runGrokSearch({
					input: query,
					tools: [
						{
							type: "x_search",
							...(handles?.length ? { allowed_x_handles: handles } : {}),
							...(excluded?.length ? { excluded_x_handles: excluded } : {}),
							...(params.from_date ? { from_date: params.from_date } : {}),
							...(params.to_date ? { to_date: params.to_date } : {}),
						},
					],
					signal,
					onText: onUpdate
						? (text) => onUpdate({ content: [{ type: "text", text: text || "(searching X…)" }] })
						: undefined,
					onProgress: onUpdate
						? (p) =>
								onUpdate({
									content: [
										{
											type: "text",
											text:
												p.phase === "retrying"
													? `(proxy busy, retrying… attempt ${p.attempt + 1})`
													: `(searching X… ${p.xCalls} result${p.xCalls === 1 ? "" : "s"} so far)`,
										},
									],
								})
						: undefined,
				});

				const details: XSearchDetails = {
					query,
					citations: result.citations,
					xCalls: result.toolCalls.x,
					handles,
					from: params.from_date,
					to: params.to_date,
					mode: result.mode,
					model: result.model,
				};

				return {
					content: [{ type: "text", text: formatSearchMarkdown(result) }],
					details,
				};
			} catch (err) {
				if ((err as Error)?.name === "AbortError") {
					return { content: [{ type: "text", text: "grok-x-search aborted." }], isError: true };
				}
				const prefix = err instanceof GrokAuthError ? "Grok not authorised" : "grok-x-search failed";
				return {
					content: [{ type: "text", text: `${prefix}: ${(err as Error).message}` }],
					isError: true,
				};
			}
		},

		renderCall(args: XSearchInput, theme) {
			let text = theme.fg("toolTitle", theme.bold("grok-x-search "));
			text += theme.fg("accent", args.query || "…");
			const scopes: string[] = [];
			if (args.allowed_x_handles?.length) scopes.push(`@${args.allowed_x_handles.map(stripAt).join(", @")}`);
			if (args.from_date || args.to_date) scopes.push(`${args.from_date ?? "…"}→${args.to_date ?? "…"}`);
			if (scopes.length) text += theme.fg("dim", ` [${scopes.join("; ")}]`);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as XSearchDetails | undefined;
			const body = result.content[0];
			const bodyText = body?.type === "text" ? body.text : "(no output)";

			if (result.isError) {
				return new Text(theme.fg("error", bodyText), 0, 0);
			}
			if (!details) {
				return new Text(bodyText, 0, 0);
			}

			const header =
				theme.fg("success", "✓ ") +
				theme.fg("toolTitle", theme.bold("grok-x-search ")) +
				theme.fg("muted", `${details.xCalls} search${details.xCalls === 1 ? "" : "es"} · ${details.citations.length} post${details.citations.length === 1 ? "" : "s"}`) +
				theme.fg("dim", ` · ${details.mode}`);

			const answer = details.citations.length ? bodyText.split("\nSources:")[0].trimEnd() : bodyText;
			const answerPreview = expanded ? answer : answer.split("\n").slice(0, 6).join("\n");

			let text = `${header}\n${theme.fg("toolOutput", answerPreview)}`;
			if (details.citations.length) {
				const shown = expanded ? details.citations : details.citations.slice(0, 4);
				text += "\n";
				shown.forEach((c, i) => {
					text += `\n${theme.fg("muted", `[${i + 1}] `)}${theme.fg("accent", c.url)}`;
				});
				if (!expanded && details.citations.length > shown.length) {
					text += `\n${theme.fg("muted", `… +${details.citations.length - shown.length} more (Ctrl+O to expand)`)}`;
				}
			}
			return new Text(text, 0, 0);
		},
	});
}

function stripAt(handle: string): string {
	return handle.trim().replace(/^@+/, "");
}
