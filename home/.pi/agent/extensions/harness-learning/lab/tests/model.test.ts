import assert from "node:assert/strict";
import { test } from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { ModelRuntime, type CreateModelRuntimeOptions } from "@earendil-works/pi-coding-agent";
import { Effect, Fiber, Result } from "effect";
import { TestClock } from "effect/testing";
import { runPromise } from "../../../_shared/effect-runtime.ts";
import { createLabModels, MAX_MODEL_RESPONSE_BYTES, requestLabModel } from "../model.ts";
import { labBudget } from "../state.ts";
import { loadLabStore } from "../store.ts";
import { config, seededDocument, startedDocument } from "./fixtures.ts";
import { context, fakeModels, response, runtimeStore } from "./runtime-fixtures.ts";

test("headless initialization disables catalog networking and refresh without loading sessions or extensions", async (t) => {
	const fake = fakeModels();
	let options: CreateModelRuntimeOptions | undefined;
	t.mock.method(ModelRuntime, "create", async (input: CreateModelRuntimeOptions) => {
		options = input;
		return fake.client as ModelRuntime;
	});
	assert.equal(await runPromise(createLabModels()), fake.client);
	assert.equal(options?.allowModelNetwork, false);
	assert.equal(options?.refreshOnCreate, false);
	assert.ok(options?.signal instanceof AbortSignal);
	assert.equal(fake.calls.length, 0);
});

test("provider calls have persisted reservations, fixed model identity, bounded options, and exact reported usage", async (t) => {
	const store = await runtimeStore(t);
	const models = fakeModels();
	const reserved: string[] = [];
	const result = await runPromise(
		requestLabModel(store, models.client, "executor", context(), (id) => reserved.push(id)),
	);
	assert.deepEqual(reserved, [result.requestId]);
	assert.equal(models.calls.length, 1);
	const options = models.calls[0]![2]!;
	assert.equal(options.maxTokens, 256);
	assert.equal(options.maxRetries, 0);
	assert.equal(options.maxRetryDelayMs, 1);
	assert.equal(options.cacheRetention, "none");
	assert.ok(options.timeoutMs! <= 1000);
	const { state } = await runPromise(loadLabStore(store));
	assert.equal(state.requestStarts[0]!.id, result.requestId);
	assert.ok(state.requestStarts[0]!.reservedTokens > 256 + Buffer.byteLength(JSON.stringify(context())));
	assert.deepEqual(state.requestEnds[0]!.usage, { tokens: 20, costUsd: 0.002 });
	assert.equal(state.requestEnds[0]!.status, "completed");
	assert.deepEqual(labBudget(state).pending, []);
});

test("unavailable models, oversize context, and insufficient reservations refuse before calling a provider", async (t) => {
	for (const failure of ["missing", "context", "tokens"] as const) {
		const settings = config();
		if (failure === "missing") settings.targetModel = "missing/model";
		if (failure === "tokens") settings.limits.maxTotalTokens = 1300;
		const store = await runtimeStore(t, startedDocument(settings));
		const models = fakeModels();
		const input = context();
		if (failure === "context") input.systemPrompt = "a".repeat(256 * 1024 + 1);
		await assert.rejects(
			runPromise(requestLabModel(store, models.client, "executor", input)),
			/Physical model|bounded allowance|remaining budget/,
		);
		assert.equal(models.calls.length, 0);
		assert.equal((await runPromise(loadLabStore(store))).state.requestStarts.length, 0);
	}
});

test("reported cost and request-count limits stop before another call; overshoot remains recorded", async (t) => {
	for (const limit of ["cost", "requests", "tokens"] as const) {
		const settings = config();
		if (limit === "cost") settings.limits.maxReportedCostUsd = 0.001;
		if (limit === "requests") settings.limits.maxRequests = 1;
		const store = await runtimeStore(t, startedDocument(settings));
		const models = fakeModels(() => {
			const message = response();
			if (limit === "tokens") message.usage.totalTokens = settings.limits.maxTotalTokens + 1;
			return message;
		});
		await runPromise(requestLabModel(store, models.client, "executor", context()));
		await assert.rejects(
			runPromise(requestLabModel(store, models.client, "executor", context())),
			/cost|request budget|Observed token/,
		);
		assert.equal(models.calls.length, 1);
		const { state } = await runPromise(loadLabStore(store));
		assert.equal(state.requestEnds[0]!.usage!.tokens, limit === "tokens" ? 100_001 : 20);
		assert.equal(state.requestEnds[0]!.usage!.costUsd, 0.002);
	}
});

