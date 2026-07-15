import * as assert from "node:assert/strict";
import { test } from "node:test";
import { fitDashboardHeight, formatAgentCounts, formatTranscript, sanitizeTerminalText } from "../dashboard.ts";
import type { AgentView } from "../host.ts";

function view(status: AgentView["summary"]["status"]): AgentView {
	return {
		summary: {
			agent_id: status,
			agent: "scout",
			task_name: "test",
			profile: "fast",
			model: "opencode-go/deepseek-v4-flash",
			effective_thinking: "low",
			depth: 1,
			generation: 1,
			status,
		},
		details: {
			agent: "scout",
			taskName: "test",
			profile: "fast",
			model: "opencode-go/deepseek-v4-flash",
			effectiveThinking: "low",
			depth: 1,
			exitCode: 0,
			finalText: "",
			stderr: "",
			aborted: false,
			startTime: 0,
			toolCount: 0,
			recentTools: [],
			lastMessage: "",
			nestedRuns: [],
			tokens: 0,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
		},
	};
}

test("formatAgentCounts groups starting and running agents", () => {
	assert.equal(
		formatAgentCounts([view("starting"), view("running"), view("idle"), view("failed")]),
		"2 running · 1 ready · 1 failed",
	);
	assert.equal(formatAgentCounts([]), "0 running");
});

test("fitDashboardHeight preserves the frame and controls on short terminals", () => {
	const lines = ["top", "one", "two", "three", "four", "help", "bottom"];
	assert.deepEqual(fitDashboardHeight(lines, 5), ["top", "one", "two", "help", "bottom"]);
	assert.equal(fitDashboardHeight(lines, 5).length, 5);
	assert.deepEqual(fitDashboardHeight(lines, 2), ["help", "bottom"]);
	assert.deepEqual(fitDashboardHeight(lines, 0), []);
	assert.equal(fitDashboardHeight(lines, 10), lines);
});

test("sanitizeTerminalText removes terminal controls and flattens rows", () => {
	assert.equal(
		sanitizeTerminalText("safe\u001b[2J\u001b]8;;https://example.com\u0007link\u001b]8;;\u0007\nnext\u0000"),
		"safelink next",
	);
});

test("formatTranscript produces a bounded compact activity log", () => {
	const messages = [
		{ role: "user", content: [{ type: "text", text: "Inspect\nthis\u001b[2J" }] },
		{
			role: "assistant",
			content: [
				{ type: "text", text: "I will inspect it." },
				{ type: "toolCall", name: "read", arguments: { path: "host.ts" } },
			],
		},
		{ role: "toolResult", content: [{ type: "text", text: "done" }] },
	];

	assert.deepEqual(formatTranscript(messages), [
		"user: Inspect this",
		"assistant: I will inspect it. · → read",
		"toolResult: done",
	]);

	const many = Array.from({ length: 25 }, (_, index) => ({
		role: "assistant",
		content: [{ type: "text", text: `line ${index}` }],
	}));
	const bounded = formatTranscript(many);
	assert.equal(bounded.length, 20);
	assert.equal(bounded[0], "assistant: line 5");
});
