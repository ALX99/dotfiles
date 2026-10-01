import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Effect, Result } from "effect";
import { privateStoreErrorMessage, toError, type FsError } from "../_shared/errors.ts";
import {
	makePrivateDirectory,
	readPrivateFileSnapshotIfExists,
	readPrivateFileStringIfExists,
	realPath,
	withExclusiveFileLock,
	writePrivateFileAtomic,
} from "../_shared/fs.ts";
import { parseJson } from "../_shared/json.ts";
import { HarnessError, MAX_STORE_BYTES, type HarnessDocument } from "./schema.ts";
import { appendEvent, decodeHarnessDocument, emptyDocument, replayDocument, type HarnessState } from "./state.ts";

export interface HarnessStore {
	readonly scope: string;
	readonly root: string;
	readonly directory: string;
	readonly file: string;
	readonly lock: string;
}

export interface LoadedHarness {
	readonly document: HarnessDocument;
	readonly state: HarnessState;
}

/** Canonical repository paths, not cwd labels, own the learning history. */
export const openStore = Effect.fn("harnessLearning.openStore")(function* (
	scope: string,
	root = join(homedir(), ".pi", "harness-learning"),
) {
	const canonical = yield* realPath(scope).pipe(Effect.mapError(storageError));
	const base = resolve(root);
	const directory = join(base, createHash("sha256").update(canonical).digest("hex"));
	return {
		scope: canonical,
		root: base,
		directory,
		file: join(directory, "history.json"),
		lock: join(directory, "write.lock"),
	};
});

export const loadStore = Effect.fn("harnessLearning.loadStore")(function* (store: HarnessStore) {
	yield* prepare(store);
	return yield* readStore(store);
});

/** The lock spans read/validate/write; simultaneous sessions cannot lose updates. */
export const appendStoreEvent = Effect.fn("harnessLearning.appendStoreEvent")(function* (
	store: HarnessStore,
	event: unknown,
	assertCurrent?: () => void,
) {
	yield* prepare(store);
	return yield* withExclusiveFileLock(
		store.lock,
		Effect.gen(function* () {
			const current = yield* readStore(store);
			const next = yield* Effect.fromResult(appendEvent(current.document, event));
			const contents = `${JSON.stringify(next.document)}\n`;
			if (Buffer.byteLength(contents, "utf8") > MAX_STORE_BYTES)
				return yield* new HarnessError({ message: `Harness history exceeds its ${MAX_STORE_BYTES}-byte capacity` });
			if (assertCurrent !== undefined)
				yield* Effect.try({
					try: assertCurrent,
					catch: (cause) => new HarnessError({ message: toError(cause).message }),
				});
			yield* writePrivateFileAtomic(store.file, contents).pipe(Effect.mapError(storageError));
			return next.state;
		}),
	).pipe(Effect.mapError((error) => (error instanceof HarnessError ? error : storageError(error))));
});

const prepare = Effect.fnUntraced(function* (store: HarnessStore) {
	yield* makePrivateDirectory(store.root).pipe(Effect.mapError(storageError));
	yield* makePrivateDirectory(store.directory).pipe(Effect.mapError(storageError));
});

/** Offline planning can inspect an empty production scope without initializing storage. */
export const loadStoreSnapshot = Effect.fnUntraced(function* (store: HarnessStore) {
	return yield* readStore(store, false);
});

const readStore = Effect.fnUntraced(function* (
	store: HarnessStore,
	restorePermissions = true,
): Effect.fn.Return<LoadedHarness, HarnessError> {
	const read = restorePermissions ? readPrivateFileStringIfExists : readPrivateFileSnapshotIfExists;
	const raw = yield* read(store.file, MAX_STORE_BYTES).pipe(Effect.mapError(storageError));
	const parsed =
		raw === undefined
			? emptyDocument(store.scope)
			: parseJson(raw, store.file).pipe(Result.mapError((error) => new HarnessError({ message: error.message })));
	const input = yield* Effect.fromResult(parsed);
	const document = yield* Effect.fromResult(decodeHarnessDocument(input));
	const state = yield* Effect.fromResult(replayDocument(document));
	if (state.scope !== store.scope)
		return yield* new HarnessError({ message: "Harness store belongs to a different repository scope" });
	return { document, state };
});

function storageError(error: FsError): HarnessError {
	return new HarnessError({ message: privateStoreErrorMessage(error) });
}
