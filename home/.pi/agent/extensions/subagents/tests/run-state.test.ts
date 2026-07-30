import * as assert from "node:assert/strict";
import { test } from "node:test";
import { OutputSpool } from "../output-spool.ts";
import { argsPreview, foldAgentEvent, initRunData, snapshotRunData, type MutableRunData } from "../run-state.ts";

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

test("assistant narration updates transcript state but never terminal finalText", async (t) => {
	const run = details();
	const output = new OutputSpool();
	t.after(() => output.close());
	await foldAgentEvent(
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
		output,
	);
	assert.equal(run.finalText, "");
	assert.equal(run.transcriptPreview, "working narration");
	assert.equal(run.lastAssistantText, "working narration");
	assert.equal(run.usage.input, 10);
	assert.equal(run.tokens, 15);
});

test("event folding retains bounded tool observability and counts mutation-capable completions", async (t) => {
	const run = details();
	const output = new OutputSpool();
	t.after(() => output.close());
	await foldAgentEvent(
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
		output,
	);
	await foldAgentEvent(
		{ type: "tool_execution_end", toolCallId: "call-1", toolName: "edit", result: {}, isError: false },
		run,
		output,
	);
	assert.equal(run.toolCount, 1);
	assert.equal(run.mutationToolCalls, 1);
	assert.deepEqual(run.recentTools, [{ name: "edit", argsPreview: "src/file.ts" }]);
	assert.equal(run.lastMessage, "Applying the change");
});

test("provider errors are recorded and cleared by a later successful assistant message", async (t) => {
	const run = details();
	const output = new OutputSpool();
	t.after(() => output.close());
	await foldAgentEvent(
		{
			type: "message_end",
			message: { role: "assistant", content: [], stopReason: "error", errorMessage: "quota exhausted" },
		},
		run,
		output,
	);
	assert.equal(run.assistantError, "quota exhausted");
	await foldAgentEvent(
		{
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: "recovered" }], stopReason: "stop" },
		},
		run,
		output,
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
