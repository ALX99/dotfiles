import assert from "node:assert/strict";
import test from "node:test";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";

import { accountAssistantMessage, EMPTY_SESSION_TOTALS, sessionTotals, type SessionTotals } from "../session-totals.ts";

interface UsageParts {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly reasoning?: number;
}

function usageWithTotal(usage: UsageParts): UsageParts & { totalTokens: number } {
	return { ...usage, totalTokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite };
}

function assistantMessage(stopReason: string, usage: UsageParts): Pick<AssistantMessage, "stopReason" | "usage"> {
	return { stopReason, usage: usageWithTotal(usage) } as Pick<AssistantMessage, "stopReason" | "usage">;
}

function assistantEntry(stopReason: string, usage: UsageParts): SessionEntry {
	return {
		type: "message",
		message: { role: "assistant", ...assistantMessage(stopReason, usage) },
	} as unknown as SessionEntry;
}

function usageEntry(type: "compaction" | "branch_summary", usage: UsageParts): SessionEntry {
	return { type, usage: usageWithTotal(usage) } as unknown as SessionEntry;
}

test("starts with empty totals and ignores entries without usage accounting", () => {
	const empty: SessionTotals = {
		turns: 0,
		compactions: 0,
		totalTokens: 0,
		readTokens: 0,
		writeTokens: 0,
		cachedTokens: 0,
	};

	assert.deepEqual(EMPTY_SESSION_TOTALS, empty);
	assert.deepEqual(sessionTotals([]), empty);
	assert.deepEqual(
		sessionTotals([
			{ type: "message", message: { role: "user" } } as unknown as SessionEntry,
			{ type: "model_change" } as unknown as SessionEntry,
			{ type: "custom" } as unknown as SessionEntry,
		]),
		empty,
	);
});

test("counts turns, compactions, and token usage across session entries", () => {
	const entries = [
		assistantEntry("stop", { input: 100, output: 200, cacheRead: 700, cacheWrite: 0, reasoning: 80 }),
		{ type: "message", message: { role: "user" } } as unknown as SessionEntry,
		assistantEntry("error", { input: 500, output: 500, cacheRead: 0, cacheWrite: 0, reasoning: 500 }),
		{ type: "model_change" } as unknown as SessionEntry,
		assistantEntry("aborted", { input: 50, output: 50, cacheRead: 150, cacheWrite: 0, reasoning: 10 }),
		usageEntry("compaction", { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 2 }),
		usageEntry("branch_summary", { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 1 }),
		{ type: "branch_summary", fromId: "x", summary: "s" } as unknown as SessionEntry,
	];

	assert.deepEqual(sessionTotals(entries), {
		turns: 2,
		compactions: 3,
		totalTokens: 1000 + 250 + 15 + 2,
		readTokens: 800 + 200 + 10 + 1,
		writeTokens: 200 + 50 + 5 + 1,
		cachedTokens: 700 + 150,
	});
});

test("incremental assistant accounting matches replay for successful and aborted replies", () => {
	const messages = [
		assistantMessage("stop", { input: 100, output: 200, cacheRead: 700, cacheWrite: 0, reasoning: 80 }),
		assistantMessage("aborted", { input: 50, output: 50, cacheRead: 150, cacheWrite: 0, reasoning: 10 }),
		assistantMessage("error", { input: 500, output: 500, cacheRead: 0, cacheWrite: 0, reasoning: 500 }),
	];
	const incremental = messages.reduce(accountAssistantMessage, EMPTY_SESSION_TOTALS);
	const replayed = sessionTotals(
		messages.map(
			(message) =>
				({
					type: "message",
					message: { role: "assistant", ...message },
				}) as unknown as SessionEntry,
		),
	);

	assert.deepEqual(incremental, replayed);
	assert.equal(incremental.turns, 2);
});
