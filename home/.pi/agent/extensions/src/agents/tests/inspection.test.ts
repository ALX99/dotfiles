import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSessionEvent, SessionEntry } from "@earendil-works/pi-coding-agent";

import { latestObservableActivity, observeSessionEvent, relativeAge } from "../inspection.ts";

const now = Date.UTC(2026, 9, 6, 12, 0, 0);

function entry(id: string, ageMs: number, message: unknown): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date(now - ageMs).toISOString(),
		message,
	} as SessionEntry;
}

test("inspection returns the five newest observable events newest-first with relative ages", () => {
	const entries = [
		entry("old", 120_000, { role: "assistant", content: [{ type: "text", text: "Older output" }] }),
		entry("output", 90_000, { role: "assistant", content: [{ type: "text", text: "A visible update" }] }),
		entry("thinking", 60_000, {
			role: "assistant",
			content: [{ type: "thinking", thinking: "Provider-exposed reasoning" }],
		}),
		entry("parent", 30_000, {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "ask-1",
					name: "ask_parent",
					arguments: { message: "Which database?", options: ["SQLite", "Postgres"] },
				},
			],
		}),
		entry("result", 5_000, {
			role: "toolResult",
			toolCallId: "read-1",
			toolName: "read",
			content: [{ type: "text", text: "Found the handler." }],
		}),
		entry("hidden", 2_000, {
			role: "assistant",
			content: [{ type: "redacted_thinking", data: "private hidden reasoning" }],
		}),
		{
			type: "compaction",
			id: "compact",
			parentId: null,
			timestamp: new Date(now - 1_000).toISOString(),
			summary: "Session compacted.",
		} as SessionEntry,
	];

	const latest = latestObservableActivity(entries, [], now);
	assert.deepEqual(
		latest.map(({ type }) => type),
		["session_event", "tool_result", "ask_parent", "thinking", "output"],
	);
	assert.deepEqual(
		latest.map(({ age }) => age),
		["1s ago", "5s ago", "30s ago", "1m ago", "1m ago"],
	);
	assert.deepEqual(latest[2], {
		age: "30s ago",
		type: "ask_parent",
		message: "Which database?",
		options: ["SQLite", "Postgres"],
	});
	assert.equal(
		latest.some((event) => "content" in event && event.content.includes("private hidden reasoning")),
		false,
	);
});

test("provider-exposed stream output is inspectable before the message is persisted", () => {
	const message = {
		role: "assistant",
		timestamp: now - 1_000,
		content: [
			{ type: "text", text: "I am tracing the request." },
			{ type: "thinking", thinking: "The visible response points to the router." },
		],
	};
	const live = observeSessionEvent({ type: "message_update", message } as AgentSessionEvent);
	const persisted = entry("assistant", 1_000, message);
	const latest = latestObservableActivity([persisted], live, now);

	assert.deepEqual(
		latest.map(({ type }) => type),
		["thinking", "output"],
	);
	assert.deepEqual(
		latest.map(({ age }) => age),
		["1s ago", "1s ago"],
	);
});

test("live tool events merge with persisted session entries without duplicates", () => {
	const live = observeSessionEvent(
		{
			type: "tool_execution_start",
			toolCallId: "call-1",
			toolName: "bash",
			args: { command: "pnpm test" },
		} as AgentSessionEvent,
		now - 1_000,
	);
	const history = entry("tool-call", 2_000, {
		role: "assistant",
		content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "pnpm test" } }],
	});
	const latest = latestObservableActivity([history], live, now);
	assert.equal(latest.length, 1);
	assert.deepEqual(latest[0], {
		age: "1s ago",
		type: "tool_call",
		tool: "bash",
		input: '{"command":"pnpm test"}',
	});
});

test("relative age uses concise second, minute, hour, and day units", () => {
	assert.equal(relativeAge(now - 1_000, now), "1s ago");
	assert.equal(relativeAge(now - 14_000, now), "14s ago");
	assert.equal(relativeAge(now - 2 * 60_000, now), "2m ago");
	assert.equal(relativeAge(now - 3 * 60 * 60_000, now), "3h ago");
	assert.equal(relativeAge(now - 2 * 24 * 60 * 60_000, now), "2d ago");
});
