import { dirname, join, resolve, sep } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionEntry,
	SessionStartEvent,
	SessionTreeEvent,
	ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Effect, Predicate } from "effect";
import type { ApplicationEffects } from "../../application.ts";
import { readFileString } from "../../support/fs.ts";
import { observeToolFiles, patchTargetPaths, resolveToolPath } from "../../integration/tool-observations.ts";

export { patchTargetPaths };

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

/** Absolute paths a tool call will touch. Unrecognized tools contribute nothing. */
export function toolCallTargetPaths(toolName: string, input: unknown, cwd: string): string[] {
	return [...observeToolFiles(toolName, input, cwd).attemptedPaths];
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
		const absolutePath = resolveToolPath(filePath, cwd);
		if (absolutePath === undefined) return [];
		let dir = dirname(absolutePath);
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

export interface NestedContextEvents {
	readonly sessionStart: (event: SessionStartEvent, ctx: ExtensionContext) => void;
	readonly sessionTree: (event: SessionTreeEvent, ctx: ExtensionContext) => void;
	readonly toolCall: (event: ToolCallEvent, ctx: ExtensionContext) => Promise<void>;
}

export default function nestedContext(pi: ExtensionAPI, applicationEffects: ApplicationEffects): NestedContextEvents {
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
	const sessionStart: NestedContextEvents["sessionStart"] = restore;
	const sessionTree: NestedContextEvents["sessionTree"] = restore;
	const toolCall: NestedContextEvents["toolCall"] = async (event, ctx) => {
		const targets = toolCallTargetPaths(event.toolName, event.input, ctx.cwd);
		if (targets.length === 0) return;
		const pending = new Set(loaded);
		const discovered = await applicationEffects.run(
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
	};

	pi.registerMessageRenderer(NESTED_CONTEXT_MESSAGE_TYPE, (message, options, theme) => {
		const details = Predicate.isObject(message.details) ? message.details : undefined;
		const recorded = details?.paths;
		const summary = Array.isArray(recorded) ? recorded.join(", ") : "";
		return new Text(theme.fg("dim", `nested context: ${summary}`), options.outputPad, 0);
	});

	return { sessionStart, sessionTree, toolCall };
}
