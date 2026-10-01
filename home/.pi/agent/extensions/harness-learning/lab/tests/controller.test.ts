import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { runPromise } from "../../../_shared/effect-runtime.ts";
import { readRegularFileStringIfExists } from "../../../_shared/fs.ts";
import { runLabController } from "../controller.ts";
import type { LabModels } from "../model.ts";
import { labBudget, labReleaseGate } from "../state.ts";
import { loadLabStore } from "../store.ts";
import { controllerBoundaries, controllerConfig, CORRECT_SOLUTION } from "./controller-fixtures.ts";
import { startedDocument } from "./fixtures.ts";
import { response, runtimeStore } from "./runtime-fixtures.ts";

test("automatic research, full coding pairs, selection, and one-shot holdout leave production untouched", async (t) => {
	const store = await runtimeStore(t, startedDocument(controllerConfig()));
	const fake = controllerBoundaries();
	const state = await runPromise(runLabController(store, fake.models.client, fake.sandbox));
	assert.equal(state.finished?.status, "completed");
	assert.equal(labReleaseGate(state).eligible, true);
	assert.equal(state.selections.length, 1);
	assert.equal(state.selections[0]!.decision, "accept");
	assert.notEqual(state.head.id, "root");
	assert.equal(state.controller?.kind, "controller-start");
	assert.equal(state.tasks.filter(({ phase }) => phase === "seed").length, 4);
	assert.equal(state.tasks.filter(({ phase }) => phase === "development").length, 24);
	assert.equal(state.tasks.filter(({ phase }) => phase === "holdout").length, 12);
	assert.deepEqual(fake.counts(), { cleanup: 40, verification: 40 });
	assert.equal(
		await runPromise(readRegularFileStringIfExists(join(store.scopeDirectory, "history.json"), 4096)),
		undefined,
	);
	const firstHoldout = state.tasks.findIndex(({ phase }) => phase === "holdout");
	assert.equal(
		state.tasks.slice(firstHoldout).every(({ phase }) => phase === "holdout"),
		true,
	);
	const researcherCalls = fake.models.calls.filter(([model]) => model.id === "researcher");
	assert.equal(researcherCalls.length, 1);
	for (const [, context] of researcherCalls) {
		const input = JSON.stringify(context);
		assert.equal(context.tools, undefined);
		assert.equal(input.includes("PRIVATE_HOLDOUT_PROMPT"), false);
		assert.equal(input.includes("Synthetic holdout"), false);
		assert.equal(input.includes("readFileSync"), false);
		assert.equal(input.includes("assert.equal"), false);
		assert.equal(input.includes(CORRECT_SOLUTION), false);
	}
	for (const repeat of [0, 1, 2]) {
		const pair = state.tasks.filter(
			({ phase, taskId, repeat: r }) => phase === "development" && taskId === "target-0" && r === repeat,
		);
		assert.deepEqual(
			pair.map(({ arm }) => arm),
			repeat % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"],
		);
	}
	const callCount = fake.models.calls.length;
	await assert.rejects(runPromise(runLabController(store, fake.models.client, fake.sandbox)), /finished|fresh run/);
	assert.equal(fake.models.calls.length, callCount);
});

test("rejected theories feed the next iteration, while only a passing candidate advances experimental ancestry", async (t) => {
	const store = await runtimeStore(t, startedDocument(controllerConfig()));
	const fake = controllerBoundaries(true);
	const state = await runPromise(runLabController(store, fake.models.client, fake.sandbox));
	assert.equal(state.finished?.status, "completed");
	assert.deepEqual(
		state.selections.map(({ decision }) => decision),
		["reject", "accept"],
	);
	assert.equal(state.versions.length, 2);
	assert.equal(state.head.candidateId, state.candidates[1]!.id);
	assert.equal(state.head.procedureIds.includes(state.candidates[0]!.id), false);
	const calls = fake.models.calls.filter(([model]) => model.id === "researcher");
	assert.equal(calls.length, 2);
	const input = JSON.stringify(calls[1]![1]);
	assert.ok(input.includes(state.candidates[0]!.id));
	assert.ok(input.includes('"decision\\":\\"reject"') || input.includes("reject"));
	assert.equal(input.includes("PRIVATE_HOLDOUT_PROMPT"), false);
});

