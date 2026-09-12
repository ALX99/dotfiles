import * as path from "node:path";
import { getAgentDir, SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { Effect, Result, Schema } from "effect";
import { toError } from "../_shared/errors.ts";
import type { FsError } from "../_shared/errors.ts";
import { lstat, realpath } from "../_shared/fs.ts";

/** Why a stored result could not be read or a request to read it was rejected. */
export const ResultReadReason = Schema.Literals([
	"unknown_agent",
	"unknown_generation",
	"invalid_result_id",
	"identity_mismatch",
	"missing_entry",
	"unmanaged_path",
	"not_a_regular_file",
	"foreign_owner",
	"unusable_cursor",
	"invalid_range",
	"pending_generation",
]);
export type ResultReadReason = Schema.Schema.Type<typeof ResultReadReason>;

/** A rejected result read; `message` is the text a tool reports. */
export class ResultReadError extends Schema.TaggedError<ResultReadError>()("ResultReadError", {
	reason: ResultReadReason,
	message: Schema.String,
}) {}

function readError(reason: ResultReadReason, message: string): ResultReadError {
	return new ResultReadError({ reason, message });
}
import { Predicate } from "effect";

export const SUBAGENT_SETTLEMENT_CUSTOM_TYPE = "subagent-settlement";
export const RESULT_READ_MIN_BYTES = 4;
export const RESULT_READ_DEFAULT_BYTES = 6 * 1024;
export const RESULT_READ_MAX_BYTES = 6 * 1024;
export const RESULT_PREVIEW_MAX_BYTES = 4 * 1024;
export const RESULT_PREVIEW_MAX_LINES = 100;
export const RESULT_PREVIEW_TRUNCATION_NOTICE = "\n[Result preview truncated; use read_agent_result for exact output.]";

const RESULT_ID_PATTERN = /^[0-9a-f]{64}$/;

export interface StoredAgentResult {
	readonly generation: number;
	readonly resultId: string;
	readonly text: string;
	readonly complete: boolean;
	readonly totalBytes: number;
}

/** The one entry needed to reproduce a completed generation's terminal text. */
export interface GenerationResultLocator {
	readonly version: 2;
	readonly generation: number;
	readonly resultId: string;
	readonly sessionId: string;
	readonly sessionFile: string;
	readonly resultEntryId: string | null;
}

export interface AgentResultReference {
	readonly generation: number;
	readonly result_id: string;
	readonly complete: boolean;
	readonly total_bytes: number;
}

export interface ResultPage {
	readonly agent_id: string;
	readonly generation: number;
	readonly result_id: string;
	readonly text: string;
	readonly offset: number;
	readonly next_offset: number;
	readonly next_cursor?: string;
	readonly done: boolean;
	readonly complete: boolean;
	readonly total_bytes: number;
}

export function storedResult(generation: number, resultId: string, text: string, complete: boolean): StoredAgentResult {
	assertResultId(resultId);
	return Object.freeze({
		generation,
		resultId,
		text,
		complete,
		totalBytes: Buffer.byteLength(text, "utf8"),
	});
}

export function resultReference(result: StoredAgentResult): AgentResultReference {
	return Object.freeze({
		generation: result.generation,
		result_id: result.resultId,
		complete: result.complete,
		total_bytes: result.totalBytes,
	});
}

export function resultPreview(text: string): string {
	const maximum = RESULT_PREVIEW_MAX_BYTES - Buffer.byteLength(RESULT_PREVIEW_TRUNCATION_NOTICE);
	let end = 0;
	let bytes = 0;
	let lines = 1;
	for (const character of text) {
		const next = Buffer.byteLength(character);
		if (bytes + next > maximum || (character === "\n" && lines >= RESULT_PREVIEW_MAX_LINES - 1)) break;
		bytes += next;
		end += character.length;
		if (character === "\n") lines++;
	}
	return end === text.length ? text : `${text.slice(0, end)}${RESULT_PREVIEW_TRUNCATION_NOTICE}`;
}

export function isTruncatedResultPreview(text: string): boolean {
	return text.endsWith(RESULT_PREVIEW_TRUNCATION_NOTICE);
}

export function parseGenerationResultLocator(value: unknown): GenerationResultLocator | undefined {
	if (!Predicate.isObject(value)) return undefined;
	const { version, generation, resultId, sessionId, sessionFile, resultEntryId } = value;
	if (
		version !== 2 ||
		typeof generation !== "number" ||
		!Number.isSafeInteger(generation) ||
		generation < 1 ||
		typeof resultId !== "string" ||
		!RESULT_ID_PATTERN.test(resultId) ||
		typeof sessionId !== "string" ||
		!sessionId ||
		typeof sessionFile !== "string" ||
		!sessionFile ||
		(resultEntryId !== null && (typeof resultEntryId !== "string" || !resultEntryId))
	) {
		return undefined;
	}
	return Object.freeze({
		version,
		generation,
		resultId,
		sessionId,
		sessionFile,
		resultEntryId,
	});
}

export class ResultCatalog {
	private readonly locators = new Map<string, Map<number, GenerationResultLocator>>();
	private readonly agentDir: string;

	constructor(agentDir = getAgentDir()) {
		this.agentDir = agentDir;
	}

	record(agentId: string, locator: GenerationResultLocator): void {
		const generations = this.locators.get(agentId) ?? new Map<number, GenerationResultLocator>();
		generations.set(locator.generation, locator);
		this.locators.set(agentId, generations);
	}

	clear(): void {
		this.locators.clear();
	}

	get size(): number {
		return [...this.locators.values()].reduce((total, generations) => total + generations.size, 0);
	}

	agentIds(): Iterable<string> {
		return this.locators.keys();
	}

	restore(entries: readonly SessionEntry[]): number {
		this.clear();
		for (const entry of entries) {
			const value = persistedSubagentResultValue(entry);
			for (const candidate of locatorCandidates(value)) this.record(candidate.agentId, candidate.locator);
		}
		return this.size;
	}

	readResult(
		agentId: string,
		options: {
			readonly generation?: number;
			readonly cursor?: string;
			readonly offset?: number;
			readonly maxBytes?: number;
		} = {},
	): Effect.Effect<ResultPage, ResultReadError> {
		return Effect.gen({ self: this }, function* () {
			const generations = this.locators.get(agentId);
			if (!generations) return yield* readError("unknown_agent", `Unknown agent_id '${agentId}'.`);
			const generation = options.generation ?? Math.max(...generations.keys());
			const locator = generations.get(generation);
			if (!locator) {
				return yield* readError("unknown_generation", `Agent ${agentId} has no result for generation ${generation}.`);
			}
			const stored = yield* readLocatedAgentResult(locator, this.agentDir);
			return yield* Effect.fromResult(paginateStoredResult(agentId, stored, options));
		});
	}
}

export function readLocatedAgentResult(
	locator: GenerationResultLocator,
	agentDir = getAgentDir(),
): Effect.Effect<StoredAgentResult, ResultReadError> {
	return Effect.gen(function* () {
		const sessionFile = yield* validateChildSessionPath(locator.sessionFile, agentDir);
		const manager = SessionManager.open(sessionFile);
		if (manager.getSessionId() !== locator.sessionId) {
			return yield* readError("identity_mismatch", "Stored subagent session identity does not match.");
		}
		const entry = locator.resultEntryId === null ? undefined : manager.getEntry(locator.resultEntryId);
		if (locator.resultEntryId !== null && (entry?.type !== "message" || entry.message.role !== "assistant")) {
			return yield* readError(
				"missing_entry",
				"Stored subagent result entry is missing or is not an assistant message.",
			);
		}
		return storedResult(
			locator.generation,
			locator.resultId,
			assistantText(entry) ?? "",
			entry?.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "stop",
		);
	});
}

export function paginateStoredResult(
	agentId: string,
	result: StoredAgentResult,
	options: { readonly offset?: number; readonly cursor?: string; readonly maxBytes?: number },
): Result.Result<ResultPage, ResultReadError> {
	const parsedCursor = options.cursor === undefined ? undefined : parseResultCursor(options.cursor, result.resultId);
	if (parsedCursor !== undefined && Result.isFailure(parsedCursor)) return Result.fail(parsedCursor.failure);
	const cursorOffset = parsedCursor === undefined ? undefined : parsedCursor.success;
	if (cursorOffset !== undefined && options.offset !== undefined) {
		return Result.fail(readError("invalid_range", "Provide either cursor or offset, not both."));
	}
	const offset = cursorOffset ?? options.offset ?? 0;
	if (
		!Number.isInteger(offset) ||
		offset < 0 ||
		offset > result.text.length ||
		(offset > 0 && isLowSurrogate(result.text.charCodeAt(offset)))
	) {
		return Result.fail(
			readError(
				"invalid_range",
				`offset must be an integer from 0 to ${result.text.length} that does not split a Unicode surrogate pair.`,
			),
		);
	}
	const maxBytes = options.maxBytes ?? RESULT_READ_DEFAULT_BYTES;
	if (!Number.isInteger(maxBytes) || maxBytes < RESULT_READ_MIN_BYTES || maxBytes > RESULT_READ_MAX_BYTES) {
		return Result.fail(
			readError(
				"invalid_range",
				`max_bytes must be an integer from ${RESULT_READ_MIN_BYTES} to ${RESULT_READ_MAX_BYTES}.`,
			),
		);
	}
	let nextOffset = offset;
	let bytes = 0;
	for (const character of result.text.slice(offset)) {
		const size = Buffer.byteLength(character);
		if (bytes + size > maxBytes) break;
		bytes += size;
		nextOffset += character.length;
	}
	const done = nextOffset === result.text.length;
	return Result.succeed(
		Object.freeze({
			agent_id: agentId,
			generation: result.generation,
			result_id: result.resultId,
			text: result.text.slice(offset, nextOffset),
			offset,
			next_offset: nextOffset,
			...(done ? {} : { next_cursor: formatResultCursor(result.resultId, nextOffset) }),
			done,
			complete: result.complete,
			total_bytes: result.totalBytes,
		}),
	);
}

export function formatResultCursor(resultId: string, offset: number): string {
	assertResultId(resultId);
	if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid result cursor offset.");
	return `v1.${resultId}.${offset}`;
}

export function validateChildSessionPath(
	sessionFile: string,
	agentDir = getAgentDir(),
): Effect.Effect<string, ResultReadError> {
	return Effect.gen(function* () {
		if (!path.isAbsolute(sessionFile)) {
			return yield* readError("unmanaged_path", "Child session path must be absolute.");
		}
		const candidate = path.resolve(sessionFile);
		const directory = yield* realpath(path.resolve(agentDir, "subagent-sessions")).pipe(Effect.mapError(unreadable));
		const resolvedCandidate = yield* realpath(candidate).pipe(Effect.mapError(unreadable));
		const relative = path.relative(directory, resolvedCandidate);
		if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
			return yield* readError("unmanaged_path", "Child session path escapes managed storage.");
		}
		const stats = yield* lstat(candidate).pipe(Effect.mapError(unreadable));
		if (!stats.isFile || stats.isSymbolicLink) {
			return yield* readError("not_a_regular_file", "Child session is not a regular file.");
		}
		const uid = process.getuid?.();
		if (uid !== undefined && stats.uid !== uid) {
			return yield* readError("foreign_owner", "Child session is not owned by the current user.");
		}
		return resolvedCandidate;
	});
}

