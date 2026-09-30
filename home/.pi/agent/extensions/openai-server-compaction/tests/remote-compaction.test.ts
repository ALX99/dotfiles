import assert from "node:assert/strict";
import test from "node:test";

import type { Api, Model } from "@earendil-works/pi-ai";
import { Effect, Result } from "effect";

import { runPromise } from "../../_shared/effect-runtime.ts";
import type { ResponseItem } from "../response-items.ts";
import {
	buildRemoteCompactionHeaders,
	buildRemoteCompactionRequestBody,
	callRemoteCompaction,
	parseCompactionItem,
	parseSseData,
	parseSseUsage,
	remoteCompactionEndpointUrl,
	RemoteCompactionError,
	stringHeaders,
} from "../remote-compaction.ts";

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

/** A token whose payload carries the account claim the Codex endpoint requires. */
function codexToken(accountId: string): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
	).toString("base64url");
	return `header.${payload}.signature`;
}

const COMPACTION_ITEM: ResponseItem = { type: "compaction", encrypted_content: "opaque" };

function compactionStream(extra: string[] = []): string {
	return [
		`event: response.output_item.done`,
		`data: ${JSON.stringify({ type: "response.output_item.done", item: COMPACTION_ITEM })}`,
		"",
		...extra,
		`data: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 } } })}`,
		"",
		"data: [DONE]",
		"",
	].join("\n");
}

test("the compaction endpoint follows the model's own Responses URL", () => {
	assert.equal(remoteCompactionEndpointUrl(model({})), "https://api.openai.com/v1/responses");
	assert.equal(
		remoteCompactionEndpointUrl(model({ baseUrl: "https://api.openai.com/v1/responses" })),
		"https://api.openai.com/v1/responses",
	);
	assert.equal(remoteCompactionEndpointUrl(codexModel), "https://chatgpt.com/backend-api/codex/responses");
	assert.equal(
		remoteCompactionEndpointUrl(model({ ...codexModel, baseUrl: "https://chatgpt.com/backend-api/codex" })),
		"https://chatgpt.com/backend-api/codex/responses",
	);
	assert.throws(
		() => remoteCompactionEndpointUrl(model({ provider: "anthropic", api: "anthropic-messages" })),
		/not supported/,
	);
});

test("the request mirrors the surrounding turn and ends with the compaction trigger", () => {
	const body = buildRemoteCompactionRequestBody({
		model: model({}),
		protocol: "trigger",
		input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
		instructions: "system",
		tools: [{ type: "function", name: "read" }],
		reasoning: { effort: "high", summary: "auto" },
		sessionId: "session-1",
	});
	assert.equal(body.model, "gpt-6.1-sol");
	assert.equal(body.stream, true);
	assert.equal(body.instructions, "system");
	assert.deepEqual(body.tools, [{ type: "function", name: "read" }]);
	assert.equal(body.prompt_cache_key, "session-1");
	assert.deepEqual(body.reasoning, { effort: "high", summary: "auto" });
	assert.equal(body.store, false, "the endpoint rejects the request unless store is false");
	const input = body.input as ResponseItem[];
	assert.equal(input.length, 2);
	assert.deepEqual(input[1], { type: "compaction_trigger" });
});

test("request headers carry the beta flag, and the Codex endpoint also the account id", () => {
	const direct = buildRemoteCompactionHeaders({ model: model({}), apiKey: "sk-test", sessionId: "session-1" });
	assert.equal(direct.authorization, "Bearer sk-test");
	assert.equal(direct["x-codex-beta-features"], "remote_compaction_v2");
	assert.equal(direct["session-id"], "session-1");
	assert.equal(direct.accept, "text/event-stream");
	assert.equal(direct["chatgpt-account-id"], undefined);

	const codex = buildRemoteCompactionHeaders({ model: codexModel, apiKey: codexToken("acct_1") });
	assert.equal(codex["chatgpt-account-id"], "acct_1");
	assert.equal(codex.originator, "pi");
	assert.equal(codex["OpenAI-Beta"], "responses=experimental");
	assert.throws(() => buildRemoteCompactionHeaders({ model: codexModel, apiKey: "not-a-jwt" }), /not a JWT/);
	assert.throws(
		() => buildRemoteCompactionHeaders({ model: codexModel, apiKey: codexToken("") }),
		/chatgpt_account_id/,
	);
});

test("context management keeps the original instructions and input without permitting tools", () => {
	const input: ResponseItem[] = [
		{ type: "message", role: "user", content: [{ type: "input_text", text: "remember this" }] },
	];
	const body = buildRemoteCompactionRequestBody({
		model: model({}),
		protocol: "context-management",
		input,
		instructions: "original system prompt",
		tools: [{ type: "function", name: "read" }],
	});
	assert.deepEqual(body.input, input);
	assert.equal(body.instructions, "original system prompt");
	assert.deepEqual(body.context_management, [{ type: "compaction", compact_threshold: 1000 }]);
	assert.equal(body.tool_choice, "none");
	assert.equal(body.store, false);
	assert.equal(body.stream, true);
});

