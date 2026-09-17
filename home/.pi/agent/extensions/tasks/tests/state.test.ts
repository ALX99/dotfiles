import * as assert from "node:assert/strict";
import { test } from "node:test";

import {
	buildOutcome,
	cancelQueue,
	createQueue,
	currentItem,
	finishedCount,
	latestActive,
	pendingCompaction,
	positionOf,
	projectOutcome,
	queueIsClosed,
	replay,
	TaskQueueError,
	taskCounts,
	titleOf,
	type ActiveQueue,
	type TaskLogEntry,
	type TaskOutcome,
	type TaskQueueDetails,
} from "../state.ts";

const queueEntry = (id: string, queueId: string, titles: readonly string[]): TaskLogEntry => ({
	id,
	type: "message",
	message: {
		role: "toolResult",
		details: {
			kind: "tasks:queue",
			queueId,
			tasks: titles.map((title, index) => ({ id: `t${index + 1}`, title })),
		},
	},
});

interface OutcomeOptions {
	status?: "completed" | "failed" | "blocked";
	outcome?: string;
	addedTasks?: Array<{ id: string; title: string; after: string }>;
	changedFiles?: string[];
	checkpoint?: "rewrite" | "inline";
}

const outcomeDetails = (taskId: string, options: OutcomeOptions = {}) => ({
	kind: "tasks:outcome" as const,
	taskId,
	status: options.status ?? "completed",
	outcome: options.outcome ?? `${taskId} outcome`,
	addedTasks: options.addedTasks ?? [],
	changedFiles: options.changedFiles ?? [],
	checkpoint: options.checkpoint ?? "inline",
});

const outcomeEntry = (id: string, taskId: string, options: OutcomeOptions = {}): TaskLogEntry => ({
	id,
	type: "message",
	message: { role: "toolResult", details: outcomeDetails(taskId, options) },
});

const branchSummaryEntry = (id: string, taskId: string, options: OutcomeOptions = {}): TaskLogEntry => ({
	id,
	type: "branch_summary",
	details: outcomeDetails(taskId, options),
});

const cancelEntry = (id: string, queueId: string, reason: string): TaskLogEntry => ({
	id,
	type: "custom_message",
	customType: "tasks:cancel",
	details: { kind: "tasks:cancel", queueId, reason },
});

const persistedQueue = (id: string, queue: TaskQueueDetails): TaskLogEntry => ({
	id,
	type: "message",
	message: { role: "toolResult", details: queue },
});

const persistedOutcome = (id: string, outcome: TaskOutcome): TaskLogEntry => ({
	id,
	type: "message",
	message: { role: "toolResult", details: outcome },
});

const stateOf = (entries: readonly TaskLogEntry[]): ActiveQueue => replay(entries).at(-1)!;

const taskIds = (active: ActiveQueue): string[] => active.queue.tasks.map((task) => task.id);

test("replay is stable across a restart", () => {
	const entries = [
		queueEntry("e1", "q1", ["One", "Two", "Three"]),
		outcomeEntry("e2", "t1", { changedFiles: ["src/a.ts"] }),
		outcomeEntry("e3", "t2", { status: "failed" }),
	];
	const restarted = replay(JSON.parse(JSON.stringify(entries)) as readonly TaskLogEntry[]);
	assert.deepEqual(replay(entries), restarted);
	assert.equal(restarted[0]?.outcomes.get("t2")?.status, "failed");
});

test("replay reconstructs the state a live projection produced", () => {
	const base = queueEntry("e1", "q1", ["One", "Two", "Three"]);
	const live = stateOf([base]);
	const outcome = buildOutcome(live, {
		status: "completed",
		outcome: "  One is done.  ",
		additions: [{ title: "Follow-up" }],
		changedFiles: ["src/a.ts"],
		checkpoint: "inline",
	});
	const replayed = stateOf([base, persistedOutcome("e2", outcome)]);
	assert.deepEqual(replayed.queue, projectOutcome(live, outcome).queue);
	assert.deepEqual(replayed.outcomes, projectOutcome(live, outcome).outcomes);
	assert.equal(replayed.checkpointEntryId, "e2");
	assert.equal(replayed.outcomes.get("t1")?.outcome, "One is done.");
	assert.deepEqual(taskIds(replayed), ["t1", "t4", "t2", "t3"]);
});

