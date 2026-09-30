import type { CompactionResult, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { compact } from "@earendil-works/pi-coding-agent";
import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import { calculateCost } from "@earendil-works/pi-ai";
import { Effect, Predicate, Schema } from "effect";
import { arch, platform, release } from "node:os";

import { toError } from "../_shared/errors.ts";
import { hostnameFromBaseUrl, isDirectOpenAIResponsesModel, isOpenAICodexResponsesModel } from "./models.ts";
import { buildCompactedHistory, type ResponseItem, type ResponsesReasoningConfig } from "./response-items.ts";

/**
 * OpenAI's own compaction, requested through the Responses API.
 *
 * Pi summarizes a long conversation into text when the context fills up. OpenAI does
 * something else: it answers a trigger or context-management request with an
 * encrypted item that replaces the history, so the conversation continues from the provider's own state
 * instead of a lossy summary of it. This module makes that call at Pi's compaction
 * boundary and hands the returned history back for the compaction entry to store.
 */

/** The Responses compaction call failed, so Pi's own summary is used instead. */
export class RemoteCompactionError extends Schema.TaggedError<RemoteCompactionError>()("RemoteCompactionError", {
	message: Schema.String,
}) {}

export interface RemoteCompactionResult {
	readonly output: ResponseItem[];
	readonly usage?: Usage;
}

/** Beta flag the endpoint expects for the current compaction protocol. */
const REMOTE_COMPACTION_FEATURE = "remote_compaction_v2";

/** Direct OAuth allows context management but rejects the explicit trigger protocol. */
type CompactionProtocol = "trigger" | "context-management";

const isCompactionItem = Schema.is(
	Schema.Struct({ type: Schema.Literal("compaction"), encrypted_content: Schema.NonEmptyString }),
);

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";

/** The Responses endpoint that serves a compaction request for this model. */
export function remoteCompactionEndpointUrl(model: Model<Api>): string {
	if (isDirectOpenAIResponsesModel(model)) {
		return responsesUrl(normalizeBaseUrl(model.baseUrl, DEFAULT_OPENAI_BASE_URL));
	}
	if (isOpenAICodexResponsesModel(model)) {
		const baseUrl = normalizeBaseUrl(model.baseUrl, DEFAULT_CODEX_BASE_URL);
		if (baseUrl.endsWith("/codex/responses")) return baseUrl;
		return baseUrl.endsWith("/codex") ? `${baseUrl}/responses` : `${baseUrl}/codex/responses`;
	}
	throw new Error(`Remote compaction is not supported for ${model.provider}/${model.id}.`);
}

/** The compaction request mirrors the shape of the surrounding turns, not the endpoint defaults. */
export function buildRemoteCompactionRequestBody(params: {
	readonly model: Model<Api>;
	readonly protocol: CompactionProtocol;
	readonly input: readonly ResponseItem[];
	readonly instructions?: string;
	readonly tools: readonly Record<string, unknown>[];
	readonly reasoning?: ResponsesReasoningConfig;
	readonly sessionId?: string;
}): Record<string, unknown> {
	return {
		model: params.model.id,
		input: params.protocol === "trigger" ? [...params.input, { type: "compaction_trigger" }] : [...params.input],
		...(params.protocol === "context-management"
			? {
					context_management: [{ type: "compaction", compact_threshold: 1000 }],
					tool_choice: "none",
				}
			: {}),
		instructions: params.instructions,
		tools: params.tools,
		stream: true,
		// This endpoint keeps no response state for the credentials this extension runs
		// on, and rejects the request when `store` is absent or true.
		store: false,
		include: ["reasoning.encrypted_content"],
		...(params.sessionId === undefined ? {} : { prompt_cache_key: params.sessionId }),
		...(params.reasoning === undefined ? {} : { reasoning: params.reasoning }),
	};
}

/** Who the compaction request is sent as, which is all the headers depend on. */
export interface RemoteCompactionTarget {
	readonly model: Model<Api>;
	readonly apiKey: string;
	/** Provider headers Pi resolved for this model; a null value removes a header. */
	readonly headers?: Record<string, string | null>;
	readonly sessionId?: string;
}

export interface RemoteCompactionRequest extends RemoteCompactionTarget {
	readonly protocol: CompactionProtocol;
	readonly input: readonly ResponseItem[];
	readonly instructions?: string;
	readonly tools: readonly Record<string, unknown>[];
	readonly reasoning?: ResponsesReasoningConfig;
	readonly signal?: AbortSignal;
}

/**
 * Return the replacement history, excluding any generation after context compaction.
 * The trigger protocol retains user turns beside its compaction item; context
 * management's leading item already represents the entire input.
 */
export const callRemoteCompaction = Effect.fnUntraced(function* (
	request: RemoteCompactionRequest,
): Effect.fn.Return<RemoteCompactionResult, RemoteCompactionError> {
	return yield* Effect.tryPromise({
		try: async () => {
			const response = await fetch(remoteCompactionEndpointUrl(request.model), {
				method: "POST",
				headers: buildRemoteCompactionHeaders(request),
				body: JSON.stringify(buildRemoteCompactionRequestBody(request)),
				...(request.signal === undefined ? {} : { signal: request.signal }),
			});
			if (!response.ok) {
				const detail = await response.text().catch(() => "");
				throw new RemoteCompactionError({
					message: `Remote compaction failed (${response.status}): ${detail || response.statusText}`,
				});
			}

			const stream = await response.text();
			const compactionItem = parseCompactionItem(parseSseData(stream), request.protocol);
			const usage = extractRemoteCompactionUsage(request.model, parseSseUsage(stream));
			return {
				output:
					request.protocol === "trigger" ? buildCompactedHistory(request.input, compactionItem) : [compactionItem],
				...(usage === undefined ? {} : { usage }),
			};
		},
		catch: remoteCompactionError,
	});
});

/**
 * Identity headers the endpoint expects. The Codex account id comes from the
 * subscription token, the same way Pi's own Codex transport derives it.
 */
export function buildRemoteCompactionHeaders(request: RemoteCompactionTarget): Record<string, string> {
	const headers: Record<string, string> = {
		authorization: `Bearer ${request.apiKey}`,
		accept: "text/event-stream",
		"content-type": "application/json",
		"user-agent": piUserAgent(),
		"x-codex-beta-features": REMOTE_COMPACTION_FEATURE,
		...stringHeaders(request.headers),
		...(request.sessionId === undefined
			? {}
			: { "session-id": request.sessionId, "x-client-request-id": request.sessionId }),
	};
	if (!isOpenAICodexResponsesModel(request.model)) return headers;
	return {
		...headers,
		"chatgpt-account-id": codexAccountId(request.apiKey),
		originator: "pi",
		"OpenAI-Beta": "responses=experimental",
	};
}

/** The user agent Pi sends on its own Responses requests, so the endpoint sees one client. */
function piUserAgent(): string {
	return "pi (" + platform() + " " + release() + "; " + arch() + ")";
}

/** Provider headers with their removable entries dropped, ready to send. */
export function stringHeaders(headers: Record<string, string | null> | undefined): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers ?? {})) {
		if (value !== null) result[name] = value;
	}
	return result;
}

