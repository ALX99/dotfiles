import { getAgentDir, SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { isRecord } from "../_shared/json.ts";
import { validateChildSessionPath } from "./result-store.ts";
import type { RpcRequestOptions } from "./rpc-transport.ts";

/** An entry id in a session's append log, or the position before its first entry. */
export type SessionEntryCursor = string | null;

/**
 * Progress within one session.
 *
 * `appendCursor` identifies the last entry consumed from Pi's append-ordered
 * `get_entries` stream. `leafId` is the current branch leaf and may move
 * backwards independently. A checkpoint has no session identity: callers must
 * bind it to the session they requested or recovered.
 */
export interface SessionCheckpoint {
	readonly appendCursor: SessionEntryCursor;
	readonly leafId: SessionEntryCursor;
}

export interface ChildSessionIdentity {
	readonly sessionId: string;
	readonly sessionFile: string;
}

export interface SessionEntries {
	readonly entries: readonly SessionEntry[];
	readonly checkpoint: SessionCheckpoint;
}

export interface SessionEntriesRpc {
	request(command: Readonly<Record<string, unknown>>, options?: RpcRequestOptions): Promise<unknown>;
}

/**
 * Read Pi's append-ordered entries after `previous.appendCursor`.
 *
 * Pi returns the active leaf independently of the append stream, so an empty
 * delta retains the prior append cursor while still adopting the returned leaf.
 */
export async function getRpcSessionEntries(
	rpc: SessionEntriesRpc,
	previous: SessionCheckpoint,
	options?: RpcRequestOptions,
): Promise<SessionEntries> {
	const command = {
		type: "get_entries",
		...(previous.appendCursor === null ? {} : { since: previous.appendCursor }),
	};
	const response = options === undefined ? await rpc.request(command) : await rpc.request(command, options);
	return parseRpcSessionEntries(response, previous);
}

/**
 * Recover Pi `get_entries` semantics directly from a validated child session.
 *
 * Session identity scoping is the caller's responsibility: only reuse
 * `previous` for the same session file/RPC session.
 */
export async function readChildSessionEntriesSince(
	sessionFile: string,
	previous: SessionCheckpoint,
	agentDir = getAgentDir(),
): Promise<SessionEntries> {
	const validated = await validateChildSessionPath(sessionFile, agentDir);
	const manager = SessionManager.open(validated);
	const entries = manager.getEntries();
	const start = sessionCursorIndex(entries, previous.appendCursor);
	return sessionEntries(entries.slice(start + 1), previous.appendCursor, manager.getLeafId());
}

export function parseRpcSessionEntries(response: unknown, previous: SessionCheckpoint): SessionEntries {
	if (!isRecord(response) || !Array.isArray(response.entries) || !isSessionEntryCursor(response.leafId)) {
		throw new Error("Subagent RPC returned an invalid get_entries response.");
	}
	if (
		!response.entries.every(isSessionEntry) ||
		new Set(response.entries.map((entry) => entry.id)).size !== response.entries.length
	) {
		throw new Error("Subagent RPC returned invalid get_entries entries.");
	}
	return sessionEntries(response.entries, previous.appendCursor, response.leafId);
}

export function parseChildSessionIdentity(value: unknown): ChildSessionIdentity {
	if (
		!isRecord(value) ||
		typeof value.sessionId !== "string" ||
		!value.sessionId.trim() ||
		typeof value.sessionFile !== "string" ||
		!value.sessionFile.trim()
	) {
		throw new Error("Subagent RPC returned an invalid session identity.");
	}
	return Object.freeze({ sessionId: value.sessionId, sessionFile: value.sessionFile });
}

export function assertSameChildSession(expected: ChildSessionIdentity, resumed: ChildSessionIdentity): void {
	if (resumed.sessionId !== expected.sessionId || resumed.sessionFile !== expected.sessionFile) {
		throw new Error("Subagent RPC resumed a different session identity or file.");
	}
}

function sessionEntries(
	entries: readonly SessionEntry[],
	previousAppendCursor: SessionEntryCursor,
	leafId: SessionEntryCursor,
): SessionEntries {
	return Object.freeze({
		entries: Object.freeze([...entries]),
		checkpoint: Object.freeze({
			appendCursor: entries.at(-1)?.id ?? previousAppendCursor,
			leafId,
		}),
	});
}

function sessionCursorIndex(entries: readonly SessionEntry[], since: SessionEntryCursor): number {
	if (since === null) return -1;
	const index = entries.findIndex((entry) => entry.id === since);
	if (index < 0) throw new Error(`Session append cursor '${since}' does not exist.`);
	return index;
}

function isSessionEntryCursor(value: unknown): value is SessionEntryCursor {
	return value === null || (typeof value === "string" && value.length > 0);
}

/**
 * RPC cursors need only the stable base entry shape. In particular, do not
 * assume a compaction representation; Pi may evolve compaction-specific data.
 */
function isSessionEntry(value: unknown): value is SessionEntry {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		value.id.length > 0 &&
		isSessionEntryCursor(value.parentId) &&
		typeof value.timestamp === "string" &&
		typeof value.type === "string" &&
		value.type.length > 0
	);
}
