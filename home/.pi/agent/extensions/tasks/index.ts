import { StringEnum } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { isAbsolute, relative } from "node:path";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { Predicate, Result, Schema } from "effect";

const TASK_QUEUE_DETAILS_TYPE = "tasks:queue";
const TASK_OUTCOME_DETAILS_TYPE = "tasks:outcome";
const TASK_CANCEL_DETAILS_TYPE = "tasks:cancel";
const TASK_RECOVERY_MESSAGE_TYPE = "tasks:recovery";
const TASK_TOGGLE_TYPE = "tasks:toggle";
const TASK_STATUS_KEY = "tasks";

/** Shared with minimal mode so its tool restriction can keep an active queue workable. */
export const TASK_TOOL_NAMES = ["create_tasks", "finish_task"] as const;
const TASK_BOOTSTRAP_TOOL_NAMES = ["create_tasks"] as const;
const TASK_TOOL_SET = new Set<string>(TASK_TOOL_NAMES);
const TASK_OUTCOME_STATUSES = ["completed", "failed", "blocked"] as const;
const TASK_SPINNER_FRAMES = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"] as const;
const TASK_COMPACTION_MARKER = "⟳";
const MIN_TASKS = 4;
const MAX_TASKS = 100;
const MAX_ADDED_TASKS = 20;
const MAX_TASK_ORIGIN_LENGTH = 32_000;

type TaskOutcomeStatus = (typeof TASK_OUTCOME_STATUSES)[number];
type TaskCheckpoint = "rewrite" | "inline";
type TaskStatus = TaskOutcomeStatus | "pending" | "cancelled";
type TaskCounts = Record<TaskStatus, number>;

interface TaskQueueItem {
	id: string;
	title: string;
}

interface TaskQueueDetails {
	kind: typeof TASK_QUEUE_DETAILS_TYPE;
	queueId: string;
	tasks: TaskQueueItem[];
	/** Conversation context captured automatically before create_tasks was called. */
	origin: string;
}

type TaskAdditionPoint = string;

interface TaskAddedItem extends TaskQueueItem {
	/** The insertion point supplied to finish_task, defaulting to current. */
	after: TaskAdditionPoint;
}

/**
 * The only task outcome persisted by the extension. The same payload is stored
 * in the finish tool result and in the branch summary created at the boundary.
 */
interface TaskOutcome {
	kind: typeof TASK_OUTCOME_DETAILS_TYPE;
	taskId: string;
	status: TaskOutcomeStatus;
	summary: string;
	addedTasks: TaskAddedItem[];
	/** Files targeted by successful edit/write/apply_patch calls observed in this task. */
	changedFiles: string[];
	/** Whether this outcome is expected to be rewritten into a branch summary. */
	checkpoint: TaskCheckpoint;
}

interface TaskCancelledDetails {
	kind: typeof TASK_CANCEL_DETAILS_TYPE;
	queueId: string;
	reason: string;
}

interface ActiveQueue {
	queue: TaskQueueDetails;
	/** Stable boundary for the current task: the queue anchor or previous task checkpoint. */
	checkpointEntryId: string;
	outcomes: Map<string, TaskOutcome>;
	/** The interactive outcome awaiting navigation to its branch summary. */
	pendingCompaction?: TaskOutcome;
	cancelled?: TaskCancelledDetails;
}

interface TaskStatusContext {
	sessionManager: {
		getBranch(): SessionEntry[];
		buildContextEntries?: () => SessionEntry[];
	};
	mode?: string;
	ui: {
		setStatus(key: string, text: string | undefined): void;
	};
}

interface BranchContext {
	sessionManager: {
		getBranch(): SessionEntry[];
		buildContextEntries?: () => SessionEntry[];
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
	origin: boundedString(MAX_TASK_ORIGIN_LENGTH),
});

const TaskOutcomeSchema = Schema.Struct({
	kind: Schema.Literals([TASK_OUTCOME_DETAILS_TYPE]),
	taskId: requiredText(200),
	status: Schema.Literals(TASK_OUTCOME_STATUSES),
	summary: requiredText(6000),
	addedTasks: AddedTaskItemsSchema,
	changedFiles: Schema.Array(boundedString(2000)),
	checkpoint: Schema.Literals(["rewrite", "inline"]),
});

const TaskCancelledSchema = Schema.Struct({
	kind: Schema.Literals([TASK_CANCEL_DETAILS_TYPE]),
	queueId: requiredText(200),
	reason: requiredText(1000),
});

const CreateTasksParams = Type.Object(
	{
		tasks: Type.Array(
			Type.String({
				minLength: 1,
				maxLength: 200,
				description: "Outcome-oriented title for one clearly separable step",
			}),
			{
				minItems: MIN_TASKS,
				maxItems: MAX_TASKS,
				description: "At least four substantial related phases; do not pad simple work with generic steps",
			},
		),
	},
	{ additionalProperties: false },
);

