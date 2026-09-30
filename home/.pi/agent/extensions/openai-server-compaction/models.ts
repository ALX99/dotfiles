import type { Api, Model } from "@earendil-works/pi-ai";
import { Predicate } from "effect";

import type { ResponseItem, ResponsesReasoningConfig } from "./response-items.ts";

/**
 * Which OpenAI endpoints this extension may use, and what it changes about a request to
 * one of them. Pi owns the transport for every endpoint, so these functions only decide
 * whether a payload may be patched and how.
 */

export type ResponsesPayload = Record<string, unknown>;

export function hostnameFromBaseUrl(baseUrl: unknown): string | undefined {
	if (typeof baseUrl !== "string" || !baseUrl.trim()) return undefined;
	try {
		return new URL(baseUrl).hostname.toLowerCase();
	} catch {
		return undefined;
	}
}

/** Identity of a model for the session, so stored state is only used by the model that produced it. */
export function modelKey(model: Model<Api>): string {
	return `${model.provider}:${model.api}:${model.id}`;
}

/** OpenAI's own Responses endpoint, authenticated with an API key or direct OAuth. */
export function isDirectOpenAIResponsesModel(model: Model<Api>): boolean {
	if (model.api !== "openai-responses" || model.provider !== "openai") return false;
	const host = hostnameFromBaseUrl(model.baseUrl);
	return host === undefined || host === "api.openai.com";
}

/** The ChatGPT-backed Codex endpoint, whose WebSocket transport Pi already streams. */
export function isOpenAICodexResponsesModel(model: Model<Api>): boolean {
	if (model.api !== "openai-codex-responses") return false;
	if (model.provider === "openai-codex") return true;
	return hostnameFromBaseUrl(model.baseUrl) === "chatgpt.com";
}

/** The two OpenAI endpoints whose encrypted compaction history this extension replays. */
export function supportsServerCompaction(model: Model<Api>): boolean {
	return isOpenAICodexResponsesModel(model) || isDirectOpenAIResponsesModel(model);
}

/**
 * A Responses request, as opposed to the chat, image, or classifier calls the same model
 * also makes. Pi sends `input` for the first and `messages` for the rest, so only a
 * payload with `input` and no `messages` may be patched.
 */
export function isResponsesRequest(payload: unknown): payload is ResponsesPayload {
	return Predicate.isObject(payload) && "input" in payload && !("messages" in payload);
}

/**
 * Replay the history OpenAI returned from its own compaction. That history is the whole
 * input, so the request cannot also continue from a live response, and any id Pi put
 * there for its own continuity would contradict it.
 */
export function withReplayedHistory(payload: ResponsesPayload, history: readonly ResponseItem[]): ResponsesPayload {
	const nextPayload: ResponsesPayload = { ...payload, input: [...history] };
	delete nextPayload.previous_response_id;
	return nextPayload;
}

/** The reasoning configuration Pi would send for the session's thinking level. */
export function thinkingLevelToResponsesReasoning(thinkingLevel: unknown): ResponsesReasoningConfig | undefined {
	if (
		thinkingLevel === "minimal" ||
		thinkingLevel === "low" ||
		thinkingLevel === "medium" ||
		thinkingLevel === "high" ||
		thinkingLevel === "xhigh"
	) {
		return { effort: thinkingLevel, summary: "auto" };
	}
	return undefined;
}
