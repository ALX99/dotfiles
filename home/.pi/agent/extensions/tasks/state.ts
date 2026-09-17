import { randomUUID } from "node:crypto";
import { Result, Schema } from "effect";

import { MAX_ADDED_TASKS, MAX_TASKS, MIN_TASKS, TASK_OUTCOME_STATUSES } from "./tools.ts";

export const TASK_CANCEL_DETAILS_TYPE = "tasks:cancel";

const TASK_QUEUE_DETAILS_TYPE = "tasks:queue";
const TASK_OUTCOME_DETAILS_TYPE = "tasks:outcome";

type TaskOutcomeStatus = (typeof TASK_OUTCOME_STATUSES)[number];
export type TaskCheckpoint = "rewrite" | "inline";
type TaskStatus = TaskOutcomeStatus | "pending" | "cancelled";
export type TaskCounts = Record<TaskStatus, number>;

export interface TaskQueueItem {
	id: string;
	title: string;
}

export interface TaskQueueDetails {
	kind: typeof TASK_QUEUE_DETAILS_TYPE;
	queueId: string;
	tasks: TaskQueueItem[];
}

export interface TaskAddedItem extends TaskQueueItem {
	/** The insertion point supplied to finish_task, defaulting to current. */
	after: string;
}

/**
 * The only task outcome persisted by the extension. The same payload is stored
 * in the finish tool result and in the branch summary created at the boundary.
 */
export interface TaskOutcome {
	kind: typeof TASK_OUTCOME_DETAILS_TYPE;
	taskId: string;
	status: TaskOutcomeStatus;
	/** Durable result and context later tasks need after this task compacts. */
	outcome: string;
	addedTasks: TaskAddedItem[];
	/** Files targeted by successful edit/write/apply_patch calls observed in this task. */
	changedFiles: string[];
	/** Whether this outcome is expected to be rewritten into a branch summary. */
	checkpoint: TaskCheckpoint;
}

export interface TaskCancelledDetails {
	kind: typeof TASK_CANCEL_DETAILS_TYPE;
	queueId: string;
	reason: string;
}

export interface ActiveQueue {
	queue: TaskQueueDetails;
	/** Stable boundary for the current task: the queue anchor or previous task checkpoint. */
	checkpointEntryId: string;
	outcomes: Map<string, TaskOutcome>;
	/** The interactive outcome awaiting navigation to its branch summary. */
	pendingCompaction?: TaskOutcome;
	cancelled?: TaskCancelledDetails;
}

/**
 * The slice of a session log entry that replay reads. Pi's `SessionEntry` and
 * plain test fixtures both satisfy it, so this module stays free of Pi APIs.
 */
export interface TaskLogEntry {
	readonly id: string;
	readonly type: string;
	readonly customType?: string;
	readonly details?: unknown;
	readonly message?: {
		readonly role?: string;
		readonly isError?: boolean;
		readonly details?: unknown;
	};
}

const boundedString = (maxLength: number) =>
	Schema.String.check(
		Schema.makeFilter((value: string) =>
			value.length <= maxLength ? undefined : `must be at most ${maxLength} characters`,
		),
	);

const requiredText = (maxLength: number) =>
	boundedString(maxLength).check(
		Schema.isMinLength(1),
		Schema.makeFilter((value: string) => (value.trim().length > 0 ? undefined : "must not be blank")),
	);

const TaskQueueItemSchema = Schema.Struct({
	id: requiredText(200),
	title: requiredText(200),
});

const TaskQueueItemsSchema = Schema.Array(TaskQueueItemSchema).check(
	Schema.isMinLength(MIN_TASKS),
	Schema.makeFilter((tasks) =>
		tasks.length <= MAX_TASKS && new Set(tasks.map((task) => task.id)).size === tasks.length
			? undefined
			: `must contain between ${MIN_TASKS} and ${MAX_TASKS} unique tasks`,
	),
);

const TaskAddedItemSchema = Schema.Struct({
	id: requiredText(200),
	title: requiredText(200),
	after: requiredText(200),
});

const AddedTaskItemsSchema = Schema.Array(TaskAddedItemSchema).check(
	Schema.makeFilter((tasks) =>
		tasks.length <= MAX_ADDED_TASKS && new Set(tasks.map((task) => task.id)).size === tasks.length
			? undefined
			: `must contain at most ${MAX_ADDED_TASKS} unique added tasks`,
	),
);

const TaskQueueSchema = Schema.Struct({
	kind: Schema.Literals([TASK_QUEUE_DETAILS_TYPE]),
	queueId: requiredText(200),
	tasks: TaskQueueItemsSchema,
});

