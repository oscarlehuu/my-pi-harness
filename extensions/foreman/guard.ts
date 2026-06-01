import * as path from "node:path";

export type GuardedToolKind = "edit" | "write" | "bash";

export interface ToolCallLike {
	toolName: string;
	input?: unknown;
}

export interface ToolCallClassification {
	gate: boolean;
	kind?: GuardedToolKind;
	reason?: string;
}

export interface ImpactPathContext {
	repoRoot: string | null;
	scratchDirs: string[];
}

export interface ImpactResolverOptions {
	cwd: string;
	findRepoRoot?: (p: string) => string | null;
	findGitRoot?: (p: string) => string | null;
	scratchDirs?: string[];
	tmpDirs?: string[];
}

const READ_ONLY_TOOL_NAMES = new Set(["read", "grep", "find", "ls"]);
const CONTROL_TOKENS = new Set([";", "|", "||", "&", "&&"]);
const OUTPUT_REDIRECTS = new Set([">", ">>", ">|"]);
const PROSE_EXTENSIONS = new Set([".md", ".markdown", ".mdx", ".txt", ".rst", ".adoc"]);
const PROSE_KNOWN_NAMES = new Set(["LICENSE", "LICENCE", "COPYING", "NOTICE", "AUTHORS"]);

function isPathUnderDir(targetPath: string, dir: string): boolean {
	const resolvedTarget = path.resolve(targetPath);
	const resolvedDir = path.resolve(dir);
	const relative = path.relative(resolvedDir, resolvedTarget);
	return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function isProsePath(absPath: string): boolean {
	const basename = path.basename(path.resolve(absPath));
	const extension = path.extname(basename).toLowerCase();
	if (PROSE_EXTENSIONS.has(extension)) return true;
	const stem = extension ? basename.slice(0, -extension.length) : basename;
	return PROSE_KNOWN_NAMES.has(stem.toUpperCase());
}

export function isNoImpactPath(absPath: string, ctx: ImpactPathContext): boolean {
	const resolvedPath = path.resolve(absPath);
	if (ctx.scratchDirs.some((dir) => dir && isPathUnderDir(resolvedPath, dir))) return true;
	if (ctx.repoRoot === null) return true;
	const repoRoot = path.resolve(ctx.repoRoot);
	if (!isPathUnderDir(resolvedPath, repoRoot)) return true;
	return isProsePath(resolvedPath);
}

export function resolveImpactContext(absPath: string, options: ImpactResolverOptions): ImpactPathContext {
	const resolvedPath = path.isAbsolute(absPath) ? path.resolve(absPath) : path.resolve(options.cwd, absPath);
	const scratchDirs = [...(options.scratchDirs ?? []), ...(options.tmpDirs ?? [])].filter(Boolean).map((dir) => path.resolve(dir));
	const findRepoRoot = options.findRepoRoot ?? options.findGitRoot;
	const repoRoot = findRepoRoot?.(resolvedPath) ?? null;
	return { repoRoot: repoRoot ? path.resolve(repoRoot) : null, scratchDirs };
}

function quoteForSnippet(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\s+/g, " ").trim();
}

function truncate(value: string, max = 120): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

function pathFromInput(input: unknown): string | undefined {
	if (!input || typeof input !== "object") return undefined;
	const maybe = input as Record<string, unknown>;
	return typeof maybe.path === "string" ? maybe.path : typeof maybe.file_path === "string" ? maybe.file_path : undefined;
}

function implementationReason(kind: "edit" | "write", input: unknown): string {
	const target = pathFromInput(input);
	const task = target ? `Apply the intended ${kind} to ${target}` : "Apply the intended code change";
	return (
		"Implementation in the main session is routed through Foreman. " +
		`Don't hand-edit here — start this change as a Foreman task: foreman({ task: "${quoteForSnippet(task)}", verifyCommand: "<how to verify>" }). ` +
		"The developer crew will implement it and the dev→test→fix loop + gates will run. " +
		"(If the founder explicitly asked for a direct edit, they can toggle /foreman-direct.)"
	);
}

function bashReason(command: string): string {
	const task = `Apply the intended file changes from: ${truncate(command, 90)}`;
	return (
		"This bash command writes files; route the change through Foreman instead: " +
		`foreman({ task: "${quoteForSnippet(task)}", verifyCommand: "<how to verify>" }). ` +
		"The developer crew will make the change and the dev→test→fix loop + gates will run. " +
		"(If the founder explicitly asked for a direct edit, they can toggle /foreman-direct.)"
	);
}

