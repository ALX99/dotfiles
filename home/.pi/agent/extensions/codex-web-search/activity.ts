import { Predicate } from "effect";

/** Search calls can return dozens of URLs; entries stay bounded. */
const MAX_QUERIES = 20;
const MAX_SOURCES = 40;

export interface SearchSummary {
	/** Queries the backend ran for the model. */
	readonly queries: readonly string[];
	/** URLs the backend reported as search sources. */
	readonly sources: readonly string[];
	/** URLs the model opened directly instead of searching. */
	readonly openedUrls: readonly string[];
	/** Number of `web_search_call` items in the response. */
	readonly callCount: number;
}

export type ActivityOutcome =
	| { readonly kind: "ignored" }
	| { readonly kind: "response-started" }
	| { readonly kind: "search-started" }
	| { readonly kind: "response-completed"; readonly summary: SearchSummary };

export interface ActivityTracker {
	/** Feed one decoded Codex stream frame; never throws. */
	handle(frame: unknown): ActivityOutcome;
}

/**
 * Summarize the hosted web search calls in one Codex response. Codex emits
 * `response.web_search_call.*` progress events plus `response.output_item.done` items
 * whose `action` carries the query and sources; the item is the authoritative record.
 */
export function createActivityTracker(): ActivityTracker {
	let queries: string[] = [];
	let sources: string[] = [];
	let openedUrls: string[] = [];
	let callCount = 0;

	function reset(): void {
		queries = [];
		sources = [];
		openedUrls = [];
		callCount = 0;
	}

	function recordCall(item: Record<string, unknown>): void {
		callCount += 1;
		const action = item.action;
		if (!Predicate.isObject(action)) return;
		if (action.type === "search") {
			pushUnique(queries, action.query, MAX_QUERIES);
			if (Array.isArray(action.queries)) {
				for (const query of action.queries) pushUnique(queries, query, MAX_QUERIES);
			}
			if (Array.isArray(action.sources)) {
				for (const source of action.sources) pushUnique(sources, sourceUrl(source), MAX_SOURCES);
			}
			return;
		}
		if (action.type === "open_page") pushUnique(openedUrls, action.url, MAX_SOURCES);
	}

	return {
		handle(frame: unknown): ActivityOutcome {
			if (!Predicate.isObject(frame)) return { kind: "ignored" };
			const type = typeof frame.type === "string" ? frame.type : "";
			switch (type) {
				case "response.created":
					reset();
					return { kind: "response-started" };
				case "response.web_search_call.in_progress":
				case "response.web_search_call.searching":
					return { kind: "search-started" };
				case "response.output_item.done": {
					const item = frame.item;
					if (!Predicate.isObject(item) || item.type !== "web_search_call") return { kind: "ignored" };
					recordCall(item);
					return { kind: "search-started" };
				}
				case "response.completed":
				case "response.done":
				case "response.incomplete": {
					const summary: SearchSummary = {
						queries: [...queries],
						sources: [...sources],
						openedUrls: [...openedUrls],
						callCount,
					};
					reset();
					return { kind: "response-completed", summary };
				}
				default:
					return { kind: "ignored" };
			}
		},
	};
}

function pushUnique(list: string[], value: unknown, limit: number): void {
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	if (trimmed.length === 0 || list.includes(trimmed) || list.length >= limit) return;
	list.push(trimmed);
}

function sourceUrl(source: unknown): string | undefined {
	if (typeof source === "string") return source;
	if (Predicate.isObject(source) && typeof source.url === "string") return source.url;
	return undefined;
}