test("assigns stable sequential task IDs", () => {
	const queue = createQueue(["One", "Two"]);
	assert.deepEqual(
		queue.tasks.map((task) => task.id),
		["t1", "t2"],
	);

	const base = persistedQueue("e1", queue);
	const live = stateOf([base]);
	const outcome = buildOutcome(live, {
		status: "completed",
		outcome: "One.",
		additions: [{ title: "Third" }, { title: "Fourth" }],
		changedFiles: [],
		checkpoint: "inline",
	});
	assert.deepEqual(taskIds(stateOf([base, persistedOutcome("e2", outcome)])), ["t1", "t3", "t4", "t2"]);
});

test("ignores outcomes that arrive out of order, twice, or for unknown tasks", () => {
	const base = queueEntry("e1", "q1", ["One", "Two", "Three"]);
	const outOfOrder = stateOf([base, outcomeEntry("e2", "t2"), outcomeEntry("e3", "t3"), outcomeEntry("e4", "t9")]);
	assert.deepEqual([...outOfOrder.outcomes.keys()], []);
	assert.equal(currentItem(outOfOrder)?.id, "t1");
	assert.equal(finishedCount(outOfOrder), 0);

	const afterFirst = stateOf([base, outcomeEntry("e2", "t2"), outcomeEntry("e3", "t1")]);
	assert.deepEqual([...afterFirst.outcomes.keys()], ["t1"]);
	assert.equal(currentItem(afterFirst)?.id, "t2");

	const duplicated = stateOf([base, outcomeEntry("e2", "t1"), outcomeEntry("e3", "t1", { outcome: "Rewritten." })]);
	assert.equal(duplicated.outcomes.size, 1);
	assert.equal(duplicated.outcomes.get("t1")?.outcome, "t1 outcome");
});

test("applies an outcome only once its preconditions hold", () => {
	const pending = stateOf([
		queueEntry("e1", "q1", ["One", "Two"]),
		outcomeEntry("e2", "t1", { checkpoint: "rewrite" }),
	]);
	assert.throws(
		() => buildOutcome(pending, { status: "completed", outcome: "Again.", changedFiles: [], checkpoint: "inline" }),
		(error) => error instanceof TaskQueueError && error.reason === "already_recorded",
	);

	const finished = stateOf([
		queueEntry("e1", "q1", ["One", "Two"]),
		outcomeEntry("e2", "t1"),
		outcomeEntry("e3", "t2"),
	]);
	assert.throws(
		() => buildOutcome(finished, { status: "completed", outcome: "Again.", changedFiles: [], checkpoint: "inline" }),
		(error) => error instanceof TaskQueueError && error.reason === "no_pending_outcome",
	);

	const cancelled = stateOf([queueEntry("e1", "q1", ["One", "Two"]), cancelEntry("e2", "q1", "stopped")]);
	assert.throws(
		() => buildOutcome(cancelled, { status: "completed", outcome: "Still.", changedFiles: [], checkpoint: "inline" }),
		(error) => error instanceof TaskQueueError && error.reason === "no_pending_outcome",
	);
});

