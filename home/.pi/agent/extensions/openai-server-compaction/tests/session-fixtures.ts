import { parseSessionEntries, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";

/** Compact fixtures acquire the same tree metadata and entry shapes as a real session file. */
export interface BranchEntryLike {
	readonly type: string;
	readonly id: string;
	readonly message?: Message;
	readonly details?: unknown;
	readonly [key: string]: unknown;
}

export function sessionBranch(entries: readonly BranchEntryLike[]): SessionEntry[] {
	const lines = entries.map((entry, index) =>
		JSON.stringify({
			parentId: entries[index - 1]?.id ?? null,
			timestamp: "2026-10-05T00:00:00Z",
			...(entry.type === "compaction"
				? { summary: "portable checkpoint", firstKeptEntryId: entry.id, tokensBefore: 1000 }
				: {}),
			...entry,
		}),
	);
	return parseSessionEntries(lines.join("\n")).filter((entry) => entry.type !== "session");
}
