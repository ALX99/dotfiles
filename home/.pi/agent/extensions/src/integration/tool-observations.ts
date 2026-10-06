import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { Predicate } from "effect";
import { APPLY_PATCH_TOOL_NAME } from "../tools/apply-patch/types.ts";

export interface ToolFileObservations {
	/** Absolute lexical targets to inspect before a tool runs. */
	readonly attemptedPaths: readonly string[];
	/** Absolute lexical targets that may have changed if the tool succeeds. */
	readonly mutationPaths: readonly string[];
}

const EMPTY_OBSERVATIONS: ToolFileObservations = {
	attemptedPaths: [],
	mutationPaths: [],
};

const PATCH_FILE_LINE = /^\*\*\* (?:Add File|Delete File|Update File|Move to): (.+)$/u;

/** File paths named by a Codex apply_patch body, deduplicated in order of appearance. */
export function patchTargetPaths(patch: string): string[] {
	const paths = new Set<string>();
	for (const line of patch.split(/\r?\n/u)) {
		const match = PATCH_FILE_LINE.exec(line);
		if (match?.[1]) paths.add(match[1].trim());
	}
	return [...paths];
}

/**
 * Describe lexical file targets shared by nested-context discovery and task outcome
 * accounting. Attempted paths are available before execution; callers must use
 * mutationPaths only after the corresponding tool result succeeds.
 */
export function observeToolFiles(toolName: string, input: unknown, cwd: string): ToolFileObservations {
	if (!Predicate.isObject(input)) return EMPTY_OBSERVATIONS;

	if (toolName === "read" || toolName === "edit" || toolName === "write") {
		if (typeof input.path !== "string") return EMPTY_OBSERVATIONS;
		const path = resolveToolPath(input.path, cwd);
		if (path === undefined) return EMPTY_OBSERVATIONS;
		return {
			attemptedPaths: [path],
			mutationPaths: toolName === "read" ? [] : [path],
		};
	}

	if (toolName !== APPLY_PATCH_TOOL_NAME || typeof input.patch !== "string") return EMPTY_OBSERVATIONS;
	const paths = uniqueResolvedPaths(patchTargetPaths(input.patch), cwd);
	return { attemptedPaths: paths, mutationPaths: paths };
}

function uniqueResolvedPaths(paths: readonly string[], cwd: string): string[] {
	const resolved = new Set<string>();
	for (const path of paths) {
		const absolute = resolveToolPath(path, cwd);
		if (absolute !== undefined) resolved.add(absolute);
	}
	return [...resolved];
}

export function resolveToolPath(filePath: string, cwd: string): string | undefined {
	let normalized = filePath.trim();
	if (normalized.length === 0) return undefined;
	if (normalized.startsWith("@")) normalized = normalized.slice(1);
	const expanded =
		normalized === "~" ? homedir() : normalized.startsWith("~/") ? join(homedir(), normalized.slice(2)) : normalized;
	return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}