const TaskOutcomeSchema = Schema.Struct({
	kind: Schema.Literals([TASK_OUTCOME_DETAILS_TYPE]),
	taskId: requiredText(200),
	status: Schema.Literals(TASK_OUTCOME_STATUSES),
	outcome: requiredText(6000),
	addedTasks: AddedTaskItemsSchema,
	changedFiles: Schema.Array(boundedString(2000)),
	checkpoint: Schema.Literals(["rewrite", "inline"]),
});

const TaskCancelledSchema = Schema.Struct({
	kind: Schema.Literals([TASK_CANCEL_DETAILS_TYPE]),
	queueId: requiredText(200),
	reason: requiredText(1000),
});

/** Why a task operation was refused; `message` is the text shown at the boundary. */
const TaskQueueReason = Schema.Literals([
	"cancelled",
	"finished",
	"capacity",
	"invalid_task",
	"print_mode",
	"active_queue",
	"no_queue",
	"pending_compaction",
	"already_recorded",
	"no_pending_outcome",
	"tasks_disabled",
	"not_isolated",
]);
type TaskQueueReason = Schema.Schema.Type<typeof TaskQueueReason>;

/** A refused task operation. Tool boundaries throw it; the message is user-facing. */
export class TaskQueueError extends Schema.TaggedError<TaskQueueError>()("TaskQueueError", {
	reason: TaskQueueReason,
	message: Schema.String,
}) {}

export function taskError(reason: TaskQueueReason, message: string): TaskQueueError {
	return new TaskQueueError({ reason, message });
}

/** Replay the same validated outcomes for execution and read-only history on a branch. */
export function replay(entries: readonly TaskLogEntry[]): ActiveQueue[] {
	const queues: ActiveQueue[] = [];
	let active: ActiveQueue | undefined;
	for (const entry of entries) {
		const queue = readTaskQueue(entry);
		if (queue !== undefined) {
			if (active !== undefined && !queueIsClosed(active)) continue;
			active = {
				queue,
				checkpointEntryId: entry.id,
				outcomes: new Map(),
			};
			queues.push(active);
			continue;
		}
		if (active === undefined) continue;

		const cancelled = readTaskCancellation(entry);
		if (cancelled !== undefined && cancelled.queueId === active.queue.queueId) {
			if (active.cancelled === undefined) active.cancelled = cancelled;
			continue;
		}

		const outcome = readTaskOutcome(entry);
		if (outcome === undefined) continue;
		if (active.pendingCompaction !== undefined) {
			if (entry.type !== "branch_summary" || !sameOutcome(active.pendingCompaction, outcome)) continue;
			active.checkpointEntryId = entry.id;
			delete active.pendingCompaction;
			continue;
		}
		if (!applyOutcome(active, outcome)) continue;
		if (entry.type === "branch_summary") {
			active.checkpointEntryId = entry.id;
		} else if (outcome.checkpoint === "rewrite") {
			active.pendingCompaction = outcome;
		} else {
			active.checkpointEntryId = entry.id;
		}
	}
	return queues;
}

/** The queue execution continues on, or nothing when the latest one is retired. */
export function latestActive(queues: readonly ActiveQueue[]): ActiveQueue | undefined {
	const latest = queues.at(-1);
	return latest === undefined || (latest.pendingCompaction === undefined && shouldRetireQueue(latest))
		? undefined
		: latest;
}

/** Build a new queue, assigning the stable task IDs that outcomes refer to. */
export function createQueue(titles: readonly string[]): TaskQueueDetails {
	const seen = new Set<string>();
	return {
		kind: TASK_QUEUE_DETAILS_TYPE,
		queueId: randomUUID(),
		tasks: titles.map((title) => ({ id: uniqueTaskId(seen), title })),
	};
}

export interface TaskOutcomeInput {
	status: TaskOutcomeStatus;
	outcome: string;
	additions?: readonly { title: string; after?: string | undefined }[] | undefined;
	changedFiles: readonly string[];
	checkpoint: TaskCheckpoint;
}

/** Materialize an outcome for the current task, or refuse if none is pending. */
export function buildOutcome(active: ActiveQueue, input: TaskOutcomeInput): TaskOutcome {
	if (active.pendingCompaction !== undefined)
		throw taskError("already_recorded", "The current task already has a recorded outcome.");
	const item = currentItem(active);
	if (item === undefined) throw taskError("no_pending_outcome", "Every queued task already has a recorded outcome.");
	const outcome = input.outcome.trim();
	if (outcome.length === 0) throw new Error("Invalid finish_task parameters.");
	return {
		kind: TASK_OUTCOME_DETAILS_TYPE,
		taskId: item.id,
		status: input.status,
		outcome,
		addedTasks: addedTasksForOutcome(active, input.additions),
		changedFiles: [...input.changedFiles],
		checkpoint: input.checkpoint,
	};
}

