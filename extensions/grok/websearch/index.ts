/**
 * grok-web-search — web search powered by Grok's subscription-backed proxy.
 *
 * Mirrors the grok CLI's built-in `web_search` tool: it routes a query through
 * xAI's server-side web_search tool on the Responses API and returns a synthesized
 * answer with real URL citations. Works whenever Grok is authorised (`grok login`),
 * or with an explicit GROK_API_KEY / XAI_API_KEY.
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

const WebSearchParams = Type.Object({
	query: Type.String({ description: "The search query to run on the web. Be specific; include version numbers or dates for technical queries." }),
	allowed_domains: Type.Optional(
		Type.Array(Type.String(), {
			description: "Restrict results to these domains (e.g. [\"nodejs.org\"]). Most providers cap this at 5 domains.",
		}),
	),
	excluded_domains: Type.Optional(
		Type.Array(Type.String(), { description: "Exclude these domains from results (e.g. [\"reddit.com\"])." }),
	),
});

type WebSearchInput = {
	query: string;
	allowed_domains?: string[];
	excluded_domains?: string[];
};

interface WebSearchDetails {
	query: string;
	citations: Citation[];
	webCalls: number;
	mode: GrokSearchResult["mode"];
	model: string;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "grok-web-search",
		label: "Grok Web Search",
		description: [
			"Search the web for up-to-date information using Grok's server-side web search.",
			"Returns a synthesized answer with real source URLs (citations).",
			"Use this for current events, latest versions, docs, or anything past the model's training cutoff.",
			"Requires Grok to be authorised (run `grok login`) or a GROK_API_KEY/XAI_API_KEY.",
		].join(" "),
		promptSnippet: "Search the web via Grok and return an answer with cited source URLs.",
		parameters: WebSearchParams,

		async execute(_toolCallId, params: WebSearchInput, signal, onUpdate, _ctx) {
			const query = params.query?.trim();
			if (!query) {
				return {
					content: [{ type: "text", text: "grok-web-search requires a non-empty query." }],
					isError: true,
				};
			}

			try {
				const result = await runGrokSearch({
					input: query,
					tools: [
						{
							type: "web_search",
							...(params.allowed_domains?.length ? { allowed_domains: params.allowed_domains } : {}),
							...(params.excluded_domains?.length ? { excluded_domains: params.excluded_domains } : {}),
						},
					],
					signal,
					onText: onUpdate
						? (text) => onUpdate({ content: [{ type: "text", text: text || "(searching…)" }] })
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
													: `(searching the web… ${p.webCalls} result${p.webCalls === 1 ? "" : "s"} so far)`,
										},
									],
								})
						: undefined,
				});

				const details: WebSearchDetails = {
					query,
					citations: result.citations,
					webCalls: result.toolCalls.web,
					mode: result.mode,
					model: result.model,
				};

				return {
					content: [{ type: "text", text: formatSearchMarkdown(result) }],
					details,
				};
			} catch (err) {
				if ((err as Error)?.name === "AbortError") {
					return { content: [{ type: "text", text: "grok-web-search aborted." }], isError: true };
				}
				const prefix = err instanceof GrokAuthError ? "Grok not authorised" : "grok-web-search failed";
				return {
					content: [{ type: "text", text: `${prefix}: ${(err as Error).message}` }],
					isError: true,
				};
			}
		},

		renderCall(args: WebSearchInput, theme) {
			let text = theme.fg("toolTitle", theme.bold("grok-web-search "));
			text += theme.fg("accent", args.query || "…");
			const scopes: string[] = [];
			if (args.allowed_domains?.length) scopes.push(`only ${args.allowed_domains.join(", ")}`);
			if (args.excluded_domains?.length) scopes.push(`not ${args.excluded_domains.join(", ")}`);
			if (scopes.length) text += theme.fg("dim", ` [${scopes.join("; ")}]`);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as WebSearchDetails | undefined;
			const body = result.content[0];
			const bodyText = body?.type === "text" ? body.text : "(no output)";

			if (result.isError) {
				return new Text(theme.fg("error", bodyText), 0, 0);
			}
			if (!details) {
				return new Text(bodyText, 0, 0);
			}

			const callCount = details.webCalls;
			const header =
				theme.fg("success", "✓ ") +
				theme.fg("toolTitle", theme.bold("grok-web-search ")) +
				theme.fg("muted", `${callCount} search${callCount === 1 ? "" : "es"} · ${details.citations.length} source${details.citations.length === 1 ? "" : "s"}`) +
				theme.fg("dim", ` · ${details.mode}`);

			const answer = details.citations.length
				? bodyText.split("\nSources:")[0].trimEnd()
				: bodyText;
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
