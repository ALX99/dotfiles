import assert from "node:assert/strict";
import { test } from "node:test";
import { failure } from "../../tests/fixtures.ts";
import { appendLabEvent, labBudget, labRequestBounds, requestGate } from "../state.ts";
import { config, nextAt, push, request, startedDocument, stateOf } from "./fixtures.ts";

test("requests reserve before execution and allow only one outstanding reservation", () => {
	const document = startedDocument();
	assert.equal(requestGate(stateOf(document), 512, 1001).eligible, true);
	const pending = push(document, {
		id: "request1",
		at: 1001,
		kind: "request-start",
		role: "executor",
		reservedTokens: 512,
	});
	assert.equal(labBudget(stateOf(pending)).pending.length, 1);
	assert.match(requestGate(stateOf(pending), 512, 1002).reasons.join(";"), /outstanding/);
	failure(
		appendLabEvent(pending, { id: "request2", at: 1002, kind: "request-start", role: "executor", reservedTokens: 512 }),
		/outstanding/,
	);
	failure(
		appendLabEvent(pending, {
			id: "unknown",
			at: 1002,
			kind: "request-end",
			requestId: "foreign",
			status: "completed",
			usage: { tokens: 100, costUsd: 0 },
		}),
		/outstanding reservation/,
	);
	const finished = push(pending, {
		id: "response1",
		at: 1002,
		kind: "request-end",
		requestId: "request1",
		status: "completed",
		usage: { tokens: 100, costUsd: 0.01 },
	});
	assert.deepEqual(labBudget(stateOf(finished)), {
		requests: 1,
		tokens: 100,
		reportedCostUsd: 0.01,
		pending: [],
		unreported: [],
	});
	failure(
		appendLabEvent(finished, {
			id: "response2",
			at: 1003,
			kind: "request-end",
			requestId: "request1",
			status: "completed",
			usage: { tokens: 100, costUsd: 0.01 },
		}),
		/exactly once/,
	);
});

test("reservations and reported tokens share one authoritative budget, with no silent reset on completion", () => {
	const settings = config();
	settings.limits.maxTotalTokens = 1024;
	const document = startedDocument(settings);
	for (const tokens of [0, 100, Number.NaN, 1.5])
		assert.equal(requestGate(stateOf(document), tokens, 1001).eligible, false);
	assert.equal(requestGate(stateOf(document), 1025, 1001).eligible, false);
	const paid = request(document, "executor", 800);
	assert.match(requestGate(stateOf(paid.document), 256, nextAt(paid.document)).reasons.join(";"), /remaining budget/);
	assert.equal(requestGate(stateOf(paid.document), 224, nextAt(paid.document)).eligible, false);
	assert.match(requestGate(stateOf(paid.document), 224, nextAt(paid.document)).reasons.join(";"), /configured output/);
});

test("actual usage above a reservation is retained, including cost or token overshoot, then stops further calls", () => {
	const settings = config();
	settings.limits.maxTotalTokens = 1024;
	settings.limits.maxReportedCostUsd = 1;
	for (const [tokens, costUsd, message] of [
		[1100, 0.1, /Observed token/],
		[100, 1.01, /Reported cost/],
	] as const) {
		const paid = request(startedDocument(settings), "executor", tokens, costUsd);
		assert.equal(labBudget(stateOf(paid.document)).tokens, tokens);
		assert.equal(labBudget(stateOf(paid.document)).reportedCostUsd, costUsd);
		assert.match(requestGate(stateOf(paid.document), 256, nextAt(paid.document)).reasons.join(";"), message);
	}
	const exactlySpent = request(startedDocument(settings), "executor", 100, 1);
	assert.match(
		requestGate(stateOf(exactlySpent.document), 256, nextAt(exactlySpent.document)).reasons.join(";"),
		/cost budget is exhausted/,
	);
});

test("request count is enforced before a second call even when the first reports zero cost", () => {
	const settings = config();
	settings.limits.maxRequests = 1;
	const paid = request(startedDocument(settings), "executor", 100, 0);
	assert.match(requestGate(stateOf(paid.document), 512, nextAt(paid.document)).reasons.join(";"), /request budget/);
	failure(
		appendLabEvent(paid.document, {
			id: "request2",
			at: nextAt(paid.document),
			kind: "request-start",
			role: "executor",
			reservedTokens: 512,
		}),
		/request budget/,
	);
});

test("missing usage and interrupted requests remain unknown, never become zero-cost successes, and prohibit continuation", () => {
	const pending = push(startedDocument(), {
		id: "request1",
		at: 1001,
		kind: "request-start",
		role: "executor",
		reservedTokens: 512,
	});
	failure(
		appendLabEvent(pending, {
			id: "response",
			at: 1002,
			kind: "request-end",
			requestId: "request1",
			status: "completed",
			usage: null,
		}),
		/reported usage/,
	);
	for (const status of ["failed", "cancelled"] as const) {
		const ended = push(pending, {
			id: "response",
			at: 1002,
			kind: "request-end",
			requestId: "request1",
			status,
			usage: null,
		});
		assert.deepEqual(labBudget(stateOf(ended)).unreported, ["request1"]);
		assert.match(requestGate(stateOf(ended), 512, 1003).reasons.join(";"), /unreported usage/);
		const known = push(pending, {
			id: "response",
			at: 1002,
			kind: "request-end",
			requestId: "request1",
			status,
			usage: { tokens: 100, costUsd: 0.01 },
		});
		assert.match(requestGate(stateOf(known), 512, 1003).reasons.join(";"), /failed or was interrupted/);
	}
});

test("deadlines use recorded creation time and cannot be extended by new events or backward clocks", () => {
	const settings = config();
	settings.limits.maxWallTimeMs = 10_000;
	const document = startedDocument(settings);
	assert.equal(requestGate(stateOf(document), 512, 10_999).eligible, true);
	assert.match(requestGate(stateOf(document), 512, 11_000).reasons.join(";"), /wall-time/);
	assert.match(requestGate(stateOf(document), 512, 999).reasons.join(";"), /predates/);
	assert.equal(requestGate(stateOf(document), 512, Number.NaN).eligible, false);
	const paid = request(document, "executor");
	const stopped = push(paid.document, {
		id: "stop",
		at: nextAt(paid.document),
		kind: "finished",
		status: "stopped",
		reason: "Budget was too small.",
	});
	assert.match(requestGate(stateOf(stopped), 512, nextAt(stopped)).reasons.join(";"), /finished/);
});

test("planning counts seed, research, paired development, and one final holdout independently", () => {
	assert.deepEqual(labRequestBounds(config()), { seed: 8, developmentPerCandidate: 49, holdout: 24, total: 179 });
	const settings = config();
	settings.limits.maxTurnsPerTask = 1;
	settings.limits.maxCandidates = 1;
	assert.deepEqual(labRequestBounds(settings), { seed: 4, developmentPerCandidate: 25, holdout: 12, total: 41 });
});