/** The queue state an outcome would produce, without recording it. */
export function projectOutcome(active: ActiveQueue, outcome: TaskOutcome): ActiveQueue {
	const tasks = insertAddedTasks(active, outcome);
	if (tasks === undefined) throw new Error("Invalid task outcome.");
	return {
		queue: {
			kind: TASK_QUEUE_DETAILS_TYPE,
			queueId: active.queue.queueId,
			tasks,
		},
		checkpointEntryId: active.checkpointEntryId,
		outcomes: new Map([...active.outcomes, [outcome.taskId, outcome]]),
		...(active.cancelled === undefined ? {} : { cancelled: active.cancelled }),
	};
}

export function cancelQueue(active: ActiveQueue, reason: string): TaskCancelledDetails {
	return {
		kind: TASK_CANCEL_DETAILS_TYPE,
		queueId: active.queue.queueId,
		reason: reason.trim(),
	};
}

export function pendingCompaction(active: ActiveQueue | undefined): TaskOutcome | undefined {
	return active?.pendingCompaction;
}

export function currentItem(active: ActiveQueue): TaskQueueItem | undefined {
	if (active.cancelled !== undefined) return undefined;
	return active.queue.tasks.find((task) => !active.outcomes.has(task.id));
}

export function queueIsClosed(active: ActiveQueue): boolean {
	return active.pendingCompaction === undefined && currentItem(active) === undefined;
}

export function finishedCount(active: ActiveQueue): number {
	return active.queue.tasks.filter((task) => active.outcomes.has(task.id)).length;
}

export function positionOf(active: ActiveQueue, taskId: string): number {
	return active.queue.tasks.findIndex((task) => task.id === taskId) + 1;
}

export function titleOf(active: ActiveQueue, taskId: string): string {
	const task = active.queue.tasks.find((candidate) => candidate.id === taskId);
	return task === undefined ? taskId : task.title;
}

export function taskCounts(active: ActiveQueue): TaskCounts {
	const counts: TaskCounts = {
		pending: 0,
		completed: 0,
		failed: 0,
		blocked: 0,
		cancelled: 0,
	};
	for (const task of active.queue.tasks) {
		const outcome = active.outcomes.get(task.id);
		if (outcome !== undefined) counts[outcome.status] += 1;
		else if (active.cancelled !== undefined) counts.cancelled += 1;
		else counts.pending += 1;
	}
	return counts;
}

export function hasTaskIssues(counts: TaskCounts): boolean {
	return counts.failed > 0 || counts.blocked > 0 || counts.cancelled > 0;
}

export function formatTaskCounts(counts: TaskCounts): string {
	const order: TaskStatus[] = ["completed", "failed", "blocked", "cancelled", "pending"];
	return order
		.filter((status) => counts[status] > 0)
		.map((status) => `${counts[status]} ${status}`)
		.join(", ");
}

export function formatAddedTask(task: TaskAddedItem): string {
	const position =
		task.after === "current" ? "after current" : task.after === "end" ? "at the end" : `after ${task.after}`;
	return `${task.id}: ${task.title} (${position})`;
}

export function finishQueueMessage(active: ActiveQueue, status: TaskOutcomeStatus): string {
	const counts = taskCounts(active);
	if (status !== "completed" || hasTaskIssues(counts)) {
		return " Queue finished with issues; the final summary must distinguish completed, failed, and blocked tasks.";
	}
	return " Queue complete.";
}

export function finalSummaryPrompt(active: ActiveQueue): string {
	const counts = taskCounts(active);
	if (active.cancelled !== undefined) {
		return `The task queue was canceled (${formatTaskCounts(counts)}). Summarize completed, failed, blocked, and canceled tasks, include the cancellation reason, and do not claim the queue succeeded.`;
	}
	if (hasTaskIssues(counts)) {
		return `The task queue finished with ${formatTaskCounts(counts)}. Summarize the overall outcome for the user, clearly distinguishing completed, failed, and blocked tasks. Do not claim full success.`;
	}
	return "All queued tasks are complete. Summarize the overall outcome for the user.";
}

export function nextTaskPrompt(next: TaskQueueItem): string {
	return `Continue with the next task: ${next.title}.`;
}

