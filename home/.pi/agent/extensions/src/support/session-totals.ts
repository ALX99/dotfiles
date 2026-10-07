import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";

export interface SessionTotals {
	readonly turns: number;
	readonly compactions: number;
	readonly totalTokens: number;
	/** Prompt tokens: fresh input plus cache reads and writes. */
	readonly readTokens: number;
	/** Generated tokens. */
	readonly writeTokens: number;
	/** Prompt tokens served from cache. */
	readonly cachedTokens: number;
}

export const EMPTY_SESSION_TOTALS: SessionTotals = {
	turns: 0,
	compactions: 0,
	totalTokens: 0,
	readTokens: 0,
	writeTokens: 0,
	cachedTokens: 0,
};

function addUsage(totals: SessionTotals, usage: Usage): SessionTotals {
	return {
		...totals,
		totalTokens: totals.totalTokens + usage.totalTokens,
		readTokens: totals.readTokens + usage.input + usage.cacheRead + usage.cacheWrite,
		writeTokens: totals.writeTokens + usage.output,
		cachedTokens: totals.cachedTokens + usage.cacheRead,
	};
}

/** Account for an assistant reply unless it failed; an aborted reply still counts. */
export function accountAssistantMessage(
	totals: SessionTotals,
	message: Pick<AssistantMessage, "stopReason" | "usage">,
): SessionTotals {
	// Auto-retry removes failed attempts from agent state but keeps them in the
	// session file, so count only completed responses.
	if (message.stopReason === "error") return totals;
	return { ...addUsage(totals, message.usage), turns: totals.turns + 1 };
}

function accountEntry(totals: SessionTotals, entry: SessionEntry): SessionTotals {
	if (entry.type === "message" && entry.message.role === "assistant") {
		return accountAssistantMessage(totals, entry.message);
	}
	if (entry.type !== "compaction" && entry.type !== "branch_summary") return totals;

	return {
		...(entry.usage ? addUsage(totals, entry.usage) : totals),
		compactions: totals.compactions + 1,
	};
}

/**
 * Counts assistant replies and compaction events across all recorded entries.
 * Summarized branches and their recorded summary-generation usage still count.
 */
export function sessionTotals(entries: readonly SessionEntry[]): SessionTotals {
	let totals = EMPTY_SESSION_TOTALS;
	for (const entry of entries) totals = accountEntry(totals, entry);
	return totals;
}
