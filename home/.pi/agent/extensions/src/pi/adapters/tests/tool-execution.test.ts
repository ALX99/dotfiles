import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, SessionEntry, Theme } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";

import type { ApplicationEffects } from "../../../application.ts";
import { installToolExecutionAdapter } from "../tool-execution.ts";

test("the application installs one execution observer shared by builtin and patch renderers", (t) => {
	let now = 100;
	t.mock.method(performance, "now", () => now);

	const handlers = new Map<string, Array<(event: unknown, context: ExtensionContext) => void>>();
	const branch: SessionEntry[] = [];
	const pi = {
		on(name: string, handler: (event: unknown, context: ExtensionContext) => void) {
			const registered = handlers.get(name) ?? [];
			registered.push(handler);
			handlers.set(name, registered);
		},
		appendEntry(customType: string, data: unknown) {
			branch.push({
				type: "custom",
				id: `${branch.length}`,
				parentId: null,
				timestamp: "2026-10-06T00:00:00.000Z",
				customType,
				data,
			} as SessionEntry);
		},
	} as unknown as ExtensionAPI;
	const context = { sessionManager: { getBranch: () => branch } } as unknown as ExtensionContext;
	const applicationEffects: ApplicationEffects = {
		initiate: (effect) => Effect.runPromise(effect),
		run: (effect, options) => Effect.runPromise(effect, options),
	};
	const statusFor = installToolExecutionAdapter(pi, applicationEffects);

	assert.equal(handlers.get("session_start")?.length, 1);
	assert.equal(handlers.get("session_tree")?.length, 1);
	assert.equal(handlers.get("session_shutdown")?.length, 1);
	assert.equal(handlers.get("tool_execution_start")?.length, 1);
	assert.equal(handlers.get("tool_execution_end")?.length, 1);

	const emit = (name: string, event: unknown = {}) => {
		for (const handler of handlers.get(name) ?? []) handler(event, context);
	};
	emit("session_start");
	for (const [toolName, toolCallId] of [
		["read", "read-call"],
		["apply_patch", "patch-call"],
	] as const) {
		emit("tool_execution_start", { toolName, toolCallId });
		now += 250;
		emit("tool_execution_end", { toolName, toolCallId });
	}

	assert.deepEqual(
		branch.map((entry) => entry.type === "custom" && entry.data),
		[
			{ toolCallId: "read-call", toolName: "read", durationMs: 250 },
			{ toolCallId: "patch-call", toolName: "apply_patch", durationMs: 250 },
		],
	);

	emit("session_tree");
	for (const toolCallId of ["read-call", "patch-call"]) {
		const state: { durationMs?: number } = {};
		statusFor(
			{ fg: (_color: string, text: string) => text } as Theme,
			{ state, toolCallId, isPartial: false, isError: false } as Parameters<typeof statusFor>[1],
		);
		assert.equal(state.durationMs, 250);
	}

	emit("session_shutdown");
});
