import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import { Predicate } from "effect";
import type { SearchSummary } from "./activity.ts";

/** Custom entry the frame observer writes for every response that searched. */
export const SEARCH_ENTRY_TYPE = "codex-web-search";

/** Custom message carrying recorded searches the model can no longer read from context. */
export const RECALL_MESSAGE_TYPE = "codex-web-search-recall";

/** The tool that reads the records back in full, activated alongside a recall message. */
export const RECALL_TOOL_NAME = "web_search_log";

/** One stored summary and the entry id that locates it. */
export interface SearchRecord {
	readonly entryId: string;
	readonly summary: SearchSummary;
}

/** Every search summary on a branch, oldest first. Malformed records are skipped. */
export function searchRecords(entries: readonly SessionEntry[]): SearchRecord[] {
	const records: SearchRecord[] = [];
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== SEARCH_ENTRY_TYPE) continue;
		const summary = parseSummary(entry.data);
		if (summary !== undefined) records.push({ entryId: entry.id, summary });
	}
	return records;
}

/** Entry ids a recall message already announced on this branch. */
export function advertisedEntryIds(entries: readonly SessionEntry[]): Set<string> {
	const ids = new Set<string>();
	for (const entry of entries) {
		if (entry.type !== "custom_message" || entry.customType !== RECALL_MESSAGE_TYPE) continue;
		if (!Predicate.isObject(entry.details)) continue;
		const recorded = entry.details.entryIds;
		if (!Array.isArray(recorded)) continue;
		for (const id of recorded) {
			if (typeof id === "string") ids.add(id);
		}
	}
	return ids;
}

/**
 * Search summaries the model cannot be assumed to reach. Records land in session entries that never
 * become context messages, so their position in the context entry list says nothing about
 * reachability. What carries a search to the model is the server-side response chain: a compaction
 * rewrites the input it hangs off, and any other change to the request body makes Pi start a new
 * chain. `unreachable` collects the records lost to changes this module cannot infer from the
 * branch alone.
 */
export function hiddenSearchRecords(branch: readonly SessionEntry[], unreachable: ReadonlySet<string>): SearchRecord[] {
	const records = searchRecords(branch);
	if (records.length === 0) return [];
	const positions = new Map(branch.map((entry, index) => [entry.id, index]));
	const lastCompaction = branch.findLastIndex((entry) => entry.type === "compaction");
	return records.filter((record) => {
		if (unreachable.has(record.entryId)) return true;
		if (lastCompaction < 0) return false;
		const position = positions.get(record.entryId);
		return position !== undefined && position < lastCompaction;
	});
}

/** The read path that works under minimal mode, where the tool is not in the selection. */
const SESSION_FILE_COMMAND = `jq -c 'select(.type=="custom" and .customType=="${SEARCH_ENTRY_TYPE}")' "$PI_SESSION_FILE"`;

/**
 * Source hosts carried per record before the message declares the host list partial.
 */
const MAX_DIGEST_HOSTS = 12;

/**
 * A manifest of the recorded searches, never their source URLs.
 *
 * A search runs inside the model turn, so Pi never writes its sources to the transcript; the only
 * thing that carried them was the server-side response chain, and that chain does not survive a
 * compaction or any other change to the request body. Sending the URLs themselves works but is
 * bulky and mostly noise — one search returned 40 sources, most irrelevant — and a model handed a
 * partial list can still answer "no such URL" about the part it cannot see.
 *
 * Queries and hosts are small, cannot be mistaken for the full list, and settle the question that
 * was answered wrongly without them: whether a search ever mentioned a given host. The URLs stay in
 * the record, so the model reads them only when a task actually needs one.
 */
export function formatRecallDigest(records: readonly SearchRecord[], toolActive: boolean): string {
	const searches = `${records.length} earlier web ${records.length === 1 ? "search" : "searches"}`;
	const verb = records.length === 1 ? "is" : "are";
	const read = toolActive ? `the ${RECALL_TOOL_NAME} tool or ${SESSION_FILE_COMMAND}` : SESSION_FILE_COMMAND;
	const lines = [
		`${searches} recorded in this session ${verb} no longer in this conversation. Their queries and source hosts follow; read the source URLs with ${read} before reporting what a search did or did not find.`,
	];
	for (const record of records) lines.push(...formatRecordDigest(record));
	return lines.join("\n");
}

function formatRecordDigest(record: SearchRecord): string[] {
	const { queries, sources, openedUrls, callCount } = record.summary;
	const heading = queries.length > 0 ? queries.map((query) => `"${query}"`).join(", ") : "query unrecorded";
	const counted = hostCounts([...sources, ...openedUrls]);
	const shown = counted.slice(0, MAX_DIGEST_HOSTS);
	const hidden = counted.length - shown.length;
	const total = `${countSearches(callCount)}, ${sources.length} ${sources.length === 1 ? "source" : "sources"}`;
	return [
		`- ${heading} (${total})`,
		`  hosts: ${shown.map(([host, count]) => `${host} ${count}`).join(", ")}${hidden > 0 ? `, +${hidden} more` : ""}`,
	];
}

/** Distinct source hosts with counts, most frequent first. */
function hostCounts(urls: readonly string[]): Array<[string, number]> {
	const counts = new Map<string, number>();
	for (const url of urls) {
		const host = hostOf(url);
		if (host === undefined) continue;
		counts.set(host, (counts.get(host) ?? 0) + 1);
	}
	return [...counts].toSorted(
		([leftHost, left], [rightHost, right]) => right - left || leftHost.localeCompare(rightHost),
	);
}

function hostOf(url: string): string | undefined {
	return /^https?:\/\/([^/?#]+)/i.exec(url)?.[1];
}

/** The recall tool's output: one block per recorded search, optionally filtered by text. */
export function formatSearchLog(records: readonly SearchRecord[], query?: string): string {
	if (records.length === 0) return "No web searches are recorded in this session.";
	const needle = query?.trim().toLowerCase();
	const matches =
		needle === undefined || needle.length === 0
			? records
			: records.filter((record) => formatRecord(record).toLowerCase().includes(needle));
	if (matches.length === 0) {
		return `No recorded web search matches ${JSON.stringify(query)}. ${records.length} recorded in this session.`;
	}
	return matches.map(formatRecord).join("\n");
}

function formatRecord(record: SearchRecord): string {
	const { queries, sources, openedUrls, callCount } = record.summary;
	const heading = queries.length > 0 ? queries.map((query) => `"${query}"`).join(", ") : "query unrecorded";
	const lines = [`- ${heading} (${countSearches(callCount)})`];
	for (const url of sources) lines.push(`  ${url}`);
	for (const url of openedUrls) lines.push(`  opened ${url}`);
	return lines.join("\n");
}

function countSearches(count: number): string {
	return `${count} backend ${count === 1 ? "search" : "searches"}`;
}

/** Stored summaries are read back from disk, so their shape is checked rather than trusted. */
function parseSummary(data: unknown): SearchSummary | undefined {
	if (!Predicate.isObject(data)) return undefined;
	const queries = stringArray(data.queries);
	const sources = stringArray(data.sources);
	const openedUrls = stringArray(data.openedUrls);
	if (queries === undefined || sources === undefined || openedUrls === undefined) return undefined;
	const { callCount } = data;
	if (typeof callCount !== "number" || !Number.isInteger(callCount) || callCount < 0) return undefined;
	return { queries, sources, openedUrls, callCount };
}

function stringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value.every((item) => typeof item === "string") ? [...value] : undefined;
}
