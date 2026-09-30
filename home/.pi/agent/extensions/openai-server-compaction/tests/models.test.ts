import assert from "node:assert/strict";
import test from "node:test";

import type { Api, Model } from "@earendil-works/pi-ai";

import {
	hostnameFromBaseUrl,
	isDirectOpenAIResponsesModel,
	isOpenAICodexResponsesModel,
	isResponsesRequest,
	modelKey,
	supportsServerCompaction,
	thinkingLevelToResponsesReasoning,
	withReplayedHistory,
} from "../models.ts";

function model(overrides: Partial<Model<Api>>): Model<Api> {
	return {
		id: "gpt-6.1-sol",
		name: "GPT-6.1 Sol",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		contextWindow: 400_000,
		maxTokens: 128_000,
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		...overrides,
	} as Model<Api>;
}

const codexModel = model({
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
});

/** A model defined without a base URL, which Pi allows. */
function withoutBaseUrl(overrides: Partial<Model<Api>> = {}): Model<Api> {
	const next: Partial<Model<Api>> = { ...model(overrides) };
	delete next.baseUrl;
	return next as Model<Api>;
}

test("only OpenAI's own Responses endpoint counts as direct", () => {
	assert.equal(isDirectOpenAIResponsesModel(model({})), true);
	assert.equal(isDirectOpenAIResponsesModel(withoutBaseUrl()), true);
	assert.equal(isDirectOpenAIResponsesModel(codexModel), false);
	assert.equal(
		isDirectOpenAIResponsesModel(model({ baseUrl: "https://proxy.internal/v1" })),
		false,
		"a custom base URL is not OpenAI's endpoint",
	);
});

test("the ChatGPT-backed Codex endpoint is recognized separately", () => {
	assert.equal(isOpenAICodexResponsesModel(codexModel), true);
	assert.equal(isOpenAICodexResponsesModel(withoutBaseUrl({ api: "openai-codex-responses" })), false);
	assert.equal(isOpenAICodexResponsesModel(model({})), false);
});

test("both OpenAI endpoints are eligible independently of the credential", () => {
	assert.equal(supportsServerCompaction(model({})), true);
	assert.equal(supportsServerCompaction(codexModel), true);
	assert.equal(supportsServerCompaction(model({ baseUrl: "https://proxy.internal/v1" })), false);
	assert.equal(supportsServerCompaction(model({ api: "anthropic-messages", provider: "anthropic" })), false);
});

test("only a Responses request may be patched", () => {
	assert.equal(isResponsesRequest({ model: "gpt-6.1-sol", input: [] }), true);
	assert.equal(
		isResponsesRequest({ model: "gpt-6.1-sol", messages: [] }),
		false,
		"the same model also makes chat and classifier calls",
	);
	assert.equal(isResponsesRequest({ prompt: "x" }), false);
	assert.equal(isResponsesRequest("input"), false);
});

test("replaying stored history owns the whole input and drops a continuation id", () => {
	const payload = withReplayedHistory(
		{ model: "gpt-6.1-sol", input: [{ type: "message" }], previous_response_id: "resp_1", store: false },
		[{ type: "compaction", encrypted_content: "opaque" }],
	);
	assert.deepEqual(payload.input, [{ type: "compaction", encrypted_content: "opaque" }]);
	assert.equal(payload.previous_response_id, undefined);
	assert.equal(payload.store, false, "the rest of Pi's request is left alone");
});

test("the model key identifies provider, api, and model", () => {
	assert.equal(modelKey(model({})), "openai:openai-responses:gpt-6.1-sol");
});

test("a host is read from a base URL, or unknown when there is none", () => {
	assert.equal(hostnameFromBaseUrl("https://API.OpenAI.com/v1"), "api.openai.com");
	assert.equal(hostnameFromBaseUrl("not a url"), undefined);
	assert.equal(hostnameFromBaseUrl(undefined), undefined);
});

test("a thinking level maps to the reasoning configuration Pi sends", () => {
	assert.deepEqual(thinkingLevelToResponsesReasoning("xhigh"), { effort: "xhigh", summary: "auto" });
	assert.equal(thinkingLevelToResponsesReasoning("off"), undefined);
	assert.equal(thinkingLevelToResponsesReasoning(undefined), undefined);
});
