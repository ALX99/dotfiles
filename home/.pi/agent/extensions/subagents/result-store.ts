import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { getAgentDir, SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";

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
	readonly sha256: string;
}

/** The one entry needed to reproduce a completed generation's terminal text. */
export interface GenerationResultLocator {
	readonly version: 2;
	readonly generation: number;
	readonly resultId: string;
	readonly sessionId: string;
	readonly sessionFile: string;
	readonly resultEntryId: string | null;
	readonly resultSha256: string;
}

export interface AgentResultReference {
	readonly generation: number;
	readonly result_id: string;
	readonly complete: boolean;
	readonly total_bytes: number;
	readonly sha256: string;
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
	readonly sha256: string;
}

export function storedResult(generation: number, resultId: string, text: string, complete: boolean): StoredAgentResult {
	assertResultId(resultId);
	return Object.freeze({
		generation,
		resultId,
		text,
		complete,
		totalBytes: Buffer.byteLength(text, "utf8"),
		sha256: sha256(text),
	});
}

export function resultReference(result: StoredAgentResult): AgentResultReference {
	return Object.freeze({
		generation: result.generation,
		result_id: result.resultId,
		complete: result.complete,
		total_bytes: result.totalBytes,
		sha256: result.sha256,
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
	if (!isRecord(value)) return undefined;
	const { version, generation, resultId, sessionId, sessionFile, resultEntryId, resultSha256 } = value;
	if (
		version !== 2 ||
		!Number.isSafeInteger(generation) ||
		(generation as number) < 1 ||
		typeof resultId !== "string" ||
		!RESULT_ID_PATTERN.test(resultId) ||
		typeof sessionId !== "string" ||
		!sessionId ||
		typeof sessionFile !== "string" ||
		!sessionFile ||
		(resultEntryId !== null && (typeof resultEntryId !== "string" || !resultEntryId)) ||
		typeof resultSha256 !== "string" ||
		!RESULT_ID_PATTERN.test(resultSha256)
	) {
		return undefined;
	}
	return Object.freeze({
		version,
		generation: generation as number,
		resultId,
		sessionId,
		sessionFile,
		resultEntryId,
		resultSha256,
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

	forget(agentId: string): void {
		this.locators.delete(agentId);
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
			const value =
				entry.type === "custom" && entry.customType === SUBAGENT_SETTLEMENT_CUSTOM_TYPE
					? entry.data
					: entry.type === "message" && entry.message.role === "toolResult"
						? entry.message.details
						: undefined;
			for (const candidate of locatorCandidates(value)) this.record(candidate.agentId, candidate.locator);
		}
		return this.size;
	}

	async readResult(
		agentId: string,
		options: {
			readonly generation?: number;
			readonly cursor?: string;
			readonly offset?: number;
			readonly maxBytes?: number;
		} = {},
	): Promise<ResultPage> {
		const generations = this.locators.get(agentId);
		if (!generations) throw new Error(`Unknown agent_id '${agentId}'.`);
		const generation = options.generation ?? Math.max(...generations.keys());
		const locator = generations.get(generation);
		if (!locator) throw new Error(`Agent ${agentId} has no result for generation ${generation}.`);
		return paginateStoredResult(agentId, await readLocatedAgentResult(locator, this.agentDir), options);
	}
}

export async function readLocatedAgentResult(
	locator: GenerationResultLocator,
	agentDir = getAgentDir(),
): Promise<StoredAgentResult> {
	const sessionFile = await validateChildSessionPath(locator.sessionFile, agentDir);
	const manager = SessionManager.open(sessionFile);
	if (manager.getSessionId() !== locator.sessionId) throw new Error("Stored subagent session identity does not match.");
	const entry = locator.resultEntryId === null ? undefined : manager.getEntry(locator.resultEntryId);
	const text = assistantText(entry) ?? "";
	const result = storedResult(
		locator.generation,
		locator.resultId,
		text,
		entry?.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "stop",
	);
	if (result.sha256 !== locator.resultSha256) throw new Error("Stored subagent result integrity check failed.");
	return result;
}

export function paginateStoredResult(
	agentId: string,
	result: StoredAgentResult,
	options: { readonly offset?: number; readonly cursor?: string; readonly maxBytes?: number },
): ResultPage {
	const cursorOffset = options.cursor === undefined ? undefined : parseResultCursor(options.cursor, result.resultId);
	if (cursorOffset !== undefined && options.offset !== undefined)
		throw new Error("Provide either cursor or offset, not both.");
	const offset = cursorOffset ?? options.offset ?? 0;
	if (
		!Number.isInteger(offset) ||
		offset < 0 ||
		offset > result.text.length ||
		(offset > 0 && isLowSurrogate(result.text.charCodeAt(offset)))
	) {
		throw new Error(
			`offset must be an integer from 0 to ${result.text.length} that does not split a Unicode surrogate pair.`,
		);
	}
	const maxBytes = options.maxBytes ?? RESULT_READ_DEFAULT_BYTES;
	if (!Number.isInteger(maxBytes) || maxBytes < RESULT_READ_MIN_BYTES || maxBytes > RESULT_READ_MAX_BYTES) {
		throw new Error(`max_bytes must be an integer from ${RESULT_READ_MIN_BYTES} to ${RESULT_READ_MAX_BYTES}.`);
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
	return Object.freeze({
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
		sha256: result.sha256,
	});
}

export function formatResultCursor(resultId: string, offset: number): string {
	assertResultId(resultId);
	if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid result cursor offset.");
	return `v1.${resultId}.${offset}`;
}

export async function validateChildSessionPath(sessionFile: string, agentDir = getAgentDir()): Promise<string> {
	const directory = path.resolve(agentDir, "subagent-sessions");
	const candidate = path.resolve(sessionFile);
	const relative = path.relative(directory, candidate);
	if (relative.startsWith("..") || path.isAbsolute(relative))
		throw new Error("Child session path escapes managed storage.");
	const stats = await fs.promises.lstat(candidate);
	if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("Child session is not a regular file.");
	const uid = process.getuid?.();
	if (uid !== undefined && stats.uid !== uid) throw new Error("Child session is not owned by the current user.");
	return candidate;
}

export async function readChildTranscript(sessionFile: string, agentDir = getAgentDir()): Promise<unknown[]> {
	const manager = SessionManager.open(await validateChildSessionPath(sessionFile, agentDir));
	return manager.buildSessionContext().messages;
}

export function assistantText(entry: SessionEntry | undefined): string | undefined {
	if (entry?.type !== "message" || entry.message.role !== "assistant") return undefined;
	const text = entry.message.content.flatMap((part) => (part.type === "text" ? [part.text] : []));
	return text.length ? text.join("\n") : undefined;
}

function locatorCandidates(
	value: unknown,
): Array<{ readonly agentId: string; readonly locator: GenerationResultLocator }> {
	if (Array.isArray(value)) return value.flatMap(locatorCandidates);
	if (!isRecord(value)) return [];
	const agentId =
		typeof value.agent_id === "string" ? value.agent_id : typeof value.agentId === "string" ? value.agentId : undefined;
	const locator = parseGenerationResultLocator(value.result_locator ?? value.resultLocator);
	const nested = Array.isArray(value.summaries) ? value.summaries.flatMap(locatorCandidates) : [];
	return agentId && locator ? [{ agentId, locator }, ...nested] : nested;
}

function parseResultCursor(cursor: string, resultId: string): number {
	const match = /^v1\.([0-9a-f]{64})\.(\d+)$/.exec(cursor);
	if (!match || match[1] !== resultId) throw new Error("Invalid or stale result cursor.");
	const offset = Number(match[2]);
	if (!Number.isSafeInteger(offset)) throw new Error("Invalid result cursor offset.");
	return offset;
}

function assertResultId(resultId: string): void {
	if (!RESULT_ID_PATTERN.test(resultId)) throw new Error("Invalid result identity.");
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function isLowSurrogate(code: number): boolean {
	return code >= 0xdc00 && code <= 0xdfff;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
