/**
 * grok-image-edit — image editing via Grok's subscription-backed Imagine proxy.
 *
 * Calls POST /images/edits on cli-chat-proxy.grok.com/v1. Input images may be
 * local paths (encoded as data URIs), data URIs, or http(s) URLs; up to three
 * images can be sent for a multi-image edit.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { GrokAuthError } from "../_shared/grokClient.ts";
import { editImage } from "../_shared/imagineClient.ts";

const ImageEditParams = Type.Object({
	prompt: Type.String({ description: "Edit instruction for the image(s)." }),
	image: Type.Union([
		Type.String({ description: "Input image path, data URI, or http(s) URL." }),
		Type.Array(Type.String(), { minItems: 1, maxItems: 3, description: "One to three input image paths, data URIs, or URLs." }),
	]),
	aspect_ratio: Type.Optional(Type.String({ description: "Optional target aspect ratio, e.g. \"16:9\", \"1:1\", or \"9:16\"." })),
	n: Type.Optional(Type.Number({ minimum: 1, maximum: 10, description: "Number of images to return (1-10)." })),
	output: Type.Optional(Type.String({ description: "Optional output filename. Basename only is used and sanitized." })),
});

type ImageEditInput = {
	prompt: string;
	image: string | string[];
	aspect_ratio?: string;
	n?: number;
	output?: string;
};

interface ImageEditDetails {
	prompt: string;
	inputCount: number;
	paths: string[];
	mimeTypes: string[];
	n: number;
	aspectRatio?: string;
	mode: "subscription" | "api-key";
	model: string;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "grok-image-edit",
		label: "Grok Image Edit",
		description: [
			"Edit one or more images with Grok Imagine through the subscription-backed CLI proxy.",
			"Input images can be local paths, data URIs, or http(s) URLs; up to 3 are supported.",
			"Saves each output image to disk and returns inline image content.",
		].join(" "),
		promptSnippet: "Edit images via Grok Imagine; accepts paths/data URIs/URLs and returns saved inline images.",
		parameters: ImageEditParams,

		async execute(_toolCallId, params: ImageEditInput, signal, onUpdate, ctx) {
			const prompt = params.prompt?.trim();
			if (!prompt) {
				return { content: [{ type: "text", text: "grok-image-edit requires a non-empty prompt." }], isError: true } as any;
			}
			const images = Array.isArray(params.image) ? params.image : [params.image];
			if (!images.length || images.some((img) => !img?.trim())) {
				return { content: [{ type: "text", text: "grok-image-edit requires at least one image." }], isError: true } as any;
			}
			if (images.length > 3) {
				return { content: [{ type: "text", text: "grok-image-edit accepts at most 3 input images." }], isError: true } as any;
			}

			try {
				const result = await editImage({
					prompt,
					image: images,
					aspectRatio: params.aspect_ratio,
					n: params.n,
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
													? `Grok image proxy busy, retrying… attempt ${(p.attempt ?? 1) + 1}`
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
					aspectRatio: params.aspect_ratio,
					mode: result.mode,
					model: result.model,
				};
				const text = result.images.map((img) => `Image saved to ${img.path}`).join("\n");
				return {
					content: [
						{ type: "text", text },
						...result.images.map((img) => ({ type: "image", data: img.b64Json, mimeType: img.mimeType })),
					],
					details,
				};
			} catch (err) {
				if ((err as Error)?.name === "AbortError") {
					return { content: [{ type: "text", text: "grok-image-edit aborted." }], isError: true } as any;
				}
				const prefix = err instanceof GrokAuthError ? "Grok not authorised" : "grok-image-edit failed";
				return { content: [{ type: "text", text: `${prefix}: ${(err as Error).message}` }], isError: true } as any;
			}
		},

		renderCall(args: ImageEditInput, theme) {
			let text = theme.fg("toolTitle", theme.bold("grok-image-edit "));
			text += theme.fg("accent", args.prompt || "…");
			const imageCount = Array.isArray(args.image) ? args.image.length : args.image ? 1 : 0;
			const opts = [`${imageCount} image${imageCount === 1 ? "" : "s"}`, args.aspect_ratio, args.n ? `n=${args.n}` : undefined].filter(Boolean);
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
				theme.fg("toolTitle", theme.bold("grok-image-edit ")) +
				theme.fg("muted", `${details.paths.length} image${details.paths.length === 1 ? "" : "s"} saved`) +
				theme.fg("dim", ` · ${details.mode}`);
			for (const p of details.paths) text += `\n${theme.fg("accent", p)}`;
			return new Text(text, 0, 0);
		},
	});
}
