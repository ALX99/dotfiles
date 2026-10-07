import * as assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import { extractCodeBlocks, getLastAssistantReply } from "../copy-code.ts";

function assistantEntry(
	content: string | AssistantMessage["content"],
	stopReason: "stop" | "toolUse" | "aborted" = "stop",
): SessionEntry {
	return {
		type: "message",
		id: "assistant",
		parentId: null,
		timestamp: new Date(0).toISOString(),
		message: {
			role: "assistant",
			content: typeof content === "string" ? (content === "" ? [] : [{ type: "text", text: content }]) : [...content],
			api: "test",
			provider: "test",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					total: 0,
				},
			},
			stopReason,
			timestamp: 0,
		},
	};
}

test("extractCodeBlocks finds labeled and unlabeled fenced blocks", () => {
	assert.deepEqual(
		extractCodeBlocks(
			[
				"Use this:",
				"```bash",
				"  echo hello",
				"```",
				"",
				"~~~typescript",
				"const answer = 42;",
				"~~~",
				"",
				"```",
				"plain",
				"```",
			].join("\n"),
		),
		[
			{ language: "bash", code: "  echo hello" },
			{ language: "typescript", code: "const answer = 42;" },
			{ language: "plain", code: "plain" },
		],
	);
});

test("extractCodeBlocks supports longer fences and an unfinished final fence", () => {
	assert.deepEqual(
		extractCodeBlocks(["````sh", "echo one", "```", "echo two", "````", "```python", "print(1)"].join("\n")),
		[
			{ language: "sh", code: "echo one\n```\necho two" },
			{ language: "python", code: "print(1)" },
		],
	);
});

test("extractCodeBlocks ignores text that is not a Markdown fence", () => {
	assert.deepEqual(extractCodeBlocks(["``sh", "not a block", "``"].join("\n")), []);
});

test("getLastAssistantReply reads only the latest assistant message", () => {
	const entries = [assistantEntry("```sh\nold\n```"), assistantEntry("The latest answer has no code.")];
	assert.equal(getLastAssistantReply(entries), "The latest answer has no code.");
});

test("getLastAssistantReply joins text blocks, ignores other content, and skips an empty aborted reply", () => {
	const reply = "```sh\nprintf 'ok'\n```";
	const splitReply: AssistantMessage["content"] = [
		{ type: "text", text: "```sh\n" },
		{ type: "thinking", thinking: "not part of the reply" },
		{ type: "text", text: "printf 'ok'\n```" },
	];
	const entries = [assistantEntry("older reply"), assistantEntry(splitReply), assistantEntry("", "aborted")];
	assert.equal(getLastAssistantReply(entries), reply);
});