function readProcessSubstitution(command: string, start: number): { token: string; next: number } {
	let i = start + 2;
	let depth = 1;
	let quote: "'" | '"' | null = null;
	while (i < command.length) {
		const c = command[i];
		if (quote) {
			if (c === "\\") {
				i += 2;
				continue;
			}
			if (c === quote) quote = null;
			i++;
			continue;
		}
		if (c === "'" || c === '"') {
			quote = c;
			i++;
			continue;
		}
		if (c === "(") depth++;
		else if (c === ")") {
			depth--;
			i++;
			if (depth <= 0) break;
			continue;
		}
		i++;
	}
	return { token: command.slice(start, i), next: i };
}

function tokenizeShell(command: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let i = 0;
	const pushCurrent = () => {
		if (current) {
			tokens.push(current);
			current = "";
		}
	};

	while (i < command.length) {
		const c = command[i];

		if (/\s/.test(c)) {
			pushCurrent();
			i++;
			continue;
		}

		if (c === "\\") {
			current += command[i + 1] ?? "";
			i += command[i + 1] ? 2 : 1;
			continue;
		}

		if (c === "'" || c === '"') {
			const quote = c;
			i++;
			while (i < command.length) {
				const q = command[i];
				if (quote === '"' && q === "\\") {
					current += command[i + 1] ?? "";
					i += command[i + 1] ? 2 : 1;
					continue;
				}
				if (q === quote) {
					i++;
					break;
				}
				current += q;
				i++;
			}
			continue;
		}

		if ((c === ">" || c === "<") && command[i + 1] === "(") {
			pushCurrent();
			const ps = readProcessSubstitution(command, i);
			tokens.push(ps.token);
			i = ps.next;
			continue;
		}

		if (c === ">") {
			pushCurrent();
			if (command[i + 1] === ">") {
				tokens.push(">>");
				i += 2;
			} else if (command[i + 1] === "|") {
				tokens.push(">|");
				i += 2;
			} else {
				tokens.push(">");
				i++;
			}
			continue;
		}

		if (c === "<") {
			pushCurrent();
			if (command.slice(i, i + 3) === "<<<") {
				tokens.push("<<<");
				i += 3;
			} else if (command.slice(i, i + 2) === "<<") {
				tokens.push("<<");
				i += 2;
			} else {
				tokens.push("<");
				i++;
			}
			continue;
		}

		if (c === ";") {
			pushCurrent();
			tokens.push(";");
			i++;
			continue;
		}

		if (c === "|") {
			pushCurrent();
			if (command[i + 1] === "|") {
				tokens.push("||");
				i += 2;
			} else {
				tokens.push("|");
				i++;
			}
			continue;
		}

		if (c === "&") {
			pushCurrent();
			if (command[i + 1] === "&") {
				tokens.push("&&");
				i += 2;
			} else {
				tokens.push("&");
				i++;
			}
			continue;
		}

		current += c;
		i++;
	}
	pushCurrent();
	return tokens;
}

function redirectionTarget(tokens: string[], operatorIndex: number): string | undefined {
	const next = tokens[operatorIndex + 1];
	if (next === "&") return tokens[operatorIndex + 2] ? `&${tokens[operatorIndex + 2]}` : undefined;
	return next;
}

function isNullDevice(target: string): boolean {
	return target === "/dev/null" || target.toLowerCase() === "nul";
}

function isClearFileTarget(target: string | undefined): boolean {
	if (!target || CONTROL_TOKENS.has(target)) return false;
	if (target === "-" || target.startsWith("&") || target.startsWith("$")) return false;
	if (target.startsWith("(") || target.startsWith(">(") || target.startsWith("<(")) return false;
	if (isNullDevice(target)) return false;
	return true;
}

function isIgnoredShellFileTarget(target: string | undefined): boolean {
	if (!target || CONTROL_TOKENS.has(target)) return true;
	if (target === "-" || target.startsWith("&")) return true;
	if (target.startsWith("(") || target.startsWith(">(") || target.startsWith("<(")) return true;
	return isNullDevice(target);
}

function splitSegments(tokens: string[]): string[][] {
	const segments: string[][] = [];
	let current: string[] = [];
	for (const token of tokens) {
		if (CONTROL_TOKENS.has(token)) {
			if (current.length) segments.push(current);
			current = [];
			continue;
		}
		current.push(token);
	}
	if (current.length) segments.push(current);
	return segments;
}

function baseName(command: string | undefined): string {
	if (!command) return "";
	return command.split(/[\\/]/).pop() ?? command;
}

function isAssignment(token: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token);
}

function skipRedirection(tokens: string[], index: number): number {
	if (OUTPUT_REDIRECTS.has(tokens[index]) || tokens[index] === "<" || tokens[index] === "<<" || tokens[index] === "<<<") {
		const target = tokens[index + 1] === "&" ? 2 : 1;
		return index + 1 + target;
	}
	return index;
}

