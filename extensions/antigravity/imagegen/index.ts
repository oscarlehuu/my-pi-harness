/**
 * antigravity-image-gen — image generation via Antigravity's generate_image tool.
 *
 * Calls the user's local cli-proxy-api (`/v1/chat/completions`) with the
 * reverse-engineered Antigravity image model (`gemini-3.1-flash-image`). The
 * proxy owns the Antigravity Google OAuth credentials; the response carries
 * data-URI image bytes in `message.images`, which we save to disk and return
 * inline as ImageContent.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { ANTIGRAVITY_IMAGE_MODEL, AntigravityAuthError, generateImage } from "../_shared/antigravityClient.ts";

const ReasoningEffortParam = Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")], {
	description: "Optional reasoning effort for the OpenAI-compatible chat call. Defaults to low for reliable image emission.",
	default: "low",
});

const ImageGenParams = Type.Object({
	prompt: Type.String({ description: "Image prompt to generate." }),
	n: Type.Optional(Type.Number({ minimum: 1, maximum: 10, description: "Number of images to generate (1-10)." })),
	model: Type.Optional(
		Type.String({ description: `Optional image model override. Defaults to ${ANTIGRAVITY_IMAGE_MODEL} (Antigravity's Gemini flash-image model).` }),
	),
	reasoning_effort: Type.Optional(ReasoningEffortParam),
	output: Type.Optional(Type.String({ description: "Optional output filename. Basename only is used and sanitized." })),
});

type ReasoningEffort = "low" | "medium" | "high";

type ImageGenInput = {
	prompt: string;
	n?: number;
	model?: string;
	reasoning_effort?: ReasoningEffort;
	output?: string;
};

interface ImageGenDetails {
	prompt: string;
	paths: string[];
	mimeTypes: string[];
	n: number;
	model: string;
	reasoningEffort: ReasoningEffort;
	baseUrl: string;
}

function promptPreview(text: string, max = 90): string {
	const clean = text.replace(/\s+/g, " ").trim();
	return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "antigravity-image-gen",
		label: "Antigravity Image Gen",
		description: [
			"Generate images through Antigravity CLI's reverse-engineered generate_image backend.",
			"Routes via the user's local cli-proxy-api OpenAI-compatible endpoint.",
			"Saves each image to disk and returns inline image content.",
		].join(" "),
		promptSnippet: "Generate images via Antigravity/Gemini flash-image; saves files and returns inline images.",
		parameters: ImageGenParams,

		async execute(_toolCallId, params: ImageGenInput, signal, onUpdate, _ctx) {
			const prompt = params.prompt?.trim();
			if (!prompt) {
				return { content: [{ type: "text", text: "antigravity-image-gen requires a non-empty prompt." }], isError: true } as any;
			}

			try {
				const result = await generateImage({
					prompt,
					n: params.n,
					model: params.model,
					reasoningEffort: params.reasoning_effort ?? "low",
					output: params.output,
					signal,
					onProgress: onUpdate
						? (p) =>
								onUpdate({
									content: [
										{
											type: "text",
											text:
												p.phase === "retrying"
													? `Antigravity image proxy busy, retrying… attempt ${(p.attempt ?? 1) + 1}`
													: "generating image…",
										},
									],
									details: undefined,
								} as any)
						: undefined,
				});

				const details: ImageGenDetails = {
					prompt,
					paths: result.images.map((img) => img.path),
					mimeTypes: result.images.map((img) => img.mimeType),
					n: result.images.length,
					model: result.model,
					reasoningEffort: params.reasoning_effort ?? "low",
					baseUrl: result.baseUrl,
				};
				const text = result.images.map((img) => `Image saved to ${img.path}`).join("\n");
				return {
					content: [
						{ type: "text", text },
						...result.images.map((img) => ({ type: "image", data: img.b64, mimeType: img.mimeType })),
					],
					details,
				};
			} catch (err) {
				if ((err as Error)?.name === "AbortError") {
					return { content: [{ type: "text", text: "antigravity-image-gen aborted." }], isError: true } as any;
				}
				const prefix = err instanceof AntigravityAuthError ? "Antigravity not available" : "antigravity-image-gen failed";
				return { content: [{ type: "text", text: `${prefix}: ${(err as Error).message}` }], isError: true } as any;
			}
		},

		renderCall(args: ImageGenInput, theme) {
			let text = theme.fg("toolTitle", theme.bold("antigravity-image-gen "));
			text += theme.fg("accent", promptPreview(args.prompt || "…"));
			const opts = [args.model, args.reasoning_effort, args.n ? `n=${args.n}` : undefined].filter(Boolean);
			if (opts.length) text += theme.fg("dim", ` [${opts.join(" · ")}]`);
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as ImageGenDetails | undefined;
			const body = result.content.find((part) => part.type === "text");
			const bodyText = body?.type === "text" ? body.text : "(no output)";
			if ((result as any).isError) return new Text(theme.fg("error", bodyText), 0, 0);
			if (!details) return new Text(bodyText, 0, 0);

			let text =
				theme.fg("success", "✓ ") +
				theme.fg("toolTitle", theme.bold("antigravity-image-gen ")) +
				theme.fg("muted", `${details.paths.length} image${details.paths.length === 1 ? "" : "s"} saved`) +
				theme.fg("dim", ` · ${details.model}`);
			for (const p of details.paths) text += `\n${theme.fg("accent", p)}`;
			return new Text(text, 0, 0);
		},
	});
}