test("context management saves only a leading compaction, not output or later compactions", async () => {
	const originalFetch = globalThis.fetch;
	const stream = compactionStream([
		`data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "not part of the session" }] } })}\n\n`,
		`data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "compaction", encrypted_content: "post-generation" } })}\n\n`,
	]);
	globalThis.fetch = async () => new Response(stream);
	try {
		const result = await runPromise(
			callRemoteCompaction({
				model: model({}),
				protocol: "context-management",
				apiKey: "oauth-token",
				input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "old work" }] }],
				tools: [],
			}),
		);
		assert.deepEqual(result.output, [COMPACTION_ITEM]);
		assert.equal(result.usage?.totalTokens, 120);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("context management rejects absent, late, malformed and incomplete checkpoints", () => {
	const generated = {
		type: "response.output_item.done",
		item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] },
	};
	const compacted = { type: "response.output_item.done", item: COMPACTION_ITEM };
	const completed = { type: "response.completed" };
	for (const events of [
		[completed],
		[generated, completed],
		[generated, compacted, completed],
		[{ type: "response.output_item.done", item: { type: "compaction", encrypted_content: "" } }, completed],
		[{ type: "response.output_item.done", item: null }, compacted, completed],
	]) {
		assert.throws(() => parseCompactionItem(events, "context-management"), /no leading compaction item/);
	}
	assert.throws(() => parseCompactionItem([compacted], "context-management"), /ended before the response completed/);
	for (const failure of [
		{ type: "error", message: "refused" },
		{ type: "response.failed", response: { error: { message: "refused" } } },
	]) {
		assert.throws(() => parseCompactionItem([compacted, failure], "context-management"), /refused/);
	}
});

test("a header Pi resolved to null is dropped rather than sent", () => {
	assert.deepEqual(stringHeaders({ a: "1", b: null }), { a: "1" });
	assert.deepEqual(stringHeaders(undefined), {});
	const headers = buildRemoteCompactionHeaders({
		model: model({}),
		apiKey: "sk-test",
		headers: { "x-model-provider": null, "x-extra": "kept" },
	});
	assert.equal(headers["x-model-provider"], undefined);
	assert.equal(headers["x-extra"], "kept");
});

test("an event stream decodes to its JSON payloads", () => {
	assert.equal(parseSseData(compactionStream()).length, 2);
	assert.equal(parseSseData("data: not json\n\n").length, 0);
	assert.equal(parseSseData("data: [DONE]\n\n").length, 0);
	assert.equal(parseSseData("").length, 0);
});

test("a completed stream yields exactly one compaction item and its usage", () => {
	const events = parseSseData(compactionStream());
	assert.deepEqual(parseCompactionItem(events, "trigger"), COMPACTION_ITEM);
	assert.deepEqual(parseSseUsage(compactionStream()), { input_tokens: 100, output_tokens: 20, total_tokens: 120 });
});

test("a stream that failed, ended early, or returned two items is rejected", () => {
	assert.throws(
		() =>
			parseCompactionItem(parseSseData(`data: ${JSON.stringify({ type: "error", message: "nope" })}\n\n`), "trigger"),
		/nope/,
	);
	assert.throws(
		() =>
			parseCompactionItem(
				parseSseData(
					`data: ${JSON.stringify({ type: "response.failed", response: { error: { message: "bad" } } })}\n\n`,
				),
				"trigger",
			),
		/bad/,
	);
	assert.throws(() => parseCompactionItem([], "trigger"), /ended before the response completed/);
	const two = compactionStream([
		`data: ${JSON.stringify({ type: "response.output_item.done", item: COMPACTION_ITEM })}\n\n`,
	]);
	assert.throws(() => parseCompactionItem(parseSseData(two), "trigger"), /expected exactly one/);
});

test("a compaction call returns the history to replay and the usage it cost", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => new Response(compactionStream(), { status: 200 });

	try {
		const result = await runPromise(
			Effect.result(
				callRemoteCompaction({
					model: model({}),
					protocol: "trigger",
					apiKey: "sk-test",
					input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "keep this" }] }],
					tools: [],
				}),
			),
		);
		assert.ok(Result.isSuccess(result));
		assert.equal(result.success.output.length, 2);
		assert.deepEqual(result.success.output[0], {
			type: "message",
			role: "user",
			content: [{ type: "input_text", text: "keep this" }],
		});
		assert.deepEqual(result.success.output[1], COMPACTION_ITEM);
		assert.equal(result.success.usage?.totalTokens, 120);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("a refused or unreachable endpoint fails in this extension's error channel", async () => {
	const originalFetch = globalThis.fetch;
	try {
		globalThis.fetch = async () => new Response("subscription sharing is not supported", { status: 400 });
		const refused = await runPromise(
			Effect.result(
				callRemoteCompaction({ model: model({}), protocol: "trigger", apiKey: "token", input: [], tools: [] }),
			),
		);
		assert.ok(Result.isFailure(refused));
		assert.match(refused.failure.message, /400.*subscription sharing is not supported/s);
		assert.ok(refused.failure instanceof RemoteCompactionError);

		globalThis.fetch = async () => {
			throw new Error("connection reset");
		};
		const unreachable = await runPromise(
			Effect.result(
				callRemoteCompaction({ model: model({}), protocol: "trigger", apiKey: "token", input: [], tools: [] }),
			),
		);
		assert.ok(Result.isFailure(unreachable));
		assert.match(unreachable.failure.message, /connection reset/);
	} finally {
		globalThis.fetch = originalFetch;
	}
});
