import { StringEnum } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { isAbsolute, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";

const TASK_QUEUE_DETAILS_TYPE = "tasks:queue";
const TASK_FINISH_DETAILS_TYPE = "tasks:finish";
const TASK_COMPLETION_DETAILS_TYPE = "tasks:completion";
const TASK_READ_DETAILS_TYPE = "tasks:read";
const TASK_UPDATE_DETAILS_TYPE = "tasks:update";
const TASK_TOGGLE_TYPE = "tasks:toggle";
const TASK_STATUS_KEY = "tasks";
const TASK_TOOL_NAMES = ["create_tasks", "finish_task", "read_tasks", "update_tasks"] as const;
const TASK_STATUSES = ["completed", "failed", "blocked"] as const;
const TASK_ITEM_STATES = ["pending", "skipped"] as const;
const TASK_UPDATE_ACTIONS = ["insert", "rename", "skip", "cancel"] as const;
const EVIDENCE_KINDS = ["file", "test", "commit", "finding"] as const;
const TASK_SPINNER_FRAMES = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"] as const;
const TASK_COMPACTION_MARKER = "⟳";
const TASK_READ_ALL_FILTER = "*";

type TaskStatus = (typeof TASK_STATUSES)[number];
type TaskItemState = (typeof TASK_ITEM_STATES)[number];
type TaskUpdateAction = (typeof TASK_UPDATE_ACTIONS)[number];
type TaskReadStatus = TaskStatus | TaskItemState | "cancelled";

interface TaskUpdateInput {
	action: TaskUpdateAction;
	taskId?: string;
	title?: string;
	afterTaskId?: string;
	reason?: string;
}

interface TaskQueueItem {
	id: string;
	title: string;
	state?: TaskItemState;
	skipReason?: string;
}

interface TaskQueueDetails {
	kind: typeof TASK_QUEUE_DETAILS_TYPE;
	queueId: string;
	tasks: TaskQueueItem[];
	cancelled?: boolean;
	cancelReason?: string;
}

interface TaskFinishDetails {
	kind: typeof TASK_FINISH_DETAILS_TYPE;
	taskId: string;
	status: TaskStatus;
	summary: string;
	evidence: Evidence[];
	decisions: string[];
	remaining: string[];
	/** Files targeted by successful edit/write/apply_patch calls observed in this task. */
	changedFiles: string[];
	compact: boolean;
}

interface TaskCompletionDetails extends Omit<TaskFinishDetails, "kind"> {
	kind: typeof TASK_COMPLETION_DETAILS_TYPE;
	title: string;
	/** Latest queue shape, carried through compaction so amendments survive. */
	queue?: TaskQueueDetails;
}

interface TaskUpdateDetails {
	kind: typeof TASK_UPDATE_DETAILS_TYPE;
	queueId: string;
	action: TaskUpdateAction;
	tasks: TaskQueueItem[];
	cancelled: boolean;
	taskId?: string;
	title?: string;
	afterTaskId?: string;
	reason?: string;
}

interface TaskReadItem {
	id: string;
	title: string;
	status: TaskReadStatus;
	summary?: string;
	evidence?: Evidence[];
	decisions?: string[];
	remaining?: string[];
	changedFiles?: string[];
	skipReason?: string;
}

interface TaskReadDetails {
	kind: typeof TASK_READ_DETAILS_TYPE;
	queueId?: string;
	currentTaskId?: string;
	cancelled: boolean;
	cancelReason?: string;
	tasks: TaskReadItem[];
	counts: Record<TaskReadStatus, number>;
}

interface Evidence {
	kind: (typeof EVIDENCE_KINDS)[number];
	description: string;
	path?: string;
	command?: string;
	result?: string;
	hash?: string;
}

interface ActiveQueue {
	queue: TaskQueueDetails;
	/** Entry the next compaction rewinds to: the queue anchor, or the latest recorded outcome. */
	baseEntryId: string;
	outcomes: Map<string, TaskFinishDetails>;
	/** A compaction entry appeared after baseEntryId, so the current trace is incomplete. */
	compactedSinceBase: boolean;
	/** The finish record awaiting navigation to its completion summary. */
	pendingCompaction?: TaskFinishDetails | undefined;
}

interface BranchContext {
	sessionManager: {
		getBranch(): SessionEntry[];
	};
}

interface TaskStatusContext extends BranchContext {
	mode?: string;
	ui: {
		setStatus(key: string, text: string | undefined): void;
	};
}

const CreateTasksParams = Type.Object({
	tasks: Type.Array(
		Type.Object({
			title: Type.String({
				minLength: 1,
				maxLength: 200,
				description: "Outcome-oriented title for one clearly separable step",
			}),
		}),
		{
			minItems: 4,
			maxItems: 10,
			description:
				"Four or more substantial, related phases of relatively complex work; do not pad a simple request with generic read, implement, review, or double-check steps",
		},
	),
});

const ReadTasksParams = Type.Object({
	taskId: Type.Optional(
		Type.String({
			minLength: 1,
			maxLength: 200,
			description:
				"Optional task ID to inspect in detail. Use * for an unfiltered lookup when the caller requires a value.",
		}),
	),
	path: Type.Optional(
		Type.String({
			minLength: 1,
			maxLength: 1000,
			description:
				"Optional file path to find across observed task changes. Use * for an unfiltered lookup when the caller requires a value.",
		}),
	),
});

const UpdateTasksParams = Type.Object({
	action: StringEnum(TASK_UPDATE_ACTIONS, {
		description: "insert a pending task, rename or skip a pending task, or cancel the remaining queue",
	}),
	taskId: Type.Optional(
		Type.String({
			minLength: 1,
			maxLength: 200,
			description: "Existing task ID for rename or skip",
		}),
	),
	title: Type.Optional(
		Type.String({
			minLength: 1,
			maxLength: 200,
			description: "New title for rename, or title for insert",
		}),
	),
	afterTaskId: Type.Optional(
		Type.String({
			minLength: 1,
			maxLength: 200,
			description: "Insert after this existing task; omit to append",
		}),
	),
	reason: Type.Optional(
		Type.String({
			minLength: 1,
			maxLength: 1000,
			description: "Why a task was skipped or the queue was canceled",
		}),
	),
});

const EvidenceParams = Type.Object({
	kind: StringEnum(EVIDENCE_KINDS, {
		description:
			"file for a relevant path, test for a verification command, commit for a Git commit, finding for an investigation result",
	}),
	description: Type.String({
		minLength: 1,
		maxLength: 1000,
		description: "What this evidence establishes",
	}),
	path: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
	command: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
	result: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
	hash: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
});

const FinishTaskParams = Type.Object({
	status: StringEnum(TASK_STATUSES, {
		description:
			"completed when the task succeeded, failed when it could not be completed, blocked when an external dependency prevents progress. Every status is a terminal checkpoint and advances the queue; put unresolved work in remaining",
	}),
	summary: Type.String({
		minLength: 1,
		maxLength: 6000,
		description: "Concise outcome and the critical context required to continue correctly",
	}),
	evidence: Type.Array(EvidenceParams, {
		minItems: 1,
		maxItems: 30,
		description: "Concrete files, verification commands, commits, or findings supporting the outcome",
	}),
	decisions: Type.Optional(
		Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), {
			maxItems: 20,
			description: "Decisions a later task must preserve",
		}),
	),
	remaining: Type.Optional(
		Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), {
			maxItems: 20,
			description: "Known follow-up work or unresolved constraints",
		}),
	),
	compact: Type.Optional(
		Type.Boolean({
			description:
				"Whether to replace the active task trace with its compact result. Defaults to true outside print mode; print mode records without compaction.",
		}),
	),
});

