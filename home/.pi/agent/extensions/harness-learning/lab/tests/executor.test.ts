import assert from "node:assert/strict";
import { test } from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { runPromise } from "../../../_shared/effect-runtime.ts";
import type { LabSandbox } from "../docker.ts";
import { executeLabTask, type LabTrial } from "../executor.ts";
import { LabError } from "../schema.ts";
import { loadLabStore } from "../store.ts";
import { candidateDocument, config, startedDocument } from "./fixtures.ts";
import { fakeModels, response, runtimeStore } from "./runtime-fixtures.ts";

const SEED: LabTrial = { phase: "seed", candidateId: null, taskId: "target-0", repeat: 0, arm: "baseline" };
function fakeSandbox() {
	const lifecycle: string[] = [];
	let verifyExit = 0;
	let failure: Effect.Effect<never, LabError> | undefined;
	const sandbox: LabSandbox = {
		withWorkspace: (files, use) => {
			const artifacts = new Map(files.map((file) => [file.path, file.content]));
			return Effect.gen(function* () {
				lifecycle.push("workspace");
				return yield* use({
					call: (tool) =>
						Effect.sync(() => {
							assert.equal(tool.name, "write");
							assert.ok(typeof tool.arguments.path === "string");
							assert.ok(typeof tool.arguments.content === "string");
							artifacts.set(tool.arguments.path, tool.arguments.content);
							return { text: "ok", isError: false };
						}),
					export: (paths) =>
						Effect.sync(() =>
							paths.filter((path) => artifacts.has(path)).map((path) => ({ path, content: artifacts.get(path)! })),
						),
				});
			}).pipe(Effect.ensuring(Effect.sync(() => lifecycle.push("removed"))));
		},
		verify: (_task, artifacts) =>
			Effect.gen(function* () {
				lifecycle.push("verify");
				assert.equal(lifecycle.at(-2), "removed");
				assert.deepEqual(
					artifacts.map((file) => file.path),
					["src/input.mjs"],
				);
				if (failure !== undefined) return yield* failure;
				return { verificationExitCode: verifyExit, verificationOutput: verifyExit === 0 ? "ok" : "assertion failed" };
			}),
	};
	return {
		sandbox,
		lifecycle,
		setExit: (code: number) => {
			verifyExit = code;
		},
		setFailure: (next: typeof failure) => {
			failure = next;
		},
	};
}

test("coding tasks execute bounded tools, then export and independently verify before recording success", async (t) => {
	const store = await runtimeStore(t);
	let turn = 0;
	const models = fakeModels(() => {
		const message = response();
		if (turn++ === 0) {
			message.stopReason = "toolUse";
			message.content = [
				{
					type: "toolCall",
					id: "write1",
					name: "write",
					arguments: { path: "src/input.mjs", content: "export const value = 2;" },
				},
			];
		}
		return message;
	});
	const fake = fakeSandbox();
	const event = await runPromise(executeLabTask(store, models.client, fake.sandbox, SEED));
	assert.equal(event.outcome.status, "completed");
	assert.equal(event.requestIds.length, 2);
	assert.ok(event.trace.includes("write"));
	assert.deepEqual(fake.lifecycle, ["workspace", "removed", "verify"]);
	const { state } = await runPromise(loadLabStore(store));
	assert.deepEqual(state.tasks, [event]);
	assert.equal(state.requestEnds.length, 2);
	assert.deepEqual(state.head.procedureIds, []);
	for (const call of models.calls) {
		const input = JSON.stringify(call[1]);
		assert.equal(input.includes("assert.ok(true)"), false);
		assert.equal(input.includes("/verify/"), false);
		assert.equal(input.includes("Synthetic holdout"), false);
		assert.deepEqual(
			call[1].tools!.map((tool) => tool.name),
			["read", "write", "exec"],
		);
	}
	assert.equal(event.outcome.status === "completed" && event.outcome.artifacts[0]!.content, "export const value = 2;");
});

test("repeat/arm/phase duplicates are refused before allocating a sandbox or paying for a request", async (t) => {
	const store = await runtimeStore(t);
	const models = fakeModels();
	const fake = fakeSandbox();
	await runPromise(executeLabTask(store, models.client, fake.sandbox, SEED));
	const calls = models.calls.length;
	const lifecycle = fake.lifecycle.length;
	for (const trial of [
		SEED,
		{ ...SEED, repeat: 3 },
		{ ...SEED, arm: "candidate" as const },
		{ ...SEED, taskId: "holdout-4" },
	])
		await assert.rejects(
			runPromise(executeLabTask(store, models.client, fake.sandbox, trial)),
			/only once|matrix|evaluation plan/,
		);
	assert.equal(models.calls.length, calls);
	assert.equal(fake.lifecycle.length, lifecycle);
});

test("development candidate and baseline requests use their respective frozen guidance", async (t) => {
	const store = await runtimeStore(t, candidateDocument());
	const models = fakeModels();
	const fake = fakeSandbox();
	for (const arm of ["baseline", "candidate"] as const)
		await runPromise(
			executeLabTask(store, models.client, fake.sandbox, {
				...SEED,
				phase: "development",
				candidateId: "candidate1",
				arm,
			}),
		);
	assert.equal(models.calls[0]![1].systemPrompt!.includes("Edit generator inputs"), false);
	assert.equal(models.calls[1]![1].systemPrompt!.includes("Edit generator inputs"), true);
});

