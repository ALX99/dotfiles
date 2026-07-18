import path from "node:path";
import { realpath } from "node:fs/promises";
import {
	type ExtensionAPI,
	type ToolDefinition,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	applyPreflightedPatch,
	PatchEngineError,
	preflightPatch,
	type PatchPlan,
} from "./engine.ts";
import { APPLY_PATCH_TOOL_DESCRIPTION, APPLY_PATCH_TOOL_NAME } from "./types.ts";

export interface ApplyPatchToolDetails {
	workspaceRoot: string;
	added: string[];
	updated: string[];
	deleted: string[];
	moved: Array<{ from: string; to: string }>;
	journalArtifacts?: string[];
}

export type FileMutationQueue = <T>(filePath: string, run: () => Promise<T>) => Promise<T>;

export interface ApplyPatchToolOptions {
	mutationQueue?: FileMutationQueue;
}

/** Maximum UTF-8 size accepted by the Pi tool before parsing or filesystem access (512 KiB). */
export const MAX_APPLY_PATCH_BYTES = 512 * 1024;

const APPLY_PATCH_PARAMETERS = Type.Object({
	patch: Type.String({
		description: `Raw *** Begin Patch ... *** End Patch text (maximum ${MAX_APPLY_PATCH_BYTES} UTF-8 bytes).`,
		maxLength: MAX_APPLY_PATCH_BYTES,
	}),
}, { additionalProperties: false });

function planLockPaths(plan: PatchPlan): string[] {
	return plan.changes.flatMap((change) => change.kind === "update" && change.moveAbsolutePath !== undefined
		? [change.absolutePath, change.moveAbsolutePath]
		: [change.absolutePath]);
}

function filesystemErrorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String((error as { code?: unknown }).code)
		: undefined;
}

async function canonicalMutationPath(filePath: string): Promise<string> {
	const suffix: string[] = [];
	let current = path.resolve(filePath);
	while (true) {
		try {
			const canonicalParent = await realpath(current);
			return path.join(canonicalParent, ...suffix.toReversed());
		} catch (error) {
			if (filesystemErrorCode(error) !== "ENOENT") throw error;
			const parent = path.dirname(current);
			if (parent === current) throw error;
			suffix.push(path.basename(current));
			current = parent;
		}
	}
}

/** Acquire mutation queues in sorted order to avoid cross-tool multi-file lock cycles. */
export async function withSortedFileMutationLocks<T>(
	filePaths: readonly string[],
	run: () => Promise<T>,
	queue: FileMutationQueue = withFileMutationQueue,
): Promise<T> {
	const uniqueResolved = [...new Set(filePaths.map((filePath) => path.resolve(filePath)))];
	const canonicalPairs = await Promise.all(uniqueResolved.map(async (filePath) => ({
		filePath,
		canonical: await canonicalMutationPath(filePath),
	})));
	const canonicalOwners = new Map<string, string>();
	for (const pair of canonicalPairs) {
		const owner = canonicalOwners.get(pair.canonical);
		if (owner !== undefined && owner !== pair.filePath) {
			throw new PatchEngineError(
				"path_conflict",
				`Patch lock paths are canonical aliases (${owner} and ${pair.filePath})`,
			);
		}
		canonicalOwners.set(pair.canonical, pair.filePath);
	}
	const sorted = [...canonicalOwners.keys()].sort();
	const acquire = (index: number): Promise<T> => index === sorted.length
		? run()
		: queue(sorted[index], () => acquire(index + 1));
	return acquire(0);
}

function describeWriteFailure(error: PatchEngineError): string {
	const state = error.writeState;
	if (state === undefined) return error.message;
	const applied = state.applied.map((change) => change.path).join(", ") || "none";
	const rolledBack = state.rolledBack.map((change) => change.path).join(", ") || "none";
	const rollbackFailures = state.rollbackFailures
		.map((failure) => `${failure.action} ${failure.path}: ${failure.message}`)
		.join("; ") || "none";
	const artifacts = state.journalArtifacts.join(", ") || "none";
	return [
		error.message,
		`Applied before failure: ${applied}.`,
		`Rolled back: ${rolledBack}.`,
		`Rollback failures: ${rollbackFailures}.`,
		`Recovery artifacts: ${artifacts}.`,
	].join("\n");
}