const FinishTaskParams = Type.Object(
	{
		status: StringEnum(TASK_OUTCOME_STATUSES, {
			description:
				"completed when the task succeeded, failed when it could not be completed, or blocked when an external dependency prevents progress",
		}),
		summary: Type.String({
			minLength: 1,
			maxLength: 6000,
			description: "Concise outcome and continuation context required to continue correctly",
		}),
		addTasks: Type.Optional(
			Type.Array(
				Type.Object(
					{
						title: Type.String({
							minLength: 1,
							maxLength: 200,
							description: "Outcome-oriented title for newly discovered work",
						}),
						after: Type.Optional(
							Type.Union([
								Type.Literal("current"),
								Type.Literal("end"),
								Type.String({
									minLength: 1,
									maxLength: 200,
									description: "ID of an existing pending task",
								}),
							]),
						),
					},
					{ additionalProperties: false },
				),
				{
					maxItems: MAX_ADDED_TASKS,
					description:
						"Optional newly discovered tasks. Omit after to insert after the current task; use end to append or a pending task ID to insert after that task.",
				},
			),
		),
	},
	{ additionalProperties: false },
);

/** Why a task operation was refused; `message` is the text shown at the boundary. */
export const TaskQueueReason = Schema.Literals([
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
export type TaskQueueReason = Schema.Schema.Type<typeof TaskQueueReason>;

/** A refused task operation. Tool boundaries throw it; the message is user-facing. */
export class TaskQueueError extends Schema.TaggedError<TaskQueueError>()("TaskQueueError", {
	reason: TaskQueueReason,
	message: Schema.String,
}) {}

function taskError(reason: TaskQueueReason, message: string): TaskQueueError {
	return new TaskQueueError({ reason, message });
}

export default function tasksExtension(pi: ExtensionAPI): void {
	let agentActive = false;
	let printTaskFinished = false;
	let spinnerIndex = 0;
	let spinnerTimer: ReturnType<typeof setInterval> | undefined;

	const refreshStatus = (ctx: TaskStatusContext): void => {
		updateTaskStatus(ctx, agentActive, spinnerIndex);
	};

	const startSpinner = (ctx: TaskStatusContext): void => {
		if (ctx.mode !== "tui" || spinnerTimer !== undefined || !tasksEnabled(ctx)) return;
		const active = getActiveQueue(ctx);
		if (active === undefined || pendingCompaction(active) !== undefined || currentItem(active) === undefined) return;
		spinnerIndex = 0;
		spinnerTimer = setInterval(() => {
			spinnerIndex = (spinnerIndex + 1) % TASK_SPINNER_FRAMES.length;
			refreshStatus(ctx);
		}, 100);
	};

	const stopSpinner = (): void => {
		if (spinnerTimer === undefined) return;
		clearInterval(spinnerTimer);
		spinnerTimer = undefined;
	};

	pi.registerTool({
		name: "create_tasks",
		label: "Create Tasks",
		description:
			"Create a task queue for genuinely complex multi-phase work, then work the tasks in order with finish_task.",
		promptSnippet: "Create a task queue for genuinely complex multi-phase work",
		promptGuidelines: [
			"Use create_tasks rarely, only for genuinely complex work with at least four substantial, independently useful phases that need separate checkpoints. Never pad to four items or split routine reading, coding, testing, review, or verification; complete small or straightforward edits directly.",
		],
		parameters: CreateTasksParams,
		executionMode: "sequential",
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			ensureTasksEnabled(ctx);
			if (ctx.mode === "print" && printTaskFinished) {
				throw taskError(
					"print_mode",
					"The current task outcome has already been recorded. Continue with the next task.",
				);
			}
			requireIsolatedTaskCall(ctx, toolCallId, "create_tasks");
			const active = getActiveQueue(ctx);
			if (active !== undefined && (pendingCompaction(active) !== undefined || currentItem(active) !== undefined)) {
				throw taskError(
					"active_queue",
					"A task queue is already active. Finish its remaining tasks before creating another queue.",
				);
			}

			const queueId = randomUUID();
			const seen = new Set<string>();
			const tasks: TaskQueueItem[] = params.tasks.map((title) => ({
				id: uniqueTaskId(seen),
				title,
			}));
			const details: TaskQueueDetails = {
				kind: TASK_QUEUE_DETAILS_TYPE,
				queueId,
				tasks,
				origin: captureTaskOrigin(ctx, toolCallId),
			};
			activateTaskTools(pi);
			ctx.ui.setStatus(TASK_STATUS_KEY, formatTaskLabel(1, tasks.length, tasks[0]!.title, agentActive, spinnerIndex));
			return {
				content: [
					{
						type: "text",
						text: [
							`Queued ${tasks.length} tasks.`,
							...tasks.map((task, index) => `${index + 1}. ${task.id}: ${task.title}`),
							"Work them in order and call finish_task alone after each task with an outcome summary.",
						].join("\n"),
					},
				],
				details,
			};
		},
	});

	pi.registerTool({
		name: "finish_task",
		label: "Finish Task",
		description:
			"Finish the current queued task with its outcome and concise continuation context. If the work revealed additional necessary tasks, add them at precise positions in the existing queue.",
		promptSnippet: "Finish the current queued task with its outcome and summary",
		promptGuidelines: [
			"Call finish_task alone after reaching an outcome for the current task. Use completed, failed, or blocked status and a concise summary. If the work revealed additional necessary tasks, add their titles in addTasks: omit after to place them after the current task, use end to append, or use a pending task ID to place them after that task.",
		],
		parameters: FinishTaskParams,
		executionMode: "sequential",
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			ensureTasksEnabled(ctx);
			if (ctx.mode === "print" && printTaskFinished) {
				throw taskError(
					"print_mode",
					"The current task outcome has already been recorded. Continue with the next task.",
				);
			}
			requireIsolatedTaskCall(ctx, toolCallId, "finish_task");
			if (!Check(FinishTaskParams, params)) throw new Error("Invalid finish_task parameters.");
			const active = getActiveQueue(ctx);
			if (active === undefined) {
				throw taskError(
					"no_queue",
					"No task queue is active. Call create_tasks with four or more related steps first.",
				);
			}
			if (pendingCompaction(active) !== undefined)
				throw taskError("already_recorded", "The current task already has a recorded outcome.");
			const item = currentItem(active);
			if (item === undefined)
				throw taskError("no_pending_outcome", "Every queued task already has a recorded outcome.");

			if (params.summary.trim().length === 0) throw new Error("Invalid finish_task parameters.");
			const checkpoint = ctx.mode === "print" ? "inline" : "rewrite";
			const addedTasks = addedTasksForOutcome(active, params.addTasks);
			const details: TaskOutcome = {
				kind: TASK_OUTCOME_DETAILS_TYPE,
				taskId: item.id,
				status: params.status,
				summary: params.summary.trim(),
				addedTasks,
				changedFiles: changedFilesForTask(ctx, active),
				checkpoint,
			};
			if (ctx.mode === "print") printTaskFinished = true;

			const projected = projectOutcome(active, details);
			const next = currentItem(projected);
			const completedCount = finishedCount(projected);
			const taskNumber = positionOf(active, item.id);
			const total = projected.queue.tasks.length;
			ctx.ui.setStatus(
				TASK_STATUS_KEY,
				checkpoint === "rewrite"
					? `${TASK_COMPACTION_MARKER} Task ${taskNumber}/${total} · compacting`
					: `Task ${taskNumber}/${total} · recorded`,
			);
			return {
				content: [
					{
						type: "text",
						text: [
							`Task outcome recorded (${completedCount}/${total}).`,
							...(addedTasks.length === 0 ? [] : [`Added: ${addedTasks.map(formatAddedTask).join("; ")}`]),
							next === undefined ? finishQueueMessage(projected, params.status) : `Next: ${next.id}: ${next.title}.`,
						].join(" "),
					},
				],
				details,
				terminate: checkpoint === "rewrite",
			};
		},
	});

	pi.registerCommand("tasks", {
		description: "Inspect or control tasks (/tasks [status|on|off|commit|cancel <reason>]).",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const action = trimmed.toLowerCase();
			if (action === "" || action === "status") {
				showTaskStatus(ctx);
				return;
			}
			if (action === "on" || action === "off") {
				setEnabled(pi, ctx, action === "on", () => refreshStatus(ctx));
				return;
			}
			if (action.startsWith("cancel")) {
				const reason = trimmed.slice("cancel".length).trim();
				if (reason.length === 0) {
					ctx.ui.notify("Usage: /tasks cancel <reason>", "warning");
					return;
				}
				cancelQueue(pi, ctx, reason, () => refreshStatus(ctx));
				return;
			}
			if (action !== "commit") {
				ctx.ui.notify("Usage: /tasks [status|on|off|commit|cancel <reason>]", "warning");
				return;
			}

			const active = getActiveQueue(ctx);
			const finish = pendingCompaction(active);
			if (active === undefined || finish === undefined) {
				ctx.ui.notify("No completed task is waiting to compact.", "warning");
				return;
			}
			const result = await ctx.navigateTree(active.checkpointEntryId, {
				summarize: true,
				label: `task: ${titleOf(active, finish.taskId)}`,
			});
			if (result.cancelled) {
				refreshStatus(ctx);
				ctx.ui.notify("Task compaction canceled; task remains pending. Retry /tasks commit.", "warning");
				return;
			}
			refreshStatus(ctx);
			ctx.ui.notify(`Task compacted: ${titleOf(active, finish.taskId)}. Continue from its outcome.`, "info");
			const next = currentItem(active);
			if (ctx.mode !== "print") {
				scheduleContinuation(
					pi,
					next === undefined ? finalSummaryPrompt(active) : nextTaskPrompt(active, finish, next),
				);
			}
		},
	});

	pi.on("session_before_tree", (event, ctx) => {
		const active = getActiveQueue(ctx);
		const finish = pendingCompaction(active);
		if (active === undefined || finish === undefined || event.preparation.targetId !== active.checkpointEntryId)
			return undefined;
		return {
			summary: {
				summary: `${formatOutcome(active, finish)}\n\n${formatQueueProgress(active)}`,
				details: finish,
			},
			label: `task: ${titleOf(active, finish.taskId)}`,
		};
	});

	pi.on("session_compact", (event, ctx) => {
		if (event.reason === "manual") return;
		const active = getActiveQueue(ctx);
		const current = active === undefined ? undefined : currentItem(active);
		if (active === undefined || current === undefined) return;
		pi.sendMessage(
			{
				customType: TASK_RECOVERY_MESSAGE_TYPE,
				content: formatTaskRecovery(active),
				display: false,
				details: {
					queueId: active.queue.queueId,
					taskId: current.id,
					compactionEntryId: event.compactionEntry.id,
				},
			},
			{ deliverAs: "steer" },
		);
	});

	pi.on("session_start", (_event, ctx) => {
		syncTaskToolVisibility(pi, ctx);
		printTaskFinished = false;
		agentActive = false;
		stopSpinner();
		refreshStatus(ctx);
	});

	pi.on("agent_start", (_event, ctx) => {
		printTaskFinished = false;
		agentActive = true;
		startSpinner(ctx);
		refreshStatus(ctx);
	});

	pi.on("turn_end", (_event, ctx) => {
		startSpinner(ctx);
		refreshStatus(ctx);
	});

	pi.on("session_tree", (_event, ctx) => {
		refreshStatus(ctx);
	});

	pi.on("agent_settled", (_event, ctx) => {
		agentActive = false;
		stopSpinner();
		refreshStatus(ctx);
		if (ctx.mode === "print" || !tasksEnabled(ctx) || pendingCompaction(getActiveQueue(ctx)) === undefined) return;
		pi.sendUserMessage("/tasks commit", { expandPromptTemplates: true });
	});

	pi.on("session_shutdown", (_event, ctx) => {
		printTaskFinished = false;
		agentActive = false;
		stopSpinner();
		ctx.ui.setStatus(TASK_STATUS_KEY, undefined);
	});
}

