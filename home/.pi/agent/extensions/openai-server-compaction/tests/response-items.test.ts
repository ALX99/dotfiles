import assert from "node:assert/strict";
import test from "node:test";

import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { createApplyPatchTool } from "../../codex-apply-patch/index.ts";
import type { ResponsesModel } from "../models.ts";

import {
	buildCompactedHistory,
	buildToolsPayload,
	messagesToResponseItems,
	normalizeResponseItemsForPrompt,
	type ResponseItem,
} from "../response-items.ts";

const textModel = { input: ["text"] };
const imageModel = { input: ["text", "image"] };
const responsesModel = {
	id: "gpt-6.1-sol",
	api: "openai-responses",
	provider: "openai",
	input: ["text", "image"],
} as ResponsesModel;
const NO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function tool(name: string, description: string): ToolInfo {
	return {
		name,
		description,
		parameters: { type: "object" },
		exposure: "direct",
		sourceInfo: { path: `builtin:${name}`, source: "builtin", scope: "user", origin: "top-level" },
	};
}

function user(text: string): Message {
	return { role: "user", content: [{ type: "text", text }], timestamp: 0 };
}

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-6.1-sol",
		usage: NO_USAGE,
		stopReason: "stop",
		timestamp: 0,
	};
}

test("a user message becomes one input_text item", () => {
	assert.deepEqual(messagesToResponseItems([user("hello")], responsesModel), [
		{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
	]);
});

test("an assistant turn keeps its text, encrypted reasoning, and tool calls in order", () => {
	const message: AssistantMessage = {
		...assistant("done"),
		content: [
			{
				type: "thinking",
				thinking: "hidden",
				thinkingSignature: JSON.stringify({
					type: "reasoning",
					summary: [{ type: "summary_text", text: "plan" }],
					encrypted_content: "opaque",
				}),
			},
			{ type: "text", text: "done" },
			{ type: "toolCall", id: "call_1|session", name: "read", arguments: { path: "a.ts" } },
		],
	};
	assert.partialDeepStrictEqual(messagesToResponseItems([message], responsesModel), [
		{ type: "reasoning", summary: [{ type: "summary_text", text: "plan" }], encrypted_content: "opaque" },
		{ type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] },
		{ type: "function_call", name: "read", call_id: "call_1", arguments: JSON.stringify({ path: "a.ts" }) },
		{ type: "function_call_output", call_id: "call_1", output: "No result provided" },
	]);
});

test("a tool result keeps the call id without the session suffix", () => {
	const message: Message = {
		role: "toolResult",
		toolCallId: "call_1|session",
		toolName: "read",
		content: [{ type: "text", text: "output" }],
		timestamp: 0,
		isError: false,
	};
	assert.deepEqual(messagesToResponseItems([message], responsesModel), [
		{ type: "function_call_output", call_id: "call_1", output: "output" },
	]);
});

test("normalization closes an open tool call and drops an orphaned output", () => {
	const items: ResponseItem[] = [
		{ type: "function_call", name: "read", call_id: "call_1", arguments: "{}" },
		{ type: "function_call_output", call_id: "call_1", output: "kept" },
		{ type: "function_call_output", call_id: "call_gone", output: "stale" },
		{ type: "function_call", name: "bash", call_id: "call_2", arguments: "{}" },
	];
	assert.deepEqual(normalizeResponseItemsForPrompt(items, textModel), [
		{ type: "function_call", name: "read", call_id: "call_1", arguments: "{}" },
		{ type: "function_call_output", call_id: "call_1", output: "kept" },
		{ type: "function_call", name: "bash", call_id: "call_2", arguments: "{}" },
		{ type: "function_call_output", call_id: "call_2", output: "aborted" },
	]);
});