function unreadable(error: FsError): ResultReadError {
	return readError("unmanaged_path", `Child session is not readable: ${toError(error.cause).message}`);
}

export function readChildTranscript(
	sessionFile: string,
	agentDir = getAgentDir(),
): Effect.Effect<unknown[], ResultReadError> {
	return Effect.gen(function* () {
		const manager = SessionManager.open(yield* validateChildSessionPath(sessionFile, agentDir));
		return manager.buildSessionContext().messages;
	});
}

export function assistantText(entry: SessionEntry | undefined): string | undefined {
	if (entry?.type !== "message" || entry.message.role !== "assistant") return undefined;
	const text = entry.message.content.flatMap((part) => (part.type === "text" ? [part.text] : []));
	return text.length ? text.join("\n") : undefined;
}

function persistedSubagentResultValue(entry: SessionEntry): unknown {
	if (entry.type === "custom" && entry.customType === SUBAGENT_SETTLEMENT_CUSTOM_TYPE) return entry.data;
	if (entry.type === "message" && entry.message.role === "toolResult" && isSubagentToolName(entry.message.toolName)) {
		return entry.message.details;
	}
	return undefined;
}

function isSubagentToolName(value: unknown): boolean {
	return (
		value === "spawn_agent" ||
		value === "followup_agent" ||
		value === "steer_agent" ||
		value === "answer_agent" ||
		value === "wait_agents" ||
		value === "read_agent_result" ||
		value === "agents_status" ||
		value === "close_agent" ||
		// Retired names remain readable so persisted branches restore results.
		value === "agent_input" ||
		value === "agent_control" ||
		value === "wait_agent" ||
		value === "list_agents" ||
		value === "interrupt_agent" ||
		value === "send_agent"
	);
}