function pendingCompaction(active: ActiveQueue | undefined): TaskOutcome | undefined {
	return active?.pendingCompaction;
}

function updateTaskStatus(ctx: TaskStatusContext, agentActive: boolean, spinnerIndex: number): void {
	if (!tasksEnabled(ctx)) {
		ctx.ui.setStatus(TASK_STATUS_KEY, "Tasks off");
		return;
	}

	const active = getActiveQueue(ctx);
	if (active === undefined) {
		ctx.ui.setStatus(TASK_STATUS_KEY, undefined);
		return;
	}

	const finish = pendingCompaction(active);
	if (finish !== undefined) {
		const taskNumber = positionOf(active, finish.taskId);
		ctx.ui.setStatus(
			TASK_STATUS_KEY,
			`${TASK_COMPACTION_MARKER} Task ${taskNumber}/${active.queue.tasks.length} · compacting`,
		);
		return;
	}

	const item = currentItem(active);
	if (item === undefined) {
		ctx.ui.setStatus(TASK_STATUS_KEY, formatQueueStatus(active));
		return;
	}

	ctx.ui.setStatus(
		TASK_STATUS_KEY,
		formatTaskLabel(positionOf(active, item.id), active.queue.tasks.length, item.title, agentActive, spinnerIndex),
	);
}

