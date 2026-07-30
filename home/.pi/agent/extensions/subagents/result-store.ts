import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { getAgentDir, SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import {
	ACCEPTED_CONTEXT_CUSTOM_TYPE,
	parseAcceptedContextData,
	type AcceptedContextData,
} from "./context-artifacts.ts";
import type { RunUsage } from "./run-state.ts";

export const RESULT_PAGE_CUSTOM_TYPE = "subagent-result-page";
export const RESULT_PAGE_MAX_BYTES = 32 * 1024;
export const RESULT_READ_MIN_BYTES = 4;
export const RESULT_READ_DEFAULT_BYTES = 6 * 1024;
export const RESULT_READ_MAX_BYTES = 6 * 1024;
const MUTATION_CAPABLE_TOOLS = new Set(["bash", "edit", "write", "apply_patch"]);

const RESULT_ID_PATTERN = /^[0-9a-f]{64}$/;
const ResultPageDataSchema = z.strictObject({
	version: z.literal(1),
	generation: z.number().int().positive(),
	resultId: z.string().regex(RESULT_ID_PATTERN),
	pageIndex: z.number().int().nonnegative(),
	final: z.boolean(),
	page: z.string(),
	pageBytes: z.number().int().nonnegative().max(RESULT_PAGE_MAX_BYTES),
	pageSha256: z.string().regex(RESULT_ID_PATTERN),
	totalBytes: z.number().int().nonnegative(),
	totalSha256: z.string().regex(RESULT_ID_PATTERN),
});

export type ResultPageData = Readonly<z.infer<typeof ResultPageDataSchema>>;

export interface StoredAgentResult {
	readonly generation: number;
	readonly resultId: string;
	readonly text: string;
	readonly pageCount: number;
	readonly complete: boolean;
	readonly totalBytes: number;
	readonly sha256: string;
	readonly source: "pages" | "assistant_fallback";
}

export interface AgentResultReference {
	readonly generation: number;
	readonly result_id: string;
	readonly pages: number;
	readonly complete: boolean;
	readonly total_bytes: number;
	readonly sha256: string;
	readonly source: StoredAgentResult["source"];
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
	readonly pages: number;
	readonly total_bytes: number;
	readonly sha256: string;
	readonly source: StoredAgentResult["source"];
}

export interface ChildRunStats {
	readonly usage: Readonly<RunUsage>;
	readonly startTime?: number;
	readonly endTime?: number;
	readonly mutationToolCalls: number;
}

export function resultReference(result: StoredAgentResult): AgentResultReference {
	return Object.freeze({
		generation: result.generation,
		result_id: result.resultId,
		pages: result.pageCount,
		complete: result.complete,
		total_bytes: result.totalBytes,
		sha256: result.sha256,
		source: result.source,
	});
}

export function createResultPageData(
	entries: readonly SessionEntry[],
	input: {
		readonly generation: number;
		readonly resultId: string;
		readonly pageIndex: number;
		readonly page: string;
		readonly final: boolean;
	},
): ResultPageData {
	assertResultId(input.resultId);
	const existing = assembleResultPages(entries, input.generation, input.resultId);
	if (existing.complete) throw new Error("The terminal result is already complete.");
	if (input.pageIndex !== existing.pageCount) {
		throw new Error(`Result page_index must be ${existing.pageCount}; received ${input.pageIndex}.`);
	}
	const pageBytes = Buffer.byteLength(input.page, "utf8");
	if (pageBytes > RESULT_PAGE_MAX_BYTES) {
		throw new Error(
			`Result page is ${pageBytes} UTF-8 bytes; the transport page limit is ${RESULT_PAGE_MAX_BYTES} bytes. Split it without truncating the result.`,
		);
	}
	const text = existing.text + input.page;
	return Object.freeze({
		version: 1,
		generation: input.generation,
		resultId: input.resultId,
		pageIndex: input.pageIndex,
		final: input.final,
		page: input.page,
		pageBytes,
		pageSha256: sha256(input.page),
		totalBytes: Buffer.byteLength(text, "utf8"),
		totalSha256: sha256(text),
	});
}

export function assembleResultPages(
	entries: readonly SessionEntry[],
	generation: number,
	resultId: string,
): StoredAgentResult {
	assertResultId(resultId);
	const pages = entries.flatMap((entry) => {
		if (entry.type !== "custom" || entry.customType !== RESULT_PAGE_CUSTOM_TYPE) return [];
		const parsed = ResultPageDataSchema.safeParse(entry.data);
		if (!parsed.success) throw new Error("Stored result page metadata is malformed.");
		return parsed.data.generation === generation && parsed.data.resultId === resultId ? [parsed.data] : [];
	});
	let text = "";
	let complete = false;
	for (const [index, page] of pages.entries()) {
		if (page.pageIndex !== index) throw new Error(`Stored result pages are out of order at page ${index}.`);
		if (complete) throw new Error("Stored result has pages after its final page.");
		if (Buffer.byteLength(page.page, "utf8") !== page.pageBytes || sha256(page.page) !== page.pageSha256) {
			throw new Error(`Stored result page ${index} failed its integrity check.`);
		}
		text += page.page;
		if (Buffer.byteLength(text, "utf8") !== page.totalBytes || sha256(text) !== page.totalSha256) {
			throw new Error(`Stored result page ${index} failed its cumulative integrity check.`);
		}
		complete = page.final;
	}
	return Object.freeze({
		generation,
		resultId,
		text,
		pageCount: pages.length,
		complete,
		totalBytes: Buffer.byteLength(text, "utf8"),
		sha256: sha256(text),
		source: "pages",
	});
}

export async function readStoredAgentResult(
	sessionFile: string,
	generation: number,
	resultId: string | undefined,
	agentDir = getAgentDir(),
): Promise<StoredAgentResult> {
	const manager = await openValidatedChildSession(sessionFile, agentDir);
	const branch = manager.getBranch();
	const resolvedResultId = resultId ?? resultIdForGeneration(branch, generation);
	const runEntries = entriesForRun(branch, generation, resolvedResultId).entries;
	const paged = assembleResultPages(runEntries, generation, resolvedResultId);
	if (paged.pageCount > 0) return paged;
	const text = lastAssistantText(runEntries) ?? "";
	return Object.freeze({
		generation,
		resultId: resolvedResultId,
		text,
		pageCount: 0,
		complete: true,
		totalBytes: Buffer.byteLength(text, "utf8"),
		sha256: sha256(text),
		source: "assistant_fallback",
	});
}

export async function readChildTranscript(sessionFile: string, agentDir = getAgentDir()): Promise<unknown[]> {
	const manager = await openValidatedChildSession(sessionFile, agentDir);
	return manager.buildSessionContext().messages;
}

export async function readChildRunStats(
	sessionFile: string,
	generation: number,
	resultId: string,
	agentDir = getAgentDir(),
): Promise<ChildRunStats> {
	const manager = await openValidatedChildSession(sessionFile, agentDir);
	const range = entriesForRun(manager.getBranch(), generation, resultId);
	if (!range.start) {
		throw new Error(`Child session has no persisted run boundary for generation ${generation}.`);
	}
	const usage: RunUsage = {
		input: 0,
		output: 0,
		reasoning: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		turns: 0,
	};
	let mutationToolCalls = 0;
	for (const entry of range.entries) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			addStoredUsage(usage, entry.message.usage);
			usage.turns++;
		} else if (entry.type === "compaction" || entry.type === "branch_summary") {
			addStoredUsage(usage, entry.usage);
		} else if (
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			MUTATION_CAPABLE_TOOLS.has(entry.message.toolName)
		) {
			mutationToolCalls++;
		}
	}
	const first = range.start ?? range.entries[0];
	const last = range.entries.at(-1);
	const startTime = first ? parseEntryTime(first.timestamp) : undefined;
	const endTime = last ? parseEntryTime(last.timestamp) : undefined;
	return Object.freeze({
		usage: Object.freeze(usage),
		...(startTime === undefined ? {} : { startTime }),
		...(endTime === undefined ? {} : { endTime }),
		mutationToolCalls,
	});
}