function normalizeBaseUrl(baseUrl: string | undefined, fallback: string): string {
	const trimmed = baseUrl?.trim();
	return trimmed ? trimmed.replace(/\/+$/, "") : fallback;
}

function responsesUrl(baseUrl: string): string {
	if (baseUrl.endsWith("/responses")) return baseUrl;
	return baseUrl.endsWith("/v1") ? `${baseUrl}/responses` : `${baseUrl}/v1/responses`;
}

/** The subscription account a Codex token belongs to. */
function codexAccountId(token: string): string {
	const parts = token.split(".");
	if (parts.length !== 3) throw new Error("Codex token is not a JWT.");
	const claims = safeParse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8"));
	const auth =
		Predicate.isObject(claims) && Predicate.isObject(claims["https://api.openai.com/auth"])
			? claims["https://api.openai.com/auth"]
			: undefined;
	const accountId = auth?.chatgpt_account_id;
	if (typeof accountId !== "string" || accountId.length === 0) {
		throw new Error("Codex token does not carry a chatgpt_account_id claim.");
	}
	return accountId;
}

/** Decode a `text/event-stream` body into its JSON payloads. */
export function parseSseData(text: string): unknown[] {
	return text
		.replace(/\r\n/g, "\n")
		.split("\n\n")
		.flatMap((block) => {
			const data = block
				.split("\n")
				.filter((line) => line.startsWith("data:"))
				.map((line) => line.slice(5).trimStart())
				.join("\n")
				.trim();
			if (!data || data === "[DONE]") return [];
			try {
				return [JSON.parse(data) as unknown];
			} catch {
				return [];
			}
		});
}

/**
 * A context-management checkpoint must precede all generated output. A later
 * compaction can contain that generation and would advance the saved conversation.
 */
