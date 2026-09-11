import * as assert from "node:assert/strict";
import { test } from "node:test";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import {
	advertisedEntryIds,
	formatRecallDigest,
	formatSearchLog,
	hiddenSearchRecords,
	RECALL_MESSAGE_TYPE,
	SEARCH_ENTRY_TYPE,
	searchRecords,
} from "../recall.ts";

const TIMESTAMP = new Date(0).toISOString();

function searchEntry(id: string, query: string, extra: Record<string, unknown> = {}): SessionEntry {
	return {
		type: "custom",
		id,
		parentId: null,
		timestamp: TIMESTAMP,
		customType: SEARCH_ENTRY_TYPE,
		data: {
			queries: [query],
			sources: [`https://example.com/${query}`],
			openedUrls: [],
			callCount: 1,
			...extra,
		},
	} as unknown as SessionEntry;
}

function pointerEntry(id: string, entryIds: unknown): SessionEntry {
	return {
		type: "custom_message",
		id,
		parentId: null,
		timestamp: TIMESTAMP,
		customType: RECALL_MESSAGE_TYPE,
		content: "earlier searches are recoverable",
		details: { entryIds },
	} as unknown as SessionEntry;
}

function otherEntry(id: string): SessionEntry {
	return {
		type: "custom",
		id,
		parentId: null,
		timestamp: TIMESTAMP,
		customType: "something-else",
		data: {},
	} as unknown as SessionEntry;
}

test("search records are read from their custom entries and malformed ones are skipped", () => {
	const records = searchRecords([
		searchEntry("a", "first"),
		otherEntry("b"),
		{ type: "message", id: "c", parentId: null, timestamp: TIMESTAMP, message: {} } as unknown as SessionEntry,
		{
			type: "custom",
			id: "d",
			parentId: null,
			timestamp: TIMESTAMP,
			customType: SEARCH_ENTRY_TYPE,
			data: { queries: ["only queries"] },
		} as unknown as SessionEntry,
		searchEntry("e", "second"),
	]);

	assert.deepEqual(
		records.map((record) => record.entryId),
		["a", "e"],
	);
	assert.deepEqual(records[0]?.summary.queries, ["first"]);
});

test("advertised ids come from recall messages only", () => {
	const ids = advertisedEntryIds([
		pointerEntry("p1", ["a", "b"]),
		pointerEntry("p2", ["b", "c"]),
		pointerEntry("p3", "not a list"),
		otherEntry("x"),
	]);

	assert.deepEqual([...ids].toSorted(), ["a", "b", "c"]);
});

function compactionEntry(id: string, firstKeptEntryId: string): SessionEntry {
	return {
		type: "compaction",
		id,
		parentId: null,
		timestamp: TIMESTAMP,
		summary: "summary",
		firstKeptEntryId,
		tokensBefore: 100,
	} as unknown as SessionEntry;
}

test("records followed by a compaction are hidden, later ones are not", () => {
	const before = searchEntry("before", "summarized away");
	const after = searchEntry("after", "still reachable");
	const records = hiddenSearchRecords([before, compactionEntry("c1", "after"), after], new Set());

	assert.deepEqual(
		records.map((record) => record.entryId),
		["before"],
	);
});

test("a compaction that keeps the record as its first kept entry still hides it", () => {
	// Compaction can cut at a custom entry, which keeps the record in the context entry list.
	// The record is still unreachable, because a custom entry never becomes a context message.
	const record = searchEntry("kept", "kept but unreachable");
	const records = hiddenSearchRecords([record, compactionEntry("c1", "kept")], new Set());

	assert.deepEqual(
		records.map((entry) => entry.entryId),
		["kept"],
	);
});

test("records inherited from an earlier process are hidden", () => {
	const inheritedRecord = searchEntry("old", "from a resumed session");
	const freshRecord = searchEntry("new", "recorded in this process");
	const records = hiddenSearchRecords([inheritedRecord, freshRecord], new Set(["old"]));

	assert.deepEqual(
		records.map((entry) => entry.entryId),
		["old"],
	);
});

