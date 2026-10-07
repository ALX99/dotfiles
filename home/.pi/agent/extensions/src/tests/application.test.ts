import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { applicationWorkflow, createApplicationRuntime } from "../runtime.ts";

test("settlement runs concrete work in application-owned priority order", async () => {
	const runtime = createApplicationRuntime();
	const pending = new Set(["taskCheckpoint", "rescuedInput", "scheduledMessage", "taskInput", "taskReminder"]);
	const observed: string[] = [];

	try {
		await runtime.runPromise(applicationWorkflow((application) => application.startSession));
		for (let index = 0; index < 5; index++) {
			const action = (name: string) =>
				pending.has(name)
					? Effect.sync(() => {
							observed.push(name);
							pending.delete(name);
						})
					: undefined;
			const prepare = (name: string) => Effect.sync(() => action(name));
			await runtime.runPromise(
				applicationWorkflow((application) =>
					application.settle({
						taskCheckpoint: prepare("taskCheckpoint"),
						rescuedInput: prepare("rescuedInput"),
						scheduledMessage: prepare("scheduledMessage"),
						taskInput: prepare("taskInput"),
						taskReminder: prepare("taskReminder"),
					}),
				),
			);
		}

		assert.deepEqual(observed, ["taskCheckpoint", "rescuedInput", "scheduledMessage", "taskInput", "taskReminder"]);
	} finally {
		await runtime.dispose();
	}
});

test("activity stops its indicator on agent_end before settlement", async () => {
	const runtime = createApplicationRuntime();
	try {
		const activity = (
			signal: "session_start" | "agent_start" | "agent_end" | "agent_settled" | "ui_prompt_start" | "ui_prompt_end",
		) => runtime.runPromise(applicationWorkflow((application) => application.activity(signal)));

		assert.deepEqual(await activity("session_start"), {
			activeRuns: 0,
			indicatorActive: false,
			keepAwakeActive: false,
		});
		assert.deepEqual(await activity("agent_start"), {
			activeRuns: 1,
			indicatorActive: true,
			keepAwakeActive: true,
		});
		assert.deepEqual(await activity("ui_prompt_start"), {
			activeRuns: 1,
			indicatorActive: false,
			keepAwakeActive: false,
		});
		assert.deepEqual(await activity("ui_prompt_end"), {
			activeRuns: 1,
			indicatorActive: true,
			keepAwakeActive: true,
		});
		assert.deepEqual(await activity("agent_end"), {
			activeRuns: 1,
			indicatorActive: false,
			keepAwakeActive: false,
		});
		assert.deepEqual(await activity("agent_settled"), {
			activeRuns: 0,
			indicatorActive: false,
			keepAwakeActive: false,
		});
	} finally {
		await runtime.dispose();
	}
});

test("provider request transforms run in order and isolate failures", async () => {
	const runtime = createApplicationRuntime();
	const order: string[] = [];

	try {
		const result = await runtime.runPromise(
			applicationWorkflow((application) =>
				application.providerRequest({ initial: true }, {} as ExtensionContext, [
					(payload) => {
						order.push("search");
						return { ...(payload as object), searched: true };
					},
					async () => {
						order.push("compaction");
						throw new Error("optional transform failed");
					},
					(payload) => {
						order.push("following transform");
						return { ...(payload as object), following: true };
					},
				]),
			),
		);

		assert.deepEqual(order, ["search", "compaction", "following transform"]);
		assert.deepEqual(result, { initial: true, searched: true, following: true });
	} finally {
		await runtime.dispose();
	}
});

test("work initiation is atomic, releases after failure, and closes at session shutdown", async () => {
	const runtime = createApplicationRuntime();
	let releaseFirst!: () => void;
	let enteredFirst!: () => void;
	const entered = new Promise<void>((resolve) => {
		enteredFirst = resolve;
	});
	const gate = new Promise<void>((resolve) => {
		releaseFirst = resolve;
	});
	const observed: string[] = [];

	try {
		await runtime.runPromise(applicationWorkflow((application) => application.startSession));
		const first = runtime.runPromise(
			applicationWorkflow((application) =>
				application.initiate(
					Effect.promise(async () => {
						enteredFirst();
						await gate;
						observed.push("first");
					}),
				),
			),
		);
		await entered;
		await runtime.runPromise(
			applicationWorkflow((application) =>
				application.initiate(
					Effect.sync(() => {
						observed.push("overlap");
					}),
				),
			),
		);
		releaseFirst();
		await first;
		await assert.rejects(
			runtime.runPromise(
				applicationWorkflow((application) =>
					application.initiate(
						Effect.sync(() => {
							throw new Error("expected action failure");
						}),
					),
				),
			),
			/expected action failure/u,
		);
		await runtime.runPromise(
			applicationWorkflow((application) =>
				application.initiate(
					Effect.sync(() => {
						observed.push("after-failure");
					}),
				),
			),
		);

		await runtime.runPromise(applicationWorkflow((application) => application.shutdown));
		await runtime.runPromise(
			applicationWorkflow((application) =>
				application.initiate(
					Effect.sync(() => {
						observed.push("closed");
					}),
				),
			),
		);
		await runtime.runPromise(applicationWorkflow((application) => application.startSession));
		await runtime.runPromise(
			applicationWorkflow((application) =>
				application.initiate(
					Effect.sync(() => {
						observed.push("reopened");
					}),
				),
			),
		);

		assert.deepEqual(observed, ["first", "after-failure", "reopened"]);
	} finally {
		releaseFirst();
		await runtime.dispose();
	}
});
