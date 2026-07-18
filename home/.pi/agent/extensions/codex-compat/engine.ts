import { createHash, randomBytes } from "node:crypto";
import {
	chmod,
	link,
	lstat,
	mkdir,
	open,
	realpath,
	rename,
	rmdir,
	rm,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { Stats } from "node:fs";
import { toError } from "../_shared/errors.ts";
import {
	PatchEngineError,
	nodeErrorCode,
	type AppliedChange,
	type PatchRollbackFailure,
	type PatchWriteFailureState,
} from "./errors.ts";
import { parsePatch } from "./parser.ts";
import type { ParsedPatch, PatchChunk, PatchOperation } from "./patch-types.ts";
import { inspectPatchPath, isWithinRoot, sameDirectoryEntry, type InspectedPath } from "./path-policy.ts";

export { PatchEngineError } from "./errors.ts";
export type { AppliedChange, PatchEngineErrorCode, PatchRollbackFailure, PatchWriteFailureState } from "./errors.ts";

/** Maximum file size read by the patch engine, including sources and journals (10 MiB). */
export const MAX_PATCH_SOURCE_BYTES = 10 * 1024 * 1024;

export type SourceSnapshot =
	| { readonly path: string; readonly absolutePath: string; readonly state: "missing" }
	| {
			readonly path: string;
			readonly absolutePath: string;
			readonly state: "file";
			readonly hash: string;
			readonly mode: number;
	  };

interface PlannedChangeBase {
	readonly operationIndex: number;
	readonly kind: PatchOperation["kind"];
	readonly path: string;
	readonly absolutePath: string;
	readonly beforeContent: string | null;
	readonly afterContent: string | null;
	readonly beforeHash?: string;
	readonly afterHash?: string;
}

export interface PlannedAddChange extends PlannedChangeBase {
	readonly kind: "add";
}

export interface PlannedDeleteChange extends PlannedChangeBase {
	readonly kind: "delete";
	readonly beforeContent: string;
	readonly afterContent: null;
}

export interface PlannedUpdateChange extends PlannedChangeBase {
	readonly kind: "update";
	readonly beforeContent: string;
	readonly afterContent: string;
	readonly moveTo?: string;
	readonly moveAbsolutePath?: string;
	readonly overwrittenContent?: string;
	readonly overwrittenHash?: string;
}

export type PlannedChange = PlannedAddChange | PlannedDeleteChange | PlannedUpdateChange;

export interface PatchPlan {
	readonly workspaceRoot: string;
	readonly patch: ParsedPatch;
	readonly changes: readonly PlannedChange[];
	readonly snapshots: readonly SourceSnapshot[];
	readonly summary: {
		readonly added: readonly string[];
		readonly updated: readonly string[];
		readonly deleted: readonly string[];
		readonly moved: readonly { readonly from: string; readonly to: string }[];
	};
}

export interface AppliedPatchResult {
	readonly workspaceRoot: string;
	readonly changes: readonly AppliedChange[];
	/** Backup files retained only when post-commit cleanup could not remove them. */
	readonly journalArtifacts: readonly string[];
}

export type SourceHasher = (content: string, absolutePath: string) => string | Promise<string>;
export type SourceRevalidator = (expected: SourceSnapshot, actual: SourceSnapshot) => boolean | Promise<boolean>;

export interface PreflightPatchOptions {
	readonly workspaceRoot: string;
	readonly signal?: AbortSignal;
	readonly hashSource?: SourceHasher;
	readonly revalidateSource?: SourceRevalidator;
}

export interface ApplyPatchOptions {
	readonly signal?: AbortSignal;
	/** @deprecated Strategies are bound to the preflight plan; a different value is rejected. */
	readonly hashSource?: SourceHasher;
	/** @deprecated Strategies are bound to the preflight plan; a different value is rejected. */
	readonly revalidateSource?: SourceRevalidator;
}

interface PathClaim {
	absolutePath: string;
	operationIndex: number;
	patchPath: string;
	stats?: Stats;
}

interface Replacement {
	start: number;
	oldLength: number;
	newLines: string[];
}

/**
 * Test-only seam for deterministic filesystem failure characterization.  It is
 * deliberately process-local and unset in production; callers must never use
 * it to change patch semantics.
 */
export type PatchEngineFailurePoint =
	| "source_read"
	| "hash"
	| "parent_creation"
	| "temporary_write"
	| "chmod"
	| "guard_capture"
	| "guard_revalidation"
	| "backup_hard_link"
	| "backup_verification"
	| "destination_publication"
	| "source_unlink"
	| "installed_output_verification"
	| "rollback_unlink"
	| "rollback_restore"
	| "journal_cleanup"
	| "created_directory_cleanup"
	| "operation_committed";

let testFailureInjector: ((point: PatchEngineFailurePoint) => void | Promise<void>) | undefined;

/** @internal Tests only. Reset this hook in a finally block. */
export function setPatchEngineFailureInjectorForTests(
	injector: ((point: PatchEngineFailurePoint) => void | Promise<void>) | undefined,
): void {
	testFailureInjector = injector;
}

async function atFailurePoint(point: PatchEngineFailurePoint): Promise<void> {
	await testFailureInjector?.(point);
}

function sha256(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

async function hashSourceContent(hashSource: SourceHasher, content: string, absolutePath: string): Promise<string> {
	await atFailurePoint("hash");
	return hashSource(content, absolutePath);
}

function checkCancelled(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new PatchEngineError("cancelled", "Patch operation was cancelled");
}

async function readUtf8File(inspected: InspectedPath, operationIndex: number): Promise<string> {
	if (inspected.stats === undefined) {
		throw new PatchEngineError("missing_file", `File does not exist: ${inspected.patchPath}`, {
			operationIndex,
			patchPath: inspected.patchPath,
		});
	}
	if (!inspected.stats.isFile()) {
		throw new PatchEngineError("not_a_file", `Path is not a regular file: ${inspected.patchPath}`, {
			operationIndex,
			patchPath: inspected.patchPath,
		});
	}
	await atFailurePoint("source_read");
	const handle = await open(inspected.absolutePath, "r");
	let bytes: Buffer;
	try {
		// Read at most the limit plus one byte. Unlike readFile this remains
		// bounded even if a concurrently modified file grows after lstat.
		const buffer = Buffer.allocUnsafe(MAX_PATCH_SOURCE_BYTES + 1);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		if (bytesRead > MAX_PATCH_SOURCE_BYTES) {
			throw new PatchEngineError(
				"source_too_large",
				`File exceeds the ${MAX_PATCH_SOURCE_BYTES}-byte patch source limit: ${inspected.patchPath}`,
				{ operationIndex, patchPath: inspected.patchPath },
			);
		}
		bytes = buffer.subarray(0, bytesRead);
	} finally {
		await handle.close();
	}
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch (cause) {
		throw new PatchEngineError("invalid_utf8", `File is not valid UTF-8: ${inspected.patchPath}`, {
			operationIndex,
			patchPath: inspected.patchPath,
			cause,
		});
	}
}

function sourceLines(content: string): string[] {
	if (content.length === 0) return [];
	const withoutFinalNewline = content.endsWith("\n") ? content.slice(0, -1) : content;
	return withoutFinalNewline.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

function findSequence(lines: readonly string[], wanted: readonly string[], from: number, eof: boolean): number {
	if (wanted.length === 0) return eof ? lines.length : from;
	const lastStart = lines.length - wanted.length;
	for (let start = from; start <= lastStart; start++) {
		if (eof && start !== lastStart) continue;
		let matches = true;
		for (let offset = 0; offset < wanted.length; offset++) {
			if (lines[start + offset] !== wanted[offset]) {
				matches = false;
				break;
			}
		}
		if (matches) return start;
	}
	return -1;
}

/** Deterministically apply exact update chunks to text, producing LF output with a final newline. */
export function applyPatchChunks(content: string, chunks: readonly PatchChunk[], patchPath = "<source>"): string {
	const lines = sourceLines(content);
	const replacements: Replacement[] = [];
	let cursor = 0;
	for (const chunk of chunks) {
		if (chunk.context !== undefined) {
			const contextIndex = findSequence(lines, [chunk.context], cursor, false);
			if (contextIndex < 0) {
				throw new PatchEngineError("patch_mismatch", `Could not find context '${chunk.context}' in ${patchPath}`, {
					patchPath,
				});
			}
			cursor = contextIndex + 1;
		}

		let start: number;
		if (chunk.oldLines.length === 0) {
			start = chunk.endOfFile || chunk.context === undefined ? lines.length : cursor;
		} else {
			start = findSequence(lines, chunk.oldLines, cursor, chunk.endOfFile);
			if (start < 0) {
				throw new PatchEngineError(
					"patch_mismatch",
					`Could not find expected lines in ${patchPath}:\n${chunk.oldLines.join("\n")}`,
					{ patchPath },
				);
			}
		}
		if (replacements.some((replacement) => start < replacement.start + replacement.oldLength)) {
			throw new PatchEngineError("patch_mismatch", `Update chunks overlap in ${patchPath}`, { patchPath });
		}
		replacements.push({ start, oldLength: chunk.oldLines.length, newLines: [...chunk.newLines] });
		cursor = start + chunk.oldLines.length;
	}

	const output = [...lines];
	for (const replacement of replacements.toReversed()) {
		output.splice(replacement.start, replacement.oldLength, ...replacement.newLines);
	}
	return output.length === 0 ? "" : `${output.join("\n")}\n`;
}

type SnapshotCapture =
	| { snapshot: Extract<SourceSnapshot, { state: "missing" }>; content: null }
	| { snapshot: Extract<SourceSnapshot, { state: "file" }>; content: string };

async function makeSnapshot(
	inspected: InspectedPath,
	operationIndex: number,
	hashSource: SourceHasher,
): Promise<SnapshotCapture> {
	if (inspected.stats === undefined) {
		return {
			snapshot: { path: inspected.patchPath, absolutePath: inspected.absolutePath, state: "missing" },
			content: null,
		};
	}
	const content = await readUtf8File(inspected, operationIndex);
	return {
		snapshot: {
			path: inspected.patchPath,
			absolutePath: inspected.absolutePath,
			state: "file",
			hash: await hashSourceContent(hashSource, content, inspected.absolutePath),
			mode: inspected.stats.mode,
		},
		content,
	};
}

function claimPath(claims: PathClaim[], inspected: InspectedPath, operationIndex: number): void {
	for (const claim of claims) {
		const samePath = claim.absolutePath === inspected.absolutePath;
		const sameExistingEntry =
			claim.stats !== undefined && inspected.stats !== undefined && sameDirectoryEntry(claim.stats, inspected.stats);
		const claimedIsParent = inspected.absolutePath.startsWith(`${claim.absolutePath}${path.sep}`);
		const inspectedIsParent = claim.absolutePath.startsWith(`${inspected.absolutePath}${path.sep}`);
		if (samePath || sameExistingEntry || claimedIsParent || inspectedIsParent) {
			throw new PatchEngineError(
				"path_conflict",
				`Operations ${claim.operationIndex} and ${operationIndex} affect conflicting paths (${claim.patchPath} and ${inspected.patchPath})`,
				{ operationIndex, patchPath: inspected.patchPath },
			);
		}
	}
	claims.push({
		absolutePath: inspected.absolutePath,
		operationIndex,
		patchPath: inspected.patchPath,
		...(inspected.stats === undefined ? {} : { stats: inspected.stats }),
	});
}

function deepFreeze<T>(value: T): T {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
	for (const child of Object.values(value)) deepFreeze(child);
	return Object.freeze(value);
}

const issuedPlans = new WeakSet<PatchPlan>();
interface PlanStrategy {
	readonly hashSource: SourceHasher;
	readonly revalidateSource: SourceRevalidator;
}
const issuedPlanStrategies = new WeakMap<PatchPlan, PlanStrategy>();

/** Parse and validate every operation without writing anything. */
export async function preflightPatch(patchInput: string, options: PreflightPatchOptions): Promise<PatchPlan> {
	checkCancelled(options.signal);
	if (typeof options.workspaceRoot !== "string" || options.workspaceRoot.length === 0) {
		throw new PatchEngineError("invalid_workspace", "workspaceRoot must be a non-empty path");
	}
	let workspaceRoot: string;
	try {
		workspaceRoot = await realpath(path.resolve(options.workspaceRoot));
		if (!(await stat(workspaceRoot)).isDirectory()) throw new Error("not a directory");
	} catch (cause) {
		throw new PatchEngineError("invalid_workspace", `Workspace root is unavailable: ${options.workspaceRoot}`, {
			cause,
		});
	}
	const patch = parsePatch(patchInput);
	const hashSource = options.hashSource ?? ((content: string) => sha256(content));
	const revalidateSource = options.revalidateSource ?? defaultRevalidator;
	const claims: PathClaim[] = [];
	const changes: PlannedChange[] = [];
	const snapshots: SourceSnapshot[] = [];
	const summary: {
		added: string[];
		updated: string[];
		deleted: string[];
		moved: Array<{ from: string; to: string }>;
	} = { added: [], updated: [], deleted: [], moved: [] };

	for (const [operationIndex, operation] of patch.operations.entries()) {
		checkCancelled(options.signal);
		const source = await inspectPatchPath(workspaceRoot, operation.path, operationIndex);
		claimPath(claims, source, operationIndex);

		if (operation.kind === "add") {
			if (source.stats !== undefined) {
				throw new PatchEngineError("target_exists", `Add target already exists: ${operation.path}`, {
					operationIndex,
					patchPath: operation.path,
				});
			}
			const before = await makeSnapshot(source, operationIndex, hashSource);
			snapshots.push(before.snapshot);
			const change: PlannedAddChange = {
				operationIndex,
				kind: "add",
				path: operation.path,
				absolutePath: source.absolutePath,
				beforeContent: null,
				afterContent: operation.content,
				afterHash: await hashSourceContent(hashSource, operation.content, source.absolutePath),
			};
			changes.push(change);
			summary.added.push(operation.path);
			continue;
		}

		const before = await makeSnapshot(source, operationIndex, hashSource);
		if (before.content === null) {
			throw new PatchEngineError("missing_file", `File does not exist: ${operation.path}`, {
				operationIndex,
				patchPath: operation.path,
			});
		}
		snapshots.push(before.snapshot);
		if (operation.kind === "delete") {
			changes.push({
				operationIndex,
				kind: "delete",
				path: operation.path,
				absolutePath: source.absolutePath,
				beforeContent: before.content,
				afterContent: null,
				beforeHash: before.snapshot.hash,
			});
			summary.deleted.push(operation.path);
			continue;
		}

		const afterContent = applyPatchChunks(before.content, operation.chunks, operation.path);
		let moveTo: string | undefined;
		let moveAbsolutePath: string | undefined;
		let afterHash: string;
		if (operation.moveTo !== undefined) {
			const destination = await inspectPatchPath(workspaceRoot, operation.moveTo, operationIndex);
			claimPath(claims, destination, operationIndex);
			if (destination.stats !== undefined) {
				throw new PatchEngineError("target_exists", `Move destination already exists: ${operation.moveTo}`, {
					operationIndex,
					patchPath: operation.moveTo,
				});
			}
			const destinationSnapshot = await makeSnapshot(destination, operationIndex, hashSource);
			snapshots.push(destinationSnapshot.snapshot);
			moveTo = operation.moveTo;
			moveAbsolutePath = destination.absolutePath;
			afterHash = await hashSourceContent(hashSource, afterContent, destination.absolutePath);
			summary.moved.push({ from: operation.path, to: operation.moveTo });
		} else {
			afterHash = await hashSourceContent(hashSource, afterContent, source.absolutePath);
			summary.updated.push(operation.path);
		}
		const moveFields = moveTo === undefined || moveAbsolutePath === undefined ? {} : { moveTo, moveAbsolutePath };
		changes.push({
			operationIndex,
			kind: "update",
			path: operation.path,
			absolutePath: source.absolutePath,
			beforeContent: before.content,
			afterContent,
			beforeHash: before.snapshot.hash,
			afterHash,
			...moveFields,
		});
	}

	checkCancelled(options.signal);
	const plan = deepFreeze({ workspaceRoot, patch, changes, snapshots, summary });
	issuedPlans.add(plan);
	issuedPlanStrategies.set(plan, { hashSource, revalidateSource });
	return plan;
}

async function currentSnapshot(
	root: string,
	expected: SourceSnapshot,
	operationIndex: number,
	hashSource: SourceHasher,
): Promise<SourceSnapshot> {
	const inspected = await inspectPatchPath(root, expected.path, operationIndex);
	return (await makeSnapshot(inspected, operationIndex, hashSource)).snapshot;
}

function defaultRevalidator(expected: SourceSnapshot, actual: SourceSnapshot): boolean {
	if (expected.absolutePath !== actual.absolutePath || expected.state !== actual.state) return false;
	if (expected.state === "missing" || actual.state === "missing") return true;
	return expected.hash === actual.hash && permissionMode(expected.mode) === permissionMode(actual.mode);
}

let temporaryCounter = 0;

function permissionMode(mode: number | undefined): number | undefined {
	return mode === undefined ? undefined : mode & 0o777;
}

function temporaryPath(absolutePath: string): string {
	const suffix = `${process.pid}-${temporaryCounter++}-${randomBytes(6).toString("hex")}`;
	return path.join(path.dirname(absolutePath), `.${path.basename(absolutePath)}.apply-patch-${suffix}`);
}

async function writeTemporary(temporary: string, content: string, mode?: number): Promise<void> {
	const permissions = permissionMode(mode);
	await atFailurePoint("temporary_write");
	await writeFile(temporary, content, {
		encoding: "utf8",
		flag: "wx",
		...(permissions === undefined ? {} : { mode: permissions }),
	});
	if (permissions !== undefined) {
		await atFailurePoint("chmod");
		await chmod(temporary, permissions);
	}
}

async function ensureParentDirectories(
	root: string,
	absolutePath: string,
	createdDirectories: string[],
): Promise<void> {
	const parent = path.dirname(absolutePath);
	const relative = path.relative(root, parent);
	if (!isWithinRoot(root, parent)) {
		throw new PatchEngineError("outside_workspace", `Target parent escapes the workspace: ${absolutePath}`);
	}
	if (relative === "") return;

	let current = root;
	for (const part of relative.split(path.sep)) {
		const candidate = path.join(current, part);
		let before: Stats;
		try {
			before = await lstat(candidate);
		} catch (error) {
			if (nodeErrorCode(error) !== "ENOENT") throw error;
			try {
				await atFailurePoint("parent_creation");
				await mkdir(candidate);
				createdDirectories.push(candidate);
			} catch (mkdirError) {
				if (nodeErrorCode(mkdirError) !== "EEXIST") throw mkdirError;
			}
			before = await lstat(candidate);
		}
		if (before.isSymbolicLink()) {
			throw new PatchEngineError("symlink_path", `Symlink parent is not allowed: ${candidate}`);
		}
		if (!before.isDirectory()) {
			throw new PatchEngineError("not_a_file", `Target parent is not a directory: ${candidate}`);
		}
		const canonical = await realpath(candidate);
		const after = await lstat(candidate);
		if (after.isSymbolicLink() || !sameDirectoryEntry(before, after) || !isWithinRoot(root, canonical)) {
			throw new PatchEngineError("stale_source", `Target parent changed while it was being prepared: ${candidate}`);
		}
		current = canonical;
	}
}

function changeResult(change: PlannedChange): AppliedChange {
	return {
		operationIndex: change.operationIndex,
		kind: change.kind,
		path: change.path,
		...(change.kind === "update" && change.moveTo !== undefined ? { moveTo: change.moveTo } : {}),
		...(change.beforeHash === undefined ? {} : { beforeHash: change.beforeHash }),
		...(change.afterHash === undefined ? {} : { afterHash: change.afterHash }),
	};
}

function snapshotsForChange(plan: PatchPlan, change: PlannedChange): SourceSnapshot[] {
	return plan.snapshots.filter(
		(snapshot) => snapshot.path === change.path || (change.kind === "update" && change.moveTo === snapshot.path),
	);
}

async function assertSnapshotCurrent(
	root: string,
	expected: SourceSnapshot,
	operationIndex: number,
	hashSource: SourceHasher,
	revalidate: SourceRevalidator,
): Promise<void> {
	const actual = await currentSnapshot(root, expected, operationIndex, hashSource);
	if (!(await revalidate(expected, actual))) {
		throw new PatchEngineError("stale_source", `Path changed after preflight: ${expected.path}`, {
			operationIndex,
			patchPath: expected.path,
		});
	}
}

async function readJournalContent(absolutePath: string, patchPath: string, operationIndex: number): Promise<string> {
	const stats = await lstat(absolutePath);
	if (stats.isSymbolicLink() || !stats.isFile()) {
		throw new PatchEngineError("not_a_file", `Journal entry is not a regular file: ${patchPath}`, {
			operationIndex,
			patchPath,
		});
	}
	return readUtf8File({ patchPath, absolutePath, stats }, operationIndex);
}

async function verifyBackup(
	backupPath: string,
	expected: SourceSnapshot,
	operationIndex: number,
	hashSource: SourceHasher,
): Promise<void> {
	const content = await readJournalContent(backupPath, expected.path, operationIndex);
	const hash = await hashSourceContent(hashSource, content, expected.absolutePath);
	if (expected.state !== "file" || hash !== expected.hash) {
		throw new PatchEngineError("stale_source", `Source changed during commit: ${expected.path}`, {
			operationIndex,
			patchPath: expected.path,
		});
	}
}

async function pathState(absolutePath: string): Promise<"missing" | "present"> {
	try {
		await lstat(absolutePath);
		return "present";
	} catch (error) {
		if (nodeErrorCode(error) === "ENOENT") return "missing";
		throw error;
	}
}

interface StagedChange {
	change: PlannedChange;
	temporaryPath?: string;
	sourceParentGuard?: DirectoryGuard;
	outputParentGuard?: DirectoryGuard;
}

interface CommitJournalEntry extends StagedChange {
	backupPath?: string;
	installedPath?: string;
	sourceRemoved?: boolean;
}

interface DirectoryGuard {
	path: string;
	dev: number;
	ino: number;
}

async function captureDirectoryGuard(
	root: string,
	absolutePath: string,
	operationIndex: number,
	patchPath: string,
): Promise<DirectoryGuard> {
	const parent = path.dirname(absolutePath);
	let before: Stats;
	let canonical: string;
	let after: Stats;
	try {
		await atFailurePoint("guard_capture");
		before = await lstat(parent);
		if (before.isSymbolicLink() || !before.isDirectory()) throw new Error("parent is not a real directory");
		canonical = await realpath(parent);
		after = await lstat(parent);
	} catch (cause) {
		throw new PatchEngineError("stale_source", `Parent directory is unavailable: ${patchPath}`, {
			operationIndex,
			patchPath,
			cause,
		});
	}
	if (!sameDirectoryEntry(before, after) || canonical !== parent || !isWithinRoot(root, canonical)) {
		throw new PatchEngineError("stale_source", `Parent directory changed while validating: ${patchPath}`, {
			operationIndex,
			patchPath,
		});
	}
	return { path: parent, dev: after.dev, ino: after.ino };
}

async function assertDirectoryGuard(
	root: string,
	guard: DirectoryGuard,
	operationIndex: number,
	patchPath: string,
): Promise<void> {
	await atFailurePoint("guard_revalidation");
	const actual = await captureDirectoryGuard(root, path.join(guard.path, "__guard__"), operationIndex, patchPath);
	if (actual.path !== guard.path || actual.dev !== guard.dev || actual.ino !== guard.ino) {
		throw new PatchEngineError("stale_source", `Parent directory changed after staging: ${patchPath}`, {
			operationIndex,
			patchPath,
		});
	}
}

async function removeCreatedDirectories(createdDirectories: readonly string[]): Promise<string[]> {
	const remaining: string[] = [];
	for (const directory of createdDirectories.toReversed()) {
		try {
			await atFailurePoint("created_directory_cleanup");
			await rmdir(directory);
		} catch (error) {
			if (nodeErrorCode(error) !== "ENOENT") remaining.push(directory);
		}
	}
	return remaining;
}

async function collectArtifacts(entries: readonly CommitJournalEntry[]): Promise<string[]> {
	const candidates = entries.flatMap((entry) => [
		...(entry.backupPath === undefined ? [] : [entry.backupPath]),
		...(entry.temporaryPath === undefined ? [] : [entry.temporaryPath]),
	]);
	const artifacts: string[] = [];
	for (const candidate of new Set(candidates)) {
		if ((await pathState(candidate)) === "present") artifacts.push(candidate);
	}
	return artifacts;
}

async function rollbackCommit(
	entries: readonly CommitJournalEntry[],
	root: string,
	hashSource: SourceHasher,
	createdDirectories: readonly string[],
): Promise<
	Pick<PatchWriteFailureState, "rolledBack" | "rollbackFailures" | "journalArtifacts" | "createdDirectoriesRemaining">
> {
	const rolledBack: AppliedChange[] = [];
	const rollbackFailures: PatchRollbackFailure[] = [];

	for (const entry of entries.toReversed()) {
		const { change } = entry;
		const wasTouched = entry.installedPath !== undefined || entry.sourceRemoved === true;
		const originalBackupPath = entry.backupPath;
		let restored = true;

		const isInPlaceUpdate = change.kind === "update" && change.moveAbsolutePath === undefined;
		if (isInPlaceUpdate && entry.installedPath !== undefined) {
			try {
				if (entry.sourceParentGuard !== undefined) {
					await assertDirectoryGuard(root, entry.sourceParentGuard, change.operationIndex, change.path);
				}
				if (entry.backupPath === undefined || (await pathState(entry.backupPath)) !== "present") {
					throw new Error("original backup is unavailable");
				}
				const content = await readJournalContent(entry.installedPath, change.path, change.operationIndex);
				const hash = await hashSourceContent(hashSource, content, entry.installedPath);
				if (hash !== change.afterHash) {
					throw new Error("installed file changed after commit; refusing to replace it");
				}
				await atFailurePoint("rollback_restore");
				await rename(entry.backupPath, change.absolutePath);
				delete entry.backupPath;
			} catch (error) {
				restored = false;
				rollbackFailures.push({
					operationIndex: change.operationIndex,
					path: entry.installedPath,
					action: "atomically restore original",
					message: toError(error).message,
				});
			}
		} else if (entry.installedPath !== undefined && (await pathState(entry.installedPath)) === "present") {
			try {
				if (entry.outputParentGuard !== undefined) {
					await assertDirectoryGuard(
						root,
						entry.outputParentGuard,
						change.operationIndex,
						change.kind === "update" && change.moveTo !== undefined ? change.moveTo : change.path,
					);
				}
				const displayPath = change.kind === "update" ? (change.moveTo ?? change.path) : change.path;
				const content = await readJournalContent(entry.installedPath, displayPath, change.operationIndex);
				const hash = await hashSourceContent(hashSource, content, entry.installedPath);
				if (hash !== change.afterHash) {
					throw new Error("installed file changed after commit; refusing to remove it");
				}
				await atFailurePoint("rollback_unlink");
				await unlink(entry.installedPath);
			} catch (error) {
				restored = false;
				rollbackFailures.push({
					operationIndex: change.operationIndex,
					path: entry.installedPath,
					action: "remove installed file",
					message: toError(error).message,
				});
			}
		}

		if (!isInPlaceUpdate && originalBackupPath !== undefined && (await pathState(originalBackupPath)) === "present") {
			if (entry.sourceRemoved === true) {
				try {
					if (entry.sourceParentGuard !== undefined) {
						await assertDirectoryGuard(root, entry.sourceParentGuard, change.operationIndex, change.path);
					}
					if ((await pathState(change.absolutePath)) === "present") {
						throw new Error("target is occupied");
					}
					await atFailurePoint("rollback_restore");
					await link(originalBackupPath, change.absolutePath);
					await atFailurePoint("rollback_unlink");
					await unlink(originalBackupPath);
					delete entry.backupPath;
				} catch (error) {
					restored = false;
					rollbackFailures.push({
						operationIndex: change.operationIndex,
						path: originalBackupPath,
						action: "restore original",
						message: toError(error).message,
					});
				}
			} else {
				try {
					if (entry.sourceParentGuard !== undefined) {
						await assertDirectoryGuard(root, entry.sourceParentGuard, change.operationIndex, change.path);
					}
					const sourceStats = await lstat(change.absolutePath);
					const backupStats = await lstat(originalBackupPath);
					if (!sameDirectoryEntry(sourceStats, backupStats)) {
						throw new Error("source no longer matches its backup hardlink");
					}
					await atFailurePoint("rollback_unlink");
					await unlink(originalBackupPath);
					delete entry.backupPath;
				} catch (error) {
					restored = false;
					rollbackFailures.push({
						operationIndex: change.operationIndex,
						path: originalBackupPath,
						action: "remove unused backup",
						message: toError(error).message,
					});
				}
			}
		} else if (isInPlaceUpdate && entry.installedPath === undefined && originalBackupPath !== undefined) {
			try {
				if (entry.sourceParentGuard !== undefined) {
					await assertDirectoryGuard(root, entry.sourceParentGuard, change.operationIndex, change.path);
				}
				const sourceStats = await lstat(change.absolutePath);
				const backupStats = await lstat(originalBackupPath);
				if (!sameDirectoryEntry(sourceStats, backupStats)) {
					throw new Error("source no longer matches its backup hardlink");
				}
				await atFailurePoint("rollback_unlink");
				await unlink(originalBackupPath);
				delete entry.backupPath;
			} catch (error) {
				restored = false;
				rollbackFailures.push({
					operationIndex: change.operationIndex,
					path: originalBackupPath,
					action: "remove unused backup",
					message: toError(error).message,
				});
			}
		}

		if (entry.temporaryPath !== undefined) {
			try {
				const stagedPath = entry.temporaryPath;
				await atFailurePoint("rollback_unlink");
				await rm(stagedPath, { force: true });
				delete entry.temporaryPath;
			} catch (error) {
				const stagedPath = entry.temporaryPath;
				rollbackFailures.push({
					operationIndex: change.operationIndex,
					path: stagedPath ?? change.absolutePath,
					action: "remove staged file",
					message: toError(error).message,
				});
			}
		}
		if (restored && wasTouched) {
			rolledBack.push(changeResult(change));
		}
	}

	const createdDirectoriesRemaining = await removeCreatedDirectories(createdDirectories);
	for (const directory of createdDirectoriesRemaining) {
		rollbackFailures.push({
			path: directory,
			action: "remove created directory",
			message: "directory is not empty or could not be removed",
		});
	}
	return {
		rolledBack,
		rollbackFailures,
		journalArtifacts: await collectArtifacts(entries),
		createdDirectoriesRemaining,
	};
}

/** Explicitly mutate the filesystem using a previously successful preflight plan. */
export async function applyPreflightedPatch(
	plan: PatchPlan,
	options: ApplyPatchOptions = {},
): Promise<AppliedPatchResult> {
	checkCancelled(options.signal);
	if (!issuedPlans.has(plan)) {
		throw new PatchEngineError("invalid_plan", "Patch plan was not issued by preflightPatch");
	}
	const strategy = issuedPlanStrategies.get(plan);
	if (strategy === undefined)
		throw new PatchEngineError("invalid_plan", "Patch plan has no bound revalidation strategy");
	if (options.hashSource !== undefined && options.hashSource !== strategy.hashSource) {
		throw new PatchEngineError("invalid_plan", "Apply hasher does not match the preflight plan");
	}
	if (options.revalidateSource !== undefined && options.revalidateSource !== strategy.revalidateSource) {
		throw new PatchEngineError("invalid_plan", "Apply revalidator does not match the preflight plan");
	}
	let actualRoot: string;
	try {
		actualRoot = await realpath(plan.workspaceRoot);
	} catch (cause) {
		throw new PatchEngineError("invalid_workspace", "Workspace root is no longer available", { cause });
	}
	if (actualRoot !== plan.workspaceRoot) {
		throw new PatchEngineError("stale_source", "Workspace root changed after preflight");
	}

	for (const change of plan.changes) {
		const source = await inspectPatchPath(actualRoot, change.path, change.operationIndex);
		if (source.absolutePath !== change.absolutePath) {
			throw new PatchEngineError("invalid_plan", `Planned path changed: ${change.path}`);
		}
		if (change.kind === "update" && change.moveTo !== undefined) {
			const destination = await inspectPatchPath(actualRoot, change.moveTo, change.operationIndex);
			if (destination.absolutePath !== change.moveAbsolutePath) {
				throw new PatchEngineError("invalid_plan", `Planned move path changed: ${change.moveTo}`);
			}
		}
	}

	const { hashSource, revalidateSource: revalidate } = strategy;
	for (const expected of plan.snapshots) {
		checkCancelled(options.signal);
		const change = plan.changes.find(
			(candidate) =>
				candidate.path === expected.path || (candidate.kind === "update" && candidate.moveTo === expected.path),
		);
		await assertSnapshotCurrent(actualRoot, expected, change?.operationIndex ?? 0, hashSource, revalidate);
	}
	checkCancelled(options.signal);

	const createdDirectories: string[] = [];
	const staged: CommitJournalEntry[] = [];
	try {
		for (const change of plan.changes) {
			checkCancelled(options.signal);
			const sourceSnapshot = plan.snapshots.find((snapshot) => snapshot.path === change.path);
			const outputPath =
				change.kind === "update" && change.moveAbsolutePath !== undefined
					? change.moveAbsolutePath
					: change.absolutePath;
			const entry: CommitJournalEntry = { change };
			staged.push(entry);
			if (change.afterContent !== null) {
				await ensureParentDirectories(actualRoot, outputPath, createdDirectories);
				entry.outputParentGuard = await captureDirectoryGuard(
					actualRoot,
					outputPath,
					change.operationIndex,
					change.kind === "update" && change.moveTo !== undefined ? change.moveTo : change.path,
				);
				entry.temporaryPath = temporaryPath(outputPath);
				const sourceMode = sourceSnapshot?.state === "file" ? sourceSnapshot.mode : undefined;
				await writeTemporary(entry.temporaryPath, change.afterContent, sourceMode);
			}
			if (change.kind !== "add") {
				entry.sourceParentGuard = await captureDirectoryGuard(
					actualRoot,
					change.absolutePath,
					change.operationIndex,
					change.path,
				);
			}
			checkCancelled(options.signal);
		}
	} catch (cause) {
		const rollbackFailures: PatchRollbackFailure[] = [];
		for (const entry of staged) {
			if (entry.temporaryPath === undefined) continue;
			const stagedPath = entry.temporaryPath;
			try {
				await atFailurePoint("rollback_unlink");
				await rm(stagedPath, { force: true });
				delete entry.temporaryPath;
			} catch (cleanupError) {
				rollbackFailures.push({
					operationIndex: entry.change.operationIndex,
					path: stagedPath,
					action: "remove staged file",
					message: toError(cleanupError).message,
				});
			}
		}
		const createdDirectoriesRemaining = await removeCreatedDirectories(createdDirectories);
		for (const directory of createdDirectoriesRemaining) {
			rollbackFailures.push({
				path: directory,
				action: "remove created directory",
				message: "directory is not empty or could not be removed",
			});
		}
		const writeState: PatchWriteFailureState = {
			phase: "staging",
			applied: [],
			rolledBack: [],
			rollbackFailures,
			journalArtifacts: await collectArtifacts(staged),
			createdDirectoriesRemaining,
		};
		throw new PatchEngineError("write_failed", "Patch staging failed before file commit", { cause, writeState });
	}

	const applied: AppliedChange[] = [];
	let failedChange: PlannedChange | undefined;
	try {
		for (const entry of staged) {
			const { change } = entry;
			failedChange = change;
			checkCancelled(options.signal);
			for (const expected of snapshotsForChange(plan, change)) {
				await assertSnapshotCurrent(actualRoot, expected, change.operationIndex, hashSource, revalidate);
			}
			if (entry.sourceParentGuard !== undefined) {
				await assertDirectoryGuard(actualRoot, entry.sourceParentGuard, change.operationIndex, change.path);
			}
			if (entry.outputParentGuard !== undefined) {
				await assertDirectoryGuard(
					actualRoot,
					entry.outputParentGuard,
					change.operationIndex,
					change.kind === "update" && change.moveTo !== undefined ? change.moveTo : change.path,
				);
			}

			const sourceSnapshot = plan.snapshots.find((snapshot) => snapshot.path === change.path);
			if (change.kind !== "add") {
				if (sourceSnapshot === undefined || sourceSnapshot.state !== "file") {
					throw new PatchEngineError("invalid_plan", `Missing source snapshot for ${change.path}`);
				}
				const backupPath = temporaryPath(change.absolutePath);
				await atFailurePoint("backup_hard_link");
				await link(change.absolutePath, backupPath);
				entry.backupPath = backupPath;
				await atFailurePoint("backup_verification");
				await verifyBackup(entry.backupPath, sourceSnapshot, change.operationIndex, hashSource);
				if (entry.sourceParentGuard !== undefined) {
					await assertDirectoryGuard(actualRoot, entry.sourceParentGuard, change.operationIndex, change.path);
				}
			}

			if (change.kind === "delete") {
				await atFailurePoint("source_unlink");
				await unlink(change.absolutePath);
				entry.sourceRemoved = true;
				if (entry.sourceParentGuard !== undefined) {
					await assertDirectoryGuard(actualRoot, entry.sourceParentGuard, change.operationIndex, change.path);
				}
			} else if (change.afterContent !== null) {
				if (entry.temporaryPath === undefined) {
					throw new PatchEngineError("invalid_plan", `Missing staged output for ${change.path}`);
				}
				const outputPath =
					change.kind === "update" && change.moveAbsolutePath !== undefined
						? change.moveAbsolutePath
						: change.absolutePath;
				if (entry.outputParentGuard !== undefined) {
					await assertDirectoryGuard(
						actualRoot,
						entry.outputParentGuard,
						change.operationIndex,
						change.kind === "update" && change.moveTo !== undefined ? change.moveTo : change.path,
					);
				}
				if (change.kind === "update" && change.moveAbsolutePath === undefined) {
					await atFailurePoint("destination_publication");
					await rename(entry.temporaryPath, outputPath);
					entry.installedPath = outputPath;
				} else {
					await atFailurePoint("destination_publication");
					await link(entry.temporaryPath, outputPath);
					entry.installedPath = outputPath;
					await atFailurePoint("source_unlink");
					await unlink(entry.temporaryPath);
				}
				delete entry.temporaryPath;
				if (entry.outputParentGuard !== undefined) {
					await assertDirectoryGuard(
						actualRoot,
						entry.outputParentGuard,
						change.operationIndex,
						change.kind === "update" && change.moveTo !== undefined ? change.moveTo : change.path,
					);
				}
				const installedContent = await readJournalContent(
					outputPath,
					change.kind === "update" && change.moveTo !== undefined ? change.moveTo : change.path,
					change.operationIndex,
				);
				await atFailurePoint("installed_output_verification");
				if ((await hashSourceContent(hashSource, installedContent, outputPath)) !== change.afterHash) {
					throw new PatchEngineError("write_failed", `Installed output verification failed: ${change.path}`, {
						operationIndex: change.operationIndex,
						patchPath: change.path,
					});
				}
				if (change.kind === "update" && change.moveAbsolutePath !== undefined) {
					if (entry.sourceParentGuard !== undefined) {
						await assertDirectoryGuard(actualRoot, entry.sourceParentGuard, change.operationIndex, change.path);
					}
					await atFailurePoint("source_unlink");
					await unlink(change.absolutePath);
					entry.sourceRemoved = true;
					if (entry.sourceParentGuard !== undefined) {
						await assertDirectoryGuard(actualRoot, entry.sourceParentGuard, change.operationIndex, change.path);
					}
				}
			}
			applied.push(changeResult(change));
			await atFailurePoint("operation_committed");
			checkCancelled(options.signal);
			failedChange = undefined;
		}
	} catch (cause) {
		const rollback = await rollbackCommit(staged, actualRoot, hashSource, createdDirectories);
		const writeState: PatchWriteFailureState = {
			phase: rollback.rollbackFailures.length === 0 ? "commit" : "rollback",
			...(failedChange === undefined ? {} : { failedOperationIndex: failedChange.operationIndex }),
			applied,
			...rollback,
		};
		const rollbackSummary =
			rollback.rollbackFailures.length === 0
				? `rollback restored ${rollback.rolledBack.length} change(s)`
				: `rollback incomplete with ${rollback.rollbackFailures.length} failure(s); recoverable artifacts: ${rollback.journalArtifacts.join(", ") || "none"}`;
		throw new PatchEngineError(
			"write_failed",
			`Patch commit failed after ${applied.length} change(s); ${rollbackSummary}`,
			{
				...(failedChange === undefined
					? {}
					: {
							operationIndex: failedChange.operationIndex,
							patchPath: failedChange.path,
						}),
				cause,
				writeState,
			},
		);
	}

	const journalArtifacts: string[] = [];
	for (const entry of staged) {
		if (entry.backupPath === undefined) continue;
		const backupPath = entry.backupPath;
		try {
			await atFailurePoint("journal_cleanup");
			await unlink(backupPath);
			delete entry.backupPath;
		} catch {
			journalArtifacts.push(backupPath);
		}
	}
	return { workspaceRoot: plan.workspaceRoot, changes: applied, journalArtifacts };
}