test("a session with no searches hides nothing", () => {
	assert.deepEqual(hiddenSearchRecords([otherEntry("x"), compactionEntry("c1", "x")], new Set()), []);
});

test("the log lists sources and opened urls, and filters on request", () => {
	const records = searchRecords([
		searchEntry("a", "uv latest release"),
		searchEntry("b", "mise tasks", { openedUrls: ["https://example.com/docs"], callCount: 2 }),
	]);

	const all = formatSearchLog(records);
	assert.match(all, /"uv latest release"/);
	assert.match(all, /https:\/\/example\.com\/uv latest release/);
	assert.match(all, /opened https:\/\/example\.com\/docs/);
	assert.match(all, /"mise tasks" \(2 backend searches\)/);

	const filtered = formatSearchLog(records, "opened");
	assert.match(filtered, /mise tasks/);
	assert.doesNotMatch(filtered, /uv latest release/);

	assert.match(formatSearchLog(records, "nothing matches this"), /No recorded web search matches/);
	assert.equal(formatSearchLog([]), "No web searches are recorded in this session.");
});

test("the digest carries queries and hosts but never a source URL", () => {
	const records = searchRecords([
		searchEntry("a", "uv latest release", {
			sources: [
				"https://docs.astral.sh/uv/",
				"https://github.com/astral-sh/uv",
				"https://github.com/astral-sh/uv/releases",
				"https://pypi.org/project/uv/",
			],
			callCount: 2,
		}),
	]);

	const digest = formatRecallDigest(records, true);
	assert.match(digest, /1 earlier web search recorded in this session is no longer/);
	assert.match(digest, /read the source URLs with/);
	assert.match(digest, /"uv latest release"/);
	assert.match(digest, /hosts: github\.com 2, docs\.astral\.sh 1, pypi\.org 1/);
	// The whole point: the list stays in the record rather than in the context window.
	assert.doesNotMatch(digest, /github\.com\/astral-sh\/uv/);
	assert.doesNotMatch(digest, /https:\/\//);
});

test("the digest names only read paths the model can use", () => {
	const records = searchRecords([searchEntry("a", "uv latest release")]);

	const withTool = formatRecallDigest(records, true);
	assert.match(withTool, /web_search_log tool or jq -c/);

	// Minimal mode strips the tool, so naming it would send the model after nothing.
	const withoutTool = formatRecallDigest(records, false);
	assert.doesNotMatch(withoutTool, /web_search_log tool/);
	assert.match(withoutTool, /jq -c/);
});

test("the digest bounds the host list and marks it partial", () => {
	const sources = Array.from(
		{ length: 20 },
		(_, index) => `https://host${String(index).padStart(2, "0")}.example/page`,
	);
	const records = searchRecords([searchEntry("a", "wide search", { sources })]);

	const digest = formatRecallDigest(records, true);
	assert.match(digest, /\+8 more/);
	assert.equal(digest.match(/host\d\d\.example/g)?.length, 12);
});

test("searches with no sources still report their queries", () => {
	const records = searchRecords([
		searchEntry("a", "opened only", { sources: [], openedUrls: ["https://example.com/x"] }),
	]);
	const digest = formatRecallDigest(records, true);
	assert.match(digest, /"opened only"/);
	assert.match(digest, /hosts: example\.com 1/);
});

test("the log lists sources and opened urls, and filters on request", () => {
	const records = searchRecords([
		searchEntry("a", "uv latest release"),
		searchEntry("b", "mise tasks", { openedUrls: ["https://example.com/docs"], callCount: 2 }),
	]);

	const all = formatSearchLog(records);
	assert.match(all, /"uv latest release"/);
	assert.match(all, /https:\/\/example\.com\/uv latest release/);
	assert.match(all, /opened https:\/\/example\.com\/docs/);
	assert.match(all, /"mise tasks" \(2 backend searches\)/);

	const filtered = formatSearchLog(records, "opened");
	assert.match(filtered, /mise tasks/);
	assert.doesNotMatch(filtered, /uv latest release/);

	assert.match(formatSearchLog(records, "nothing matches this"), /No recorded web search matches/);
	assert.equal(formatSearchLog([]), "No web searches are recorded in this session.");
});

test("the log lists sources and opened urls, and filters on request", () => {
	const records = searchRecords([
		searchEntry("a", "uv latest release"),
		searchEntry("b", "mise tasks", { openedUrls: ["https://example.com/docs"], callCount: 2 }),
	]);

	const all = formatSearchLog(records);
	assert.match(all, /"uv latest release"/);
	assert.match(all, /https:\/\/example\.com\/uv latest release/);
	assert.match(all, /opened https:\/\/example\.com\/docs/);
	assert.match(all, /"mise tasks" \(2 backend searches\)/);

	const filtered = formatSearchLog(records, "opened");
	assert.match(filtered, /mise tasks/);
	assert.doesNotMatch(filtered, /uv latest release/);

	assert.match(formatSearchLog(records, "nothing matches this"), /No recorded web search matches/);
	assert.equal(formatSearchLog([]), "No web searches are recorded in this session.");
});

test("the digest carries queries and hosts but never a source URL", () => {
	const records = searchRecords([
		searchEntry("a", "uv latest release", {
			sources: [
				"https://docs.astral.sh/uv/",
				"https://github.com/astral-sh/uv",
				"https://github.com/astral-sh/uv/releases",
				"https://pypi.org/project/uv/",
			],
			callCount: 2,
		}),
	]);

	const digest = formatRecallDigest(records, true);
	assert.match(digest, /1 earlier web search recorded in this session is no longer/);
	assert.match(digest, /read the source URLs with/);
	assert.match(digest, /"uv latest release"/);
	assert.match(digest, /hosts: github\.com 2, docs\.astral\.sh 1, pypi\.org 1/);
	// The whole point: the list stays in the record rather than in the context window.
	assert.doesNotMatch(digest, /github\.com\/astral-sh\/uv/);
	assert.doesNotMatch(digest, /https:\/\//);
});

test("the digest names only read paths the model can use", () => {
	const records = searchRecords([searchEntry("a", "uv latest release")]);

	const withTool = formatRecallDigest(records, true);
	assert.match(withTool, /web_search_log tool or jq -c/);

	// Minimal mode strips the tool, so naming it would send the model after nothing.
	const withoutTool = formatRecallDigest(records, false);
	assert.doesNotMatch(withoutTool, /web_search_log tool/);
	assert.match(withoutTool, /jq -c/);
});

test("the digest bounds the host list and marks it partial", () => {
	const sources = Array.from(
		{ length: 20 },
		(_, index) => `https://host${String(index).padStart(2, "0")}.example/page`,
	);
	const records = searchRecords([searchEntry("a", "wide search", { sources })]);

	const digest = formatRecallDigest(records, true);
	assert.match(digest, /\+8 more/);
	assert.equal(digest.match(/host\d\d\.example/g)?.length, 12);
});

test("searches with no sources still report their queries", () => {
	const records = searchRecords([
		searchEntry("a", "opened only", { sources: [], openedUrls: ["https://example.com/x"] }),
	]);
	const digest = formatRecallDigest(records, true);
	assert.match(digest, /"opened only"/);
	assert.match(digest, /hosts: example\.com 1/);
});

test("the log lists sources and opened urls, and filters on request", () => {
	const records = searchRecords([
		searchEntry("a", "uv latest release"),
		searchEntry("b", "mise tasks", { openedUrls: ["https://example.com/docs"], callCount: 2 }),
	]);

	const all = formatSearchLog(records);
	assert.match(all, /"uv latest release"/);
	assert.match(all, /https:\/\/example\.com\/uv latest release/);
	assert.match(all, /opened https:\/\/example\.com\/docs/);
	assert.match(all, /"mise tasks" \(2 backend searches\)/);

	const filtered = formatSearchLog(records, "opened");
	assert.match(filtered, /mise tasks/);
	assert.doesNotMatch(filtered, /uv latest release/);

	assert.match(formatSearchLog(records, "nothing matches this"), /No recorded web search matches/);
	assert.equal(formatSearchLog([]), "No web searches are recorded in this session.");
});