export async function readChildAssistantError(
	sessionFile: string,
	agentDir = getAgentDir(),
): Promise<string | undefined> {
	const manager = await openValidatedChildSession(sessionFile, agentDir);
	for (const entry of manager.getBranch().toReversed()) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		return entry.message.stopReason === "error"
			? (entry.message.errorMessage ?? "Subagent assistant stopped with an error.")
			: undefined;
	}
	return undefined;
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
		pages: result.pageCount,
		total_bytes: result.totalBytes,
		sha256: result.sha256,
		source: result.source,
	});
}

export function formatResultCursor(resultId: string, offset: number): string {
	assertResultId(resultId);
	if (!Number.isInteger(offset) || offset < 0) throw new Error("Invalid result cursor offset.");
	return `v1.${resultId}.${offset}`;
}

export async function validateChildSessionPath(sessionFile: string, agentDir = getAgentDir()): Promise<string> {
	const sessionDirectory = path.resolve(agentDir, "subagent-sessions");
	const candidate = path.resolve(sessionFile);
	const relative = path.relative(sessionDirectory, candidate);
	if (relative.startsWith("..") || path.isAbsolute(relative)) {
		throw new Error("Child session path escapes the managed subagent session directory.");
	}
	const stats = await fs.promises.lstat(candidate);
	if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("Child session is not a regular file.");
	const uid = process.getuid?.();
	if (uid !== undefined && stats.uid !== uid) throw new Error("Child session is not owned by the current user.");
	return candidate;
}

