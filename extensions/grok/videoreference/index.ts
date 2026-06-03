/**
 * grok-video-reference — reference→video via Grok's Imagine proxy.
 *
 * Calls POST /videos/generations on cli-chat-proxy.grok.com/v1 with
 * reference_images:[{url}, ...], polls GET /videos/{request_id}, then downloads
 * the returned mp4 URL to disk.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { GrokAuthError } from "../_shared/grokClient.ts";
import { generateReferenceVideo } from "../_shared/imagineClient.ts";

const VideoReferenceParams = Type.Object({
	prompt: Type.String({ description: "Text prompt describing the desired video." }),
	images: Type.Array(Type.String(), {
		minItems: 2,
		maxItems: 7,
		description: "Two to seven reference images (paths, data URIs, or http(s) URLs) for style/content consistency.",
	}),
	duration: Type.Optional(Type.Number({ minimum: 1, maximum: 15, description: "Duration in seconds (6 or 10 recommended)." })),
	aspect_ratio: Type.Optional(Type.String({ description: "Optional aspect ratio, e.g. \"16:9\", \"1:1\", or \"9:16\"." })),
	resolution: Type.Optional(
		Type.Union([Type.Literal("480p"), Type.Literal("720p")], { description: "Optional video resolution." }),
	),
	output: Type.Optional(Type.String({ description: "Optional mp4 output filename. Basename only is used and sanitized." })),
});

type VideoReferenceInput = {
	prompt: string;
	images: string[];
	duration?: number;
	aspect_ratio?: string;
	resolution?: "480p" | "720p";
	output?: string;
};

interface VideoReferenceDetails {
	prompt: string;
	path: string;
	url: string;
	requestId: string;
	duration?: number;
	mode: "subscription" | "api-key";
	model: string;
	referenceCount: number;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "grok-video-reference",
		label: "Grok Video Reference",
		description: [
			"Generate a video from 2–7 reference images guided by a text prompt with Grok Imagine via the subscription-backed CLI proxy, for strong character/style consistency.",
			"Resolves each image, polls progress, downloads the mp4 to disk, and returns its path plus source URL.",
			"Requires Grok to be authorised with `grok login`.",
		].join(" "),
		promptSnippet: "Generate a Grok Imagine video from 2–7 reference images plus a prompt; saves an mp4 to disk.",
		parameters: VideoReferenceParams,

		async execute(_toolCallId, params: VideoReferenceInput, signal, onUpdate, ctx) {
			const prompt = params.prompt?.trim();
			if (!prompt) {
				return { content: [{ type: "text", text: "grok-video-reference requires a non-empty prompt." }], isError: true } as any;
			}
			if (!Array.isArray(params.images) || params.images.length < 2) {
				return { content: [{ type: "text", text: "reference_to_video requires at least 2 reference images" }], isError: true } as any;
			}
			if (params.images.length > 7) {
				return { content: [{ type: "text", text: "reference_to_video accepts at most 7 reference images" }], isError: true } as any;
			}

			try {
				const result = await generateReferenceVideo({
					prompt,
					images: params.images,
					duration: params.duration,
					aspectRatio: params.aspect_ratio,
					resolution: params.resolution,
					output: params.output,
					cwd: ctx.cwd,
					signal,
					onProgress: onUpdate
						? (p) => {
								const percent = typeof p.progress === "number" ? ` ${p.progress}%` : "";
								const text =
									p.phase === "retrying"
										? `Grok video proxy busy, retrying… attempt ${(p.attempt ?? 1) + 1}`
										: p.phase === "downloading"
											? "downloading video…"
											: `generating reference video…${percent}`;
								onUpdate({ content: [{ type: "text", text }], details: undefined } as any);
							}
						: undefined,
				});

				const details: VideoReferenceDetails = {
					prompt,
					path: result.path,
					url: result.url,
					requestId: result.requestId,
					duration: result.duration,
					mode: result.mode,
					model: result.model,
					referenceCount: result.referenceCount ?? params.images.length,
				};
				return {
					content: [{ type: "text", text: `Video saved to ${result.path}\nSource URL: ${result.url}` }],
					details,
				};
			} catch (err) {
				if ((err as Error)?.name === "AbortError") {
					return { content: [{ type: "text", text: "grok-video-reference aborted." }], isError: true } as any;
				}
				const prefix = err instanceof GrokAuthError ? "Grok not authorised" : "grok-video-reference failed";
				return { content: [{ type: "text", text: `${prefix}: ${(err as Error).message}` }], isError: true } as any;
			}
		},

		renderCall(args: VideoReferenceInput, theme) {
			let text = theme.fg("toolTitle", theme.bold("grok-video-reference "));
			text += theme.fg("accent", args.prompt || "…");
			const opts = [
				`${args.images?.length ?? 0} refs`,
				args.duration ? `${args.duration}s` : undefined,
				args.aspect_ratio,
				args.resolution,
			].filter(Boolean);
			if (opts.length) text += theme.fg("dim", ` [${opts.join(" · ")}]`);
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as VideoReferenceDetails | undefined;
			const body = result.content[0];
			const bodyText = body?.type === "text" ? body.text : "(no output)";
			if ((result as any).isError) return new Text(theme.fg("error", bodyText), 0, 0);
			if (!details) return new Text(bodyText, 0, 0);

			const text =
				theme.fg("success", "✓ ") +
				theme.fg("toolTitle", theme.bold("grok-video-reference ")) +
				theme.fg("muted", `mp4 saved · ${details.referenceCount} refs`) +
				theme.fg("dim", ` · ${details.mode}`) +
				`\n${theme.fg("accent", details.path)}` +
				`\n${theme.fg("muted", "source: ")}${theme.fg("accent", details.url)}`;
			return new Text(text, 0, 0);
		},
	});
}
