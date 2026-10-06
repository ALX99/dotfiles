import * as assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import { extractCodeBlocks, getLastAssistantReply } from "../copy-code.ts";

function assistantEntry(text: string, stopReason: "stop" | "toolUse" | "aborted" = "stop"): SessionEntry {
	return {
		type: "message",
		id: "assistant",
		parentId: null,
		timestamp: new Date(0).toISOString(),
		message: {
			role: "assistant",
			content: text === "" ? [] : [{ type: "text", text }],
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

test("getLastAssistantReply joins text content and ignores an empty aborted message", () => {
	const entries = [assistantEntry("```sh\nprintf 'ok'\n```"), assistantEntry("", "aborted")];
	assert.equal(getLastAssistantReply(entries), "```sh\nprintf 'ok'\n```");
});
