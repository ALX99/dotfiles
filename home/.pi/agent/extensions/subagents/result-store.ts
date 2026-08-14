import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { getAgentDir, SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { RunUsage } from "./run-state.ts";
import type { ChildSessionIdentity, SessionCheckpoint } from "./session-cursors.ts";

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

export interface GenerationResultLocator {
	readonly version: 1;
	readonly generation: number;
	readonly resultId: string;
	readonly sessionId: string;
	readonly sessionFile: string;
	readonly start: SessionCheckpoint;
	readonly end: SessionCheckpoint;
	readonly resultEntryId: string | null;
	readonly resultSha256: string;
}

export interface CapturedGeneration {
	readonly result: StoredAgentResult;
	readonly locator: GenerationResultLocator;
	readonly stats: ChildRunStats;
	readonly assistantError?: string;
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

/** Presentation-only text; the persisted result remains available by locator. */
export function resultPreview(text: string): string {
	const maxContentBytes = RESULT_PREVIEW_MAX_BYTES - Buffer.byteLength(RESULT_PREVIEW_TRUNCATION_NOTICE, "utf8");
	let end = 0;
	let bytes = 0;
	let lines = 1;
	for (const character of text) {
		const characterBytes = Buffer.byteLength(character, "utf8");
		if (bytes + characterBytes > maxContentBytes || (character === "\n" && lines >= RESULT_PREVIEW_MAX_LINES - 1)) {
			break;
		}
		bytes += characterBytes;
		end += character.length;
		if (character === "\n") lines++;
	}
	if (end === text.length) return text;
	return `${text.slice(0, end)}${RESULT_PREVIEW_TRUNCATION_NOTICE}`;
}

export function isTruncatedResultPreview(text: string): boolean {
	return text.endsWith(RESULT_PREVIEW_TRUNCATION_NOTICE);
}

export interface ChildRunStats {
	readonly usage: Readonly<RunUsage>;
	readonly startTime?: number;
	readonly endTime?: number;
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

export function parseGenerationResultLocator(value: unknown): GenerationResultLocator | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const record = value as Readonly<Record<string, unknown>>;
	const start = parseStoredCheckpoint(record.start);
	const end = parseStoredCheckpoint(record.end);
	if (
		record.version !== 1 ||
		typeof record.generation !== "number" ||
		!Number.isSafeInteger(record.generation) ||
		record.generation < 1 ||
		typeof record.resultId !== "string" ||
		!RESULT_ID_PATTERN.test(record.resultId) ||
		typeof record.sessionId !== "string" ||
		!record.sessionId.trim() ||
		typeof record.sessionFile !== "string" ||
		!record.sessionFile.trim() ||
		start === undefined ||
		end === undefined ||
		(record.resultEntryId !== null &&
			(typeof record.resultEntryId !== "string" || record.resultEntryId.length === 0)) ||
		typeof record.resultSha256 !== "string" ||
		!RESULT_ID_PATTERN.test(record.resultSha256)
	) {
		return undefined;
	}
	return Object.freeze({
		version: 1,
		generation: record.generation,
		resultId: record.resultId,
		sessionId: record.sessionId,
		sessionFile: record.sessionFile,
		start,
		end,
		resultEntryId: record.resultEntryId,
		resultSha256: record.resultSha256,
	});
}

export class ResultCatalog {
	private readonly locators = new Map<string, Map<number, GenerationResultLocator>>();
	private readonly agentDir: string;

	constructor(agentDir = getAgentDir()) {
		this.agentDir = agentDir;
	}

	record(agentId: string, locator: GenerationResultLocator): void {
		let generations = this.locators.get(agentId);
		if (!generations) {
			generations = new Map();
			this.locators.set(agentId, generations);
		}
		generations.set(locator.generation, locator);
	}

	recordGeneration(agentId: string, captured: CapturedGeneration): void {
		this.record(agentId, captured.locator);
	}

	forget(agentId: string): void {
		this.locators.delete(agentId);
	}

	clear(): void {
		this.locators.clear();
	}

	get size(): number {
		let count = 0;
		for (const generations of this.locators.values()) count += generations.size;
		return count;
	}

	restore(entries: readonly SessionEntry[]): number {
		this.locators.clear();
		for (const entry of entries) {
			for (const candidate of locatorCandidates(entry)) this.record(candidate.agentId, candidate.locator);
		}
		return [...this.locators.values()].reduce((count, generations) => count + generations.size, 0);
	}

	agentIds(): Iterable<string> {
		return this.locators.keys();
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
		const generation = options.generation ?? this.latestGeneration(generations);
		const locator = generations.get(generation);
		if (!locator) throw new Error(`Agent ${agentId} has no result locator for generation ${generation}.`);
		const result = await readLocatedAgentResult(locator, this.agentDir);
		return paginateStoredResult(agentId, result, options);
	}

	private latestGeneration(locators: ReadonlyMap<number, GenerationResultLocator>): number {
		const generations = [...locators.keys()];
		if (generations.length === 0) throw new Error("Stored agent has no result locators.");
		return Math.max(...generations);
	}
}

const LOCATOR_TOOL_NAMES = new Set([
	"spawn_agent",
	"followup_agent",
	"wait_agent",
	"list_agents",
	"send_agent",
	"answer_agent",
	"close_agent",
	"interrupt_agent",
]);

function locatorCandidates(
	entry: SessionEntry,
): Array<{ readonly agentId: string; readonly locator: GenerationResultLocator }> {
	let details: unknown;
	if (entry.type === "custom" && entry.customType === SUBAGENT_SETTLEMENT_CUSTOM_TYPE) details = entry.data;
	else if (
		entry.type === "message" &&
		entry.message.role === "toolResult" &&
		LOCATOR_TOOL_NAMES.has(entry.message.toolName)
	) {
		details = entry.message.details;
	} else return [];
	return collectLocatorCandidates(details);
}

function collectLocatorCandidates(
	value: unknown,
): Array<{ readonly agentId: string; readonly locator: GenerationResultLocator }> {
	if (Array.isArray(value)) return value.flatMap((item) => collectLocatorCandidates(item));
	if (!isRecord(value)) return [];
	const nested = Array.isArray(value.summaries)
		? value.summaries.flatMap((item) => collectLocatorCandidates(item))
		: [];
	const agentId = stringField(value, "agent_id", "agentId");
	const nativeValue = value.result_locator ?? value.resultLocator;
	if (nativeValue !== undefined) {
		const native = parseGenerationResultLocator(nativeValue);
		if (agentId === undefined || native === undefined) return nested;
		return [...nested, { agentId, locator: native }];
	}
	return nested;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: Readonly<Record<string, unknown>>, ...names: string[]): string | undefined {
	for (const name of names) {
		const field = value[name];
		if (typeof field === "string" && field.trim()) return field;
	}
	return undefined;
}

export function captureGeneration(
	identity: ChildSessionIdentity,
	generation: number,
	resultId: string,
	start: SessionCheckpoint,
	end: SessionCheckpoint,
	appendedEntries: readonly SessionEntry[],
): CapturedGeneration {
	assertResultId(resultId);
	const activeEntries = activeGenerationEntries(appendedEntries, start, end);
	const result = storedResultFromActiveBranch(activeEntries, generation, resultId);
	const nativeStats = childRunStats(appendedEntries);
	const stats = Object.freeze({
		usage: nativeStats.usage,
		...(nativeStats.startTime === undefined ? {} : { startTime: nativeStats.startTime }),
		...(nativeStats.endTime === undefined ? {} : { endTime: nativeStats.endTime }),
	});
	const assistantError = activeBranchAssistantError(activeEntries);
	const locator: GenerationResultLocator = Object.freeze({
		version: 1,
		generation,
		resultId,
		sessionId: identity.sessionId,
		sessionFile: identity.sessionFile,
		start: Object.freeze({ ...start }),
		end: Object.freeze({ ...end }),
		resultEntryId: resultEntryId(activeEntries),
		resultSha256: result.sha256,
	});
	return Object.freeze({
		result,
		locator,
		stats,
		...(assistantError === undefined ? {} : { assistantError }),
	});
}

export async function readLocatedAgentResult(
	locator: GenerationResultLocator,
	agentDir = getAgentDir(),
): Promise<StoredAgentResult> {
	const manager = await openValidatedChildSession(locator.sessionFile, agentDir);
	if (
		manager.getSessionId() !== locator.sessionId ||
		path.resolve(manager.getSessionFile() ?? "") !== path.resolve(locator.sessionFile)
	) {
		throw new Error("Stored subagent locator session identity or file does not match.");
	}
	const entries = manager.getEntries();
	const appended = appendEntriesBetween(entries, locator.start, locator.end);
	const active = activeGenerationEntries(appended, locator.start, locator.end);
	const result = storedResultFromActiveBranch(active, locator.generation, locator.resultId);
	if (resultEntryId(active) !== locator.resultEntryId || result.sha256 !== locator.resultSha256) {
		throw new Error("Stored subagent result locator failed its native entry integrity check.");
	}
	return result;
}

function storedResult(generation: number, resultId: string, text: string, complete: boolean): StoredAgentResult {
	return Object.freeze({
		generation,
		resultId,
		text,
		complete,
		totalBytes: Buffer.byteLength(text, "utf8"),
		sha256: sha256(text),
	});
}

function storedResultFromActiveBranch(
	entries: readonly SessionEntry[],
	generation: number,
	resultId: string,
): StoredAgentResult {
	const assistant = lastAssistantEntry(entries);
	const text = assistantText(assistant) ?? lastAssistantText(entries) ?? "";
	const complete =
		assistant?.type === "message" && assistant.message.role === "assistant" && assistant.message.stopReason === "stop";
	return storedResult(generation, resultId, text, complete);
}

function resultEntryId(entries: readonly SessionEntry[]): string | null {
	return lastAssistantEntry(entries)?.id ?? null;
}

function activeBranchAssistantError(entries: readonly SessionEntry[]): string | undefined {
	const assistant = lastAssistantEntry(entries);
	if (assistant?.type !== "message" || assistant.message.role !== "assistant") return undefined;
	switch (assistant.message.stopReason) {
		case "error":
			return assistant.message.errorMessage?.trim() || "Subagent assistant stopped with an error.";
		case "length":
			return "Subagent assistant stopped at its output limit before completing the terminal result.";
		case "aborted":
			return "Subagent assistant was aborted before completing the terminal result.";
		case "pending":
			return "Subagent assistant remained pending without a terminal result.";
		case "deferred":
			return "Subagent assistant deferred its terminal result.";
		case "toolUse":
			return "Subagent assistant ended with a tool call instead of a terminal result.";
		case "stop":
			return undefined;
	}
}

function lastAssistantEntry(entries: readonly SessionEntry[]): SessionEntry | undefined {
	return entries.findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
}

function lastAssistantText(entries: readonly SessionEntry[]): string | undefined {
	for (const entry of entries.toReversed()) {
		const text = assistantText(entry);
		if (text !== undefined) return text;
	}
	return undefined;
}

function assistantText(entry: SessionEntry | undefined): string | undefined {
	if (entry?.type !== "message" || entry.message.role !== "assistant") return undefined;
	const parts = entry.message.content.flatMap((part) => (part.type === "text" ? [part.text] : []));
	return parts.length === 0 ? undefined : parts.join("\n");
}

function activeGenerationEntries(
	appendedEntries: readonly SessionEntry[],
	start: SessionCheckpoint,
	end: SessionCheckpoint,
): readonly SessionEntry[] {
	const expectedAppendCursor = appendedEntries.at(-1)?.id ?? start.appendCursor;
	if (end.appendCursor !== expectedAppendCursor) {
		throw new Error("Generation end append cursor does not match its append-ordered entries.");
	}
	const byId = new Map<string, SessionEntry>();
	for (const entry of appendedEntries) {
		if (byId.has(entry.id) || entry.id === start.appendCursor) {
			throw new Error("Generation append entries contain an invalid or duplicate cursor.");
		}
		byId.set(entry.id, entry);
	}
	const reversed: SessionEntry[] = [];
	let cursor = end.leafId;
	while (cursor !== start.leafId) {
		if (cursor === null) {
			throw new Error("Generation end leaf is not descended from its start leaf.");
		}
		const entry = byId.get(cursor);
		if (!entry) {
			throw new Error(`Generation active-branch cursor '${cursor}' is outside its append range.`);
		}
		reversed.push(entry);
		cursor = entry.parentId;
	}
	return Object.freeze(reversed.reverse());
}

function appendEntriesBetween(
	entries: readonly SessionEntry[],
	start: SessionCheckpoint,
	end: SessionCheckpoint,
): readonly SessionEntry[] {
	const startIndex = checkpointIndex(entries, start, "start");
	const endIndex = checkpointIndex(entries, end, "end");
	if (endIndex < startIndex) throw new Error("Stored subagent locator end cursor precedes its start cursor.");
	return Object.freeze(entries.slice(startIndex + 1, endIndex + 1));
}

function checkpointIndex(
	entries: readonly SessionEntry[],
	checkpoint: SessionCheckpoint,
	label: "start" | "end",
): number {
	const appendIndex = entryIndex(entries, checkpoint.appendCursor, `${label} append`);
	const leafIndex = entryIndex(entries, checkpoint.leafId, `${label} leaf`);
	if (leafIndex > appendIndex) {
		throw new Error(`Stored subagent locator ${label} leaf is after its append cursor.`);
	}
	return appendIndex;
}

function entryIndex(entries: readonly SessionEntry[], cursor: string | null, label: string): number {
	if (cursor === null) return -1;
	const index = entries.findIndex((entry) => entry.id === cursor);
	if (index < 0) throw new Error(`Stored subagent locator ${label} cursor '${cursor}' does not exist.`);
	return index;
}

function parseStoredCheckpoint(value: unknown): SessionCheckpoint | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const record = value as Readonly<Record<string, unknown>>;
	if (!isStoredEntryCursor(record.appendCursor) || !isStoredEntryCursor(record.leafId)) return undefined;
	return Object.freeze({ appendCursor: record.appendCursor, leafId: record.leafId });
}

function isStoredEntryCursor(value: unknown): value is string | null {
	return value === null || (typeof value === "string" && value.length > 0);
}

export async function readChildTranscript(sessionFile: string, agentDir = getAgentDir()): Promise<unknown[]> {
	const manager = await openValidatedChildSession(sessionFile, agentDir);
	return manager.buildSessionContext().messages;
}

export function paginateStoredResult(
	agentId: string,
	result: StoredAgentResult,
	options: {
		readonly offset?: number;
		readonly cursor?: string;
		readonly maxBytes?: number;
	},
): ResultPage {
	const cursorOffset = options.cursor === undefined ? undefined : parseResultCursor(options.cursor, result.resultId);
	if (cursorOffset !== undefined && options.offset !== undefined) {
		throw new Error("Provide either cursor or offset, not both.");
	}
	const offset = cursorOffset ?? options.offset ?? 0;
	if (!Number.isInteger(offset) || offset < 0 || offset > result.text.length) {
		throw new Error(`offset must be an integer from 0 to ${result.text.length}.`);
	}
	if (offset > 0 && isLowSurrogate(result.text.charCodeAt(offset))) {
		throw new Error("offset must not split a Unicode surrogate pair.");
	}
	const maxBytes = options.maxBytes ?? RESULT_READ_DEFAULT_BYTES;
	if (!Number.isInteger(maxBytes) || maxBytes < RESULT_READ_MIN_BYTES || maxBytes > RESULT_READ_MAX_BYTES) {
		throw new Error(`max_bytes must be an integer from ${RESULT_READ_MIN_BYTES} to ${RESULT_READ_MAX_BYTES}.`);
	}
	let nextOffset = offset;
	let usedBytes = 0;
	for (const character of result.text.slice(offset)) {
		const bytes = Buffer.byteLength(character, "utf8");
		if (usedBytes + bytes > maxBytes) break;
		usedBytes += bytes;
		nextOffset += character.length;
	}
	const done = nextOffset >= result.text.length;
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
	if (!Number.isInteger(offset) || offset < 0) throw new Error("Invalid result cursor offset.");
	return `v1.${resultId}.${offset}`;
}

export async function validateChildSessionPath(sessionFile: string, agentDir = getAgentDir()): Promise<string> {
	const candidate = resolveChildSessionPath(sessionFile, agentDir);
	const stats = await fs.promises.lstat(candidate);
	if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("Child session is not a regular file.");
	const uid = process.getuid?.();
	if (uid !== undefined && stats.uid !== uid) throw new Error("Child session is not owned by the current user.");
	return candidate;
}

function resolveChildSessionPath(sessionFile: string, agentDir: string): string {
	const sessionDirectory = path.resolve(agentDir, "subagent-sessions");
	const candidate = path.resolve(sessionFile);
	const relative = path.relative(sessionDirectory, candidate);
	if (relative.startsWith("..") || path.isAbsolute(relative)) {
		throw new Error("Child session path escapes the managed subagent session directory.");
	}
	return candidate;
}

/**
 * Bind the RPC identity to the managed session directory.
 *
 * Pi does not create a new session file until its first assistant message is
 * flushed, so startup validation must also admit the prospective path. Every
 * later result read validates the created regular file and its persisted id.
 */
export async function validateChildSessionIdentity(
	identity: ChildSessionIdentity,
	agentDir = getAgentDir(),
): Promise<ChildSessionIdentity> {
	const sessionFile = resolveChildSessionPath(identity.sessionFile, agentDir);
	let manager: SessionManager;
	try {
		manager = await openValidatedChildSession(sessionFile, agentDir);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") {
			return Object.freeze({ ...identity, sessionFile });
		}
		throw error;
	}
	if (manager.getSessionId() !== identity.sessionId || manager.getSessionFile() !== sessionFile) {
		throw new Error("Child session identity or file does not match its validated session.");
	}
	return Object.freeze({ ...identity, sessionFile });
}

