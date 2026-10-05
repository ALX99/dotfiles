import { buildSessionProjection, convertToLlm, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Api, Message, Model, Tool, Usage } from "@earendil-works/pi-ai";
import { Predicate } from "effect";

import { modelKey, supportsServerCompaction } from "./models.ts";
import {
	isResponseItem,
	messagesToResponseItems,
	normalizeResponseItemsForPrompt,
	type ResponseItem,
} from "./response-items.ts";

/**
 * What the session file records about OpenAI's own compaction, and everything this
 * extension derives from it.
 *
 * The session's branch is the only authority. A fork, a tree navigation, and a restart
 * in a new process all read the same entries Pi wrote, so no state is kept in memory to
 * disagree with them, and a compaction that another process performed is picked up
 * without any handoff.
 */

/** The replacement history Pi stored for one compaction. */
export interface RemoteCompactionDetails {
	readonly version: 1 | 2;
	readonly provider: "openai-responses-compact" | "openai-responses-compaction";
	readonly modelKey: string;
	readonly replacementHistory: ResponseItem[];
	readonly usage?: Usage;
}

/** The newest compaction entry that recorded a replacement history, and where it sits. */
interface RemoteCompactionRecord {
	/** Position in the branch, so the turns after it can be replayed with it. */
	readonly index: number;
	readonly modelKey: string;
	readonly replacementHistory: ResponseItem[];
}

/** The record to store in a compaction entry's details. */
export function buildRemoteCompactionDetails(
	model: Model<Api>,
	replacementHistory: readonly ResponseItem[],
	usage?: Usage,
): RemoteCompactionDetails {
	return {
		version: 2,
		provider: "openai-responses-compaction",
		modelKey: modelKey(model),
		replacementHistory: [...replacementHistory],
		...(usage === undefined ? {} : { usage }),
	};
}

/** Read the stored replacement history out of a compaction entry, including entries written by v1. */
export function extractRemoteCompactionDetails(details: unknown): RemoteCompactionDetails | undefined {
	const remote = Predicate.isObject(details)
		? Predicate.isObject(details.remoteCompaction)
			? details.remoteCompaction
			: details
		: undefined;
	if (remote === undefined) return undefined;
	const isLegacy = remote.provider === "openai-responses-compact" && remote.version === 1;
	const isV2 = remote.provider === "openai-responses-compaction" && remote.version === 2;
	if (!isLegacy && !isV2) return undefined;
	if (!Array.isArray(remote.replacementHistory)) return undefined;

	const replacementHistory = remote.replacementHistory.filter(isResponseItem);
	if (replacementHistory.length === 0) return undefined;
	const usage = parseStoredUsage(remote.usage);

	return {
		version: isV2 ? 2 : 1,
		provider: isV2 ? "openai-responses-compaction" : "openai-responses-compact",
		modelKey: typeof remote.modelKey === "string" ? remote.modelKey : "",
		replacementHistory,
		...(usage === undefined ? {} : { usage }),
	};
}

/** The newest compaction on this branch that stored OpenAI's replacement history. */
function latestRemoteCompaction(entries: readonly SessionEntry[]): RemoteCompactionRecord | undefined {
	const index = entries.findLastIndex((entry) => entry.type === "compaction");
	const entry = entries[index];
	if (entry?.type !== "compaction") return undefined;
	const details = extractRemoteCompactionDetails(entry.details);
	// A newer Pi-only compaction supersedes the old encrypted checkpoint too.
	return details === undefined
		? undefined
		: { index, modelKey: details.modelKey, replacementHistory: details.replacementHistory };
}

/** Pi owns context edits, custom messages, branch summaries, and compaction-aware projection. */
export function projectedBranchMessages(entries: readonly SessionEntry[]): Message[] {
	return convertToLlm(buildSessionProjection([...entries]).messages);
}

/**
 * The input to replay for a model that has a compaction: OpenAI's replacement history
 * followed by the turns that came after it. Undefined when this model produced none.
 */
export function replayHistoryFor(
	entries: readonly SessionEntry[],
	model: Model<Api>,
	tools: readonly Tool[] = [],
): ResponseItem[] | undefined {
	const record = latestRemoteCompaction(entries);
	if (record === undefined || record.modelKey !== modelKey(model) || !supportsServerCompaction(model)) return undefined;
	const afterCheckpoint = new Set(entries.slice(record.index + 1).map((entry) => entry.id));
	const projected = buildSessionProjection([...entries])
		.entries.filter((entry) => afterCheckpoint.has(entry.sourceEntry.id))
		.flatMap((entry) => entry.messages);
	const messages = completedTurnMessages(convertToLlm(projected), record.modelKey);
	const turns = messagesToResponseItems(messages, model, tools);
	return normalizeResponseItemsForPrompt([...record.replacementHistory, ...turns], model);
}

/**
 * The turns after a compaction, as replayable items.
 *
 * A turn is kept only when the assistant that closed it ran on the model that produced
 * the compaction, because another model's reasoning and tool items cannot be replayed to
 * this one. The turn still in flight is kept either way: the request being patched is the
 * one carrying the question just asked, and dropping it would answer nothing.
 */
function completedTurnMessages(messages: readonly Message[], compactionModelKey: string): Message[] {
	const completed: Message[] = [];
	let inflight: Message[] = [];

	for (const message of messages) {
		if (message.role !== "assistant") {
			inflight.push(message);
			continue;
		}
		if (assistantMessageMatchesModelKey(message, compactionModelKey)) {
			completed.push(...inflight, message);
		}
		inflight = [];
	}

	return [...completed, ...inflight];
}

function assistantMessageMatchesModelKey(
	message: Extract<Message, { role: "assistant" }>,
	targetModelKey: string,
): boolean {
	const [provider, , id] = targetModelKey.split(":", 3);
	if (!provider || !id) return false;
	return message.provider === provider && message.model === id;
}

/** Stored token accounting, so a replayed compaction still reports what it cost. */
function parseStoredUsage(value: unknown): Usage | undefined {
	if (!Predicate.isObject(value)) return undefined;
	const input = count(value.input);
	const output = count(value.output);
	const cacheRead = count(value.cacheRead);
	const cacheWrite = count(value.cacheWrite);
	const cost = Predicate.isObject(value.cost) ? value.cost : undefined;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: count(value.totalTokens) || input + output + cacheRead + cacheWrite,
		cost: {
			input: count(cost?.input),
			output: count(cost?.output),
			cacheRead: count(cost?.cacheRead),
			cacheWrite: count(cost?.cacheWrite),
			total: count(cost?.total) || input + output + cacheRead + cacheWrite,
		},
	};
}

function count(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
