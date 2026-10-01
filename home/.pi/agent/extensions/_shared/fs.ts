import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as nodeFs from "node:fs/promises";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { FsError, hasNodeErrorCode } from "./errors.ts";

export interface WriteFileOptions {
	/** Create missing parent directories before writing. */
	readonly recursive?: boolean;
	/** Permission bits for a newly created file. */
	readonly mode?: number;
}

export const readFileString = (path: string): Effect.Effect<string, FsError> =>
	attempt("read", path, () => nodeFs.readFile(path, "utf8"));

/** A missing file resolves to `undefined`; every other failure stays an error. */
export const readFileStringIfExists = (path: string): Effect.Effect<string | undefined, FsError> =>
	readFileString(path).pipe(Effect.catchIf(isNotFound, () => Effect.succeed(undefined)));

export const writeFileString = (
	path: string,
	contents: string,
	options?: WriteFileOptions,
): Effect.Effect<void, FsError> =>
	attempt("write", path, async () => {
		if (options?.recursive) await nodeFs.mkdir(dirname(path), { recursive: true });
		await nodeFs.writeFile(path, contents, {
			encoding: "utf8",
			...(options?.mode === undefined ? {} : { mode: options.mode }),
		});
	});

export const makeDirectory = (path: string, mode?: number): Effect.Effect<void, FsError> =>
	attempt("mkdir", path, async () => {
		await nodeFs.mkdir(path, { recursive: true, ...(mode === undefined ? {} : { mode }) });
	});

export const realPath = (path: string): Effect.Effect<string, FsError> =>
	attempt("realpath", path, () => nodeFs.realpath(path));

/** Refuse links and foreign-owned directories, and restrict an owned directory to 0700. */
export const makePrivateDirectory = (path: string): Effect.Effect<void, FsError> =>
	attempt("private mkdir", path, async () => {
		await nodeFs.mkdir(path, { recursive: true, mode: 0o700 });
		const stat = await nodeFs.lstat(path);
		if (!stat.isDirectory() || !ownedByUser(stat.uid)) throw new Error("Expected an owned, non-symlink directory");
		await nodeFs.chmod(path, 0o700);
	}).pipe(Effect.uninterruptible);

/** Bounded reads of private regular files; a missing file is the only empty-store case. */
export const readPrivateFileStringIfExists = (
	path: string,
	maxBytes: number,
): Effect.Effect<string | undefined, FsError> => readBoundedRegularFile(path, maxBytes, true);

/** Owned, no-follow private-store snapshots without changing permissions. */
export const readPrivateFileSnapshotIfExists = (
	path: string,
	maxBytes: number,
): Effect.Effect<string | undefined, FsError> => readBoundedRegularFile(path, maxBytes, true, false);

/** Bounded, no-follow reads without changing the source file's permissions. */
export const readRegularFileStringIfExists = (
	path: string,
	maxBytes: number,
): Effect.Effect<string | undefined, FsError> => readBoundedRegularFile(path, maxBytes, false);

const readBoundedRegularFile = (
	path: string,
	maxBytes: number,
	privateFile: boolean,
	restorePermissions = true,
): Effect.Effect<string | undefined, FsError> =>
	attempt(privateFile ? "private read" : "bounded read", path, async () => {
		const file = await nodeFs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		try {
			const stat = await file.stat();
			// An open old snapshot can have zero links after atomic replacement.
			if (!stat.isFile() || (privateFile && (!ownedByUser(stat.uid) || stat.nlink > 1)))
				throw new Error("Expected an owned regular file without links");
			if (stat.size > maxBytes) throw new Error(`File exceeds ${maxBytes} bytes`);
			if (privateFile && restorePermissions) await file.chmod(0o600);
			const buffer = Buffer.alloc(Math.min(stat.size, maxBytes) + 1);
			let bytes = 0;
			while (bytes < buffer.length) {
				const read = await file.read(buffer, bytes, buffer.length - bytes, bytes);
				if (read.bytesRead === 0) return buffer.subarray(0, bytes).toString("utf8");
				bytes += read.bytesRead;
			}
			// Detect growth after stat without allocating unbounded memory.
			const extra = await file.read(Buffer.alloc(1), 0, 1, bytes);
			if (extra.bytesRead > 0 || bytes > maxBytes) throw new Error("File grew during bounded read");
			return buffer.subarray(0, bytes).toString("utf8");
		} finally {
			await file.close();
		}
	}).pipe(
		Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
		Effect.uninterruptible,
	);

/** Same-directory atomic replacement. The old file survives failures before rename. */
export const writePrivateFileAtomic = (path: string, contents: string): Effect.Effect<void, FsError> =>
	attempt("atomic write", path, async () => {
		const previous = await nodeFs.lstat(path).catch((cause: unknown) => {
			if (hasNodeErrorCode(cause, "ENOENT")) return undefined;
			throw cause;
		});
		if (previous !== undefined && (!previous.isFile() || !ownedByUser(previous.uid) || previous.nlink !== 1))
			throw new Error("Refusing to replace a linked, non-regular, or foreign-owned file");
		const temporary = join(dirname(path), `.atomic-${randomUUID()}.tmp`);
		const file = await nodeFs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
		try {
			try {
				await file.writeFile(contents, "utf8");
				await file.sync();
			} finally {
				await file.close();
			}
			await nodeFs.rename(temporary, path);
		} finally {
			await nodeFs.rm(temporary, { force: true });
		}
	}).pipe(Effect.uninterruptible);

/**
 * Cross-process exclusion, without stealing potentially live locks. A process
 * crash leaves the lock for manual inspection. Use is uninterruptible so an
 * uncancellable Node write cannot outlive its lock.
 */
export function withExclusiveFileLock<A, E>(path: string, use: Effect.Effect<A, E>): Effect.Effect<A, E | FsError> {
	return Effect.acquireUseRelease(
		attempt("lock", path, () => nodeFs.open(path, "wx", 0o600)),
		() => use.pipe(Effect.uninterruptible),
		(file) =>
			attempt("unlock", path, async () => {
				try {
					await file.close();
				} finally {
					await nodeFs.unlink(path);
				}
			}),
	);
}

function ownedByUser(uid: number): boolean {
	return process.getuid === undefined || uid === process.getuid();
}

/** Remove a file; a missing file resolves without error. */
export const removeFile = (path: string): Effect.Effect<void, FsError> =>
	attempt("remove", path, async () => {
		await nodeFs.rm(path, { force: true });
	});

/** Remove a directory tree; a missing directory resolves without error. */
export const removeTree = (path: string): Effect.Effect<void, FsError> =>
	attempt("remove", path, async () => {
		await nodeFs.rm(path, { recursive: true, force: true });
	});

/**
 * Remove a directory only when it is empty. A missing, non-empty, or otherwise
 * retained directory resolves without error; concurrent writers are expected,
 * so losing this race is not a failure.
 */
export const removeDirectoryIfEmpty = (path: string): Effect.Effect<void, FsError> =>
	attempt("rmdir", path, () => nodeFs.rmdir(path)).pipe(
		Effect.catchIf(
			(error) => ["ENOENT", "ENOTEMPTY", "EEXIST"].some((code) => hasNodeErrorCode(error.cause, code)),
			() => Effect.void,
		),
	);

/** Recover from a missing file only; other failures keep their original error. */
function isNotFound(error: FsError): boolean {
	return hasNodeErrorCode(error.cause, "ENOENT");
}

function attempt<A>(operation: string, path: string, run: () => Promise<A>): Effect.Effect<A, FsError> {
	return Effect.tryPromise({ try: run, catch: (cause) => new FsError({ operation, path, cause }) });
}
