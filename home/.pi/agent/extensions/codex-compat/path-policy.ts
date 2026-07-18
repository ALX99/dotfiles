import { lstat, realpath } from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";
import { nodeErrorCode, PatchEngineError } from "./errors.ts";

export interface InspectedPath {
	readonly patchPath: string;
	readonly absolutePath: string;
	readonly stats?: Stats;
}

export function isWithinRoot(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function sameDirectoryEntry(left: Stats, right: Stats): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function validatePatchPath(patchPath: string, operationIndex: number): string[] {
	if (patchPath.length === 0 || patchPath.includes("\0")) {
		throw new PatchEngineError("unsafe_path", "Patch path is empty or contains NUL", { operationIndex, patchPath });
	}
	if (path.isAbsolute(patchPath) || path.win32.isAbsolute(patchPath)) {
		throw new PatchEngineError("unsafe_path", `Absolute patch path is not allowed: ${patchPath}`, {
			operationIndex,
			patchPath,
		});
	}
	if (patchPath.includes("\\")) {
		throw new PatchEngineError("unsafe_path", `Backslashes are not allowed in patch paths: ${patchPath}`, {
			operationIndex,
			patchPath,
		});
	}
	const parts = patchPath.split("/");
	if (parts.some((part) => part === "" || part === "." || part === "..")) {
		throw new PatchEngineError("unsafe_path", `Patch path contains an unsafe component: ${patchPath}`, {
			operationIndex,
			patchPath,
		});
	}
	return parts;
}

/** Resolve every existing component while rejecting symlinks and root escapes. */
export async function inspectPatchPath(
	root: string,
	patchPath: string,
	operationIndex: number,
): Promise<InspectedPath> {
	const parts = validatePatchPath(patchPath, operationIndex);
	const requestedAbsolutePath = path.resolve(root, ...parts);
	if (!isWithinRoot(root, requestedAbsolutePath)) {
		throw new PatchEngineError("outside_workspace", `Patch path escapes the workspace: ${patchPath}`, {
			operationIndex,
			patchPath,
		});
	}

	let current = root;
	for (let partIndex = 0; partIndex < parts.length; partIndex++) {
		const part = parts[partIndex];
		if (part === undefined) throw new Error("validated patch path component is missing");
		const candidate = path.join(current, part);
		let beforeStats: Stats;
		try {
			beforeStats = await lstat(candidate);
		} catch (error) {
			if (nodeErrorCode(error) === "ENOENT") {
				return { patchPath, absolutePath: path.join(current, ...parts.slice(partIndex)) };
			}
			throw error;
		}
		if (beforeStats.isSymbolicLink()) {
			throw new PatchEngineError("symlink_path", `Symlink paths are not allowed: ${patchPath}`, {
				operationIndex,
				patchPath,
			});
		}
		if (partIndex < parts.length - 1 && !beforeStats.isDirectory()) {
			throw new PatchEngineError("not_a_file", `A parent component is not a directory: ${patchPath}`, {
				operationIndex,
				patchPath,
			});
		}
		let canonical: string;
		let afterStats: Stats;
		try {
			canonical = await realpath(candidate);
			afterStats = await lstat(candidate);
		} catch (cause) {
			throw new PatchEngineError("stale_source", `Path changed while it was being validated: ${patchPath}`, {
				operationIndex,
				patchPath,
				cause,
			});
		}
		if (afterStats.isSymbolicLink() || !sameDirectoryEntry(beforeStats, afterStats)) {
			throw new PatchEngineError("stale_source", `Path changed while it was being validated: ${patchPath}`, {
				operationIndex,
				patchPath,
			});
		}
		if (!isWithinRoot(root, canonical)) {
			throw new PatchEngineError("outside_workspace", `Patch path resolves outside the workspace: ${patchPath}`, {
				operationIndex,
				patchPath,
			});
		}
		current = canonical;
		if (partIndex === parts.length - 1) return { patchPath, absolutePath: canonical, stats: afterStats };
	}
	return { patchPath, absolutePath: requestedAbsolutePath };
}