function commandTokens(segment: string[]): string[] {
	let i = 0;
	while (i < segment.length) {
		const skipped = skipRedirection(segment, i);
		if (skipped !== i) {
			i = skipped;
			continue;
		}
		if (/^\d+$/.test(segment[i]) && OUTPUT_REDIRECTS.has(segment[i + 1])) {
			i = skipRedirection(segment, i + 1);
			continue;
		}
		if (isAssignment(segment[i])) {
			i++;
			continue;
		}
		break;
	}

	while (i < segment.length) {
		const name = baseName(segment[i]);
		if (name === "command" || name === "builtin" || name === "exec") {
			i++;
			continue;
		}
		if (name === "sudo") {
			i++;
			while (segment[i]?.startsWith("-")) {
				const opt = segment[i++];
				if (["-u", "-g", "-h", "-p"].includes(opt) && i < segment.length) i++;
			}
			continue;
		}
		if (name === "env") {
			i++;
			while (i < segment.length && (segment[i].startsWith("-") || isAssignment(segment[i]))) i++;
			continue;
		}
		break;
	}

	return segment.slice(i);
}

function nonOptionArgs(tokens: string[]): string[] {
	const args: string[] = [];
	let afterDoubleDash = false;
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		const skipped = skipRedirection(tokens, i);
		if (skipped !== i) {
			i = skipped - 1;
			continue;
		}
		if (!afterDoubleDash && token === "--") {
			afterDoubleDash = true;
			continue;
		}
		if (!afterDoubleDash && token.startsWith("-")) continue;
		args.push(token);
	}
	return args;
}

function gitSubcommand(tokens: string[]): { subcommand?: string; args: string[] } {
	let i = 1;
	while (i < tokens.length) {
		const token = tokens[i];
		if (token === "-C" || token === "-c" || token === "--git-dir" || token === "--work-tree") {
			i += 2;
			continue;
		}
		if (token.startsWith("--git-dir=") || token.startsWith("--work-tree=")) {
			i++;
			continue;
		}
		if (token.startsWith("-")) {
			i++;
			continue;
		}
		return { subcommand: token, args: tokens.slice(i + 1) };
	}
	return { args: [] };
}

interface BashMutationAnalysis {
	mutates: boolean;
	targets: string[];
	unknown: boolean;
}

function noMutation(): BashMutationAnalysis {
	return { mutates: false, targets: [], unknown: false };
}

function targetMutation(targets: string[], unknown = false): BashMutationAnalysis {
	return { mutates: targets.length > 0 || unknown, targets, unknown };
}

function unknownMutation(): BashMutationAnalysis {
	return { mutates: true, targets: [], unknown: true };
}

function mergeMutationAnalyses(analyses: BashMutationAnalysis[]): BashMutationAnalysis {
	return {
		mutates: analyses.some((analysis) => analysis.mutates),
		targets: analyses.flatMap((analysis) => analysis.targets),
		unknown: analyses.some((analysis) => analysis.unknown),
	};
}

function outputRedirectionAnalysis(tokens: string[]): BashMutationAnalysis {
	const targets: string[] = [];
	let unknown = false;
	for (let i = 0; i < tokens.length; i++) {
		if (!OUTPUT_REDIRECTS.has(tokens[i])) continue;
		const target = redirectionTarget(tokens, i);
		if (isClearFileTarget(target)) targets.push(target);
		else if (!isIgnoredShellFileTarget(target)) unknown = true;
	}
	return targetMutation(targets, unknown);
}

function hasSedInPlace(args: string[]): boolean {
	return args.some((arg) => arg === "-i" || arg.startsWith("-i") || arg === "--in-place" || arg.startsWith("--in-place="));
}

function sedInPlaceAnalysis(args: string[]): BashMutationAnalysis {
	if (!hasSedInPlace(args)) return noMutation();

	const files: string[] = [];
	let afterDoubleDash = false;
	let scriptProvidedByOption = false;
	let scriptSeen = false;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		const skipped = skipRedirection(args, i);
		if (skipped !== i) {
			i = skipped - 1;
			continue;
		}
		if (!afterDoubleDash && arg === "--") {
			afterDoubleDash = true;
			continue;
		}
		if (!afterDoubleDash && (arg === "-i" || arg.startsWith("-i") || arg === "--in-place" || arg.startsWith("--in-place="))) {
			continue;
		}
		if (!afterDoubleDash && (arg === "-e" || arg === "--expression" || arg === "-f" || arg === "--file")) {
			scriptProvidedByOption = true;
			i++;
			continue;
		}
		if (!afterDoubleDash && (arg.startsWith("-e") || arg.startsWith("--expression=") || arg.startsWith("-f") || arg.startsWith("--file="))) {
			scriptProvidedByOption = true;
			continue;
		}
		if (!afterDoubleDash && arg.startsWith("-")) continue;
		if (!scriptProvidedByOption && !scriptSeen) {
			scriptSeen = true;
			continue;
		}
		files.push(arg);
	}

	const clearFiles = files.filter((target) => isClearFileTarget(target));
	return targetMutation(clearFiles, clearFiles.length !== files.length || clearFiles.length === 0);
}

