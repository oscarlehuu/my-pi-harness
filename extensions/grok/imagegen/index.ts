/**
 * grok-image-gen — image generation via Grok's subscription-backed Imagine proxy.
 *
 * Calls POST /images/generations on cli-chat-proxy.grok.com/v1 using the same
 * ~/.grok/auth.json token envelope as the grok CLI. The response is base64
 * image data; we save every image to disk and also return inline ImageContent.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { GrokAuthError } from "../_shared/grokClient.ts";
import { GROK_IMAGE_MODEL, generateImage } from "../_shared/imagineClient.ts";

const ImageGenParams = Type.Object({
	prompt: Type.String({ description: "Image prompt to generate." }),
	aspect_ratio: Type.Optional(Type.String({ description: "Optional aspect ratio, e.g. \"16:9\", \"1:1\", or \"9:16\"." })),
	resolution: Type.Optional(
		Type.Union([Type.Literal("1k"), Type.Literal("2k")], { description: "Optional output resolution." }),
	),
	n: Type.Optional(Type.Number({ minimum: 1, maximum: 10, description: "Number of images to generate (1-10)." })),
	output: Type.Optional(Type.String({ description: "Optional output filename. Basename only is used and sanitized." })),
});

type ImageGenInput = {
	prompt: string;
	aspect_ratio?: string;
	resolution?: "1k" | "2k";
	n?: number;
	output?: string;
};

interface ImageGenDetails {
	prompt: string;
	paths: string[];
	mimeTypes: string[];
	n: number;
	aspectRatio?: string;
	resolution?: string;
	mode: "subscription" | "api-key";
	model: string;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "grok-image-gen",
		label: "Grok Image Gen",
		description: [
			"Generate images with Grok Imagine through the subscription-backed CLI proxy.",
			"Saves each image to disk and returns inline image content.",
			"Requires Grok to be authorised with `grok login`.",
		].join(" "),
		promptSnippet: "Generate images via Grok Imagine; saves files and returns inline images.",
		parameters: ImageGenParams,

		async execute(_toolCallId, params: ImageGenInput, signal, onUpdate, _ctx) {
			const prompt = params.prompt?.trim();
			if (!prompt) {
				return { content: [{ type: "text", text: "grok-image-gen requires a non-empty prompt." }], isError: true } as any;
			}

			try {
				const result = await generateImage({
					prompt,
					aspectRatio: params.aspect_ratio,
					resolution: params.resolution,
					n: params.n,
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
													? `Grok image proxy busy, retrying… attempt ${(p.attempt ?? 1) + 1}`
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
					aspectRatio: params.aspect_ratio,
					resolution: params.resolution,
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
					return { content: [{ type: "text", text: "grok-image-gen aborted." }], isError: true } as any;
				}
				const prefix = err instanceof GrokAuthError ? "Grok not authorised" : "grok-image-gen failed";
				return { content: [{ type: "text", text: `${prefix}: ${(err as Error).message}` }], isError: true } as any;
			}
		},

		renderCall(args: ImageGenInput, theme) {
			let text = theme.fg("toolTitle", theme.bold("grok-image-gen "));
			text += theme.fg("accent", args.prompt || "…");
			const opts = [args.aspect_ratio, args.resolution, args.n ? `n=${args.n}` : undefined].filter(Boolean);
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
				theme.fg("toolTitle", theme.bold("grok-image-gen ")) +
				theme.fg("muted", `${details.paths.length} image${details.paths.length === 1 ? "" : "s"} saved`) +
				theme.fg("dim", ` · ${details.mode}`);
			for (const p of details.paths) text += `\n${theme.fg("accent", p)}`;
			return new Text(text, 0, 0);
		},
	});
}
