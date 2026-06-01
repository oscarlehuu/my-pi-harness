/**
 * grok-video-gen — text→video and image→video via Grok's Imagine proxy.
 *
 * Calls POST /videos/generations on cli-chat-proxy.grok.com/v1, polls
 * GET /videos/{request_id}, then downloads the returned mp4 URL to disk.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { GrokAuthError } from "../_shared/grokClient.ts";
import { generateVideo } from "../_shared/imagineClient.ts";

const VideoGenParams = Type.Object({
	prompt: Type.String({ description: "Video prompt to generate." }),
	image: Type.Optional(Type.String({ description: "Optional image path, data URI, or http(s) URL for image-to-video." })),
	duration: Type.Optional(Type.Number({ minimum: 1, maximum: 15, description: "Optional duration in seconds (1-15)." })),
	aspect_ratio: Type.Optional(Type.String({ description: "Optional aspect ratio, e.g. \"16:9\", \"1:1\", or \"9:16\"." })),
	resolution: Type.Optional(
		Type.Union([Type.Literal("480p"), Type.Literal("720p")], { description: "Optional video resolution." }),
	),
	output: Type.Optional(Type.String({ description: "Optional mp4 output filename. Basename only is used and sanitized." })),
});

type VideoGenInput = {
	prompt: string;
	image?: string;
	duration?: number;
	aspect_ratio?: string;
	resolution?: "480p" | "720p";
	output?: string;
};

interface VideoGenDetails {
	prompt: string;
	path: string;
	url: string;
	requestId: string;
	duration?: number;
	mode: "subscription" | "api-key";
	model: string;
	imageToVideo: boolean;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "grok-video-gen",
		label: "Grok Video Gen",
		description: [
			"Generate text-to-video or image-to-video clips with Grok Imagine through the subscription-backed CLI proxy.",
			"Polls live progress, downloads the returned mp4 to disk, and returns the saved path plus source URL.",
			"Requires Grok to be authorised with `grok login`.",
		].join(" "),
		promptSnippet: "Generate Grok Imagine videos from text or an optional input image; saves an mp4 to disk.",
		parameters: VideoGenParams,

		async execute(_toolCallId, params: VideoGenInput, signal, onUpdate, ctx) {
			const prompt = params.prompt?.trim();
			if (!prompt) {
				return { content: [{ type: "text", text: "grok-video-gen requires a non-empty prompt." }], isError: true } as any;
			}

			try {
				const result = await generateVideo({
					prompt,
					image: params.image,
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
											: `generating video…${percent}`;
								onUpdate({ content: [{ type: "text", text }], details: undefined } as any);
							}
						: undefined,
				});

				const details: VideoGenDetails = {
					prompt,
					path: result.path,
					url: result.url,
					requestId: result.requestId,
					duration: result.duration,
					mode: result.mode,
					model: result.model,
					imageToVideo: Boolean(params.image),
				};
				return {
					content: [{ type: "text", text: `Video saved to ${result.path}\nSource URL: ${result.url}` }],
					details,
				};
			} catch (err) {
				if ((err as Error)?.name === "AbortError") {
					return { content: [{ type: "text", text: "grok-video-gen aborted." }], isError: true } as any;
				}
				const prefix = err instanceof GrokAuthError ? "Grok not authorised" : "grok-video-gen failed";
				return { content: [{ type: "text", text: `${prefix}: ${(err as Error).message}` }], isError: true } as any;
			}
		},

		renderCall(args: VideoGenInput, theme) {
			let text = theme.fg("toolTitle", theme.bold("grok-video-gen "));
			text += theme.fg("accent", args.prompt || "…");
			const opts = [
				args.image ? "image→video" : "text→video",
				args.duration ? `${args.duration}s` : undefined,
				args.aspect_ratio,
				args.resolution,
			].filter(Boolean);
			if (opts.length) text += theme.fg("dim", ` [${opts.join(" · ")}]`);
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as VideoGenDetails | undefined;
			const body = result.content[0];
			const bodyText = body?.type === "text" ? body.text : "(no output)";
			if ((result as any).isError) return new Text(theme.fg("error", bodyText), 0, 0);
			if (!details) return new Text(bodyText, 0, 0);

			const text =
				theme.fg("success", "✓ ") +
				theme.fg("toolTitle", theme.bold("grok-video-gen ")) +
				theme.fg("muted", `mp4 saved${details.duration ? ` · ${details.duration}s` : ""}`) +
				theme.fg("dim", ` · ${details.mode}`) +
				`\n${theme.fg("accent", details.path)}` +
				`\n${theme.fg("muted", "source: ")}${theme.fg("accent", details.url)}`;
			return new Text(text, 0, 0);
		},
	});
}
