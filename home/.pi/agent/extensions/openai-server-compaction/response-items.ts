import type { Message, Tool } from "@earendil-works/pi-ai";
import { Predicate } from "effect";
import type { ResponsesModel } from "./models.ts";
import {
	createGrammarToolInputProperties,
	convertResponsesMessages,
	convertResponsesTools,
	getDeclaredTools,
	normalizeContext,
} from "./pi-responses.ts";

/**
 * OpenAI Responses input items, in the shape the API expects on a replayed
 * conversation. Everything the backend returns that this extension does not
 * interpret stays an opaque record so a replay never loses provider state.
 */

export type AssistantPhase = "commentary" | "final_answer";

export type ResponseContentItem =
	| { type: "input_text"; text: string }
	| { type: "output_text"; text: string }
	| { type: "input_image"; image_url: string };

type ToolResultOutputItem = { type: "input_text"; text: string } | { type: "input_image"; image_url: string };

export type ResponseItem =
	| { type: "message"; role: string; content: ResponseContentItem[]; end_turn?: boolean; phase?: AssistantPhase }
	| {
			type: "reasoning";
			summary: { type: "summary_text"; text: string }[];
			content?: { type: "reasoning_text" | "text"; text: string }[];
			encrypted_content: string | null;
	  }
	| { type: "function_call"; name: string; arguments: string; call_id: string }
	| { type: "function_call_output"; call_id: string; output: string | ToolResultOutputItem[] }
	| { type: "compaction"; encrypted_content: string }
	| { type: "compaction_summary"; encrypted_content: string }
	| { type: "compaction_trigger" }
	| { type: string; [key: string]: unknown };

export type ResponsesReasoningConfig = {
	readonly effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
	readonly summary?: "auto" | "concise" | "detailed" | null;
};

/** A tool declaration as the Responses API expects it. */
export type ResponsesTool = Record<string, unknown>;

const IMAGE_CONTENT_OMITTED_PLACEHOLDER = "image content omitted because you do not support image input";

/** Codex retains recent user turns verbatim next to the compaction item. */
const RETAINED_MESSAGE_TOKEN_BUDGET = 20_000;

/** Approximate characters per token, matching Codex's retained-message budget. */
const CHARACTERS_PER_TOKEN = 4;

/** Deep copy through JSON so a replayed item can never alias session state. */
export function cloneResponseItem(item: ResponseItem): ResponseItem {
	const copy: unknown = JSON.parse(JSON.stringify(item));
	return isResponseItem(copy) ? copy : { type: item.type };
}

/** Pi owns message serialization, including grammar tools, reasoning, IDs, and tool pairing. */
export function messagesToResponseItems(
	messages: readonly Message[],
	model: ResponsesModel,
	tools: readonly Tool[] = [],
): ResponseItem[] {
	const context = normalizeContext({ messages: [...messages] });
	const toolOptions = responseToolOptions(model);
	const items = convertResponsesMessages(model, context, new Set(["openai", "openai-codex", "opencode"]), {
		includeSystemPrompt: false,
		grammarToolInputProperties: createGrammarToolInputProperties(
			[...tools, ...getDeclaredTools(context.messages)],
			toolOptions.supportsOpenAIGrammarTools,
		),
		supportsMidConvoSystemMessages: model.compat?.supportsMidConvoSystemMessages ?? false,
		supportsAdditionalTools: model.compat?.supportsAdditionalTools ?? false,
		supportsToolSearch: model.compat?.supportsToolSearch ?? false,
		toolOptions,
	});
	// Easy-input user messages may omit `type`; stored-history readers use its explicit form.
	return items.map((item) => ({ ...item, type: item.type ?? "message" }));
}

/**
 * Make a stored item list replayable: drop snapshots the API rejects, give every
 * tool call an output, drop outputs whose call is gone, and remove image parts
 * from a model that cannot read them.
 */
export function normalizeResponseItemsForPrompt(
	items: readonly ResponseItem[],
	model: { readonly input?: readonly unknown[] },
): ResponseItem[] {
	const withoutGhostSnapshots = items.filter((item) => item.type !== "ghost_snapshot").map(cloneResponseItem);
	return stripImagesWhenUnsupported(removeOrphanOutputs(ensureCallOutputsPresent(withoutGhostSnapshots)), model);
}