export function parseCompactionItem(events: readonly unknown[], protocol: CompactionProtocol): ResponseItem {
	let completed = false;
	const compactionItems: ResponseItem[] = [];
	const output: unknown[] = [];

	for (const event of events) {
		if (!Predicate.isObject(event)) continue;
		if (event.type === "error") {
			throw new Error(`Remote compaction failed: ${errorMessage(event, "unknown Responses API error")}`);
		}
		if (event.type === "response.failed") {
			throw new Error(`Remote compaction failed: ${responseFailureMessage(event)}`);
		}
		if (event.type === "response.output_item.done") {
			output.push(event.item);
			if (isCompactionItem(event.item)) compactionItems.push(event.item);
			continue;
		}
		if (event.type === "response.completed") completed = true;
	}

	if (!completed) throw new Error("Remote compaction stream ended before the response completed.");
	if (protocol === "context-management") {
		const first = output[0];
		if (!isCompactionItem(first)) {
			throw new Error("Remote context management returned no leading compaction item.");
		}
		return first;
	}
	if (compactionItems.length !== 1) {
		throw new Error(`Remote compaction returned ${compactionItems.length} compaction items, expected exactly one.`);
	}
	const item = compactionItems[0];
	if (item === undefined) throw new Error("Remote compaction returned no compaction item.");
	return item;
}

/** The usage a completed compaction stream reported, if any. */
export function parseSseUsage(text: string): unknown {
	for (const event of parseSseData(text)) {
		if (!Predicate.isObject(event) || event.type !== "response.completed") continue;
		return Predicate.isObject(event.response) ? event.response.usage : undefined;
	}
	return undefined;
}

function errorMessage(event: Record<string, unknown>, fallback: string): string {
	return typeof event.message === "string" ? event.message : fallback;
}

function responseFailureMessage(event: Record<string, unknown>): string {
	const response = Predicate.isObject(event.response) ? event.response : undefined;
	const error = response !== undefined && Predicate.isObject(response.error) ? response.error : undefined;
	return error !== undefined && typeof error.message === "string" ? error.message : "the response failed";
}

function extractRemoteCompactionUsage(model: Model<Api>, value: unknown): Usage | undefined {
	if (!Predicate.isObject(value)) return undefined;
	const inputTokens = count(value.input_tokens);
	const outputTokens = count(value.output_tokens);
	const totalTokens = count(value.total_tokens) || inputTokens + outputTokens;
	const details = Predicate.isObject(value.input_tokens_details) ? value.input_tokens_details : undefined;
	const cacheRead = count(details?.cached_tokens);
	const cacheWrite = count(details?.cache_creation_tokens) || count(details?.cache_write_tokens);

	const usage: Usage = {
		input: Math.max(0, inputTokens - cacheRead - cacheWrite),
		output: outputTokens,
		cacheRead,
		cacheWrite,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	calculateCost(model, usage);
	return usage;
}

function count(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function safeParse(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		return undefined;
	}
}

/** The text Pi keeps when the model produced no usable summary of its own. */
export function buildCompactionSummaryText(model: Model<Api>): string {
	const host = hostnameFromBaseUrl(model.baseUrl) ?? "api.openai.com";
	return `OpenAI remote compaction applied for ${model.provider}/${model.id} via ${host}. Pi keeps this textual summary for portability, while OpenAI turns replay the provider-native replacement history stored in the compaction entry.`;
}

export interface PortableSummaryRequest {
	readonly modelRegistry: ModelRegistry;
	readonly preparation: Parameters<typeof compact>[0];
	readonly model: Model<Api>;
	readonly apiKey: string | undefined;
	readonly headers?: Record<string, string>;
	readonly customInstructions?: string;
	/** Pi's own thinking level, including the `off` level its agent type allows. */
	readonly thinkingLevel?: Parameters<typeof compact>[6];
	readonly signal?: AbortSignal;
}

/**
 * Pi owns the portable summary, including iterative updates, split turns, file
 * tracking and usage. The registry routes its standalone request through the
 * configured provider without replaying the session's remote replacement history.
 */
export const generatePortableSummary = Effect.fnUntraced(function* (
	request: PortableSummaryRequest,
): Effect.fn.Return<CompactionResult, Error> {
	return yield* Effect.tryPromise({
		try: () =>
			compact(
				request.preparation,
				request.model,
				request.apiKey,
				request.headers,
				request.customInstructions,
				request.signal,
				request.thinkingLevel,
				(model, context, options) => request.modelRegistry.streamSimple(model, context, options),
			),
		catch: (cause) => toError(cause),
	});
});

function remoteCompactionError(cause: unknown): RemoteCompactionError {
	if (cause instanceof RemoteCompactionError) return cause;
	return new RemoteCompactionError({ message: toError(cause).message });
}