async function openValidatedChildSession(sessionFile: string, agentDir: string): Promise<SessionManager> {
	const validated = await validateChildSessionPath(sessionFile, agentDir);
	return SessionManager.open(validated);
}

function lastAssistantText(entries: readonly SessionEntry[]): string | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type !== "message" || entry.message.role !== "assistant") continue;
		return entry.message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
	}
	return undefined;
}

function resultIdForGeneration(entries: readonly SessionEntry[], generation: number): string {
	const resultIds = new Set<string>();
	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === RESULT_PAGE_CUSTOM_TYPE) {
			const parsed = ResultPageDataSchema.safeParse(entry.data);
			if (!parsed.success) throw new Error("Stored result page metadata is malformed.");
			if (parsed.data.generation === generation) resultIds.add(parsed.data.resultId);
		} else if (entry.type === "custom" && entry.customType === ACCEPTED_CONTEXT_CUSTOM_TYPE) {
			const accepted = parseAcceptedContextData(entry.data);
			if (!accepted) throw new Error("Stored accepted-context metadata is malformed.");
			if (accepted.generation === generation) resultIds.add(accepted.resultId);
		}
	}
	if (resultIds.size !== 1) {
		throw new Error(
			resultIds.size === 0
				? `No persisted result pages identify generation ${generation}.`
				: `Generation ${generation} has conflicting result identities.`,
		);
	}
	return [...resultIds][0]!;
}

function entriesForRun(
	entries: readonly SessionEntry[],
	generation: number,
	resultId: string,
): { readonly entries: readonly SessionEntry[]; readonly start?: SessionEntry } {
	let startIndex = -1;
	let endIndex = entries.length;
	for (const [index, entry] of entries.entries()) {
		const accepted = acceptedContextEntry(entry);
		if (!accepted || !startsRun(accepted)) continue;
		if (startIndex < 0) {
			if (accepted.generation === generation && accepted.resultId === resultId) startIndex = index;
			continue;
		}
		if (accepted.generation !== generation || accepted.resultId !== resultId) {
			endIndex = index;
			break;
		}
	}
	if (startIndex < 0) return { entries };
	const start = entries[startIndex];
	if (!start) return { entries };
	return {
		entries: entries.slice(startIndex, endIndex),
		start,
	};
}

function acceptedContextEntry(entry: SessionEntry): AcceptedContextData | undefined {
	if (entry.type !== "custom" || entry.customType !== ACCEPTED_CONTEXT_CUSTOM_TYPE) return undefined;
	const accepted = parseAcceptedContextData(entry.data);
	if (!accepted) throw new Error("Stored accepted-context metadata is malformed.");
	return accepted;
}

function startsRun(accepted: AcceptedContextData): boolean {
	return accepted.kind === "assignment" || accepted.kind === "followup" || accepted.kind === "fallback";
}

function addStoredUsage(
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
	target.input += finiteUsageValue(usage.input);
	target.output += finiteUsageValue(usage.output);
	target.reasoning = (target.reasoning ?? 0) + finiteUsageValue(usage.reasoning);
	target.cacheRead += finiteUsageValue(usage.cacheRead);
	target.cacheWrite += finiteUsageValue(usage.cacheWrite);
	target.cost += finiteUsageValue(usage.cost?.total);
}

function finiteUsageValue(value: number | undefined): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function parseEntryTime(value: string): number | undefined {
	const parsed = Date.parse(value);
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