export function formatTaskRecovery(active: ActiveQueue): string {
	const current = currentItem(active);
	const currentTitle = current === undefined ? "No pending task" : `${current.id}: ${current.title}`;
	const counts = taskCounts(active);
	return [
		"Task checkpoint:",
		`Continue with the current task: ${currentTitle}.`,
		`Queue progress: ${formatTaskCounts(counts)}.`,
		"Previous task outcomes remain in the conversation history.",
	].join("\n");
}

export function formatQueueProgress(active: ActiveQueue): string {
	const next = currentItem(active);
	if (next === undefined) {
		if (active.cancelled !== undefined) {
			return `## Queue progress\nQueue canceled: ${formatTaskCounts(taskCounts(active))}. No further tasks will run.`;
		}
		if (hasTaskIssues(taskCounts(active))) {
			return `## Queue progress\nQueue finished with issues: ${formatTaskCounts(taskCounts(active))}. Do not report the queue as fully successful; distinguish failed tasks from blocked tasks.`;
		}
		return `## Queue progress\n${finishedCount(active)}/${active.queue.tasks.length} complete. The queue is finished.`;
	}
	return `## Queue progress\n${finishedCount(active)}/${active.queue.tasks.length} complete. Continue with: ${next.id}: ${next.title}`;
}

export function formatOutcome(active: ActiveQueue, outcome: TaskOutcome): string {
	const lines = [
		`## Task: ${outcome.taskId}: ${titleOf(active, outcome.taskId)}`,
		`Status: ${outcome.status}`,
		"",
		"## Outcome",
		outcome.outcome,
	];
	if (outcome.addedTasks.length > 0) {
		lines.push("", "## Added tasks", ...outcome.addedTasks.map((task) => `- ${formatAddedTask(task)}`));
	}
	if (outcome.changedFiles.length > 0) {
		lines.push("", "## Observed changed files", ...outcome.changedFiles.map((path) => `- \`${path}\``));
	}
	return lines.join("\n");
}

function shouldRetireQueue(active: ActiveQueue): boolean {
	return active.cancelled === undefined && currentItem(active) === undefined && !hasTaskIssues(taskCounts(active));
}

function uniqueTaskId(seen: Set<string>): string {
	let next = 1;
	for (const id of seen) {
		const match = /^t([1-9]\d*)$/u.exec(id);
		if (match !== null) next = Math.max(next, Number(match[1]) + 1);
	}
	let id = `t${next}`;
	while (seen.has(id)) id = `t${++next}`;
	seen.add(id);
	return id;
}

function addedTasksForOutcome(
	active: ActiveQueue,
	additions: readonly { title: string; after?: string | undefined }[] | undefined,
): TaskAddedItem[] {
	if (additions === undefined || additions.length === 0) return [];
	if (active.queue.tasks.length + additions.length > MAX_TASKS) {
		throw taskError("capacity", `A task queue can contain at most ${MAX_TASKS} tasks.`);
	}
	const seen = new Set(active.queue.tasks.map((task) => task.id));
	return additions.map((addition) => {
		const title = addition.title.trim();
		if (title.length === 0) throw new Error("Invalid finish_task parameters.");

		const after = addition.after === undefined ? "current" : addition.after.trim();
		if (after.length === 0) throw new Error("Invalid finish_task parameters.");
		if (after !== "current" && after !== "end") {
			const target = active.queue.tasks.find((task) => task.id === after);
			if (target === undefined || active.outcomes.has(target.id)) {
				throw taskError("invalid_task", `Task ${after} is not a pending task.`);
			}
		}

		return {
			id: uniqueTaskId(seen),
			title,
			after,
		};
	});
}

function insertAddedTasks(active: ActiveQueue, outcome: TaskOutcome): TaskQueueItem[] | undefined {
	if (active.queue.tasks.length + outcome.addedTasks.length > MAX_TASKS) return undefined;

	const existingIds = new Set(active.queue.tasks.map((task) => task.id));
	for (const task of outcome.addedTasks) {
		if (existingIds.has(task.id)) return undefined;
		existingIds.add(task.id);
	}

	const tasks = active.queue.tasks.map((task) => ({ ...task }));
	const insertedAfter = new Map<string, number>();
	for (const addition of outcome.addedTasks) {
		if (addition.after === "end") {
			tasks.push({ id: addition.id, title: addition.title });
			continue;
		}

		const anchorId = addition.after === "current" ? outcome.taskId : addition.after;
		const anchor = active.queue.tasks.find((task) => task.id === anchorId);
		if (anchor === undefined || (addition.after !== "current" && active.outcomes.has(anchor.id))) return undefined;

		const anchorIndex = tasks.findIndex((task) => task.id === anchor.id);
		if (anchorIndex === -1) return undefined;
		const offset = insertedAfter.get(anchor.id) ?? 0;
		tasks.splice(anchorIndex + 1 + offset, 0, { id: addition.id, title: addition.title });
		insertedAfter.set(anchor.id, offset + 1);
	}
	return tasks;
}