function formatTaskLabel(
	taskNumber: number,
	total: number,
	title: string,
	agentActive: boolean,
	spinnerIndex: number,
): string {
	const spinner = agentActive ? `${TASK_SPINNER_FRAMES[spinnerIndex % TASK_SPINNER_FRAMES.length]} ` : "";
	return `${spinner}Task ${taskNumber}/${total} · ${title}`;
}

function formatAddedTask(task: TaskAddedItem): string {
	const position =
		task.after === "current" ? "after current" : task.after === "end" ? "at the end" : `after ${task.after}`;
	return `${task.id}: ${task.title} (${position})`;
}

function addedTasksForOutcome(
	active: ActiveQueue,
	additions: readonly { title: string; after?: string }[] | undefined,
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

function currentItem(active: ActiveQueue): TaskQueueItem | undefined {
	if (active.cancelled !== undefined) return undefined;
	return active.queue.tasks.find((task) => !active.outcomes.has(task.id));
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

function projectOutcome(active: ActiveQueue, outcome: TaskOutcome): ActiveQueue {
	const tasks = insertAddedTasks(active, outcome);
	if (tasks === undefined) throw new Error("Invalid task outcome.");
	return {
		queue: {
			kind: TASK_QUEUE_DETAILS_TYPE,
			queueId: active.queue.queueId,
			tasks,
			origin: active.queue.origin,
		},
		checkpointEntryId: active.checkpointEntryId,
		outcomes: new Map([...active.outcomes, [outcome.taskId, outcome]]),
		...(active.cancelled === undefined ? {} : { cancelled: active.cancelled }),
	};
}

function finishedCount(active: ActiveQueue): number {
	return active.queue.tasks.filter((task) => active.outcomes.has(task.id)).length;
}

function positionOf(active: ActiveQueue, taskId: string): number {
	return active.queue.tasks.findIndex((task) => task.id === taskId) + 1;
}

function titleOf(active: ActiveQueue, taskId: string): string {
	const task = active.queue.tasks.find((candidate) => candidate.id === taskId);
	return task === undefined ? taskId : task.title;
}

function formatQueueStatus(active: ActiveQueue): string {
	const counts = taskCounts(active);
	if (active.cancelled !== undefined) return `! Tasks canceled · ${formatTaskCounts(counts)}`;
	if (hasTaskIssues(counts)) return `! Tasks finished with issues · ${formatTaskCounts(counts)}`;
	return `✓ Tasks ${finishedCount(active)}/${active.queue.tasks.length} complete`;
}

function finishQueueMessage(active: ActiveQueue, status: TaskOutcomeStatus): string {
	const counts = taskCounts(active);
	if (status !== "completed" || hasTaskIssues(counts)) {
		return " Queue finished with issues; the final summary must distinguish completed, failed, and blocked tasks.";
	}
	return " Queue complete.";
}

function finalSummaryPrompt(active: ActiveQueue): string {
	const counts = taskCounts(active);
	if (active.cancelled !== undefined) {
		return `The task queue was canceled (${formatTaskCounts(counts)}). Summarize completed, failed, blocked, and canceled tasks, include the cancellation reason, and do not claim the queue succeeded.`;
	}
	if (hasTaskIssues(counts)) {
		return `The task queue finished with ${formatTaskCounts(counts)}. Summarize the overall outcome for the user, clearly distinguishing completed, failed, and blocked tasks. Do not claim full success.`;
	}
	return "All queued tasks are complete. Summarize the overall outcome for the user.";
}

function nextTaskPrompt(active: ActiveQueue, outcome: TaskOutcome, next: TaskQueueItem): string {
	return `Task ${positionOf(active, outcome.taskId)} recorded as ${outcome.status}. Continue with: ${next.id}: ${next.title}.`;
}

function formatTaskRecovery(active: ActiveQueue): string {
	const current = currentItem(active);
	const currentTitle = current === undefined ? "No pending task" : `${current.id}: ${current.title}`;
	const counts = taskCounts(active);
	return [
		"Task checkpoint:",
		`Continue with the current task: ${currentTitle}.`,
		`Queue progress: ${formatTaskCounts(counts)}.`,
		"Previous task summaries remain in the conversation history.",
	].join("\n");
}

function taskCounts(active: ActiveQueue): TaskCounts {
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

function hasTaskIssues(counts: TaskCounts): boolean {
	return counts.failed > 0 || counts.blocked > 0 || counts.cancelled > 0;
}

function formatTaskCounts(counts: TaskCounts): string {
	const order: TaskStatus[] = ["completed", "failed", "blocked", "cancelled", "pending"];
	return order
		.filter((status) => counts[status] > 0)
		.map((status) => `${counts[status]} ${status}`)
		.join(", ");
}

function formatQueueProgress(active: ActiveQueue): string {
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

function formatOutcome(active: ActiveQueue, outcome: TaskOutcome): string {
	const lines = [
		`## Task: ${outcome.taskId}: ${titleOf(active, outcome.taskId)}`,
		`Status: ${outcome.status}`,
		"",
		"## Summary",
		outcome.summary,
	];
	if (outcome.addedTasks.length > 0) {
		lines.push("", "## Added tasks", ...outcome.addedTasks.map((task) => `- ${formatAddedTask(task)}`));
	}
	if (outcome.changedFiles.length > 0) {
		lines.push("", "## Observed changed files", ...outcome.changedFiles.map((path) => `- \`${path}\``));
	}
	return lines.join("\n");
}

function captureTaskOrigin(ctx: ExtensionContext, toolCallId: string): string {
	const entries =
		ctx.sessionManager.buildContextEntries === undefined
			? ctx.sessionManager.getBranch()
			: ctx.sessionManager.buildContextEntries();
	const currentIndex = entries.findIndex(
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "assistant" &&
			entry.message.content.some((block) => block.type === "toolCall" && block.id === toolCallId),
	);
	const priorEntries = currentIndex === -1 ? entries : entries.slice(0, currentIndex);
	const sections = priorEntries.flatMap((entry) => {
		const text = formatTaskOriginEntry(entry);
		return text === undefined ? [] : [text];
	});
	if (sections.length === 0) return "";
	return truncate(sections.join("\n\n"), MAX_TASK_ORIGIN_LENGTH);
}

function formatTaskOriginEntry(entry: SessionEntry): string | undefined {
	if (entry.type !== "message") return undefined;
	const message = entry.message;
	if (message.role !== "user" && message.role !== "assistant") return undefined;
	const content = message.content;
	if (typeof content !== "string" && !Array.isArray(content)) return undefined;
	const text = formatTaskOriginContent(content);
	if (text.length === 0) return undefined;
	return `${message.role === "user" ? "User" : "Agent"}: ${text}`;
}

function formatTaskOriginContent(content: string | readonly object[]): string {
	if (typeof content === "string") return compactTaskOriginText(content);
	const text = content.flatMap((block) => {
		if (!Predicate.isObject(block)) return [];
		if (block.type === "text" && typeof block.text === "string") return [block.text];
		if (block.type === "image") return ["[image]"];
		return [];
	});
	return compactTaskOriginText(text.join("\n"));
}

function compactTaskOriginText(text: string): string {
	return text
		.replace(/\r\n?/gu, "\n")
		.replace(/[ \t]+\n/gu, "\n")
		.replace(/\n{3,}/gu, "\n\n")
		.trim();
}

function changedFilesForTask(ctx: ExtensionContext, active: ActiveQueue): string[] {
	const branch = ctx.sessionManager.getBranch();
	const checkpointIndex = branch.findIndex((entry) => entry.id === active.checkpointEntryId);
	if (checkpointIndex === -1) return [];

	const mutationPaths = new Map<string, string[]>();
	const changed = new Set<string>();
	for (const entry of branch.slice(checkpointIndex + 1)) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			for (const block of entry.message.content) {
				if (block.type !== "toolCall" || !Predicate.isObject(block.arguments)) continue;
				const paths = observedMutationPaths(block.name, block.arguments, ctx.cwd);
				if (paths.length > 0) mutationPaths.set(block.id, paths);
			}
			continue;
		}

		if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.isError) continue;
		const callId = entry.message.toolCallId;
		if (typeof callId !== "string") continue;
		for (const path of mutationPaths.get(callId) ?? []) changed.add(path);
	}
	return [...changed];
}

function observedMutationPaths(toolName: string, input: Record<string, unknown>, cwd: string): string[] {
	if ((toolName === "edit" || toolName === "write") && typeof input.path === "string") {
		const path = normalizeObservedPath(input.path, cwd);
		return path === undefined ? [] : [path];
	}
	if (toolName !== "apply_patch" || typeof input.patch !== "string") return [];
	return extractPatchPaths(input.patch, cwd);
}

function extractPatchPaths(patch: string, cwd: string): string[] {
	const paths: string[] = [];
	const seen = new Set<string>();
	const addPath = (value: string): void => {
		const path = normalizeObservedPath(value, cwd);
		if (path === undefined || seen.has(path)) return;
		seen.add(path);
		paths.push(path);
	};

	for (const line of patch.split(/\r?\n/u)) {
		const match = /^\*\*\* (?:Add|Delete|Update) File: (.+)$/u.exec(line);
		if (match !== null) addPath(match[1]!);
		const move = /^\*\*\* Move to: (.+)$/u.exec(line);
		if (move !== null) addPath(move[1]!);
	}
	return paths;
}

function normalizeObservedPath(value: string, cwd: string): string | undefined {
	const input = value.trim();
	if (input.length === 0) return undefined;

	const normalized = input.replaceAll("\\", "/").replace(/^\.\//u, "");
	if (!isAbsolute(input)) return normalized;

	const relativePath = relative(cwd, input).replaceAll("\\", "/");
	if (relativePath.length > 0 && relativePath !== ".." && !relativePath.startsWith("../")) return relativePath;
	return normalized;
}

function formatTaskCountsForStatus(active: ActiveQueue): string {
	return formatTaskCounts(taskCounts(active));
}

function setEnabled(pi: ExtensionAPI, ctx: ExtensionCommandContext, enabled: boolean, refresh?: () => void): void {
	if (tasksEnabled(ctx) === enabled) {
		ctx.ui.notify(`Tasks are already ${enabled ? "enabled" : "disabled"}.`, "info");
		refresh?.();
		return;
	}
	pi.sendMessage(
		{
			customType: TASK_TOGGLE_TYPE,
			content: enabled ? "/tasks on" : "/tasks off",
			display: false,
			details: { enabled },
		},
		{ triggerTurn: false },
	);
	ctx.ui.notify(
		enabled ? "Tasks enabled." : "Tasks disabled. Task tools now reject calls and automatic compaction is suspended.",
		"info",
	);
	syncTaskToolVisibility(pi, ctx, enabled);
	refresh?.();
	if (!enabled) ctx.ui.setStatus(TASK_STATUS_KEY, "Tasks off");
}

function cancelQueue(pi: ExtensionAPI, ctx: ExtensionCommandContext, reason: string, refresh?: () => void): void {
	if (!tasksEnabled(ctx)) {
		ctx.ui.notify("Tasks are disabled. Use /tasks on to re-enable.", "warning");
		return;
	}
	const active = getActiveQueue(ctx);
	if (active === undefined) {
		ctx.ui.notify("No task queue is active. Call create_tasks first.", "warning");
		return;
	}
	if (active.cancelled !== undefined) {
		ctx.ui.notify("The task queue is already canceled.", "warning");
		return;
	}
	if (pendingCompaction(active) !== undefined) {
		ctx.ui.notify("A task outcome is waiting to compact. Let it finish before canceling the queue.", "warning");
		return;
	}
	if (currentItem(active) === undefined) {
		ctx.ui.notify("No pending tasks remain in the queue.", "warning");
		return;
	}
	const details: TaskCancelledDetails = {
		kind: TASK_CANCEL_DETAILS_TYPE,
		queueId: active.queue.queueId,
		reason: reason.trim(),
	};
	pi.sendMessage(
		{
			customType: TASK_CANCEL_DETAILS_TYPE,
			content: `Canceled the remaining task queue. Reason: ${details.reason}`,
			display: false,
			details,
		},
		{ triggerTurn: false },
	);
	ctx.ui.notify(`Task queue canceled. Reason: ${details.reason}`, "info");
	refresh?.();
}

function showTaskStatus(ctx: ExtensionCommandContext): void {
	if (!tasksEnabled(ctx)) {
		ctx.ui.notify("Tasks are disabled. Use /tasks on to re-enable.", "info");
		return;
	}
	const active = getActiveQueue(ctx);
	if (active === undefined) {
		ctx.ui.notify("No task queue.", "info");
		return;
	}
	const finish = pendingCompaction(active);
	if (finish !== undefined) {
		ctx.ui.notify(
			`Task outcome recorded: ${titleOf(active, finish.taskId)} (${formatTaskCountsForStatus(active)}).`,
			"info",
		);
		return;
	}
	const item = currentItem(active);
	if (item === undefined) {
		ctx.ui.notify(
			active.cancelled !== undefined
				? `Task queue canceled (${formatTaskCountsForStatus(active)}).`
				: hasTaskIssues(taskCounts(active))
					? `Task queue finished with issues (${formatTaskCountsForStatus(active)}).`
					: `Task queue complete (${finishedCount(active)}/${active.queue.tasks.length}).`,
			"info",
		);
		return;
	}
	ctx.ui.notify(
		hasTaskIssues(taskCounts(active))
			? `Task queue: ${formatTaskCountsForStatus(active)}. Current: ${item.title}`
			: `Task queue: ${finishedCount(active)}/${active.queue.tasks.length} complete. Current: ${item.title}`,
		"info",
	);
}

function ensureTasksEnabled(ctx: BranchContext): void {
	if (tasksEnabled(ctx)) return;
	throw taskError("tasks_disabled", "Tasks are disabled for this session. A user can re-enable them with /tasks on.");
}

function scheduleContinuation(pi: ExtensionAPI, text: string): void {
	setTimeout(() => {
		pi.sendUserMessage(text);
	}, 0);
}

function syncTaskToolVisibility(pi: ExtensionAPI, ctx: BranchContext, enabled = tasksEnabled(ctx)): void {
	if (!conversationStarted(ctx)) {
		applyToolVisibility(pi, enabled);
		return;
	}
	const active = getActiveQueue(ctx);
	if (enabled && active !== undefined && !queueIsClosed(active)) activateTaskTools(pi);
}

function applyToolVisibility(pi: ExtensionAPI, enabled: boolean): void {
	const desired = enabled ? TASK_BOOTSTRAP_TOOL_NAMES : [];
	const active = pi.getActiveTools();
	const next = [...new Set([...active.filter((name) => !TASK_TOOL_SET.has(name)), ...desired])];
	if (active.length === next.length && active.every((name, index) => name === next[index])) return;
	pi.setActiveTools(next);
}

/** Add the finish tool after the queue loader succeeds so Pi can defer its definition. */
function activateTaskTools(pi: ExtensionAPI): void {
	const active = pi.getActiveTools();
	const added = TASK_TOOL_NAMES.filter((name) => !active.includes(name));
	if (added.length > 0) pi.setActiveTools([...active, ...added]);
}

function tasksEnabled(ctx: BranchContext): boolean {
	for (const entry of ctx.sessionManager.getBranch().toReversed()) {
		if (entry.type !== "custom_message" || entry.customType !== TASK_TOGGLE_TYPE) continue;
		return Predicate.isObject(entry.details) && entry.details.enabled === true;
	}
	return true;
}

function conversationStarted(ctx: BranchContext): boolean {
	return ctx.sessionManager.getBranch().some((entry) => entry.type === "message");
}

function requireIsolatedTaskCall(
	ctx: BranchContext,
	toolCallId: string,
	toolName: "create_tasks" | "finish_task",
): void {
	const toolCalls = getCurrentToolCalls(ctx);
	if (toolCalls.length === 1 && toolCalls[0]?.id === toolCallId && toolCalls[0].name === toolName) return;
	throw taskError("not_isolated", `${toolName} must be the only tool call in its assistant turn.`);
}

function getCurrentToolCalls(ctx: BranchContext): Array<{ id: string; name: string }> {
	for (const entry of ctx.sessionManager.getBranch().toReversed()) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		return entry.message.content.flatMap((block) =>
			block.type === "toolCall" ? [{ id: block.id, name: block.name }] : [],
		);
	}
	return [];
}

function getActiveQueue(ctx: BranchContext): ActiveQueue | undefined {
	let active: ActiveQueue | undefined;
	let retired = false;
	for (const entry of ctx.sessionManager.getBranch()) {
		const queue = readTaskQueue(entry);
		if (queue !== undefined) {
			if (active !== undefined && !queueIsClosed(active)) continue;
			active = {
				queue,
				checkpointEntryId: entry.id,
				outcomes: new Map(),
			};
			retired = false;
			continue;
		}
		if (active === undefined) continue;

		const cancelled = readTaskCancellation(entry);
		if (cancelled !== undefined && cancelled.queueId === active.queue.queueId) {
			if (active.cancelled === undefined) active.cancelled = cancelled;
			retired = false;
			continue;
		}

		const outcome = readTaskOutcome(entry);
		if (outcome === undefined) continue;
		if (active.pendingCompaction !== undefined) {
			if (entry.type !== "branch_summary" || !sameOutcome(active.pendingCompaction, outcome)) continue;
			active.checkpointEntryId = entry.id;
			delete active.pendingCompaction;
			retired = shouldRetireQueue(active);
			continue;
		}
		if (!applyOutcome(active, outcome)) continue;
		if (entry.type === "branch_summary") {
			active.checkpointEntryId = entry.id;
			retired = shouldRetireQueue(active);
		} else if (outcome.checkpoint === "rewrite") {
			active.pendingCompaction = outcome;
		} else {
			active.checkpointEntryId = entry.id;
			retired = shouldRetireQueue(active);
		}
	}
	return retired ? undefined : active;
}

function queueIsClosed(active: ActiveQueue): boolean {
	return active.pendingCompaction === undefined && currentItem(active) === undefined;
}

function shouldRetireQueue(active: ActiveQueue): boolean {
	return active.cancelled === undefined && currentItem(active) === undefined && !hasTaskIssues(taskCounts(active));
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
		origin: active.queue.origin,
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
		left.summary === right.summary &&
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

function readTaskQueue(entry: SessionEntry): TaskQueueDetails | undefined {
	return parseTaskQueue(successfulToolResultDetails(entry));
}

function readTaskOutcome(entry: SessionEntry): TaskOutcome | undefined {
	const details = entry.type === "branch_summary" ? entry.details : successfulToolResultDetails(entry);
	return details === undefined ? undefined : parseTaskOutcome(details);
}

function readTaskCancellation(entry: SessionEntry): TaskCancelledDetails | undefined {
	if (entry.type !== "custom_message" || entry.customType !== TASK_CANCEL_DETAILS_TYPE) return undefined;
	return parseTaskCancellation(entry.details);
}

function successfulToolResultDetails(entry: SessionEntry): object | undefined {
	if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.isError) return undefined;
	return entry.message.details;
}

function parseTaskQueue(value: unknown): TaskQueueDetails | undefined {
	const decoded = Schema.decodeUnknownResult(TaskQueueSchema)(value);
	if (Result.isFailure(decoded)) return undefined;
	return {
		kind: TASK_QUEUE_DETAILS_TYPE,
		queueId: decoded.success.queueId.trim(),
		tasks: decoded.success.tasks.map((task) => ({ id: task.id.trim(), title: task.title.trim() })),
		origin: decoded.success.origin,
	};
}

function parseTaskOutcome(value: unknown): TaskOutcome | undefined {
	const decoded = Schema.decodeUnknownResult(TaskOutcomeSchema)(value);
	if (Result.isFailure(decoded)) return undefined;
	return {
		kind: TASK_OUTCOME_DETAILS_TYPE,
		taskId: decoded.success.taskId.trim(),
		status: decoded.success.status,
		summary: decoded.success.summary.trim(),
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

function truncate(value: string, maxLength: number): string {
	return value.length <= maxLength ? value : `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}
