import assert from "node:assert/strict";
import test from "node:test";
import type {
	AgentBeforeSettleEventResult,
	ExtensionAPI,
	ExtensionContext,
	SessionEntry,
	SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";

import retryEmptyResponse, {
	emptyResponseRetry,
	lastAssistantEntry,
	type EmptyResponseRetryConfig,
} from "../retry-empty-response.ts";

function assistantEntry(errorMessage: string | undefined, stopReason = "error"): SessionMessageEntry {
	return {
		type: "message",
		id: "failed",
		parentId: null,
		timestamp: "2026-09-16T00:00:00.000Z",
		message: {
			role: "assistant",
			content: [],
			stopReason,
			errorMessage,
			timestamp: Date.parse("2026-09-16T00:00:00.000Z"),
		},
	} as unknown as SessionMessageEntry;
}

function userEntry(): SessionMessageEntry {
	return {
		type: "message",
		id: "user",
		parentId: null,
		timestamp: "2026-09-16T00:00:00.000Z",
		message: { role: "user", content: "hi", timestamp: 0 },
	} as unknown as SessionMessageEntry;
}

function createHarness(options: { retry?: EmptyResponseRetryConfig; branch?: SessionEntry[] } = {}) {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => AgentBeforeSettleEventResult | undefined>();
	const branch = options.branch ?? [];
	const pi = {
		on(name: string, handler: (event: unknown, ctx: unknown) => AgentBeforeSettleEventResult | undefined) {
			handlers.set(name, handler);
		},
		getSettings: () => ({ retry: options.retry }),
	} as unknown as ExtensionAPI & { getSettings(): unknown };
	const ctx = { sessionManager: { getBranch: () => branch } } as unknown as ExtensionContext;

	retryEmptyResponse(pi);

	return {
		pi,
		ctx,
		emit: (name: string, event: unknown): AgentBeforeSettleEventResult | undefined => handlers.get(name)?.(event, ctx),
		settle: (outcome: string): AgentBeforeSettleEventResult | undefined =>
			handlers.get("agent_before_settle")?.({ type: "agent_before_settle", outcome }, ctx),
	};
}

test("selects the last assistant entry on the branch", () => {
	const user = userEntry();
	const first = assistantEntry(undefined, "stop");
	const second = assistantEntry(undefined, "stop");

	assert.equal(lastAssistantEntry([user, first, second]), second);
	assert.equal(lastAssistantEntry([user, first]), first);
	assert.equal(lastAssistantEntry([user]), undefined);
});

test("retries an errored run whose failed turn reported an empty response", () => {
	const failed = assistantEntry("Error: Provider returned an empty response");

	assert.equal(emptyResponseRetry({ outcome: "error", failed, attempts: 0, config: { enabled: true } }), failed);
});

test("matches the provider text regardless of surrounding wrapper wording", () => {
	const failed = assistantEntry("Provider returned an empty response (response.completed with no output)");

	assert.ok(emptyResponseRetry({ outcome: "error", failed, attempts: 0, config: {} }));
});

test("leaves other failures to Pi", () => {
	assert.equal(
		emptyResponseRetry({ outcome: "error", failed: assistantEntry("overloaded_error"), attempts: 0, config: {} }),
		undefined,
	);
	assert.equal(
		emptyResponseRetry({ outcome: "error", failed: assistantEntry(undefined, "aborted"), attempts: 0, config: {} }),
		undefined,
	);
	assert.equal(
		emptyResponseRetry({ outcome: "completed", failed: assistantEntry("x"), attempts: 0, config: {} }),
		undefined,
	);
	assert.equal(
		emptyResponseRetry({ outcome: "aborted", failed: assistantEntry("x"), attempts: 0, config: {} }),
		undefined,
	);
	assert.equal(emptyResponseRetry({ outcome: "error", failed: undefined, attempts: 0, config: {} }), undefined);
});

test("stops at the configured retry budget", () => {
	const failed = assistantEntry("Provider returned an empty response");
	const config = { maxRetries: 2 };

	assert.ok(emptyResponseRetry({ outcome: "error", failed, attempts: 1, config }));
	assert.equal(emptyResponseRetry({ outcome: "error", failed, attempts: 2, config }), undefined);
	// Pi's documented default applies when the setting is absent.
	assert.ok(emptyResponseRetry({ outcome: "error", failed, attempts: 2, config: undefined }));
	assert.equal(emptyResponseRetry({ outcome: "error", failed, attempts: 3, config: undefined }), undefined);
});

test("does nothing when retries are disabled", () => {
	const failed = assistantEntry("Provider returned an empty response");

	assert.equal(emptyResponseRetry({ outcome: "error", failed, attempts: 0, config: { enabled: false } }), undefined);
});

test("omits the failed turn and asks for one continuation", () => {
	const harness = createHarness({
		retry: { enabled: true, maxRetries: 1 },
		branch: [userEntry(), assistantEntry("Error: Provider returned an empty response")],
	});

	assert.deepEqual(harness.settle("error"), {
		entries: [{ type: "context_edit", targetId: "failed", replacement: null }],
		continue: true,
	});
});

test("gives each run its own budget and stops once it is spent", () => {
	const harness = createHarness({
		retry: { enabled: true, maxRetries: 1 },
		branch: [userEntry(), assistantEntry("Provider returned an empty response")],
	});

	assert.ok(harness.settle("error")?.continue);
	assert.equal(harness.settle("error"), undefined);

	harness.emit("agent_settled", {});
	assert.ok(harness.settle("error")?.continue);
});

test("lets a completed run settle untouched", () => {
	const harness = createHarness({ branch: [userEntry(), assistantEntry("Provider returned an empty response")] });

	assert.equal(harness.settle("completed"), undefined);
});
