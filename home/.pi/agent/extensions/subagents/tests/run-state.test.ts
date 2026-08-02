import * as assert from "node:assert/strict";
import { test } from "node:test";
import {
	argsPreview,
	foldAgentEvent,
	initRunData,
	runUsageTotalTokens,
	snapshotRunData,
	toPiUsage,
	type MutableRunData,
} from "../run-state.ts";

function details(): MutableRunData {
	return initRunData({
		agent: {
			name: "worker",
			description: "test",
			systemPrompt: "",
			filePath: "worker.md",
		},
		taskName: "test",
		profile: "balanced",
		model: "provider/model",
		effectiveThinking: "high",
		resultId: "a".repeat(64),
	});
}

test("assistant narration retains fallback text but never terminal finalText", () => {
	const run = details();
	foldAgentEvent(
		{
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "working narration" }],
				stopReason: "stop",
				usage: { input: 10, output: 5, totalTokens: 15, cost: { total: 0.1 } },
			},
		},
		run,
	);
	assert.equal(run.finalText, "");
	assert.equal(run.lastAssistantText, "working narration");
	assert.equal(run.usage.input, 10);
	assert.equal(run.tokens, 15);
});

test("child aggregate usage preserves total cost without double-counting reasoning", () => {
	const usage = {
		input: 10,
		output: 5,
		reasoning: 3,
		cacheRead: 2,
		cacheWrite: 1,
		cost: 0.25,
		turns: 1,
	};
	assert.equal(runUsageTotalTokens(usage), 18);
	assert.deepEqual(toPiUsage(usage), {
		input: 10,
		output: 5,
		reasoning: 3,
		cacheRead: 2,
		cacheWrite: 1,
		totalTokens: 18,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25 },
	});
	const run = details();
	foldAgentEvent(
		{
			type: "message_end",
			message: { role: "assistant", content: [], stopReason: "stop", usage: { ...usage, cost: { total: usage.cost } } },
		},
		run,
	);
	assert.equal(run.tokens, 18);
});

test("event folding retains bounded tool observability", () => {
	const run = details();
	foldAgentEvent(
		{
			type: "message_end",
			message: {
				role: "assistant",
				content: [
					{ type: "toolCall", name: "edit", arguments: { path: "src/file.ts" } },
					{ type: "text", text: "Applying the change" },
				],
				stopReason: "toolUse",
			},
		},
		run,
	);
	foldAgentEvent(
		{ type: "tool_execution_end", toolCallId: "call-1", toolName: "edit", result: {}, isError: false },
		run,
	);
	assert.equal(run.toolCount, 1);
	assert.deepEqual(run.recentTools, [{ name: "edit", argsPreview: "src/file.ts" }]);
	assert.equal(run.lastMessage, "Applying the change");
});

test("provider errors are recorded and cleared by a later successful assistant message", () => {
	const run = details();
	foldAgentEvent(
		{
			type: "message_end",
			message: { role: "assistant", content: [], stopReason: "error", errorMessage: "quota exhausted" },
		},
		run,
	);
	assert.equal(run.assistantError, "quota exhausted");
	foldAgentEvent(
		{
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: "recovered" }], stopReason: "stop" },
		},
		run,
	);
	assert.equal(run.assistantError, undefined);
});

test("snapshots omit the unbounded compatibility assistant text", () => {
	const run = details();
	run.lastAssistantText = "private fallback";
	const snapshot = snapshotRunData(run, { status: "running", generation: 1 });
	assert.equal(Object.hasOwn(snapshot, "lastAssistantText"), false);
	assert.equal(snapshot.generation, 1);
});

test("argsPreview prefers known keys and bounds fallback JSON", () => {
	assert.equal(argsPreview({ command: "printf ok" }), "printf ok");
	assert.match(argsPreview({ unknown: "x".repeat(1_000) }), /…$/u);
});