test("assertion failure is a completed measured outcome, not a model-supplied success claim", async (t) => {
	const store = await runtimeStore(t);
	const models = fakeModels(() => response("Everything passed perfectly."));
	const fake = fakeSandbox();
	fake.setExit(1);
	const event = await runPromise(executeLabTask(store, models.client, fake.sandbox, SEED));
	assert.equal(event.outcome.status === "completed" && event.outcome.verificationExitCode, 1);
	assert.equal(event.outcome.status === "completed" && event.outcome.verificationOutput, "assertion failed");
});

test("model-turn exhaustion, request refusal, and verifier failure remain invalid executions", async (t) => {
	for (const failure of ["turns", "budget", "verifier"] as const) {
		const settings = config();
		if (failure === "budget") settings.limits.maxRequests = 1;
		const store = await runtimeStore(t, startedDocument(settings));
		const models = fakeModels(() => {
			const message = response();
			if (failure !== "verifier") {
				message.stopReason = "toolUse";
				message.content = [
					{ type: "toolCall", id: "write1", name: "write", arguments: { path: "src/input.mjs", content: "changed" } },
				];
			}
			return message;
		});
		const fake = fakeSandbox();
		if (failure === "verifier") fake.setFailure(Effect.fail(new LabError({ message: "Docker unavailable" })));
		const event = await runPromise(executeLabTask(store, models.client, fake.sandbox, SEED));
		assert.equal(event.outcome.status, "error");
		assert.equal(
			event.outcome.status === "error" && event.outcome.failure,
			failure === "verifier" ? "environment" : failure === "budget" ? "budget" : "model",
		);
		assert.equal(event.requestIds.length, failure === "turns" ? 2 : 1);
		assert.equal(fake.lifecycle.includes("removed"), true);
		assert.equal(fake.lifecycle.includes("verify"), failure === "verifier");
	}
});

test("task timeout is clock-driven and cannot produce a passing verifier result", async (t) => {
	const store = await runtimeStore(t);
	const { state } = await runPromise(loadLabStore(store));
	const models = fakeModels();
	const fake = fakeSandbox();
	const entered = Promise.withResolvers<void>();
	fake.setFailure(Effect.sync(() => entered.resolve()).pipe(Effect.andThen(Effect.never)));
	await runPromise(
		Effect.gen(function* () {
			yield* TestClock.setTime(state.started.at);
			const fiber = yield* executeLabTask(store, models.client, fake.sandbox, SEED).pipe(Effect.forkChild);
			yield* Effect.tryPromise(() => entered.promise);
			yield* TestClock.adjust(state.started.config.limits.maxTaskTimeMs);
			const event = yield* Fiber.join(fiber);
			assert.equal(event.outcome.status, "error");
			assert.match(event.outcome.status === "error" ? event.outcome.message : "", /timed out/);
		}).pipe(Effect.provide(TestClock.layer())),
	);
	assert.equal((await runPromise(loadLabStore(store))).state.tasks[0]!.outcome.status, "error");
});

test("cancellation cleans the workspace and preserves a nonpassing task outcome", async (t) => {
	const store = await runtimeStore(t);
	const models = fakeModels();
	const fake = fakeSandbox();
	const entered = Promise.withResolvers<void>();
	const controller = new AbortController();
	fake.sandbox.withWorkspace = (_files, _use) =>
		Effect.sync(() => entered.resolve()).pipe(
			Effect.andThen(Effect.never),
			Effect.ensuring(Effect.sync(() => fake.lifecycle.push("removed"))),
		);
	const pending = runPromise(executeLabTask(store, models.client, fake.sandbox, SEED), { signal: controller.signal });
	const rejected = assert.rejects(pending);
	await entered.promise;
	controller.abort();
	await rejected;
	assert.deepEqual(fake.lifecycle, ["removed"]);
	assert.equal(models.calls.length, 0);
	const { state } = await runPromise(loadLabStore(store));
	assert.equal(state.tasks[0]!.outcome.status === "error" && state.tasks[0]!.outcome.failure, "cancelled");
	assert.equal(fake.lifecycle.includes("verify"), false);
});

test("cancellation during a model call preserves the task's exact failed request identity", async (t) => {
	const store = await runtimeStore(t);
	const models = fakeModels();
	const fake = fakeSandbox();
	const called = Promise.withResolvers<void>();
	const controller = new AbortController();
	models.setStream(([, , options]) => {
		const stream = createAssistantMessageEventStream();
		options!.signal!.addEventListener("abort", () => stream.end(response()));
		called.resolve();
		return stream;
	});
	const pending = runPromise(executeLabTask(store, models.client, fake.sandbox, SEED), { signal: controller.signal });
	const rejected = assert.rejects(pending);
	await called.promise;
	controller.abort();
	await rejected;
	const { state } = await runPromise(loadLabStore(store));
	assert.equal(state.requestEnds[0]!.status, "cancelled");
	assert.deepEqual(state.tasks[0]!.requestIds, [state.requestStarts[0]!.id]);
	assert.equal(state.tasks[0]!.outcome.status === "error" && state.tasks[0]!.outcome.failure, "cancelled");
	assert.deepEqual(fake.lifecycle, ["workspace", "removed"]);
});
