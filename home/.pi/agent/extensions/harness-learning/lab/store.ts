import { join } from "node:path";
import { Effect, Result, Schema } from "effect";
import { privateStoreErrorMessage, type FsError } from "../../_shared/errors.ts";
import {
	makePrivateDirectory,
	readPrivateFileSnapshotIfExists,
	readPrivateFileStringIfExists,
	withExclusiveFileLock,
	writePrivateFileAtomic,
} from "../../_shared/fs.ts";
import { parseJson } from "../../_shared/json.ts";
import { openStore } from "../store.ts";
import { LabError, LabIdSchema, MAX_LAB_STORE_BYTES, type LabDocument } from "./schema.ts";
import { appendLabEvent, decodeLabDocument, initialLabDocument, replayLabDocument, type LabState } from "./state.ts";

export interface LabStore {
	readonly scope: string;
	readonly runId: string;
	readonly root: string;
	readonly scopeDirectory: string;
	readonly labDirectory: string;
	readonly directory: string;
	readonly file: string;
	readonly lock: string;
}

export interface LoadedLab {
	readonly document: LabDocument;
	readonly state: LabState;
}

const decodeRunId = Schema.decodeUnknownResult(LabIdSchema);
const storageError = (error: FsError) => new LabError({ message: privateStoreErrorMessage(error) });

/** Reuse production's canonical scope identity, but never read or write production history. */
export const openLabStore = Effect.fn("harnessLearning.openLabStore")(function* (
	scope: string,
	runId: string,
	root?: string,
): Effect.fn.Return<LabStore, LabError> {
	const id = yield* Effect.fromResult(decodeRunId(runId)).pipe(
		Effect.mapError((error) => new LabError({ message: `Invalid laboratory run ID: ${error.message}` })),
	);
	const production = yield* openStore(scope, root).pipe(
		Effect.mapError((error) => new LabError({ message: error.message })),
	);
	const labDirectory = join(production.directory, "lab");
	const directory = join(labDirectory, id);
	return {
		scope: production.scope,
		runId: id,
		root: production.root,
		scopeDirectory: production.directory,
		labDirectory,
		directory,
		file: join(directory, "history.json"),
		lock: join(directory, "write.lock"),
	};
});

/** Status/review do not initialize missing runs or create directories. */
export const loadLabStore = Effect.fn("harnessLearning.loadLabStore")(function* (store: LabStore) {
	return yield* readStore(store, false);
});

export const createLabStore = Effect.fn("harnessLearning.createLabStore")(function* (
	store: LabStore,
	started: unknown,
) {
	yield* prepare(store);
	return yield* withExclusiveFileLock(
		store.lock,
		Effect.gen(function* () {
			const existing = yield* readPrivateFileStringIfExists(store.file, MAX_LAB_STORE_BYTES).pipe(
				Effect.mapError(storageError),
			);
			if (existing !== undefined)
				return yield* new LabError({ message: "Laboratory run already exists; history cannot be replaced" });
			const initial = yield* Effect.fromResult(initialLabDocument(store.scope, store.runId));
			const next = yield* Effect.fromResult(appendLabEvent(initial, started));
			yield* writeDocument(store, next.document);
			return next.state;
		}),
	).pipe(Effect.mapError((error) => (error instanceof LabError ? error : storageError(error))));
});

/** A per-write lock protects ordered replay and replacement; it is not held around model calls. */
export const appendLabStoreEvent = Effect.fn("harnessLearning.appendLabStoreEvent")(function* (
	store: LabStore,
	event: unknown,
) {
	yield* prepare(store);
	return yield* withExclusiveFileLock(
		store.lock,
		Effect.gen(function* () {
			const current = yield* readStore(store);
			const next = yield* Effect.fromResult(appendLabEvent(current.document, event));
			yield* writeDocument(store, next.document);
			return next.state;
		}),
	).pipe(Effect.mapError((error) => (error instanceof LabError ? error : storageError(error))));
});

const prepare = Effect.fnUntraced(function* (store: LabStore) {
	for (const path of [store.root, store.scopeDirectory, store.labDirectory, store.directory])
		yield* makePrivateDirectory(path).pipe(Effect.mapError(storageError));
});

const readStore = Effect.fnUntraced(function* (
	store: LabStore,
	restorePermissions = true,
): Effect.fn.Return<LoadedLab, LabError> {
	const read = restorePermissions ? readPrivateFileStringIfExists : readPrivateFileSnapshotIfExists;
	const raw = yield* read(store.file, MAX_LAB_STORE_BYTES).pipe(Effect.mapError(storageError));
	if (raw === undefined) return yield* new LabError({ message: `Laboratory run not found: ${store.runId}` });
	const parsed = yield* Effect.fromResult(
		parseJson(raw, store.file).pipe(Result.mapError((error) => new LabError({ message: error.message }))),
	);
	const document = yield* Effect.fromResult(decodeLabDocument(parsed));
	if (document.scope !== store.scope || document.runId !== store.runId)
		return yield* new LabError({ message: "Laboratory history belongs to a different repository or run" });
	const state = yield* Effect.fromResult(replayLabDocument(document));
	return { document, state };
});

const writeDocument = Effect.fnUntraced(function* (store: LabStore, document: LabDocument) {
	const contents = `${JSON.stringify(document)}\n`;
	if (Buffer.byteLength(contents, "utf8") > MAX_LAB_STORE_BYTES)
		return yield* new LabError({ message: `Laboratory history exceeds its ${MAX_LAB_STORE_BYTES}-byte capacity` });
	return yield* writePrivateFileAtomic(store.file, contents).pipe(Effect.mapError(storageError));
});