/**
 * Build the history a later OpenAI turn replays after a remote compaction: the
 * retained user turns followed by the opaque compaction item.
 */
export function buildCompactedHistory(input: readonly ResponseItem[], compactionItem: ResponseItem): ResponseItem[] {
	if (compactionItem.type !== "compaction") {
		throw new Error("Remote compaction did not return a compaction item.");
	}
	const retainedUserMessages = input.filter(isRetainedUserMessage);
	return [
		...truncateRetainedMessages(retainedUserMessages, RETAINED_MESSAGE_TOKEN_BUDGET),
		cloneResponseItem(compactionItem),
	];
}

/** Declare the tools the session actually offers, as the Responses API expects them. */
export function buildToolsPayload(
	allTools: readonly Tool[],
	activeToolNames: readonly string[],
	model: ResponsesModel,
): ResponsesTool[] {
	const active = new Set(activeToolNames);
	return convertResponsesTools(
		allTools.filter((tool) => active.has(tool.name)),
		responseToolOptions(model),
	).map((tool) => ({ ...tool }));
}

function responseToolOptions(model: ResponsesModel) {
	return {
		strict: model.api === "openai-codex-responses" ? null : false,
		supportsStrictMode: model.compat?.supportsStrictMode ?? true,
		supportsOpenAIGrammarTools: model.compat?.supportsOpenAIGrammarTools ?? false,
	};
}

function responseItemCallId(item: ResponseItem): string | undefined {
	const callId = (item as Record<string, unknown>).call_id;
	return typeof callId === "string" && callId.length > 0 ? callId : undefined;
}

/** The output item type a call item expects, for the tool families the Responses API can return. */
function outputTypeForCallType(type: string): string | undefined {
	if (type === "function_call" || type === "local_shell_call") return "function_call_output";
	if (type === "tool_search_call") return "tool_search_output";
	if (type === "custom_tool_call") return "custom_tool_call_output";
	return undefined;
}

function syntheticOutputForCall(item: ResponseItem): ResponseItem | undefined {
	const callId = responseItemCallId(item);
	if (callId === undefined) return undefined;
	if (item.type === "function_call" || item.type === "local_shell_call") {
		return { type: "function_call_output", call_id: callId, output: "aborted" };
	}
	if (item.type === "tool_search_call") {
		return { type: "tool_search_output", call_id: callId, status: "completed", execution: "client", tools: [] };
	}
	if (item.type === "custom_tool_call") {
		return { type: "custom_tool_call_output", call_id: callId, output: "aborted" };
	}
	return undefined;
}

/** The API rejects a call without its output, so close every open call. */
function ensureCallOutputsPresent(items: readonly ResponseItem[]): ResponseItem[] {
	const normalized: ResponseItem[] = [];
	for (const item of items) {
		normalized.push(item);
		const outputType = outputTypeForCallType(item.type);
		const callId = responseItemCallId(item);
		if (outputType === undefined || callId === undefined) continue;
		const hasOutput = items.some(
			(candidate) => candidate.type === outputType && responseItemCallId(candidate) === callId,
		);
		if (hasOutput) continue;
		const synthetic = syntheticOutputForCall(item);
		if (synthetic !== undefined) normalized.push(synthetic);
	}
	return normalized;
}

/** The API rejects an output whose call is absent. */
function removeOrphanOutputs(items: readonly ResponseItem[]): ResponseItem[] {
	const callIdsFor = (types: readonly string[]): Set<string> => {
		const ids = new Set<string>();
		for (const item of items) {
			if (!types.includes(item.type)) continue;
			const callId = responseItemCallId(item);
			if (callId !== undefined) ids.add(callId);
		}
		return ids;
	};
	const functionCallIds = callIdsFor(["function_call", "local_shell_call"]);
	const toolSearchCallIds = callIdsFor(["tool_search_call"]);
	const customToolCallIds = callIdsFor(["custom_tool_call"]);

	return items.filter((item) => {
		const callId = responseItemCallId(item);
		if (item.type === "function_call_output") return callId !== undefined && functionCallIds.has(callId);
		if (item.type === "custom_tool_call_output") return callId !== undefined && customToolCallIds.has(callId);
		if (item.type === "tool_search_output") {
			if (item.execution === "server" || callId === undefined) return true;
			return toolSearchCallIds.has(callId);
		}
		return true;
	});
}