test("normalization removes image parts for a model that cannot read them", () => {
	const items: ResponseItem[] = [
		{
			type: "message",
			role: "user",
			content: [
				{ type: "input_text", text: "look" },
				{ type: "input_image", image_url: "data:image/png;base64,AA" },
			],
		},
	];
	assert.deepEqual(normalizeResponseItemsForPrompt(items, textModel), [
		{
			type: "message",
			role: "user",
			content: [
				{ type: "input_text", text: "look" },
				{ type: "input_text", text: "image content omitted because you do not support image input" },
			],
		},
	]);
	assert.deepEqual(normalizeResponseItemsForPrompt(items, imageModel), items);
});

test("normalization returns copies, so replaying cannot alias stored state", () => {
	const items: ResponseItem[] = [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }];
	const normalized = normalizeResponseItemsForPrompt(items, textModel);
	normalized[0] = { type: "compaction", encrypted_content: "changed" };
	assert.deepEqual(items[0], { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] });
});

test("compacted history keeps the retained user turns and the compaction item", () => {
	const input: ResponseItem[] = [
		{ type: "message", role: "user", content: [{ type: "input_text", text: "first" }] },
		{ type: "message", role: "developer", content: [{ type: "input_text", text: "ignore me" }] },
		{ type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] },
		{ type: "message", role: "user", content: [{ type: "input_text", text: "second" }] },
	];
	assert.deepEqual(buildCompactedHistory(input, { type: "compaction", encrypted_content: "opaque" }), [
		{ type: "message", role: "user", content: [{ type: "input_text", text: "first" }] },
		{ type: "message", role: "user", content: [{ type: "input_text", text: "second" }] },
		{ type: "compaction", encrypted_content: "opaque" },
	]);
});

test("compacted history trims the retained turn that overruns the budget", () => {
	const history = buildCompactedHistory(
		[{ type: "message", role: "user", content: [{ type: "input_text", text: "x".repeat(160_000) }] }],
		{ type: "compaction", encrypted_content: "opaque" },
	);
	assert.equal(history.length, 2);
	const retained = history[0] as { content: { text: string }[] } | undefined;
	assert.equal(retained?.content[0]?.text.length, 80_000);
});

test("compacted history needs the compaction item the API returns", () => {
	assert.throws(
		() => buildCompactedHistory([], { type: "compaction_summary", encrypted_content: "opaque" }),
		/did not return a compaction item/,
	);
});

test("only the session's active tools are declared", () => {
	const tools = buildToolsPayload(
		[tool("read", "read a file"), tool("bash", "run a command")],
		["read"],
		responsesModel,
	);
	assert.partialDeepStrictEqual(tools, [
		{ type: "function", name: "read", description: "read a file", parameters: { type: "object" } },
	]);
});

test("grammar tool declarations and call/result pairs keep the native custom-tool transport", () => {
	const grammarModel = {
		id: "gpt-6.1-sol",
		api: "openai-responses",
		provider: "openai",
		input: ["text"],
		compat: { supportsOpenAIGrammarTools: true },
	} as ResponsesModel;
	const patchTool = createApplyPatchTool();
	const patch = "*** Begin Patch\n*** Add File: file.txt\n+hello\n*** End Patch\n";
	const calls: Message[] = [
		{
			...assistant(""),
			content: [{ type: "toolCall", name: "apply_patch", id: "call_patch|ctc_patch", arguments: { patch } }],
		},
		{
			role: "toolResult",
			toolCallId: "call_patch|ctc_patch",
			toolName: "apply_patch",
			content: [{ type: "text", text: "Success" }],
			isError: false,
			timestamp: 0,
		},
	];
	const items = messagesToResponseItems(calls, grammarModel, [patchTool]);
	assert.partialDeepStrictEqual(items, [
		{ type: "custom_tool_call", call_id: "call_patch", name: "apply_patch", input: patch },
		{ type: "custom_tool_call_output", call_id: "call_patch", output: "Success" },
	]);
	assert.partialDeepStrictEqual(buildToolsPayload([patchTool], ["apply_patch"], grammarModel), [
		{ type: "custom", name: "apply_patch", format: { type: "grammar", syntax: "lark" } },
	]);
});