test("a failed final holdout cannot be retried, deployed, or fed back to further research", async (t) => {
	const settings = controllerConfig();
	settings.suite.tasks.find(({ kind }) => kind === "holdout")!.files[0]!.content = CORRECT_SOLUTION;
	const store = await runtimeStore(t, startedDocument(settings));
	const fake = controllerBoundaries();
	const verify = fake.sandbox.verify.bind(fake.sandbox);
	fake.sandbox.verify = (task, artifacts) =>
		task.kind === "holdout"
			? Effect.succeed({ verificationExitCode: 1, verificationOutput: "held-out failure" })
			: verify(task, artifacts);
	const state = await runPromise(runLabController(store, fake.models.client, fake.sandbox));
	assert.equal(state.finished?.status, "failed");
	assert.equal(labReleaseGate(state).eligible, false);
	assert.equal(state.tasks.filter(({ phase }) => phase === "holdout").length, 12);
	assert.equal(fake.models.calls.filter(([model]) => model.id === "researcher").length, 1);
	await assert.rejects(runPromise(runLabController(store, fake.models.client, fake.sandbox)), /finished/);
});

test("a perfect baseline produces no paid research or holdout work and no artificial improvement", async (t) => {
	const settings = controllerConfig();
	for (const task of settings.suite.tasks) task.files[0]!.content = CORRECT_SOLUTION;
	const store = await runtimeStore(t, startedDocument(settings));
	const fake = controllerBoundaries();
	const state = await runPromise(runLabController(store, fake.models.client, fake.sandbox));
	assert.equal(state.finished?.status, "stopped");
	assert.match(state.finished!.reason, /No recurring/);
	assert.equal(state.candidates.length, 0);
	assert.equal(state.tasks.length, 4);
	assert.equal(
		fake.models.calls.every(([model]) => model.id === "executor"),
		true,
	);
});

test("passing final tasks without a held-out gain does not authorize release", async (t) => {
	const settings = controllerConfig();
	for (const task of settings.suite.tasks) if (task.kind === "holdout") task.files[0]!.content = CORRECT_SOLUTION;
	const store = await runtimeStore(t, startedDocument(settings));
	const fake = controllerBoundaries();
	const state = await runPromise(runLabController(store, fake.models.client, fake.sandbox));
	assert.equal(state.finished?.status, "failed");
	assert.match(state.finished!.reason, /No measured held-out improvement/);
	assert.equal(
		state.tasks
			.filter(({ phase }) => phase === "holdout")
			.every(({ outcome }) => outcome.status === "completed" && outcome.verificationExitCode === 0),
		true,
	);
	assert.equal(labReleaseGate(state).eligible, false);
});

test("candidate and reserved-request limits stop development without consuming final holdouts", async (t) => {
	for (const limit of ["candidates", "requests"] as const) {
		const settings = controllerConfig();
		if (limit === "candidates") settings.limits.maxCandidates = 1;
		else settings.limits.maxRequests = 20;
		const store = await runtimeStore(t, startedDocument(settings));
		const fake = controllerBoundaries(true);
		const state = await runPromise(runLabController(store, fake.models.client, fake.sandbox));
		assert.equal(state.finished?.status, "stopped");
		assert.equal(
			state.tasks.some(({ phase }) => phase === "holdout"),
			false,
		);
		assert.equal(state.candidates.length, limit === "candidates" ? 1 : 0);
		assert.ok(labBudget(state).requests <= settings.limits.maxRequests);
		assert.equal(labReleaseGate(state).eligible, false);
	}
});

test("reported cost and token overshoots are retained and stop subsequent provider calls", async (t) => {
	for (const limit of ["cost", "tokens", "requests"] as const) {
		const settings = controllerConfig();
		if (limit === "cost") settings.limits.maxReportedCostUsd = 0.001;
		if (limit === "tokens") settings.limits.maxTotalTokens = 5000;
		if (limit === "requests") settings.limits.maxRequests = 1;
		const store = await runtimeStore(t, startedDocument(settings));
		const fake = controllerBoundaries();
		if (limit === "tokens") {
			fake.models.client.streamSimple = (...args) => {
				const result = createAssistantMessageEventStream();
				const message = response();
				message.usage.totalTokens = 5001;
				result.push({ type: "done", reason: "stop", message });
				assert.equal(args[0].id, "executor");
				return result;
			};
		}
		const state = await runPromise(runLabController(store, fake.models.client, fake.sandbox));
		const budget = labBudget(state);
		assert.equal(state.finished?.status, "stopped");
		assert.equal(budget.requests, 1);
		assert.equal(state.requestEnds.length, 1);
		if (limit === "tokens") assert.equal(budget.tokens, 5001);
		if (limit === "cost") assert.equal(budget.reportedCostUsd, 0.002);
		assert.equal(labReleaseGate(state).eligible, false);
	}
});

