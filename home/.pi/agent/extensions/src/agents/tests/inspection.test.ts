import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSessionEvent, SessionEntry } from "@earendil-works/pi-coding-agent";

import {
	appendLiveActivity,
	createAgentActivityRefreshThrottle,
	inspectAgentRecord,
	latestActivityTimestamp,
	latestObservableActivity,
	observeSessionEvent,
	projectAgentFooterRows,
	relativeAge,
} from "../inspection.ts";

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

test("inspection returns only the newest useful event and skips thinking and session events", () => {
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
	assert.deepEqual(latest, [
		{
			age: "5s ago",
			type: "tool_result",
			tool: "read",
			content: "Found the handler.",
		},
	]);
	assert.equal(latest.length, 1);
	assert.equal(
		latest.some((event) => "content" in event && event.content.includes("private hidden reasoning")),
		false,
	);
});

test("inspection chooses the last source-ordered useful event when timestamps tie", () => {
	const message = {
		role: "assistant",
		timestamp: now - 1_000,
		content: [
			{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "src/route.ts" } },
			{ type: "text", text: "The final assistant block." },
		],
	};
	const expected = [{ age: "1s ago", type: "output", content: "The final assistant block." }];

	assert.deepEqual(latestObservableActivity([entry("assistant", 1_000, message)], [], now), expected);

	const live = appendLiveActivity(
		[],
		observeSessionEvent({ type: "message_update", message } as AgentSessionEvent, now - 1_000),
	);
	assert.deepEqual(latestObservableActivity([], live, now), expected);
});

test("inspection shows the child's actual ask_parent request while waiting", () => {
	const parentRequest = entry("parent-request", 2_000, {
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: "ask-1",
				name: "ask_parent",
				arguments: { message: "Which database?", options: ["SQLite", "Postgres"] },
			},
		],
	});
	const newerUserEvent = entry("user-event", 1_000, { role: "user", content: "Waiting for your answer." });

	assert.deepEqual(latestObservableActivity([parentRequest, newerUserEvent], [], now), [
		{
			age: "2s ago",
			type: "ask_parent",
			message: "Which database?",
			options: ["SQLite", "Postgres"],
		},
	]);
});

test("settled inspection projects the child's ordinary final handoff output", () => {
	const handoff =
		"Summary: Implemented inspection.\nFiles: inspection.ts.\nChecks: Focused tests passed.\nBlockers: None.";
	const settled = inspectAgentRecord(
		{ id: "engineer-agent-1", profile: { name: "engineer" }, status: "settled", cwd: "/workspace" },
		[
			entry("final", 0, {
				role: "assistant",
				content: [{ type: "text", text: handoff }],
			}),
		],
		[],
		now,
	);

	assert.equal(settled.status, "settled");
	assert.deepEqual(settled.latest_events, [
		{
			age: "1s ago",
			type: "output",
			content: "Summary: Implemented inspection. Files: inspection.ts. Checks: Focused tests passed. Blockers: None.",
		},
	]);
});

test("stream updates refresh activity time, then persisted entries remain authoritative", () => {
	const message = {
		role: "assistant",
		timestamp: now - 60_000,
		content: [{ type: "text", text: "First chunk" }],
	};
	const firstUpdate = observeSessionEvent({ type: "message_update", message } as AgentSessionEvent, now - 5_000);
	const secondUpdate = observeSessionEvent(
		{
			type: "message_update",
			message: { ...message, content: [{ type: "text", text: "First chunk, then the latest chunk" }] },
		} as AgentSessionEvent,
		now - 1_000,
	);
	const merged = appendLiveActivity(firstUpdate, secondUpdate);
	assert.equal(latestActivityTimestamp([], merged), now - 1_000);
	assert.equal(latestObservableActivity([], merged, now)[0]?.age, "1s ago");

	const committed = entry("streamed", 0, {
		...message,
		content: [{ type: "text", text: "First chunk, then the latest chunk" }],
	});
	assert.equal(latestActivityTimestamp([committed], merged), now);
});

test("stream footer refreshes are throttled per child without timers", () => {
	const throttle = createAgentActivityRefreshThrottle();

	assert.equal(throttle.shouldRefresh("worker-agent-1", now), true);
	assert.equal(throttle.shouldRefresh("worker-agent-1", now + 999), false);
	assert.equal(throttle.shouldRefresh("worker-agent-1", now + 1_000), true);
	assert.equal(throttle.shouldRefresh("reviewer-agent-1", now + 1_000), true);
	throttle.reset("worker-agent-1");
	assert.equal(throttle.shouldRefresh("worker-agent-1", now + 1_001), true);
	throttle.clear();
	assert.equal(throttle.shouldRefresh("reviewer-agent-1", now + 1_001), true);
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

test("footer activity timestamps use the newest persisted or live observable activity", () => {
	const history = entry("old-output", 10_000, {
		role: "assistant",
		content: [{ type: "text", text: "Previously recorded output." }],
	});
	const live = observeSessionEvent(
		{
			type: "tool_execution_start",
			toolCallId: "active-call",
			toolName: "read",
			args: { path: "src/index.ts" },
		} as AgentSessionEvent,
		now - 1_000,
	);

	assert.equal(latestActivityTimestamp([history], live), now - 1_000);
	assert.equal(latestActivityTimestamp([], []), null);
});

test("footer projection preserves every direct child in registry order and keeps unknown context unknown", () => {
	const statuses = ["running", "waiting_parent", "settled", "interrupted", "cancelled", "error"] as const;
	const records = statuses.map((status, index) => ({
		id: `worker-agent-${index + 1}`,
		profile: {
			name: `worker-${index + 1}`,
			model: { provider: "test", id: "default" },
		},
		status,
	}));
	const rows = projectAgentFooterRows(
		records,
		new Map([
			[
				"worker-agent-1",
				{
					model: { provider: "test", id: "selected" },
					totalTokens: 1_250,
					lastActivityAt: now - 2_000,
					contextUsage: { tokens: null, percent: null, contextWindow: 80_000 },
				},
			],
			[
				"worker-agent-2",
				{
					totalTokens: 0,
					contextUsage: { tokens: 0, percent: 0, contextWindow: 80_000 },
				},
			],
		]),
	);

	assert.deepEqual(
		rows.map(({ id, status }) => [id, status]),
		records.map(({ id, status }) => [id, status]),
	);
	assert.equal(new Set(rows.map(({ id }) => id)).size, records.length);
	assert.deepEqual(rows[0], {
		id: "worker-agent-1",
		profile: "worker-1",
		status: "running",
		model: "test/selected",
		totalTokens: 1_250,
		lastActivityAt: now - 2_000,
		contextTokens: null,
		contextWindow: 80_000,
		contextPercent: null,
	});
	assert.equal(rows[1]?.totalTokens, 0);
	assert.equal(rows[1]?.contextTokens, 0);
	assert.equal(rows[1]?.contextPercent, 0);
	assert.equal(rows[2]?.totalTokens, null);
	assert.equal(rows[2]?.contextTokens, null);
	assert.equal(rows[2]?.contextWindow, null);
});