test("a stalled call excludes concurrent requests, and cancellation durably closes the reservation", async (t) => {
	const store = await runtimeStore(t);
	const models = fakeModels();
	const controller = new AbortController();
	const called = Promise.withResolvers<void>();
	let aborted = false;
	models.setStream(([, , options]) => {
		const stream = createAssistantMessageEventStream();
		options!.signal!.addEventListener(
			"abort",
			() => {
				aborted = true;
				stream.end(response());
			},
			{ once: true },
		);
		called.resolve();
		return stream;
	});
	const pending = runPromise(requestLabModel(store, models.client, "executor", context()), {
		signal: controller.signal,
	});
	// Observe rejection immediately so cancellation cannot create an unhandled promise.
	const rejected = assert.rejects(pending);
	await called.promise;
	assert.equal(labBudget((await runPromise(loadLabStore(store))).state).pending.length, 1);
	await assert.rejects(runPromise(requestLabModel(store, models.client, "executor", context())), /outstanding/);
	controller.abort();
	await rejected;
	assert.equal(aborted, true);
	const { state } = await runPromise(loadLabStore(store));
	assert.equal(state.requestEnds[0]!.status, "cancelled");
	assert.deepEqual(labBudget(state).pending, []);
	await assert.rejects(
		runPromise(requestLabModel(store, models.client, "executor", context())),
		/interrupted|unreported/,
	);
	assert.equal(models.calls.length, 1);
});

test("different models, abnormal completions, oversized snapshots, and malformed usage cannot become successful requests", async (t) => {
	for (const failure of ["model", "stop", "output", "usage"] as const) {
		const store = await runtimeStore(t);
		const models = fakeModels(() => {
			const message = response(failure === "output" ? "x".repeat(MAX_MODEL_RESPONSE_BYTES) : "done");
			if (failure === "model") message.model = "routed-model";
			if (failure === "stop") message.stopReason = "length";
			if (failure === "usage") message.usage.totalTokens = Number.NaN;
			return message;
		});
		await assert.rejects(
			runPromise(requestLabModel(store, models.client, "executor", context())),
			/different|normally|output limit|usage/,
		);
		const { state } = await runPromise(loadLabStore(store));
		assert.equal(state.requestEnds[0]!.status, "failed");
		assert.deepEqual(state.requestEnds[0]!.usage, failure === "usage" ? null : { tokens: 20, costUsd: 0.002 });
		await assert.rejects(runPromise(requestLabModel(store, models.client, "executor", context())), /failed|unreported/);
		assert.equal(models.calls.length, 1);
	}
});

test("streamed output is counted before completion and oversized partial streams retain unknown usage", async (t) => {
	const store = await runtimeStore(t);
	const models = fakeModels();
	let aborted = false;
	models.setStream(([, , options]) => {
		const stream = createAssistantMessageEventStream();
		options!.signal!.addEventListener("abort", () => {
			aborted = true;
			stream.end(response());
		});
		stream.push({
			type: "thinking_delta",
			contentIndex: 0,
			delta: "x".repeat(MAX_MODEL_RESPONSE_BYTES + 1),
			partial: response(),
		});
		return stream;
	});
	await assert.rejects(runPromise(requestLabModel(store, models.client, "executor", context())), /streamed output/);
	assert.equal(aborted, true);
	const { state } = await runPromise(loadLabStore(store));
	assert.equal(state.requestEnds[0]!.status, "failed");
	assert.equal(state.requestEnds[0]!.usage, null);
});

test("researcher requests are tool-free and cannot accept tool calls", async (t) => {
	const store = await runtimeStore(t, seededDocument());
	const models = fakeModels(() => {
		const message = response("proposal", "researcher");
		message.content = [{ type: "toolCall", id: "call", name: "exec", arguments: { argv: ["node", "--version"] } }];
		return message;
	});
	const input = context();
	input.tools = [{ name: "unsafe", description: "Forbidden", parameters: { type: "object" } }];
	await assert.rejects(runPromise(requestLabModel(store, models.client, "researcher", input)), /cannot declare tools/);
	assert.equal(models.calls.length, 0);
	await assert.rejects(runPromise(requestLabModel(store, models.client, "researcher", context())), /attempted a tool/);
	assert.equal(models.calls[0]![0].id, "researcher");
	assert.equal((await runPromise(loadLabStore(store))).state.requestEnds.at(-1)!.status, "failed");
});

test("the absolute run deadline can expire earlier than the request deadline", async (t) => {
	const store = await runtimeStore(t);
	const { state } = await runPromise(loadLabStore(store));
	const models = fakeModels();
	const called = Promise.withResolvers<void>();
	let aborted = false;
	models.setStream(([, , options]) => {
		const stream = createAssistantMessageEventStream();
		options!.signal!.addEventListener("abort", () => {
			aborted = true;
			stream.end(response());
		});
		called.resolve();
		return stream;
	});
	await runPromise(
		Effect.gen(function* () {
			yield* TestClock.setTime(state.started.at + state.started.config.limits.maxWallTimeMs - 100);
			const fiber = yield* requestLabModel(store, models.client, "executor", context()).pipe(
				Effect.result,
				Effect.forkChild,
			);
			yield* Effect.tryPromise(() => called.promise);
			yield* TestClock.adjust(101);
			const result = yield* Fiber.join(fiber);
			assert.ok(Result.isFailure(result));
			assert.match(result.failure.message, /timed out/);
		}).pipe(Effect.provide(TestClock.layer())),
	);
	assert.equal(aborted, true);
	assert.equal(models.calls[0]![2]!.timeoutMs, 100);
	assert.equal((await runPromise(loadLabStore(store))).state.requestEnds[0]!.status, "failed");
});