test("rejects additions that do not resolve, without mutating state", () => {
	const live = stateOf([queueEntry("e1", "q1", ["One", "Two", "Three"]), outcomeEntry("e2", "t1")]);
	assert.throws(
		() =>
			buildOutcome(live, {
				status: "completed",
				outcome: "Two.",
				additions: [{ title: "After the unknown", after: "t9" }],
				changedFiles: [],
				checkpoint: "inline",
			}),
		(error) => error instanceof TaskQueueError && error.reason === "invalid_task",
	);
	assert.throws(
		() =>
			buildOutcome(live, {
				status: "completed",
				outcome: "Two.",
				additions: [{ title: "After a finished task", after: "t1" }],
				changedFiles: [],
				checkpoint: "inline",
			}),
		(error) => error instanceof TaskQueueError && error.reason === "invalid_task",
	);

	const projected = buildOutcome(live, {
		status: "completed",
		outcome: "Two.",
		additions: [{ title: "Depends on the later third task", after: "t3" }],
		changedFiles: [],
		checkpoint: "inline",
	});
	assert.deepEqual(taskIds(projectOutcome(live, projected)), ["t1", "t2", "t3", "t4"]);
	assert.deepEqual(taskIds(live), ["t1", "t2", "t3"]);
	assert.deepEqual([...live.outcomes.keys()], ["t1"]);
});

test("records an addition only when the whole outcome is valid", () => {
	const base = queueEntry("e1", "q1", ["One", "Two"]);
	const conflicting = stateOf([
		base,
		outcomeEntry("e2", "t1", { addedTasks: [{ id: "t2", title: "Clash", after: "end" }] }),
	]);
	assert.equal(conflicting.outcomes.size, 0);
	assert.deepEqual(taskIds(conflicting), ["t1", "t2"]);
	assert.equal(currentItem(conflicting)?.id, "t1");

	const oversized = stateOf([
		queueEntry("e1", "q1", ["One", "Two"]),
		outcomeEntry("e2", "t1", { addedTasks: [{ id: "t3", title: "Blank", after: "   " }] }),
	]);
	assert.equal(oversized.outcomes.size, 0);
	assert.deepEqual(taskIds(oversized), ["t1", "t2"]);
});

test("inserts additions deterministically relative to their anchors", () => {
	const state = stateOf([
		queueEntry("e1", "q1", ["One", "Two", "Three", "Four"]),
		outcomeEntry("e2", "t1", {
			addedTasks: [
				{ id: "t5", title: "After three (1)", after: "t3" },
				{ id: "t6", title: "After three (2)", after: "t3" },
				{ id: "t7", title: "At the end", after: "end" },
				{ id: "t8", title: "After current", after: "current" },
			],
		}),
	]);
	assert.deepEqual(taskIds(state), ["t1", "t8", "t2", "t3", "t5", "t6", "t4", "t7"]);
	assert.equal(positionOf(state, "t5"), 5);
	assert.equal(titleOf(state, "t7"), "At the end");
});

test("keeps a rewrite outcome pending until its own branch summary lands", () => {
	const base = queueEntry("e1", "q1", ["One", "Two"]);
	const recorded = outcomeEntry("e2", "t1", { checkpoint: "rewrite", outcome: "One done." });

	const pending = stateOf([base, recorded]);
	assert.equal(pending.checkpointEntryId, "e1");
	assert.equal(pendingCompaction(pending)?.taskId, "t1");
	assert.deepEqual([...pending.outcomes.keys()], ["t1"]);
	assert.equal(currentItem(pending)?.id, "t2");

	const replayedTwice = stateOf([base, recorded, recorded]);
	assert.equal(replayedTwice.checkpointEntryId, "e1");
	assert.equal(replayedTwice.outcomes.size, 1);

	const mismatched = stateOf([
		base,
		recorded,
		branchSummaryEntry("e3", "t1", { checkpoint: "rewrite", outcome: "Else." }),
	]);
	assert.equal(mismatched.checkpointEntryId, "e1");
	assert.equal(pendingCompaction(mismatched)?.outcome, "One done.");

	const matched = stateOf([
		base,
		recorded,
		branchSummaryEntry("e3", "t1", { checkpoint: "rewrite", outcome: "One done." }),
	]);
	assert.equal(matched.checkpointEntryId, "e3");
	assert.equal(pendingCompaction(matched), undefined);
	assert.equal(matched.outcomes.size, 1);
	assert.equal(currentItem(matched)?.id, "t2");

	const afterSummary = stateOf([
		base,
		recorded,
		branchSummaryEntry("e3", "t1", { checkpoint: "rewrite", outcome: "One done." }),
		branchSummaryEntry("e4", "t1", { checkpoint: "rewrite", outcome: "One done." }),
	]);
	assert.equal(afterSummary.checkpointEntryId, "e3");
	assert.equal(afterSummary.outcomes.size, 1);
});