export function createApplyPatchTool(options: ApplyPatchToolOptions = {}): ToolDefinition<typeof APPLY_PATCH_PARAMETERS, ApplyPatchToolDetails> {
	const queue = options.mutationQueue ?? withFileMutationQueue;
	return {
		name: APPLY_PATCH_TOOL_NAME,
		label: "Apply Patch",
		description: APPLY_PATCH_TOOL_DESCRIPTION,
		promptSnippet: "Apply an add/update/delete/move patch across workspace files",
		promptGuidelines: [
			"Use apply_patch for coordinated filesystem changes when it is available.",
		],
		parameters: APPLY_PATCH_PARAMETERS,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const patchBytes = Buffer.byteLength(params.patch, "utf8");
			if (patchBytes > MAX_APPLY_PATCH_BYTES) {
				throw new RangeError(
					`apply_patch input is ${patchBytes} bytes; maximum is ${MAX_APPLY_PATCH_BYTES} bytes (512 KiB)`,
				);
			}
			const plan = await preflightPatch(params.patch, { workspaceRoot: ctx.cwd, signal });
			const lockPaths = planLockPaths(plan);
			try {
				return await withSortedFileMutationLocks(lockPaths, async () => {
				onUpdate?.({
					content: [{ type: "text", text: "Patch preflight passed; applying patch." }],
					details: {
						workspaceRoot: plan.workspaceRoot,
						...plan.summary,
					},
				});
				const applied = await applyPreflightedPatch(plan, { signal });
				const details: ApplyPatchToolDetails = {
					workspaceRoot: applied.workspaceRoot,
					...plan.summary,
					...(applied.journalArtifacts.length === 0 ? {} : { journalArtifacts: applied.journalArtifacts }),
				};
				const changed = [
					...details.added.map((file) => `Added ${file}`),
					...details.updated.map((file) => `Updated ${file}`),
					...details.deleted.map((file) => `Deleted ${file}`),
					...details.moved.map(({ from, to }) => `Moved ${from} -> ${to}`),
				];
				if (applied.journalArtifacts.length > 0) {
					changed.push(`Warning: retained rollback journal files: ${applied.journalArtifacts.join(", ")}`);
				}
				return {
					content: [{ type: "text", text: `Applied patch successfully.\n${changed.join("\n")}` }],
					details,
				};
				}, queue);
			} catch (error) {
				if (error instanceof PatchEngineError && error.writeState !== undefined) {
					throw new Error(describeWriteFailure(error), { cause: error });
				}
				throw error;
			}
		},
	};
}

export function registerCodexCompat(pi: ExtensionAPI, options: ApplyPatchToolOptions = {}): void {
	pi.registerTool(createApplyPatchTool(options));

	const suppressedBuiltinTools = new Set<string>();
	const setCodexCompatToolsActive = (enabled: boolean): void => {
		const active = pi.getActiveTools();
		let next = active;
		if (enabled) {
			if (!next.includes(APPLY_PATCH_TOOL_NAME)) next = [...next, APPLY_PATCH_TOOL_NAME];
			for (const name of ["edit", "write"]) {
				if (next.includes(name)) {
					next = next.filter((tool) => tool !== name);
					suppressedBuiltinTools.add(name);
				}
			}
		} else {
			if (next.includes(APPLY_PATCH_TOOL_NAME)) next = next.filter((tool) => tool !== APPLY_PATCH_TOOL_NAME);
			for (const name of suppressedBuiltinTools) {
				if (!next.includes(name)) next = [...next, name];
			}
			suppressedBuiltinTools.clear();
		}
		if (next !== active) pi.setActiveTools(next);
	};

	// The mutation tool is deliberately scoped to Pi's built-in ChatGPT Codex
	// provider. Pi's version-pinned native codec patch provides raw custom input.
	const isOpenAICodexModel = (model: { provider?: string } | undefined): boolean =>
		model?.provider === "openai-codex";
	pi.on("session_start", (_event, ctx) => setCodexCompatToolsActive(isOpenAICodexModel(ctx.model)));
	pi.on("model_select", (event) => setCodexCompatToolsActive(isOpenAICodexModel(event.model)));
}

export default function codexCompatExtension(pi: ExtensionAPI): void {
	registerCodexCompat(pi);
}
