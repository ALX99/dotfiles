import * as assert from "node:assert/strict";
import { test } from "node:test";

import { createActivityTracker } from "../activity.ts";

function frame(type: string, extra: Record<string, unknown> = {}): unknown {
	return { type, ...extra };
}

function webSearchItem(action: Record<string, unknown>): Record<string, unknown> {
	return { type: "web_search_call", id: "ws_1", status: "completed", action };
}

test("a search response produces a summary of queries, sources, and opened pages", () => {
	const tracker = createActivityTracker();
	assert.deepEqual(tracker.handle(frame("response.created")), { kind: "response-started" });
	assert.deepEqual(tracker.handle(frame("response.web_search_call.in_progress")), { kind: "search-started" });

	assert.deepEqual(
		tracker.handle(
			frame("response.output_item.done", {
				item: webSearchItem({
					type: "search",
					query: "uv latest release",
					queries: ["uv latest release", "astral uv changelog"],
					sources: [
						{ type: "url", url: "https://pypi.org/project/uv/" },
						{ type: "url", url: "https://github.com/astral-sh/uv" },
					],
				}),
			}),
		),
		{ kind: "search-started" },
	);
	assert.deepEqual(
		tracker.handle(
			frame("response.output_item.done", {
				item: webSearchItem({
					type: "search",
					queries: ["astral uv changelog"],
					sources: [{ type: "url", url: "https://pypi.org/project/uv/" }],
				}),
			}),
		),
		{ kind: "search-started" },
	);
	tracker.handle(
		frame("response.output_item.done", {
			item: webSearchItem({ type: "open_page", url: "https://pypi.org/project/uv/" }),
		}),
	);

	assert.deepEqual(tracker.handle(frame("response.completed")), {
		kind: "response-completed",
		summary: {
			queries: ["uv latest release", "astral uv changelog"],
			sources: ["https://pypi.org/project/uv/", "https://github.com/astral-sh/uv"],
			openedUrls: ["https://pypi.org/project/uv/"],
			callCount: 3,
		},
	});
});

test("progress events alone do not create a summary", () => {
	const tracker = createActivityTracker();
	tracker.handle(frame("response.created"));
	tracker.handle(frame("response.web_search_call.searching"));
	assert.deepEqual(tracker.handle(frame("response.completed")), {
		kind: "response-completed",
		summary: { queries: [], sources: [], openedUrls: [], callCount: 0 },
	});
});

test("each response starts from a clean summary", () => {
	const tracker = createActivityTracker();
	tracker.handle(frame("response.created"));
	tracker.handle(frame("response.output_item.done", { item: webSearchItem({ type: "search", query: "first" }) }));
	tracker.handle(frame("response.completed"));

	tracker.handle(frame("response.created"));
	assert.deepEqual(tracker.handle(frame("response.completed")), {
		kind: "response-completed",
		summary: { queries: [], sources: [], openedUrls: [], callCount: 0 },
	});
});

test("unrelated frames and malformed input are ignored", () => {
	const tracker = createActivityTracker();
	assert.deepEqual(tracker.handle(undefined), { kind: "ignored" });
	assert.deepEqual(tracker.handle("nope"), { kind: "ignored" });
	assert.deepEqual(tracker.handle(frame("response.output_text.delta", { delta: "hi" })), { kind: "ignored" });
	assert.deepEqual(tracker.handle(frame("response.output_item.done", { item: { type: "message" } })), {
		kind: "ignored",
	});
});

test("sources and queries are deduplicated and bounded", () => {
	const tracker = createActivityTracker();
	tracker.handle(frame("response.created"));
	tracker.handle(
		frame("response.output_item.done", {
			item: webSearchItem({
				type: "search",
				queries: Array.from({ length: 30 }, (_value, index) => `query ${index}`),
				sources: Array.from({ length: 60 }, (_value, index) => ({ url: `https://example.com/${index}` })),
			}),
		}),
	);
	const outcome = tracker.handle(frame("response.completed"));
	assert.equal(outcome.kind, "response-completed");
	if (outcome.kind !== "response-completed") return;
	assert.equal(outcome.summary.queries.length, 20);
	assert.equal(outcome.summary.sources.length, 40);
});