test("cancellation stops execution and ignores later outcomes", () => {
	const state = stateOf([
		queueEntry("e1", "q1", ["One", "Two", "Three"]),
		outcomeEntry("e2", "t1"),
		cancelEntry("e3", "q1", "  no longer needed  "),
		outcomeEntry("e4", "t2"),
	]);
	assert.equal(currentItem(state), undefined);
	assert.equal(queueIsClosed(state), true);
	assert.deepEqual(taskCounts(state), { pending: 0, completed: 1, failed: 0, blocked: 0, cancelled: 2 });
	assert.equal(state.cancelled?.reason, "no longer needed");
	assert.equal(state.outcomes.size, 1);

	const stale = stateOf([queueEntry("e1", "q1", ["One", "Two"]), cancelEntry("e2", "q2", "other queue")]);
	assert.equal(stale.cancelled, undefined);

	const details = cancelQueue(state, "  cleanup  ");
	assert.equal(details.queueId, "q1");
	assert.equal(details.reason, "cleanup");
});

test("retires a cleanly finished queue but keeps one that ended with issues", () => {
	const clean = stateOf([queueEntry("e1", "q1", ["One", "Two"]), outcomeEntry("e2", "t1"), outcomeEntry("e3", "t2")]);
	assert.equal(queueIsClosed(clean), true);
	assert.equal(latestActive([clean]), undefined);

	const failed = stateOf([
		queueEntry("e1", "q1", ["One", "Two"]),
		outcomeEntry("e2", "t1", { status: "failed" }),
		outcomeEntry("e3", "t2"),
	]);
	assert.equal(queueIsClosed(failed), true);
	assert.equal(latestActive([failed]), failed);
});

test("starts a new queue only once the previous one is closed", () => {
	const ignored = replay([queueEntry("e1", "q1", ["One", "Two"]), queueEntry("e2", "q2", ["Three", "Four"])]);
	assert.deepEqual(
		ignored.map((queue) => queue.queue.queueId),
		["q1"],
	);

	const restarted = replay([
		queueEntry("e1", "q1", ["One", "Two"]),
		outcomeEntry("e2", "t1"),
		outcomeEntry("e3", "t2"),
		queueEntry("e4", "q2", ["Three", "Four"]),
	]);
	assert.deepEqual(
		restarted.map((queue) => queue.queue.queueId),
		["q1", "q2"],
	);
	assert.equal(latestActive(restarted)?.queue.queueId, "q2");
});

test("replays additions recorded as after: current", () => {
	const state = stateOf([
		queueEntry("e1", "q1", ["One", "Two"]),
		outcomeEntry("e2", "t1", { addedTasks: [{ id: "t3", title: "Legacy", after: "current" }] }),
	]);
	assert.deepEqual(taskIds(state), ["t1", "t3", "t2"]);
});

test("ignores errored tool results and unknown custom entries", () => {
	const state = stateOf([
		{ id: "e1", type: "custom", customType: "other", details: { kind: "tasks:queue", queueId: "q9" } },
		queueEntry("e2", "q1", ["One", "Two"]),
		{ id: "e3", type: "message", message: { role: "toolResult", isError: true, details: outcomeDetails("t1") } },
		{ id: "e4", type: "message", message: { role: "assistant", details: outcomeDetails("t1") } },
	]);
	assert.equal(state.outcomes.size, 0);
	assert.equal(state.queue.queueId, "q1");
});