async function openValidatedChildSession(sessionFile: string, agentDir: string): Promise<SessionManager> {
	const validated = await validateChildSessionPath(sessionFile, agentDir);
	return SessionManager.open(validated);
}

function childRunStats(entries: readonly SessionEntry[]): {
	readonly usage: Readonly<RunUsage>;
	readonly startTime?: number;
	readonly endTime?: number;
} {
	const usage: RunUsage = {
		input: 0,
		output: 0,
		reasoning: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		turns: 0,
	};
	for (const entry of entries) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			addUsage(usage, entry.message.usage);
			usage.turns++;
		} else if (entry.type === "compaction" || entry.type === "branch_summary") {
			addUsage(usage, entry.usage);
		}
	}
	const startTime = entryTime(entries[0]);
	const endTime = entryTime(entries.at(-1));
	return Object.freeze({
		usage: Object.freeze(usage),
		...(startTime === undefined ? {} : { startTime }),
		...(endTime === undefined ? {} : { endTime }),
	});
}

function addUsage(
	target: RunUsage,
	usage:
		| {
				input?: number;
				output?: number;
				reasoning?: number;
				cacheRead?: number;
				cacheWrite?: number;
				cost?: { total?: number };
		  }
		| undefined,
): void {
	if (!usage) return;
	target.input += usageValue(usage.input);
	target.output += usageValue(usage.output);
	target.reasoning = (target.reasoning ?? 0) + usageValue(usage.reasoning);
	target.cacheRead += usageValue(usage.cacheRead);
	target.cacheWrite += usageValue(usage.cacheWrite);
	target.cost += usageValue(usage.cost?.total);
}

function usageValue(value: number | undefined): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function entryTime(entry: SessionEntry | undefined): number | undefined {
	if (!entry) return undefined;
	const parsed = Date.parse(entry.timestamp);
	return Number.isFinite(parsed) ? parsed : undefined;
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
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function isLowSurrogate(code: number): boolean {
	return code >= 0xdc00 && code <= 0xdfff;
}