function locatorCandidates(
	value: unknown,
): Array<{ readonly agentId: string; readonly locator: GenerationResultLocator }> {
	if (!Predicate.isObject(value)) return [];
	const candidate = locatorCandidate(value);
	const summaries = Array.isArray(value.summaries) ? value.summaries.flatMap(locatorCandidates) : [];
	return candidate ? [candidate, ...summaries] : summaries;
}

/** Tool details use RunDetails; durable settlement entries use AgentSummary. */
function locatorCandidate(
	value: Readonly<Record<string, unknown>>,
): { readonly agentId: string; readonly locator: GenerationResultLocator } | undefined {
	const agentId = typeof value.agentId === "string" ? value.agentId : undefined;
	const locator = parseGenerationResultLocator(value.resultLocator);
	if (agentId && locator) return { agentId, locator };

	const summaryAgentId = typeof value.agent_id === "string" ? value.agent_id : undefined;
	const summaryLocator = parseGenerationResultLocator(value.result_locator);
	return summaryAgentId && summaryLocator ? { agentId: summaryAgentId, locator: summaryLocator } : undefined;
}

function parseResultCursor(cursor: string, resultId: string): Result.Result<number, ResultReadError> {
	const match = /^v1\.([0-9a-f]{64})\.(\d+)$/.exec(cursor);
	if (!match || match[1] !== resultId)
		return Result.fail(readError("unusable_cursor", "Invalid or stale result cursor."));
	const offset = Number(match[2]);
	return Number.isSafeInteger(offset)
		? Result.succeed(offset)
		: Result.fail(readError("unusable_cursor", "Invalid result cursor offset."));
}

function assertResultId(resultId: string): void {
	if (!RESULT_ID_PATTERN.test(resultId)) throw new Error("Invalid result identity.");
}

function isLowSurrogate(code: number): boolean {
	return code >= 0xdc00 && code <= 0xdfff;
}
