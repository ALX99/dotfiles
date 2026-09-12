import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Effect, Predicate } from "effect";
import { runPromise } from "./_shared/effect-runtime.ts";
import { readFileString } from "./_shared/fs.ts";
import { APPLY_PATCH_TOOL_NAME } from "./codex-apply-patch/types.ts";

/**
 * Pi only loads context files at startup from the global agent dir and the
 * cwd's ancestors. This extension lazily loads context files for subtrees
 * *below* cwd the first time a tool call touches a file there, injecting them
 * before the next LLM call so later actions still follow local rules.
 */

const CONTEXT_FILE_CANDIDATES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"] as const;

export const NESTED_CONTEXT_MESSAGE_TYPE = "nested-context";

export interface NestedContextFile {
	readonly path: string;
	readonly content: string;
}

/** Line naming a file inside a Codex `*** Begin Patch` body. */
const PATCH_FILE_LINE = /^\*\*\* (?:Add File|Delete File|Update File|Move to): (.+)$/;

/**
 * Resolve a tool-call path argument the way Pi's built-in tools do: strip a
 * leading "@", expand "~", then resolve against cwd.
 */
function resolveAgainstCwd(filePath: string, cwd: string): string {
	let normalized = filePath.trim();
	if (normalized.startsWith("@")) normalized = normalized.slice(1);
	const expanded =
		normalized === "~" ? homedir() : normalized.startsWith("~/") ? join(homedir(), normalized.slice(2)) : normalized;
	return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

/** File paths named by a Codex apply_patch body, deduplicated in order of appearance. */
export function patchTargetPaths(patch: string): string[] {
	const paths = new Set<string>();
	for (const line of patch.split("\n")) {
		const match = PATCH_FILE_LINE.exec(line);
		if (match?.[1]) paths.add(match[1].trim());
	}
	return [...paths];
}

/** Absolute paths a tool call will touch. Unrecognized tools contribute nothing. */
export function toolCallTargetPaths(toolName: string, input: unknown, cwd: string): string[] {
	if (toolName === "read" || toolName === "edit" || toolName === "write") {
		if (!Predicate.isObject(input)) return [];
		const path = input.path;
		return typeof path === "string" ? [resolveAgainstCwd(path, cwd)] : [];
	}
	if (toolName === APPLY_PATCH_TOOL_NAME) {
		if (!Predicate.isObject(input)) return [];
		const patch = input.patch;
		return typeof patch === "string" ? patchTargetPaths(patch).map((path) => resolveAgainstCwd(path, cwd)) : [];
	}
	return [];
}

/** First readable context file in `dir`, mirroring Pi's startup candidate precedence. */
function readFirstContextFile(dir: string): Effect.Effect<NestedContextFile | undefined> {
	return Effect.gen(function* () {
		for (const filename of CONTEXT_FILE_CANDIDATES) {
			const filePath = join(dir, filename);
			// An unreadable candidate (missing, or a directory of that name) is skipped.
			const content = yield* readFileString(filePath).pipe(Effect.catchTag("FsError", () => Effect.succeed(undefined)));
			if (content !== undefined) return { path: filePath, content };
		}
		return undefined;
	});
}

/**
 * Context files in directories strictly below `cwd` that contain `filePath`,
 * ordered shallowest first, adding each to `loaded`. Directories at or above
 * cwd are skipped because startup loading already covered them; files outside
 * cwd discover nothing.
 */
export function collectNestedContextFiles(
	filePath: string,
	cwd: string,
	loaded: Set<string>,
): Effect.Effect<NestedContextFile[]> {
	return Effect.gen(function* () {
		const subtreeRoot = resolve(cwd);
		let dir = dirname(resolveAgainstCwd(filePath, cwd));
		const found: NestedContextFile[] = [];
		const prefix = subtreeRoot.endsWith(sep) ? subtreeRoot : `${subtreeRoot}${sep}`;
		while (dir !== subtreeRoot && dir.startsWith(prefix)) {
			const contextFile = yield* readFirstContextFile(dir);
			if (contextFile && !loaded.has(contextFile.path)) {
				loaded.add(contextFile.path);
				found.unshift(contextFile);
			}
			dir = dirname(dir);
		}
		return found;
	});
}

export function formatNestedContext(files: readonly NestedContextFile[]): string {
	const body = files.map((file) => `<context-file path="${file.path}">\n${file.content}\n</context-file>`).join("\n\n");
	return [
		"Loaded project context for the subtree(s) touched by the previous tool call.",
		"Follow these instructions when working on files under each directory:",
		"",
		body,
	].join("\n");
}

/** Paths already injected into a session branch, read back from its custom messages. */
export function injectedContextPaths(entries: readonly SessionEntry[]): string[] {
	const paths: string[] = [];
	for (const entry of entries) {
		if (entry.type !== "custom_message" || entry.customType !== NESTED_CONTEXT_MESSAGE_TYPE) continue;
		if (!Predicate.isObject(entry.details)) continue;
		const recorded = entry.details.paths;
		if (!Array.isArray(recorded)) continue;
		for (const path of recorded) {
			if (typeof path === "string") paths.push(path);
		}
	}
	return paths;
}

export default function nestedContext(pi: ExtensionAPI): void {
	// Absolute paths of context files already injected into the current
	// conversation branch.
	const loaded = new Set<string>();

	// The cache mirrors what the conversation actually contains, so restored
	// sessions (resume/fork/switch/reload) never re-inject context that is
	// already part of their history.
	const restore = (_event: unknown, ctx: ExtensionContext): void => {
		loaded.clear();
		for (const path of injectedContextPaths(ctx.sessionManager.getBranch())) loaded.add(path);
	};
	pi.on("session_start", restore);
	pi.on("session_tree", restore);

	pi.on("tool_call", async (event, ctx) => {
		const targets = toolCallTargetPaths(event.toolName, event.input, ctx.cwd);
		if (targets.length === 0) return;
		const pending = new Set(loaded);
		const discovered = await runPromise(
			Effect.gen(function* () {
				const files: NestedContextFile[] = [];
				for (const target of targets) files.push(...(yield* collectNestedContextFiles(target, ctx.cwd, pending)));
				return files;
			}),
		);
		if (discovered.length === 0) return;

		pi.sendMessage(
			{
				customType: NESTED_CONTEXT_MESSAGE_TYPE,
				content: formatNestedContext(discovered),
				display: true,
				details: { paths: discovered.map((file) => file.path) },
			},
			// tool_call runs during streaming. Pi only steers when triggerTurn is
			// enabled; false defers the instructions until the entire run ends.
			{ deliverAs: "steer", triggerTurn: true },
		);
		for (const file of discovered) loaded.add(file.path);
	});

	pi.registerMessageRenderer(NESTED_CONTEXT_MESSAGE_TYPE, (message, options, theme) => {
		const details = Predicate.isObject(message.details) ? message.details : undefined;
		const recorded = details?.paths;
		const summary = Array.isArray(recorded) ? recorded.join(", ") : "";
		return new Text(theme.fg("dim", `nested context: ${summary}`), options.outputPad, 0);
	});
}
