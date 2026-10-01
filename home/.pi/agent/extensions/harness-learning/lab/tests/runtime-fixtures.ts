import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type Context,
	type Model,
} from "@earendil-works/pi-ai";
import { DateTime } from "effect";
import { runPromise } from "../../../_shared/effect-runtime.ts";
import { makeDirectory, removeTree } from "../../../_shared/fs.ts";
import type { LabModels } from "../model.ts";
import type { LabDocument } from "../schema.ts";
import { appendLabStoreEvent, createLabStore, openLabStore } from "../store.ts";
import { startedDocument } from "./fixtures.ts";

export async function runtimeStore(t: TestContext, document: LabDocument = startedDocument()) {
	const root = join(tmpdir(), `harness-lab-runtime-${randomUUID()}`);
	t.after(() => runPromise(removeTree(root)));
	await runPromise(makeDirectory(join(root, "repo")));
	const store = await runPromise(openLabStore(join(root, "repo"), "run1", join(root, "private")));
	const at = DateTime.toEpochMillis(await runPromise(DateTime.now));
	const events = document.events.map((event) => ({ ...event, at }));
	await runPromise(createLabStore(store, events[0]));
	for (const event of events.slice(1)) await runPromise(appendLabStoreEvent(store, event));
	return store;
}

export function model(id = "executor"): Model<Api> {
	return {
		id,
		name: `Fake ${id}`,
		provider: "test",
		api: "anthropic-messages",
		baseUrl: "https://unused.invalid",
		input: ["text"],
		reasoning: false,
		contextWindow: 500_000,
		maxTokens: 8192,
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
	};
}

export function response(text = "Done.", id = "executor"): AssistantMessage {
	return {
		role: "assistant",
		api: "anthropic-messages",
		provider: "test",
		model: id,
		content: [{ type: "text", text }],
		timestamp: 0,
		stopReason: "stop",
		usage: {
			input: 10,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 20,
			cost: { input: 0.001, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.002 },
		},
	};
}

type Request = Parameters<LabModels["streamSimple"]>;
export function fakeModels(answer: (request: Request) => AssistantMessage = () => response()) {
	const calls: Request[] = [];
	let override: ((request: Request) => ReturnType<LabModels["streamSimple"]>) | undefined;
	const client: LabModels = {
		getPhysicalModel: (provider, id) => (provider === "test" ? model(id) : undefined),
		streamSimple: (...request) => {
			calls.push(request);
			if (override !== undefined) return override(request);
			const stream = createAssistantMessageEventStream();
			const message = answer(request);
			if (message.stopReason === "stop" || message.stopReason === "toolUse" || message.stopReason === "length")
				stream.push({ type: "done", reason: message.stopReason, message });
			else stream.push({ type: "error", reason: "error", error: message });
			return stream;
		},
	};
	return {
		client,
		calls,
		setStream: (next: typeof override) => {
			override = next;
		},
	};
}

export function context(): Context {
	return { systemPrompt: "Synthetic request.", messages: [{ role: "user", content: "A task.", timestamp: 0 }] };
}