function stripImagesWhenUnsupported(
	items: readonly ResponseItem[],
	model: { readonly input?: readonly unknown[] },
): ResponseItem[] {
	if (model.input?.includes("image")) return [...items];

	return items.map((item) => {
		const next = cloneResponseItem(item);
		if (next.type === "message" && Array.isArray(next.content)) {
			next.content = next.content.map((part) =>
				part.type === "input_image" ? { type: "input_text", text: IMAGE_CONTENT_OMITTED_PLACEHOLDER } : part,
			);
			return next;
		}
		if ((next.type === "function_call_output" || next.type === "custom_tool_call_output") && "output" in next) {
			next.output = stripUnsupportedFunctionOutputImages(next.output);
			return next;
		}
		if (next.type === "image_generation_call" && typeof next.result === "string") {
			next.result = "";
		}
		return next;
	});
}

function stripUnsupportedFunctionOutputImages(output: unknown): unknown {
	if (Array.isArray(output)) {
		return output.map((item) =>
			Predicate.isObject(item) && item.type === "input_image"
				? { type: "input_text", text: IMAGE_CONTENT_OMITTED_PLACEHOLDER }
				: item,
		);
	}
	if (Predicate.isObject(output) && Array.isArray(output.content)) {
		return { ...output, content: stripUnsupportedFunctionOutputImages(output.content) };
	}
	return output;
}

/** Anything the API sent as a typed item, including kinds this extension does not interpret. */
export function isResponseItem(value: unknown): value is ResponseItem {
	return Predicate.isObject(value) && typeof value.type === "string";
}

function isRealUserMessage(item: ResponseItem): boolean {
	if (item.type !== "message" || item.role !== "user") return false;
	if (typeof item.content === "string") return item.content.trim().length > 0;
	return Array.isArray(item.content) && item.content.length > 0;
}

function isRetainedUserMessage(item: ResponseItem): boolean {
	return item.type === "message" && item.role === "user" && isRealUserMessage(item);
}

function responseMessageText(item: ResponseItem): string {
	if (item.type !== "message" || !Array.isArray(item.content)) return "";
	return item.content
		.filter((part) => part.type === "input_text" || part.type === "output_text")
		.map((part) => part.text)
		.join("");
}

function approximateMessageTokens(item: ResponseItem): number {
	return Math.max(1, Math.ceil(responseMessageText(item).length / CHARACTERS_PER_TOKEN));
}

function truncateMessageToTokenBudget(item: ResponseItem, maxTokens: number): ResponseItem | undefined {
	if (item.type !== "message" || !Array.isArray(item.content)) return cloneResponseItem(item);
	let remainingCharacters = Math.max(0, maxTokens * CHARACTERS_PER_TOKEN);
	const content = item.content.flatMap((part) => {
		if (part.type === "input_image") return [part];
		if (remainingCharacters === 0) return [];
		const text = part.text.slice(0, remainingCharacters);
		remainingCharacters -= text.length;
		return text ? [{ ...part, text }] : [];
	});
	return content.length > 0 ? { ...cloneResponseItem(item), content } : undefined;
}

/** Keep the newest user turns that fit the budget, trimming the one that straddles it. */
function truncateRetainedMessages(items: readonly ResponseItem[], maxTokens: number): ResponseItem[] {
	let remainingTokens = maxTokens;
	const retainedReversed: ResponseItem[] = [];
	for (const item of items.toReversed()) {
		if (remainingTokens === 0) break;
		const tokenCount = approximateMessageTokens(item);
		if (tokenCount <= remainingTokens) {
			retainedReversed.push(cloneResponseItem(item));
			remainingTokens -= tokenCount;
			continue;
		}
		const truncated = truncateMessageToTokenBudget(item, remainingTokens);
		if (truncated !== undefined) retainedReversed.push(truncated);
		remainingTokens = 0;
	}
	return retainedReversed.toReversed();
}