function clearTargetAnalysis(targets: string[], unknownOnUnclear = false): BashMutationAnalysis {
	const clearTargets: string[] = [];
	let unknown = false;
	for (const target of targets) {
		if (isClearFileTarget(target)) clearTargets.push(target);
		else if (unknownOnUnclear && !isIgnoredShellFileTarget(target)) unknown = true;
	}
	return targetMutation(clearTargets, unknown);
}

function segmentMutationAnalysis(segment: string[]): BashMutationAnalysis {
	const tokens = commandTokens(segment);
	if (tokens.length === 0) return noMutation();
	const command = baseName(tokens[0]);
	const args = tokens.slice(1);

	if (command === "sed" || command === "gsed") return sedInPlaceAnalysis(args);

	if (command === "tee") return clearTargetAnalysis(nonOptionArgs(args), true);

	if (command === "git") {
		const { subcommand, args: gitArgs } = gitSubcommand(tokens);
		if (subcommand === "apply" || subcommand === "restore") return unknownMutation();
		if (subcommand === "checkout" && gitArgs.includes("--")) return unknownMutation();
		return noMutation();
	}

	if (command === "patch") return unknownMutation();

	if (command === "dd") {
		return clearTargetAnalysis(args.filter((arg) => arg.startsWith("of=")).map((arg) => arg.slice(3)), true);
	}

	if (command === "truncate" || command === "install") return clearTargetAnalysis(nonOptionArgs(args));

	if (command === "cp" || command === "mv") {
		const argsWithoutOptions = nonOptionArgs(args);
		const target = argsWithoutOptions[argsWithoutOptions.length - 1];
		return target ? clearTargetAnalysis([target], true) : noMutation();
	}

	return noMutation();
}

function bashMutationAnalysis(command: string): BashMutationAnalysis {
	const tokens = tokenizeShell(command);
	return mergeMutationAnalyses([outputRedirectionAnalysis(tokens), ...splitSegments(tokens).map(segmentMutationAnalysis)]);
}

function bashMutates(command: string): boolean {
	return bashMutationAnalysis(command).mutates;
}

function absoluteToolPath(target: string, cwd: string): string {
	return path.isAbsolute(target) ? path.resolve(target) : path.resolve(cwd, target);
}

function absoluteBashTarget(target: string, cwd: string): string | null {
	if (!isClearFileTarget(target)) return null;
	if (target.startsWith("~") || target.includes("://") || /^[A-Za-z]:[\\/]/.test(target) || /[*?[\]]/.test(target)) return null;
	return absoluteToolPath(target, cwd);
}

function targetIsNoImpact(absPath: string, context: ImpactResolverOptions): boolean {
	return isNoImpactPath(absPath, resolveImpactContext(absPath, context));
}

function bashTargetsAreNoImpact(analysis: BashMutationAnalysis, context?: ImpactResolverOptions): boolean {
	if (!context || analysis.unknown || analysis.targets.length === 0) return false;
	for (const target of analysis.targets) {
		const absPath = absoluteBashTarget(target, context.cwd);
		if (!absPath || !targetIsNoImpact(absPath, context)) return false;
	}
	return true;
}

export function classifyToolCall({ toolName, input }: ToolCallLike, context?: ImpactResolverOptions): ToolCallClassification {
	if (toolName === "edit" || toolName === "write") {
		const target = pathFromInput(input);
		if (context && target && targetIsNoImpact(absoluteToolPath(target, context.cwd), context)) return { gate: false };
		return { gate: true, kind: toolName, reason: implementationReason(toolName, input) };
	}

	if (toolName === "bash") {
		const command = input && typeof input === "object" ? (input as Record<string, unknown>).command : undefined;
		if (typeof command === "string" && bashMutates(command)) {
			const analysis = bashMutationAnalysis(command);
			if (bashTargetsAreNoImpact(analysis, context)) return { gate: false };
			return { gate: true, kind: "bash", reason: bashReason(command) };
		}
		return { gate: false };
	}

	if (READ_ONLY_TOOL_NAMES.has(toolName)) return { gate: false };
	return { gate: false };
}
