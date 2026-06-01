import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	CodexAuthError,
	formatCodexImageSummary,
	runCodexImageGenerate,
	type CodexImageOutputFormat,
	type CodexImageResult,
	type CodexImageSize,
} from "../_shared/codexImageClient.ts";

const SizeParam = Type.Union(
	[Type.Literal("1024x1024"), Type.Literal("1536x1024"), Type.Literal("1024x1536"), Type.Literal("auto")],
	{ description: "Image size to request from the image_generation tool.", default: "1024x1024" },
);

const OutputFormatParam = Type.Union([Type.Literal("png"), Type.Literal("jpeg"), Type.Literal("webp")], {
	description: "Output image format.",
	default: "png",
});

const GenerateParams = Type.Object({
	prompt: Type.String({ description: "The image prompt to generate." }),
	size: Type.Optional(SizeParam),
	output_format: Type.Optional(OutputFormatParam),
	output_path: Type.Optional(Type.String({ description: "Optional explicit local path to save the generated image." })),
});

type GenerateInput = {
	prompt: string;
	size?: CodexImageSize;
	output_format?: CodexImageOutputFormat;
	output_path?: string;
};

interface CodexImageToolDetails {
	prompt: string;
	savedPath: string;
	model: string;
	size: CodexImageSize;
	outputFormat: CodexImageOutputFormat;
	mimeType: string;
	bytes: number;
	revisedPrompt?: string;
	usage?: unknown;
	partialImageCount: number;
}

function toDetails(prompt: string, result: CodexImageResult): CodexImageToolDetails {
	return {
		prompt,
		savedPath: result.savedPath,
		model: result.model,
		size: result.size,
		outputFormat: result.outputFormat,
		mimeType: result.mimeType,
		bytes: result.bytes,
		revisedPrompt: result.revisedPrompt,
		usage: result.usage,
		partialImageCount: result.partialImageCount,
	};
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function preview(text: string, max = 90): string {
	const clean = text.replace(/\s+/g, " ").trim();
	return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "codex-image-generate",
		label: "Codex Image Generate",
		description: [
			"Generate an image through ChatGPT's subscription-backed Codex image_generation backend.",
			"Uses direct Codex OAuth credentials, not pay-as-you-go API keys.",
			"Requires an openai-codex OAuth login (run `codex login`).",
		].join(" "),
		promptSnippet: "Generate an image via ChatGPT/Codex image_generation and return it inline plus save it to disk.",
		parameters: GenerateParams,

		async execute(_toolCallId, params: GenerateInput, signal, onUpdate, ctx) {
			const prompt = params.prompt?.trim();
			if (!prompt) {
				return {
					content: [{ type: "text", text: "codex-image-generate requires a non-empty prompt." }],
					isError: true,
				};
			}

			try {
				const result = await runCodexImageGenerate({
					prompt,
					size: params.size ?? "1024x1024",
					outputFormat: params.output_format ?? "png",
					outputPath: params.output_path,
					cwd: ctx.cwd,
					signal,
					onProgress: onUpdate
						? (progress) =>
								onUpdate({
									content: [
										{
											type: "text",
											text:
												progress.phase === "retrying"
													? `(Codex image backend busy, retrying… attempt ${progress.attempt + 1})`
													: `(received partial image update ${progress.partialImageCount ?? "…"})`,
										},
									],
								})
						: undefined,
				});

				return {
					content: [
						{ type: "text", text: formatCodexImageSummary(result) },
						{ type: "image", data: result.base64, mimeType: result.mimeType },
					],
					details: toDetails(prompt, result),
				};
			} catch (err) {
				if ((err as Error)?.name === "AbortError") {
					return { content: [{ type: "text", text: "codex-image-generate aborted." }], isError: true };
				}
				const prefix = err instanceof CodexAuthError ? "Codex image not authorised" : "codex-image-generate failed";
				return {
					content: [{ type: "text", text: `${prefix}: ${(err as Error).message}` }],
					isError: true,
				};
			}
		},

		renderCall(args: GenerateInput, theme) {
			let text = theme.fg("toolTitle", theme.bold("codex-image-generate "));
			text += theme.fg("accent", preview(args.prompt || "…"));
			const meta = [args.size ?? "1024x1024", args.output_format ?? "png"];
			if (args.output_path) meta.push(args.output_path);
			text += theme.fg("dim", ` [${meta.join(" · ")}]`);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const body = result.content.find((part) => part.type === "text");
			const bodyText = body?.type === "text" ? body.text : "(no output)";

			if (result.isError) {
				return new Text(theme.fg("error", bodyText), 0, 0);
			}

			const details = result.details as CodexImageToolDetails | undefined;
			if (!details) return new Text(bodyText, 0, 0);

			const header =
				theme.fg("success", "✓ ") +
				theme.fg("toolTitle", theme.bold("codex-image-generate ")) +
				theme.fg("muted", `${details.size} · ${details.outputFormat} · ${formatBytes(details.bytes)}`) +
				theme.fg("dim", ` · ${details.model}`);
			const output = expanded ? bodyText : bodyText.split("\n").slice(0, 6).join("\n");
			return new Text(`${header}\n${theme.fg("toolOutput", output)}`, 0, 0);
		},
	});
}