function applyOutcome(active: ActiveQueue, outcome: TaskOutcome): boolean {
	if (active.cancelled !== undefined || active.outcomes.has(outcome.taskId)) return false;
	if (!active.queue.tasks.some((task) => task.id === outcome.taskId)) return false;
	if (active.queue.tasks.find((task) => !active.outcomes.has(task.id))?.id !== outcome.taskId) return false;
	const tasks = insertAddedTasks(active, outcome);
	if (tasks === undefined) return false;
	active.queue = {
		kind: TASK_QUEUE_DETAILS_TYPE,
		queueId: active.queue.queueId,
		tasks,
	};
	active.outcomes.set(outcome.taskId, {
		...outcome,
		addedTasks: outcome.addedTasks.map((task) => ({ ...task })),
		changedFiles: [...outcome.changedFiles],
	});
	return true;
}

function sameOutcome(left: TaskOutcome, right: TaskOutcome): boolean {
	return (
		left.taskId === right.taskId &&
		left.status === right.status &&
		left.outcome === right.outcome &&
		left.checkpoint === right.checkpoint &&
		sameAddedTasks(left.addedTasks, right.addedTasks) &&
		left.changedFiles.length === right.changedFiles.length &&
		left.changedFiles.every((path, index) => path === right.changedFiles[index])
	);
}

function sameAddedTasks(left: readonly TaskAddedItem[], right: readonly TaskAddedItem[]): boolean {
	return (
		left.length === right.length &&
		left.every(
			(task, index) =>
				task.id === right[index]?.id && task.title === right[index]?.title && task.after === right[index]?.after,
		)
	);
}

function readTaskQueue(entry: TaskLogEntry): TaskQueueDetails | undefined {
	return parseTaskQueue(successfulToolResultDetails(entry));
}

function readTaskOutcome(entry: TaskLogEntry): TaskOutcome | undefined {
	const details = entry.type === "branch_summary" ? entry.details : successfulToolResultDetails(entry);
	return details === undefined ? undefined : parseTaskOutcome(details);
}

function readTaskCancellation(entry: TaskLogEntry): TaskCancelledDetails | undefined {
	if (entry.type !== "custom_message" || entry.customType !== TASK_CANCEL_DETAILS_TYPE) return undefined;
	return parseTaskCancellation(entry.details);
}

function successfulToolResultDetails(entry: TaskLogEntry): unknown {
	if (entry.type !== "message" || entry.message?.role !== "toolResult" || entry.message.isError === true) {
		return undefined;
	}
	return entry.message.details;
}

function parseTaskQueue(value: unknown): TaskQueueDetails | undefined {
	const decoded = Schema.decodeUnknownResult(TaskQueueSchema)(value);
	if (Result.isFailure(decoded)) return undefined;
	return {
		kind: TASK_QUEUE_DETAILS_TYPE,
		queueId: decoded.success.queueId.trim(),
		tasks: decoded.success.tasks.map((task) => ({ id: task.id.trim(), title: task.title.trim() })),
	};
}

function parseTaskOutcome(value: unknown): TaskOutcome | undefined {
	const decoded = Schema.decodeUnknownResult(TaskOutcomeSchema)(value);
	if (Result.isFailure(decoded)) return undefined;
	return {
		kind: TASK_OUTCOME_DETAILS_TYPE,
		taskId: decoded.success.taskId.trim(),
		status: decoded.success.status,
		outcome: decoded.success.outcome.trim(),
		addedTasks: decoded.success.addedTasks.map((task) => ({
			id: task.id.trim(),
			title: task.title.trim(),
			after: task.after.trim(),
		})),
		changedFiles: decoded.success.changedFiles.map((path) => path.trim()),
		checkpoint: decoded.success.checkpoint,
	};
}

function parseTaskCancellation(value: unknown): TaskCancelledDetails | undefined {
	const decoded = Schema.decodeUnknownResult(TaskCancelledSchema)(value);
	if (Result.isFailure(decoded)) return undefined;
	return {
		kind: TASK_CANCEL_DETAILS_TYPE,
		queueId: decoded.success.queueId.trim(),
		reason: decoded.success.reason.trim(),
	};
}