const MIN_TASKS = 4;
const MAX_TASKS = 10;
const MAX_TASK_READ_LENGTH = 12_000;

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

	// All task state lives in the session tree; every handler derives from it.
	pi.registerTool({
		name: "create_tasks",
		label: "Create Tasks",
		description:
			"Create a queue of four or more substantial, related tasks in one call. Use this sparingly and only for relatively complex work that genuinely requires at least four clear, separable phases, each likely to need meaningful investigation or implementation time and its own checkpoint. Do not pad a simple request with generic read, implement, review, test, or double-check steps. For quick, small, or straightforward work, work directly without a queue. When in doubt, do not use this tool. Finish each task with finish_task. In print mode, one task is checkpointed per invocation.",
		promptSnippet: "Create a queue only for genuinely complex work with four or more substantial phases",
		promptGuidelines: [
			"Treat create_tasks as a high-bar, infrequent tool rather than a default planning step. Use it only when the request is relatively complex and naturally decomposes into at least four substantial, independently useful phases; each phase should require meaningful investigation, implementation, or decision-making and benefit from a separate checkpoint.",
			"Do not create a queue merely to reach four items or to separate routine reading, coding, testing, review, or final verification. Generic steps such as 'read things', 'implement things', 'review things', and 'double-check' do not qualify. Small, straightforward, or short edits should be completed directly, even if they involve several actions. When in doubt, do not use create_tasks.",
		],
		parameters: CreateTasksParams,
		executionMode: "sequential",
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			ensureTasksEnabled(ctx);
			if (ctx.mode === "print" && printTaskFinished) {
				throw new Error("Print mode records one task per invocation. Resume the queue with the next invocation.");
			}
			requireIsolatedTaskCall(ctx, toolCallId, "create_tasks");
			const active = getActiveQueue(ctx);
			if (active !== undefined && (pendingCompaction(active) !== undefined || currentItem(active) !== undefined)) {
				throw new Error("A task queue is already active. Finish its remaining tasks before creating another queue.");
			}

			const queueId = randomUUID();
			const seen = new Set<string>([queueId]);
			const tasks: TaskQueueItem[] = params.tasks.map((task) => ({
				id: uniqueTaskId(seen),
				title: task.title,
			}));
			const details: TaskQueueDetails = {
				kind: TASK_QUEUE_DETAILS_TYPE,
				queueId,
				tasks,
			};
			ctx.ui.setStatus(TASK_STATUS_KEY, formatTaskLabel(1, tasks.length, tasks[0]!.title, agentActive, spinnerIndex));
			return {
				content: [
					{
						type: "text",
						text: [
							`Queued ${tasks.length} tasks.`,
							...tasks.map((task, index) => `${index + 1}. ${task.title} (${task.id})`),
							"Work them in order, and after each one call finish_task alone in its turn with an outcome summary and concrete evidence.",
						].join("\n"),
					},
				],
				details,
			};
		},
	});

	pi.registerTool({
		name: "read_tasks",
		label: "Read Tasks",
		description:
			"Read the active task queue and its recorded outcomes. Use it to check what previous tasks changed, decided, tested, or left unresolved. Optionally filter by taskId or file path.",
		promptSnippet: "Look up task progress, previous changes, decisions, and evidence",
		promptGuidelines: [
			"Use read_tasks before repeating investigation or editing a file that may have been handled by an earlier task.",
			"Use taskId for one task's full outcome or path to find tasks that observed a file change.",
		],
		parameters: ReadTasksParams,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			ensureTasksEnabled(ctx);
			const active = getActiveQueue(ctx);
			const taskId = normalizeReadFilter(params.taskId);
			const path = normalizeReadFilter(params.path);
			const details = readTasks(active, taskId, path);
			return {
				content: [{ type: "text", text: formatTaskRead(details, taskId !== undefined || path !== undefined) }],
				details,
			};
		},
	});

	pi.registerTool({
		name: "update_tasks",
		label: "Update Tasks",
		description:
			"Amend the active queue without reopening finished tasks. Insert a pending task, rename or skip a pending task, or cancel the remaining queue. Use only for small, concrete changes; call alone in its assistant turn.",
		promptSnippet: "Amend pending task titles, ordering, or cancellation",
		promptGuidelines: [
			"Use update_tasks only for a small queue amendment discovered during work. Finished tasks and their IDs are preserved.",
			"For insert, provide a title and optionally afterTaskId; omit afterTaskId to append. For rename and skip, provide taskId. Skip and cancel require a reason.",
			"Do not use update_tasks to retry or rewrite a finished task. Record follow-up work as a new pending task instead.",
		],
		parameters: UpdateTasksParams,
		executionMode: "sequential",
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			ensureTasksEnabled(ctx);
			if (ctx.mode === "print" && printTaskFinished) {
				throw new Error("Print mode records one task per invocation. Resume the queue with the next invocation.");
			}
			requireIsolatedTaskCall(ctx, toolCallId, "update_tasks");
			const active = getActiveQueue(ctx);
			if (active === undefined) throw new Error("No task queue is active. Call create_tasks first.");
			if (pendingCompaction(active) !== undefined) {
				throw new Error("A task outcome is waiting to compact. Let it finish before amending the queue.");
			}
			const update = normalizeTaskUpdate(params);
			const queue = amendQueue(active, update);
			active.queue = queue;
			const details = taskUpdateDetails(queue, update);
			refreshStatus(ctx);
			return {
				content: [{ type: "text", text: formatTaskUpdate(details, active) }],
				details,
			};
		},
	});

	pi.registerTool({
		name: "finish_task",
		label: "Finish Task",
		description:
			"Record the current queued task's outcome, critical context, and concrete evidence. Changed files are observed automatically from successful edit, write, and apply_patch calls since the previous task checkpoint; this is not attribution for arbitrary shell or external changes. Call alone in its assistant turn. By default, its working trace is compacted and the next queued task continues from the compacted record. In print mode, the checkpoint is recorded without compaction and the next invocation resumes with the next task.",
		promptSnippet: "Finish the current queued task with a summary and evidence",
		promptGuidelines: [
			"Use finish_task after completing each queued task, alone in its assistant turn. Include concrete evidence and every decision, blocker, or remaining item later tasks need. Keep compact enabled unless the task trace must remain in active context. If finish_task reports a mid-task session compaction, retry with compact false. In print mode, finish_task records the checkpoint without compaction; stop after the task and let the next invocation resume the queue.",
			"All statuses are terminal checkpoints: completed, failed, and blocked each advance to the next task. Put unresolved work or external dependencies in remaining.",
		],
		parameters: FinishTaskParams,
		executionMode: "sequential",
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			ensureTasksEnabled(ctx);
			if (ctx.mode === "print" && printTaskFinished) {
				throw new Error("Print mode records one task per invocation. Resume the queue with the next invocation.");
			}
			requireIsolatedTaskCall(ctx, toolCallId, "finish_task");
			const active = getActiveQueue(ctx);
			if (active === undefined) {
				throw new Error("No task queue is active. Call create_tasks with four or more related steps first.");
			}
			if (pendingCompaction(active) !== undefined) throw new Error("The current task already has a recorded outcome.");
			const item = currentItem(active);
			if (item === undefined) throw new Error("Every queued task already has a recorded outcome.");

			// Print mode is single-shot: preserve the checkpoint in place and let
			// the model produce a final response for this invocation. The next
			// invocation derives the next task from the durable finish record.
			const compact = ctx.mode === "print" ? false : (params.compact ?? true);
			if (compact && active.compactedSinceBase) {
				throw new Error(
					"The session compacted during this task, so its checkpoint can no longer be safely restored. Retry finish_task with compact: false.",
				);
			}
			const details: TaskFinishDetails = {
				kind: TASK_FINISH_DETAILS_TYPE,
				taskId: item.id,
				status: params.status,
				summary: params.summary,
				evidence: params.evidence,
				decisions: params.decisions ?? [],
				remaining: params.remaining ?? [],
				changedFiles: changedFilesForTask(ctx, active),
				compact,
			};
			if (ctx.mode === "print") printTaskFinished = true;
			const next = currentItemAfter(active, item.id);
			const completedCount = finishedCount(active) + 1;
			const taskNumber = positionOf(active, item.id);
			ctx.ui.setStatus(
				TASK_STATUS_KEY,
				compact
					? `${TASK_COMPACTION_MARKER} Task ${taskNumber}/${active.queue.tasks.length} · compacting`
					: `Task ${taskNumber}/${active.queue.tasks.length} · recorded`,
			);
			return {
				content: [
					{
						type: "text",
						text:
							ctx.mode === "print"
								? `Task outcome recorded (${completedCount}/${active.queue.tasks.length}) without compaction. This print invocation ends after the current task; the next invocation resumes with ${
										next?.title ?? "the final summary"
									}.`
								: compact
									? `Task outcome recorded (${completedCount}/${active.queue.tasks.length}).${
											next === undefined ? finishQueueMessage(active, params.status) : ` Next: ${next.title}.`
										} Its working trace will be compacted after this turn settles.`
									: "Task outcome recorded without compaction.",
					},
				],
				details,
				terminate: compact,
			};
		},
	});

	pi.registerCommand("tasks", {
		description:
			"Inspect, toggle, amend, or commit tasks (/tasks [status|on|off|commit|insert|insert-after|rename|skip|cancel]). Interactive modes compact after finish_task; print mode records one checkpoint per invocation.",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (action === "" || action === "status") {
				showTaskStatus(ctx);
				return;
			}
			if (action === "on" || action === "off") {
				setEnabled(pi, ctx, action === "on", () => refreshStatus(ctx));
				return;
			}
			if (action !== "commit") {
				const update = parseTaskCommand(args);
				if (update === undefined) {
					ctx.ui.notify(taskCommandUsage(), "warning");
					return;
				}
				applyCommandUpdate(pi, ctx, update, () => refreshStatus(ctx));
				return;
			}

			const active = getActiveQueue(ctx);
			const finish = pendingCompaction(active);
			if (active === undefined || finish === undefined) {
				ctx.ui.notify("No completed task is waiting to compact.", "warning");
				return;
			}
			const result = await ctx.navigateTree(active.baseEntryId, {
				summarize: true,
				label: `task: ${titleOf(active, finish.taskId)}`,
			});
			if (result.cancelled) {
				refreshStatus(ctx);
				ctx.ui.notify("Task compaction canceled; task remains pending. Retry /tasks commit.", "warning");
				return;
			}
			refreshStatus(ctx);
			ctx.ui.notify(`Task compacted: ${titleOf(active, finish.taskId)}. Continue from its completion record.`, "info");
			// Kick off the next queued task only after the settled run has fully torn
			// down; starting a turn inside the settle window races runtime disposal.
			// One-shot print mode exits when the outer prompt resolves, so it cannot
			// auto-continue. Print-mode finish_task records without compaction, so
			// subsequent invocations resume from the durable finish record.
			const next = currentItemAfter(active, finish.taskId);
			if (ctx.mode !== "print") {
				scheduleContinuation(pi, next === undefined ? finalSummaryPrompt(active) : nextTaskPrompt(next));
			}
		},
	});

	pi.on("session_before_tree", (event, ctx) => {
		// Any navigation rewinding exactly to the current compaction base carries the
		// derived completion record plus queue progress instead of an LLM summary.
		const active = getActiveQueue(ctx);
		const finish = pendingCompaction(active);
		if (active === undefined || finish === undefined || event.preparation.targetId !== active.baseEntryId)
			return undefined;
		const completion = toCompletion(active, finish);
		return {
			summary: {
				summary: `${formatCompletion(completion)}\n\n${formatQueueProgress(active)}`,
				details: completion,
			},
			label: `task: ${titleOf(active, finish.taskId)}`,
		};
	});

	pi.on("session_start", (_event, ctx) => {
		// Hard-hiding rewrites the system prompt's guidelines, so only do it before
		// the first model request; afterwards fall back to rejecting task tool calls.
		if (!conversationStarted(ctx) && !tasksEnabled(ctx)) applyToolVisibility(pi, false);
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
		// A queue can be created during this run, after agent_start has already
		// checked for an active queue. Start the spinner once its tool result is
		// persisted and the queue is visible in the session tree.
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

function pendingCompaction(active: ActiveQueue | undefined): TaskFinishDetails | undefined {
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

function parseTaskCommand(args: string): TaskUpdateInput | undefined {
	const match = /^(\S+)(?:\s+([\s\S]*))?$/u.exec(args.trim());
	if (match === null) return undefined;

	const command = match[1]!.toLowerCase();
	const rest = match[2]?.trim() ?? "";
	if (command === "insert") {
		return rest.length === 0 ? undefined : { action: "insert", title: rest };
	}
	if (command === "insert-after") {
		const target = takeCommandToken(rest);
		if (target === undefined || target[1].length === 0) return undefined;
		return { action: "insert", afterTaskId: target[0], title: target[1] };
	}
	if (command === "rename") {
		const target = takeCommandToken(rest);
		if (target === undefined || target[1].length === 0) return undefined;
		return { action: "rename", taskId: target[0], title: target[1] };
	}
	if (command === "skip") {
		const target = takeCommandToken(rest);
		if (target === undefined || target[1].length === 0) return undefined;
		return { action: "skip", taskId: target[0], reason: target[1] };
	}
	if (command === "cancel") {
		return rest.length === 0 ? undefined : { action: "cancel", reason: rest };
	}
	return undefined;
}

function takeCommandToken(value: string): [string, string] | undefined {
	const match = /^(\S+)(?:\s+([\s\S]*))?$/u.exec(value.trim());
	if (match === null || match[2] === undefined) return undefined;
	return [match[1]!, match[2].trim()];
}

function taskCommandUsage(): string {
	return "Usage: /tasks [status|on|off|commit|insert <title>|insert-after <task-id> <title>|rename <task-id> <title>|skip <task-id> <reason>|cancel <reason>]";
}

function applyCommandUpdate(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	params: TaskUpdateInput,
	refresh?: () => void,
): void {
	if (!tasksEnabled(ctx)) {
		ctx.ui.notify("Tasks are disabled. Use /tasks on to re-enable.", "warning");
		return;
	}
	const active = getActiveQueue(ctx);
	if (active === undefined) {
		ctx.ui.notify("No task queue is active. Call create_tasks first.", "warning");
		return;
	}
	if (pendingCompaction(active) !== undefined) {
		ctx.ui.notify("A task outcome is waiting to compact. Let it finish before amending the queue.", "warning");
		return;
	}

	try {
		const update = normalizeTaskUpdate(params);
		const queue = amendQueue(active, update);
		active.queue = queue;
		const details = taskUpdateDetails(queue, update);
		pi.sendMessage(
			{
				customType: TASK_UPDATE_DETAILS_TYPE,
				content: formatTaskUpdate(details, active),
				display: false,
				details,
			},
			{ triggerTurn: false },
		);
		refresh?.();
		ctx.ui.notify(formatTaskUpdate(details, active), "info");
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
	}
}

function normalizeTaskUpdate(params: TaskUpdateInput): TaskUpdateInput {
	return {
		action: params.action,
		...(params.taskId === undefined ? {} : { taskId: params.taskId.trim() }),
		...(params.title === undefined ? {} : { title: params.title.trim() }),
		...(params.afterTaskId === undefined ? {} : { afterTaskId: params.afterTaskId.trim() }),
		...(params.reason === undefined ? {} : { reason: params.reason.trim() }),
	};
}

function normalizeReadFilter(value: string | undefined): string | undefined {
	const normalized = value?.trim();
	return normalized === undefined || normalized === TASK_READ_ALL_FILTER ? undefined : normalized;
}

function amendQueue(active: ActiveQueue, params: TaskUpdateInput): TaskQueueDetails {
	if (active.queue.cancelled === true) throw new Error("The task queue is already canceled.");
	if (currentItem(active) === undefined) throw new Error("No pending tasks remain in the queue.");

	const queue = cloneQueue(active.queue);
	switch (params.action) {
		case "insert": {
			const title = requireText(params.title, "Insert requires a task title.");
			if (queue.tasks.length >= MAX_TASKS) {
				throw new Error(`A task queue can contain at most ${MAX_TASKS} tasks.`);
			}
			const insertionIndex =
				params.afterTaskId === undefined
					? queue.tasks.length
					: queue.tasks.findIndex((task) => task.id === params.afterTaskId) + 1;
			if (insertionIndex === 0) throw new Error(`Unknown task ID: ${params.afterTaskId}.`);
			const id = insertedTaskId(queue);
			queue.tasks.splice(insertionIndex, 0, { id, title });
			return queue;
		}
		case "rename": {
			const task = pendingTask(active, queue, params.taskId);
			task.title = requireText(params.title, "Rename requires a new task title.");
			return queue;
		}
		case "skip": {
			const task = pendingTask(active, queue, params.taskId);
			task.state = "skipped";
			task.skipReason = requireText(params.reason, "Skip requires a reason.");
			return queue;
		}
		case "cancel":
			queue.cancelled = true;
			queue.cancelReason = requireText(params.reason, "Cancel requires a reason.");
			return queue;
		default:
			throw new Error("Unknown task update action.");
	}
}

function pendingTask(active: ActiveQueue, queue: TaskQueueDetails, taskId: string | undefined): TaskQueueItem {
	if (taskId === undefined || taskId.trim().length === 0) {
		throw new Error("This queue update requires a pending task ID.");
	}
	const task = queue.tasks.find((candidate) => candidate.id === taskId);
	if (task === undefined) throw new Error(`Unknown task ID: ${taskId}.`);
	if (task.state === "skipped" || active.outcomes.has(task.id)) {
		throw new Error(`Task ${taskId} is already finished and cannot be amended.`);
	}
	return task;
}

function requireText(value: string | undefined, message: string): string {
	if (value === undefined || value.trim().length === 0) throw new Error(message);
	return value.trim();
}

function cloneQueue(queue: TaskQueueDetails): TaskQueueDetails {
	return {
		kind: TASK_QUEUE_DETAILS_TYPE,
		queueId: queue.queueId,
		tasks: queue.tasks.map((task) => ({ ...task })),
		...(queue.cancelled === undefined ? {} : { cancelled: queue.cancelled }),
		...(queue.cancelReason === undefined ? {} : { cancelReason: queue.cancelReason }),
	};
}

function insertedTaskId(queue: TaskQueueDetails): string {
	return uniqueTaskId(new Set(queue.tasks.map((task) => task.id)));
}

function uniqueTaskId(seen: Set<string>): string {
	let id = randomUUID();
	while (seen.has(id)) id = randomUUID();
	seen.add(id);
	return id;
}

function taskUpdateDetails(queue: TaskQueueDetails, params: TaskUpdateInput): TaskUpdateDetails {
	return {
		kind: TASK_UPDATE_DETAILS_TYPE,
		queueId: queue.queueId,
		action: params.action,
		tasks: queue.tasks.map((task) => ({ ...task })),
		cancelled: queue.cancelled === true,
		...(params.taskId === undefined ? {} : { taskId: params.taskId.trim() }),
		...(params.title === undefined ? {} : { title: params.title.trim() }),
		...(params.afterTaskId === undefined ? {} : { afterTaskId: params.afterTaskId.trim() }),
		...(params.reason === undefined ? {} : { reason: params.reason.trim() }),
	};
}

function formatTaskUpdate(details: TaskUpdateDetails, active: ActiveQueue): string {
	const task = details.taskId === undefined ? undefined : active.queue.tasks.find((item) => item.id === details.taskId);
	const subject = task === undefined ? (details.taskId ?? details.title ?? "queue") : `${task.title} (${task.id})`;
	const action =
		details.action === "insert"
			? `Inserted ${details.title ?? "task"}`
			: details.action === "rename"
				? `Renamed ${subject} to ${details.title ?? "new title"}`
				: details.action === "skip"
					? `Skipped ${subject}`
					: "Canceled the remaining queue";
	const reason = details.reason === undefined ? "" : ` Reason: ${details.reason}`;
	return `${action}.${reason} Queue: ${formatTaskCounts(readTasks(active).counts)}.`;
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

function currentItem(active: ActiveQueue): TaskQueueItem | undefined {
	if (active.queue.cancelled === true) return undefined;
	return active.queue.tasks.find((task) => !isTaskFinished(active, task.id) && task.state !== "skipped");
}

function currentItemAfter(active: ActiveQueue, completedId: string): TaskQueueItem | undefined {
	if (active.queue.cancelled === true) return undefined;
	return active.queue.tasks.find(
		(task) => task.id !== completedId && !isTaskFinished(active, task.id) && task.state !== "skipped",
	);
}

function progress(active: ActiveQueue): string {
	return `${finishedCount(active)}/${active.queue.tasks.length}`;
}

function finishedCount(active: ActiveQueue): number {
	return active.queue.tasks.filter((task) => isTaskFinished(active, task.id)).length;
}

function isTaskFinished(active: ActiveQueue, taskId: string): boolean {
	return (
		active.outcomes.has(taskId) || active.queue.tasks.some((task) => task.id === taskId && task.state === "skipped")
	);
}

function hasTaskIssues(counts: Record<TaskReadStatus, number>): boolean {
	return counts.failed > 0 || counts.blocked > 0 || counts.skipped > 0 || counts.cancelled > 0;
}

function finishQueueMessage(active: ActiveQueue, status: TaskStatus): string {
	const counts = readTasks(active).counts;
	if (status !== "completed" || hasTaskIssues(counts)) {
		return " Queue finished with issues; the final summary must distinguish completed, failed, blocked, and skipped tasks.";
	}
	return " Queue complete.";
}

function formatQueueStatus(active: ActiveQueue): string {
	const details = readTasks(active);
	const counts = formatTaskCounts(details.counts);
	if (details.cancelled) return `! Tasks canceled · ${counts}`;
	if (hasTaskIssues(details.counts)) return `! Tasks finished with issues · ${counts}`;
	return `✓ Tasks ${progress(active)} complete`;
}

function finalSummaryPrompt(active: ActiveQueue): string {
	const details = readTasks(active);
	if (details.cancelled) {
		return `The task queue was canceled (${formatTaskCounts(details.counts)}). Summarize completed, failed, blocked, skipped, and canceled tasks, include the cancellation reason and remaining work, and do not claim the queue succeeded.`;
	}
	if (hasTaskIssues(details.counts)) {
		return `The task queue finished with ${formatTaskCounts(details.counts)}. Summarize the overall outcome for the user, clearly distinguishing completed, failed, blocked, and skipped tasks. Do not claim full success.`;
	}
	return "All queued tasks are complete. Summarize the overall outcome for the user.";
}

function nextTaskPrompt(next: TaskQueueItem): string {
	return `Continue with the next queued task: ${next.title} (${next.id}).`;
}

function changedFilesForTask(ctx: ExtensionContext, active: ActiveQueue): string[] {
	if (active.compactedSinceBase) return [];
	const branch = ctx.sessionManager.getBranch();
	const baseIndex = branch.findIndex((entry) => entry.id === active.baseEntryId);
	if (baseIndex === -1) return [];
	const entries = branch.slice(baseIndex + 1);
	const mutationPaths = new Map<string, string[]>();
	const observed = new Set<string>();

	for (const entry of entries) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			for (const block of entry.message.content) {
				if (block.type !== "toolCall") continue;
				const paths = observedMutationPaths(block.name, block.arguments, ctx.cwd);
				if (paths.length > 0) mutationPaths.set(block.id, paths);
				continue;
			}
			continue;
		}

		if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.isError) continue;
		const callId = entry.message.toolCallId;
		if (typeof callId !== "string") continue;
		for (const path of mutationPaths.get(callId) ?? []) observed.add(path);
	}

	return [...observed];
}

function observedMutationPaths(toolName: string, input: unknown, cwd: string): string[] {
	if (!isRecord(input)) return [];
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
	if (relativePath.length > 0 && relativePath !== ".." && !relativePath.startsWith("../")) {
		return relativePath;
	}
	return normalized;
}

function positionOf(active: ActiveQueue, taskId: string): number {
	return active.queue.tasks.findIndex((task) => task.id === taskId) + 1;
}

function titleOf(active: ActiveQueue, taskId: string): string {
	return active.queue.tasks.find((task) => task.id === taskId)?.title ?? taskId;
}

function recordOutcome(active: ActiveQueue, finish: TaskFinishDetails): void {
	if (!active.outcomes.has(finish.taskId)) active.outcomes.set(finish.taskId, finish);
}

function asTaskFinish(finish: TaskCompletionDetails): TaskFinishDetails {
	return { ...finish, kind: TASK_FINISH_DETAILS_TYPE };
}

function readTasks(active: ActiveQueue | undefined, taskId?: string, path?: string): TaskReadDetails {
	if (active === undefined) {
		return {
			kind: TASK_READ_DETAILS_TYPE,
			cancelled: false,
			tasks: [],
			counts: emptyTaskCounts(),
		};
	}

	const tasks = active.queue.tasks
		.map((item) => {
			const outcome = active.outcomes.get(item.id);
			const status = statusOf(active, item, outcome);
			const task: TaskReadItem = { id: item.id, title: item.title, status };
			if (outcome !== undefined) {
				task.summary = outcome.summary;
				task.evidence = outcome.evidence;
				task.decisions = outcome.decisions;
				task.remaining = outcome.remaining;
				task.changedFiles = outcome.changedFiles;
			} else if (item.skipReason !== undefined) {
				task.skipReason = item.skipReason;
			}
			return task;
		})
		.filter((item) => {
			if (taskId !== undefined && item.id !== taskId) return false;
			if (path !== undefined && !taskMatchesPath(item, path)) return false;
			return true;
		});

	const details: TaskReadDetails = {
		kind: TASK_READ_DETAILS_TYPE,
		queueId: active.queue.queueId,
		cancelled: active.queue.cancelled === true,
		...(active.queue.cancelReason === undefined ? {} : { cancelReason: active.queue.cancelReason }),
		tasks,
		counts: emptyTaskCounts(),
	};
	const current = currentItem(active);
	if (current !== undefined) details.currentTaskId = current.id;
	for (const item of active.queue.tasks) {
		const outcome = active.outcomes.get(item.id);
		details.counts[statusOf(active, item, outcome)] += 1;
	}
	return details;
}

function statusOf(active: ActiveQueue, item: TaskQueueItem, outcome?: TaskFinishDetails): TaskReadStatus {
	if (outcome !== undefined) return outcome.status;
	if (item.state === "skipped") return "skipped";
	if (active.queue.cancelled === true) return "cancelled";
	return "pending";
}

function taskMatchesPath(item: TaskReadItem, path: string): boolean {
	const needle = path.trim();
	const candidates = [
		...(item.changedFiles ?? []),
		...(item.evidence ?? []).flatMap((evidence) => evidence.path ?? []),
	];
	return candidates.some((candidate) => {
		const file = candidate.trim();
		return file === needle || file.endsWith(`/${needle}`) || needle.endsWith(`/${file}`);
	});
}

function emptyTaskCounts(): Record<TaskReadStatus, number> {
	return {
		pending: 0,
		completed: 0,
		failed: 0,
		blocked: 0,
		skipped: 0,
		cancelled: 0,
	};
}

function formatTaskRead(details: TaskReadDetails, filtered: boolean): string {
	if (details.queueId === undefined) return "No task queue is active.";
	if (details.tasks.length === 0) {
		return filtered ? "No task matched the requested task ID or file path." : "No task queue is active.";
	}

	const state = details.cancelled ? "canceled" : details.counts.pending === 0 ? "finished" : "active";
	const lines = [`Task queue ${state} (${formatTaskCounts(details.counts)}).`];
	for (const [index, task] of details.tasks.entries()) {
		lines.push(`${index + 1}. [${task.status}] ${task.title} (${task.id})`);
		if (task.summary !== undefined) lines.push(`   Summary: ${truncate(task.summary, 800)}`);
		if (task.changedFiles !== undefined && task.changedFiles.length > 0) {
			lines.push(`   Changed files: ${task.changedFiles.join(", ")}`);
		}
		if (task.decisions !== undefined && task.decisions.length > 0) {
			lines.push(`   Decisions: ${task.decisions.map((decision) => truncate(decision, 300)).join(" | ")}`);
		}
		if (task.remaining !== undefined && task.remaining.length > 0) {
			lines.push(`   Remaining: ${task.remaining.map((remaining) => truncate(remaining, 300)).join(" | ")}`);
		}
		if (task.skipReason !== undefined) lines.push(`   Skip reason: ${truncate(task.skipReason, 500)}`);
		if (task.evidence !== undefined && task.evidence.length > 0) {
			lines.push(
				`   Evidence: ${task.evidence
					.slice(0, 5)
					.map((evidence) => `${evidence.kind}: ${truncate(evidence.description, 300)}`)
					.join(" | ")}`,
			);
			if (task.evidence.length > 5) lines.push(`   Evidence: ... ${task.evidence.length - 5} more`);
		}
	}
	if (details.currentTaskId !== undefined) {
		lines.push(`Current task: ${details.currentTaskId}`);
	}
	const output = lines.join("\n");
	if (output.length <= MAX_TASK_READ_LENGTH) return output;
	const hint = "\nOutput truncated; use taskId or path to narrow the lookup.";
	return `${truncate(output, MAX_TASK_READ_LENGTH - hint.length)}${hint}`;
}

function formatTaskCounts(counts: Record<TaskReadStatus, number>): string {
	const order: TaskReadStatus[] = ["completed", "failed", "blocked", "skipped", "cancelled", "pending"];
	return order
		.filter((status) => counts[status] > 0)
		.map((status) => `${counts[status]} ${status}`)
		.join(", ");
}

function truncate(value: string, maxLength: number): string {
	return value.length <= maxLength ? value : `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function toCompletion(active: ActiveQueue, finish: TaskFinishDetails): TaskCompletionDetails {
	return {
		...finish,
		kind: TASK_COMPLETION_DETAILS_TYPE,
		title: titleOf(active, finish.taskId),
		queue: cloneQueue(active.queue),
	};
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
	// Hiding is cache-safe only before the first model request. Re-enabling must
	// restore the tools even when the conversation has already started.
	if (enabled || !conversationStarted(ctx)) applyToolVisibility(pi, enabled);
	refresh?.();
	if (!enabled) ctx.ui.setStatus(TASK_STATUS_KEY, "Tasks off");
}

function ensureTasksEnabled(ctx: ExtensionContext): void {
	if (tasksEnabled(ctx)) return;
	throw new Error("Tasks are disabled for this session. A user can re-enable them with /tasks on.");
}

function scheduleContinuation(pi: ExtensionAPI, text: string): void {
	setTimeout(() => {
		pi.sendUserMessage(text);
	}, 0);
}

function applyToolVisibility(pi: ExtensionAPI, enabled: boolean): void {
	const active = new Set(pi.getActiveTools());
	for (const name of TASK_TOOL_NAMES) {
		if (enabled) active.add(name);
		else active.delete(name);
	}
	pi.setActiveTools([...active]);
}

function tasksEnabled(ctx: BranchContext): boolean {
	for (const entry of ctx.sessionManager.getBranch().toReversed()) {
		if (entry.type !== "custom_message" || entry.customType !== TASK_TOGGLE_TYPE) continue;
		return isRecord(entry.details) && entry.details.enabled === true;
	}
	return true;
}

function conversationStarted(ctx: BranchContext): boolean {
	return ctx.sessionManager.getBranch().some((entry) => entry.type === "message");
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
	const details = readTasks(active);
	const finish = pendingCompaction(active);
	if (finish !== undefined) {
		ctx.ui.notify(
			`Task outcome recorded: ${titleOf(active, finish.taskId)} (${formatTaskCounts(details.counts)}).`,
			"info",
		);
		return;
	}
	const item = currentItem(active);
	if (item === undefined) {
		ctx.ui.notify(
			details.cancelled
				? `Task queue canceled (${formatTaskCounts(details.counts)}).`
				: hasTaskIssues(details.counts)
					? `Task queue finished with issues (${formatTaskCounts(details.counts)}).`
					: `Task queue complete (${progress(active)}).`,
			"info",
		);
		return;
	}
	ctx.ui.notify(
		hasTaskIssues(details.counts)
			? `Task queue: ${formatTaskCounts(details.counts)}. Current: ${item.title}`
			: `Task queue: ${progress(active)} complete. Current: ${item.title}`,
		"info",
	);
}

function requireIsolatedTaskCall(
	ctx: ExtensionContext,
	toolCallId: string,
	toolName: "create_tasks" | "finish_task" | "update_tasks",
): void {
	const toolCalls = getCurrentToolCalls(ctx);
	if (toolCalls.length === 1 && toolCalls[0]?.id === toolCallId && toolCalls[0].name === toolName) return;
	throw new Error(`${toolName} must be the only tool call in its assistant turn.`);
}

function getCurrentToolCalls(ctx: ExtensionContext): Array<{ id: string; name: string }> {
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
	for (const entry of ctx.sessionManager.getBranch()) {
		const queue = readTaskQueue(entry);
		if (queue !== undefined) {
			if (active !== undefined && !queueIsClosed(active)) continue;
			active = {
				queue,
				baseEntryId: entry.id,
				outcomes: new Map(),
				compactedSinceBase: false,
			};
			continue;
		}
		if (active === undefined) continue;

		const update = readTaskUpdate(entry);
		if (update !== undefined && update.queueId === active.queue.queueId) {
			applyQueueUpdate(active, update);
			continue;
		}
		const completion = readTaskCompletion(entry);
		if (completion !== undefined && hasTask(active.queue, completion.taskId)) {
			if (completion.queue !== undefined && completion.queue.queueId === active.queue.queueId) {
				if (!applyQueueSnapshot(active, completion.queue)) continue;
			}
			if (active.pendingCompaction?.taskId !== completion.taskId && active.outcomes.has(completion.taskId)) continue;
			recordOutcome(active, asTaskFinish(completion));
			active.baseEntryId = entry.id;
			active.compactedSinceBase = false;
			active.pendingCompaction = undefined;
			continue;
		}
		const finish = readTaskFinish(entry);
		if (finish !== undefined && hasTask(active.queue, finish.taskId)) {
			if (active.outcomes.has(finish.taskId)) continue;
			recordOutcome(active, finish);
			// A pending compact finish does not move the base: its own result entry is
			// part of the trace that compaction will discard. A compact:false outcome
			// becomes the new base so its record survives later compactions.
			active.pendingCompaction = finish.compact ? finish : undefined;
			if (!finish.compact) {
				active.baseEntryId = entry.id;
				active.compactedSinceBase = false;
			}
			continue;
		}
		if (entry.type === "compaction") active.compactedSinceBase = true;
	}
	return active;
}

function queueIsClosed(active: ActiveQueue): boolean {
	return active.pendingCompaction === undefined && currentItem(active) === undefined;
}

function applyQueueUpdate(active: ActiveQueue, update: TaskUpdateDetails): boolean {
	const next = queueFromUpdate(update);
	if (!isValidQueueTransition(active, next, update)) return false;
	active.queue = next;
	return true;
}

function queueFromUpdate(update: TaskUpdateDetails): TaskQueueDetails {
	return {
		kind: TASK_QUEUE_DETAILS_TYPE,
		queueId: update.queueId,
		tasks: update.tasks.map((task) => ({ ...task })),
		...(update.cancelled ? { cancelled: true, cancelReason: update.reason } : {}),
	};
}

function applyQueueSnapshot(active: ActiveQueue, next: TaskQueueDetails): boolean {
	if (!isValidQueueTransition(active, next)) return false;
	active.queue = cloneQueue(next);
	return true;
}

function isValidQueueTransition(active: ActiveQueue, next: TaskQueueDetails, update?: TaskUpdateDetails): boolean {
	const current = active.queue;
	if (next.queueId !== current.queueId || (current.cancelled === true && next.cancelled !== true)) return false;
	if (next.cancelled === true && (current.cancelled === true || next.cancelReason === undefined)) return false;
	if (next.cancelled !== true && next.cancelReason !== undefined) return false;

	const currentById = new Map(current.tasks.map((task, index) => [task.id, { task, index }]));
	const nextIds = new Set(next.tasks.map((task) => task.id));
	if (current.tasks.some((task) => !nextIds.has(task.id))) return false;

	let previousIndex = -1;
	let added = 0;
	let addedTask: TaskQueueItem | undefined;
	let addedIndex = -1;
	let changedPending = 0;
	let changedTaskId: string | undefined;
	for (const [nextIndex, nextTask] of next.tasks.entries()) {
		const existing = currentById.get(nextTask.id);
		if (existing === undefined) {
			if (nextTask.state !== undefined) return false;
			added += 1;
			addedTask = nextTask;
			addedIndex = nextIndex;
			continue;
		}
		if (existing.index <= previousIndex) return false;
		previousIndex = existing.index;

		if (isTaskFinished(active, existing.task.id)) {
			if (!sameTaskItem(existing.task, nextTask)) return false;
			continue;
		}
		if (nextTask.state === "skipped") {
			changedPending += 1;
			changedTaskId = nextTask.id;
			continue;
		}
		if (nextTask.title !== existing.task.title) {
			changedPending += 1;
			changedTaskId = nextTask.id;
		}
	}

	if (update === undefined) return true;
	switch (update.action) {
		case "insert":
			return (
				!next.cancelled &&
				added === 1 &&
				changedPending === 0 &&
				addedTask?.title === update.title &&
				addedIndex ===
					(update.afterTaskId === undefined
						? current.tasks.length
						: (currentById.get(update.afterTaskId)?.index ?? -2) + 1)
			);
		case "rename": {
			const renamed = next.tasks.find((task) => task.id === update.taskId);
			return (
				!next.cancelled &&
				added === 0 &&
				changedPending === 1 &&
				changedTaskId === update.taskId &&
				renamed?.title === update.title &&
				renamed?.state === undefined &&
				renamed?.skipReason === undefined
			);
		}
		case "skip": {
			const skipped = next.tasks.find((task) => task.id === update.taskId);
			const previous = update.taskId === undefined ? undefined : currentById.get(update.taskId)?.task;
			return (
				!next.cancelled &&
				added === 0 &&
				changedPending === 1 &&
				changedTaskId === update.taskId &&
				skipped?.title === previous?.title &&
				skipped?.state === "skipped" &&
				skipped?.skipReason === update.reason
			);
		}
		case "cancel":
			return (
				next.cancelled === true &&
				added === 0 &&
				changedPending === 0 &&
				next.cancelReason === update.reason &&
				sameTaskList(current.tasks, next.tasks)
			);
		default:
			return false;
	}
}

function sameTaskList(left: TaskQueueItem[], right: TaskQueueItem[]): boolean {
	return left.length === right.length && left.every((task, index) => sameTaskItem(task, right[index]!));
}

function sameTaskItem(left: TaskQueueItem, right: TaskQueueItem): boolean {
	return (
		left.id === right.id &&
		left.title === right.title &&
		left.state === right.state &&
		left.skipReason === right.skipReason
	);
}

function hasTask(queue: TaskQueueDetails, taskId: string): boolean {
	return queue.tasks.some((task) => task.id === taskId);
}

function readTaskFinish(entry: SessionEntry): TaskFinishDetails | undefined {
	const details = successfulToolResultDetails(entry);
	if (!isRecord(details) || details.kind !== TASK_FINISH_DETAILS_TYPE) return undefined;
	return parseTaskFinish(details);
}

function readTaskUpdate(entry: SessionEntry): TaskUpdateDetails | undefined {
	const details =
		successfulToolResultDetails(entry) ??
		(entry.type === "custom_message" && entry.customType === TASK_UPDATE_DETAILS_TYPE ? entry.details : undefined);
	return isRecord(details) && details.kind === TASK_UPDATE_DETAILS_TYPE ? parseTaskUpdate(details) : undefined;
}

function readTaskQueue(entry: SessionEntry): TaskQueueDetails | undefined {
	return parseTaskQueue(successfulToolResultDetails(entry));
}

function successfulToolResultDetails(entry: SessionEntry): unknown {
	if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.isError) {
		return undefined;
	}
	return entry.message.details;
}

function readTaskCompletion(entry: SessionEntry): TaskCompletionDetails | undefined {
	if (
		entry.type !== "branch_summary" ||
		!isRecord(entry.details) ||
		entry.details.kind !== TASK_COMPLETION_DETAILS_TYPE
	) {
		return undefined;
	}
	const finish = parseTaskFinish(entry.details);
	if (finish === undefined || typeof entry.details.title !== "string") return undefined;
	let queue: TaskQueueDetails | undefined;
	if (entry.details.queue !== undefined) {
		queue = parseTaskQueue(entry.details.queue);
		if (queue === undefined) return undefined;
	}
	return {
		...finish,
		kind: TASK_COMPLETION_DETAILS_TYPE,
		title: entry.details.title,
		...(queue === undefined ? {} : { queue }),
	};
}

function parseTaskQueue(value: unknown): TaskQueueDetails | undefined {
	if (
		!isRecord(value) ||
		value.kind !== TASK_QUEUE_DETAILS_TYPE ||
		typeof value.queueId !== "string" ||
		value.queueId.trim().length === 0 ||
		value.queueId.length > 200
	) {
		return undefined;
	}
	const tasks = parseTaskItems(value.tasks);
	if (tasks === undefined) return undefined;
	if (value.cancelled !== undefined && typeof value.cancelled !== "boolean") return undefined;
	if (value.cancelReason !== undefined && typeof value.cancelReason !== "string") return undefined;
	if (value.cancelReason !== undefined && value.cancelled !== true) return undefined;
	if (value.cancelled === true && (typeof value.cancelReason !== "string" || value.cancelReason.trim().length === 0)) {
		return undefined;
	}
	return {
		kind: TASK_QUEUE_DETAILS_TYPE,
		queueId: value.queueId,
		tasks,
		...(value.cancelled === undefined ? {} : { cancelled: value.cancelled }),
		...(value.cancelReason === undefined ? {} : { cancelReason: value.cancelReason }),
	};
}

function parseTaskItems(value: unknown): TaskQueueItem[] | undefined {
	if (!Array.isArray(value) || value.length < MIN_TASKS || value.length > MAX_TASKS) return undefined;
	const ids = new Set<string>();
	const tasks: TaskQueueItem[] = [];
	for (const item of value) {
		if (!isRecord(item) || typeof item.id !== "string" || typeof item.title !== "string") return undefined;
		if (
			item.id.trim().length === 0 ||
			item.id.length > 200 ||
			item.title.trim().length === 0 ||
			item.title.length > 200 ||
			ids.has(item.id)
		) {
			return undefined;
		}
		if (item.state !== undefined && !isTaskItemState(item.state)) return undefined;
		if (item.skipReason !== undefined && (typeof item.skipReason !== "string" || item.skipReason.length > 1000)) {
			return undefined;
		}
		if (item.state === "skipped" && (typeof item.skipReason !== "string" || item.skipReason.trim().length === 0)) {
			return undefined;
		}
		if (item.state !== "skipped" && item.skipReason !== undefined) return undefined;
		ids.add(item.id);
		tasks.push({
			id: item.id,
			title: item.title,
			...(item.state === undefined ? {} : { state: item.state }),
			...(item.skipReason === undefined ? {} : { skipReason: item.skipReason }),
		});
	}
	return tasks;
}

function parseTaskUpdate(details: Record<string, unknown>): TaskUpdateDetails | undefined {
	if (
		typeof details.queueId !== "string" ||
		!isTaskUpdateAction(details.action) ||
		typeof details.cancelled !== "boolean"
	) {
		return undefined;
	}
	const tasks = parseTaskItems(details.tasks);
	if (tasks === undefined) return undefined;
	if (
		(details.taskId !== undefined && typeof details.taskId !== "string") ||
		(details.title !== undefined && typeof details.title !== "string") ||
		(details.afterTaskId !== undefined && typeof details.afterTaskId !== "string") ||
		(details.reason !== undefined && typeof details.reason !== "string")
	) {
		return undefined;
	}
	if (
		(details.cancelled &&
			(details.action !== "cancel" || typeof details.reason !== "string" || details.reason.trim().length === 0)) ||
		(!details.cancelled && details.action === "cancel")
	) {
		return undefined;
	}
	if (!validTaskUpdateFields(details)) return undefined;
	return {
		kind: TASK_UPDATE_DETAILS_TYPE,
		queueId: details.queueId,
		action: details.action,
		tasks,
		cancelled: details.cancelled,
		...(details.taskId === undefined ? {} : { taskId: details.taskId }),
		...(details.title === undefined ? {} : { title: details.title }),
		...(details.afterTaskId === undefined ? {} : { afterTaskId: details.afterTaskId }),
		...(details.reason === undefined ? {} : { reason: details.reason }),
	};
}

function validTaskUpdateFields(details: Record<string, unknown>): boolean {
	switch (details.action) {
		case "insert":
			return (
				typeof details.title === "string" &&
				details.title.trim().length > 0 &&
				details.taskId === undefined &&
				details.reason === undefined
			);
		case "rename":
			return (
				typeof details.taskId === "string" &&
				details.taskId.trim().length > 0 &&
				typeof details.title === "string" &&
				details.title.trim().length > 0 &&
				details.afterTaskId === undefined &&
				details.reason === undefined
			);
		case "skip":
			return (
				typeof details.taskId === "string" &&
				details.taskId.trim().length > 0 &&
				typeof details.reason === "string" &&
				details.reason.trim().length > 0 &&
				details.title === undefined &&
				details.afterTaskId === undefined
			);
		case "cancel":
			return (
				typeof details.reason === "string" &&
				details.reason.trim().length > 0 &&
				details.taskId === undefined &&
				details.title === undefined &&
				details.afterTaskId === undefined
			);
		default:
			return false;
	}
}

function parseTaskFinish(details: Record<string, unknown>): TaskFinishDetails | undefined {
	if (
		typeof details.taskId !== "string" ||
		!isTaskStatus(details.status) ||
		typeof details.summary !== "string" ||
		!Array.isArray(details.evidence) ||
		!details.evidence.every(isEvidence) ||
		!isStringArray(details.decisions) ||
		!isStringArray(details.remaining) ||
		(details.changedFiles !== undefined && !isStringArray(details.changedFiles)) ||
		typeof details.compact !== "boolean"
	) {
		return undefined;
	}
	return {
		kind: TASK_FINISH_DETAILS_TYPE,
		taskId: details.taskId,
		status: details.status,
		summary: details.summary,
		evidence: details.evidence,
		decisions: details.decisions,
		remaining: details.remaining,
		changedFiles: details.changedFiles === undefined ? [] : details.changedFiles,
		compact: details.compact,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isTaskStatus(value: unknown): value is TaskStatus {
	return TASK_STATUSES.some((status) => status === value);
}

function isTaskItemState(value: unknown): value is TaskItemState {
	return TASK_ITEM_STATES.some((state) => state === value);
}

function isTaskUpdateAction(value: unknown): value is TaskUpdateAction {
	return TASK_UPDATE_ACTIONS.some((action) => action === value);
}

function isEvidence(value: unknown): value is Evidence {
	if (!isRecord(value)) return false;
	const kind = EVIDENCE_KINDS.find((candidate) => candidate === value.kind);
	if (kind === undefined) return false;
	if (typeof value.description !== "string") return false;
	if (["path", "command", "result", "hash"].some((key) => value[key] !== undefined && typeof value[key] !== "string")) {
		return false;
	}
	return true;
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function formatCompletion(task: TaskCompletionDetails): string {
	const lines = [`## Task: ${task.title}`, `Status: ${task.status}`, "", "## Summary", task.summary, "", "## Evidence"];
	for (const evidence of task.evidence) {
		const reference = evidence.path ?? evidence.command ?? evidence.hash;
		lines.push(`- **${evidence.kind}**${reference === undefined ? "" : ` \`${reference}\``}: ${evidence.description}`);
		if (evidence.result !== undefined) lines.push(`  Result: ${evidence.result}`);
	}
	if (task.decisions.length > 0) {
		lines.push("", "## Decisions", ...task.decisions.map((decision) => `- ${decision}`));
	}
	if (task.remaining.length > 0) {
		lines.push("", "## Remaining", ...task.remaining.map((item) => `- ${item}`));
	}
	if (task.changedFiles.length > 0) {
		lines.push("", "## Observed changed files", ...task.changedFiles.map((path) => `- \`${path}\``));
	}
	return lines.join("\n");
}

function formatQueueProgress(active: ActiveQueue): string {
	const details = readTasks(active);
	const next = currentItem(active);
	if (next === undefined) {
		if (details.cancelled) {
			return `## Queue progress\nQueue canceled: ${formatTaskCounts(details.counts)}. No further tasks will run.`;
		}
		if (hasTaskIssues(details.counts)) {
			return `## Queue progress\nQueue finished with issues: ${formatTaskCounts(details.counts)}. Do not report the queue as fully successful.`;
		}
		return `## Queue progress\n${progress(active)} complete. The queue is finished.`;
	}
	if (hasTaskIssues(details.counts)) {
		return `## Queue progress\n${formatTaskCounts(details.counts)}. Continue with: ${next.title}`;
	}
	return `## Queue progress\n${progress(active)} complete. Continue with: ${next.title}`;
}
