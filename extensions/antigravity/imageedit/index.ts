/**
 * antigravity-image-edit — image-to-image through Antigravity's generate_image tool.
 *
 * Sends the edit prompt plus up to three reference images to the local
 * cli-proxy-api `/v1/chat/completions` endpoint as OpenAI multimodal content
 * parts. The Antigravity proxy returns data-URI image bytes in `message.images`;
 * we save every output and return inline ImageContent.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { ANTIGRAVITY_IMAGE_MODEL, AntigravityAuthError, editImage } from "../_shared/antigravityClient.ts";

const ReasoningEffortParam = Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")], {
	description: "Optional reasoning effort for the OpenAI-compatible chat call. Defaults to low for reliable image emission.",
	default: "low",
});

const ImageEditParams = Type.Object({
	prompt: Type.String({ description: "Edit instruction for the image(s)." }),
	image: Type.Union([
		Type.String({ description: "Input image path, data URI, or http(s) URL." }),
		Type.Array(Type.String(), { minItems: 1, maxItems: 3, description: "One to three input image paths, data URIs, or URLs." }),
	]),
	model: Type.Optional(
		Type.String({ description: `Optional image model override. Defaults to ${ANTIGRAVITY_IMAGE_MODEL} (Antigravity's Gemini flash-image model).` }),
	),
	reasoning_effort: Type.Optional(ReasoningEffortParam),
	output: Type.Optional(Type.String({ description: "Optional output filename. Basename only is used and sanitized." })),
});

type ReasoningEffort = "low" | "medium" | "high";

type ImageEditInput = {
	prompt: string;
	image: string | string[];
	model?: string;
	reasoning_effort?: ReasoningEffort;
	output?: string;
};

interface ImageEditDetails {
	prompt: string;
	inputCount: number;
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
		name: "antigravity-image-edit",
		label: "Antigravity Image Edit",
		description: [
			"Edit one or more images through Antigravity CLI's reverse-engineered generate_image backend.",
			"Input images can be local paths, data URIs, or http(s) URLs; up to 3 are supported.",
			"Saves each output image to disk and returns inline image content.",
		].join(" "),
		promptSnippet: "Edit images via Antigravity/Gemini flash-image; accepts paths/data-URIs/URLs and returns saved inline images.",
		parameters: ImageEditParams,

		async execute(_toolCallId, params: ImageEditInput, signal, onUpdate, ctx) {
			const prompt = params.prompt?.trim();
			if (!prompt) {
				return { content: [{ type: "text", text: "antigravity-image-edit requires a non-empty prompt." }], isError: true } as any;
			}
			const images = Array.isArray(params.image) ? params.image : [params.image];
			if (!images.length || images.some((img) => !img?.trim())) {
				return { content: [{ type: "text", text: "antigravity-image-edit requires at least one image." }], isError: true } as any;
			}
			if (images.length > 3) {
				return { content: [{ type: "text", text: "antigravity-image-edit accepts at most 3 input images." }], isError: true } as any;
			}

			try {
				const result = await editImage({
					prompt,
					image: images,
					model: params.model,
					reasoningEffort: params.reasoning_effort ?? "low",
					output: params.output,
					cwd: ctx.cwd,
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
													: "editing image…",
										},
									],
									details: undefined,
								} as any)
						: undefined,
				});

				const details: ImageEditDetails = {
					prompt,
					inputCount: images.length,
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
					return { content: [{ type: "text", text: "antigravity-image-edit aborted." }], isError: true } as any;
				}
				const prefix = err instanceof AntigravityAuthError ? "Antigravity not available" : "antigravity-image-edit failed";
				return { content: [{ type: "text", text: `${prefix}: ${(err as Error).message}` }], isError: true } as any;
			}
		},

		renderCall(args: ImageEditInput, theme) {
			let text = theme.fg("toolTitle", theme.bold("antigravity-image-edit "));
			text += theme.fg("accent", promptPreview(args.prompt || "…"));
			const imageCount = Array.isArray(args.image) ? args.image.length : args.image ? 1 : 0;
			const opts = [`${imageCount} image${imageCount === 1 ? "" : "s"}`, args.model, args.reasoning_effort].filter(Boolean);
			if (opts.length) text += theme.fg("dim", ` [${opts.join(" · ")}]`);
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as ImageEditDetails | undefined;
			const body = result.content.find((part) => part.type === "text");
			const bodyText = body?.type === "text" ? body.text : "(no output)";
			if ((result as any).isError) return new Text(theme.fg("error", bodyText), 0, 0);
			if (!details) return new Text(bodyText, 0, 0);

			let text =
				theme.fg("success", "✓ ") +
				theme.fg("toolTitle", theme.bold("antigravity-image-edit ")) +
				theme.fg("muted", `${details.paths.length} image${details.paths.length === 1 ? "" : "s"} saved`) +
				theme.fg("dim", ` · ${details.model}`);
			for (const p of details.paths) text += `\n${theme.fg("accent", p)}`;
			return new Text(text, 0, 0);
		},
	});
}