test("malformed or forged researcher proposals fail closed without a candidate or deployment", async (t) => {
	for (const text of ["```json\n{}\n```", '{"score":100,"parentVersion":"root"}', "{}"]) {
		const store = await runtimeStore(t, startedDocument(controllerConfig()));
		const fake = controllerBoundaries();
		const modelStream = fake.models.client.streamSimple;
		const models: LabModels = {
			getPhysicalModel: fake.models.client.getPhysicalModel,
			streamSimple: (...args) => {
				if (args[0].id !== "researcher") return modelStream(...args);
				const stream = createAssistantMessageEventStream();
				stream.push({ type: "done", reason: "stop", message: response(text, "researcher") });
				return stream;
			},
		};
		const state = await runPromise(runLabController(store, models, fake.sandbox));
		assert.equal(state.finished?.status, "failed");
		assert.equal(state.candidates.length, 0);
		assert.equal(state.requestEnds.at(-1)!.status, "completed");
		assert.equal(
			state.tasks.some(({ phase }) => phase !== "seed"),
			false,
		);
	}
});

test("cancellation during research preserves usage uncertainty and an immutable cancelled run", async (t) => {
	const store = await runtimeStore(t, startedDocument(controllerConfig()));
	const fake = controllerBoundaries();
	const called = Promise.withResolvers<void>();
	const base = fake.models.client.streamSimple;
	const models: LabModels = {
		getPhysicalModel: fake.models.client.getPhysicalModel,
		streamSimple: (...args) => {
			if (args[0].id !== "researcher") return base(...args);
			const stream = createAssistantMessageEventStream();
			args[2]?.signal?.addEventListener("abort", () => stream.end(), { once: true });
			called.resolve();
			return stream;
		},
	};
	const controller = new AbortController();
	const pending = runPromise(runLabController(store, models, fake.sandbox), { signal: controller.signal });
	const rejected = assert.rejects(pending);
	await called.promise;
	controller.abort();
	await rejected;
	const { state } = await runPromise(loadLabStore(store));
	assert.equal(state.finished?.status, "cancelled");
	assert.equal(state.requestEnds.at(-1)!.status, "cancelled");
	assert.equal(state.requestEnds.at(-1)!.usage, null);
	assert.equal(labBudget(state).pending.length, 0);
	assert.equal(state.candidates.length, 0);
	assert.equal(labReleaseGate(state).eligible, false);
});

test("the controller deadline interrupts task work and records a terminal non-releasable run", async (t) => {
	const settings = controllerConfig();
	settings.limits.maxWallTimeMs = 1000;
	settings.limits.maxTaskTimeMs = 1000;
	const store = await runtimeStore(t, startedDocument(settings));
	const startedAt = (await runPromise(loadLabStore(store))).state.started.at;
	const fake = controllerBoundaries();
	const entered = Promise.withResolvers<void>();
	let cleaned = false;
	fake.sandbox.withWorkspace = () =>
		Effect.sync(() => entered.resolve()).pipe(
			Effect.andThen(Effect.never),
			Effect.ensuring(
				Effect.sync(() => {
					cleaned = true;
				}),
			),
		);
	await runPromise(
		Effect.gen(function* () {
			yield* TestClock.setTime(startedAt);
			const fiber = yield* runLabController(store, fake.models.client, fake.sandbox).pipe(Effect.forkChild);
			yield* Effect.tryPromise(() => entered.promise);
			yield* TestClock.adjust(1000);
			const state = yield* Fiber.join(fiber);
			assert.notEqual(state.finished?.status, "completed");
			assert.equal(labReleaseGate(state).eligible, false);
			assert.equal(cleaned, true);
			assert.equal(fake.models.calls.length, 0);
		}).pipe(Effect.provide(TestClock.layer())),
	);
});

test("two controllers cannot claim the same run and interruption never authorizes resumption", async (t) => {
	const store = await runtimeStore(t, startedDocument(controllerConfig()));
	const fake = controllerBoundaries();
	const entered = Promise.withResolvers<void>();
	fake.sandbox.withWorkspace = () => Effect.sync(() => entered.resolve()).pipe(Effect.andThen(Effect.never));
	const controller = new AbortController();
	const first = runPromise(runLabController(store, fake.models.client, fake.sandbox), { signal: controller.signal });
	const rejected = assert.rejects(first);
	await entered.promise;
	await assert.rejects(runPromise(runLabController(store, fake.models.client, fake.sandbox)), /fresh run/);
	assert.equal((await runPromise(loadLabStore(store))).state.finished, null);
	controller.abort();
	await rejected;
	assert.equal((await runPromise(loadLabStore(store))).state.finished?.status, "cancelled");
});
