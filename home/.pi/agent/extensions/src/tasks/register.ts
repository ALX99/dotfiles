import type {
	AgentSettledEvent,
	AgentStartEvent,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	InputEventResult,
	SessionBeforeTreeEvent,
	SessionBeforeTreeResult,
	SessionCompactEvent,
	SessionShutdownEvent,
	SessionStartEvent,
	SessionTreeEvent,
	InputEvent,
	SessionEntry,
	ToolCallEvent,
	ToolCallEventResult,
	ToolResultEvent,
	ToolResultEventResult,
} from "@earendil-works/pi-coding-agent";
import { relative } from "node:path";
import { Check } from "typebox/value";
import { Duration, Effect, Predicate } from "effect";
import { FinishTaskParams, registerTaskTools, TASK_TOOL_NAMES } from "./tools.ts";
import type { ApplicationEffects } from "../application.ts";
import type { ToolSelection } from "../integration/tool-selection.ts";
import { observeToolFiles } from "../integration/tool-observations.ts";
import { showTaskDashboard, toDashboardQueue } from "./dashboard.ts";
import {
	buildOutcome,
	cancelQueue,
	createQueue,
	currentItem,
	finalSummaryPrompt,
	finishedCount,
	formatAddedTask,
	formatOutcome,
	formatTaskCounts,
	hasTaskIssues,
	latestActive,
	nextTaskPrompt,
	pendingCompaction,
	positionOf,
	projectOutcome,
	queueIsClosed,
	replay,
	TASK_CANCEL_DETAILS_TYPE,
	taskCounts,
	taskError,
	taskReminderPrompt,
	titleOf,
	type ActiveQueue,
	type TaskOutcome,
	type TaskQueueDetails,
} from "./state.ts";

export { TASK_TOOL_NAMES };

const TASK_RECOVERY_MESSAGE_TYPE = "tasks:recovery";
const TASK_CONTINUE_TYPE = "tasks:continue";
const TASK_REMINDER_TYPE = "tasks:reminder";
const TASK_TOGGLE_TYPE = "tasks:toggle";
const TASK_STATUS_KEY = "tasks";

const TASK_BOOTSTRAP_TOOL_NAMES = ["create_tasks"] as const;
const TASK_COMPACTION_MARKER = "⟳";

export interface TaskSettlementWork {
	taskCheckpoint(ctx: ExtensionContext): Effect.Effect<void> | undefined;
	taskInput(ctx: ExtensionContext): Effect.Effect<void> | undefined;
	taskReminder(ctx: ExtensionContext): Effect.Effect<void> | undefined;
}

/** Task state reacts to Pi lifecycle events through the Work application adapter. */
export interface TaskEventHandlers {
	readonly toolCall: (event: ToolCallEvent, ctx: ExtensionContext) => ToolCallEventResult | void;
	readonly toolResult: (event: ToolResultEvent, ctx: ExtensionContext) => ToolResultEventResult | void;
	readonly input: (event: InputEvent, ctx: ExtensionContext) => InputEventResult | void;
	readonly sessionBeforeTree: (event: SessionBeforeTreeEvent, ctx: ExtensionContext) => SessionBeforeTreeResult | void;
	readonly sessionCompact: (event: SessionCompactEvent, ctx: ExtensionContext) => void;
	readonly sessionStart: (event: SessionStartEvent, ctx: ExtensionContext) => void;
	readonly agentStart: (event: AgentStartEvent, ctx: ExtensionContext) => void;
	readonly sessionTree: (event: SessionTreeEvent, ctx: ExtensionContext) => void;
	readonly agentSettled: (event: AgentSettledEvent, ctx: ExtensionContext) => void;
	readonly sessionShutdown: (event: SessionShutdownEvent, ctx: ExtensionContext) => void;
}

export interface TaskWork extends TaskSettlementWork {
	readonly events: TaskEventHandlers;
}

interface TaskStatusContext {
	sessionManager: {
		getBranch(): SessionEntry[];
	};
	ui: {
		setStatus(key: string, text: string | undefined): void;
	};
}

interface BranchContext {
	sessionManager: {
		getBranch(): SessionEntry[];
	};
}

interface DeferredInputState {
	inputs: Array<Pick<InputEvent, "text" | "images">>;
	replaying: boolean;
	continuation: string | undefined;
}

type TaskBoundaryToolName = "create_tasks" | "finish_task";

interface CodemodeTaskBoundary {
	toolCallId: string;
	toolName: TaskBoundaryToolName;
	queue?: TaskQueueDetails;
	outcome?: TaskOutcome;
}

interface CodemodeCallState {
	nestedCallCount: number;
	pendingMutationPaths: Map<string, string[]>;
	changedFiles: Set<string>;
	boundary?: CodemodeTaskBoundary;
}

export default function tasksExtension(
	pi: ExtensionAPI,
	toolSelection: ToolSelection,
	applicationEffects: ApplicationEffects,
): TaskWork {
	let printTaskFinished = false;
	const codemodeCalls = new Map<string, CodemodeCallState>();
	const codemodeTaskCallParents = new Map<string, string>();
	const deferredInputs: DeferredInputState = {
		inputs: [],
		replaying: false,
		continuation: undefined,
	};

	let refreshDashboard: (() => void) | undefined;
	const refreshStatus = (ctx: TaskStatusContext): void => {
		updateTaskStatus(ctx);
		refreshDashboard?.();
	};

	registerTaskTools(pi, {
		async create(toolCallId, params, ctx) {
			ensureTasksEnabled(ctx);
			if (isHeadlessMode(ctx) && printTaskFinished) {
				throw taskError(
					"print_mode",
					"The current task outcome has already been recorded. Continue with the next task.",
				);
			}
			const parentToolCallId = requireTaskBoundaryCall(
				ctx,
				toolCallId,
				"create_tasks",
				codemodeCalls,
				codemodeTaskCallParents,
			);
			const active = getActiveQueue(ctx);
			if (active !== undefined && (pendingCompaction(active) !== undefined || currentItem(active) !== undefined)) {
				throw taskError(
					"active_queue",
					"A task queue is already active. Finish its remaining tasks before creating another queue.",
				);
			}

			const details = createQueue(params.tasks);
			if (parentToolCallId !== undefined) {
				codemodeCalls.get(parentToolCallId)!.boundary!.queue = details;
			}
			const { tasks } = details;
			activateTaskTools(toolSelection);
			ctx.ui.setStatus(TASK_STATUS_KEY, formatTaskLabel(0, tasks.length, tasks[0]!.title));
			return {
				content: [
					{
						type: "text",
						text: [
							`Queued ${tasks.length} tasks.`,
							...tasks.map((task, index) => `${index + 1}. ${task.id}: ${task.title}`),
							"Work tasks in order. After each task, call finish_task as the only tool call in its assistant turn, or make it the only nested tool call in a codemode script. Record a concise handoff and add any follow-up tasks.",
							nextTaskPrompt(tasks[0]!),
						].join("\n"),
					},
				],
				details,
			};
		},
		async finish(toolCallId, params, ctx) {
			ensureTasksEnabled(ctx);
			if (isHeadlessMode(ctx) && printTaskFinished) {
				throw taskError(
					"print_mode",
					"The current task outcome has already been recorded. Continue with the next task.",
				);
			}
			const parentToolCallId = requireTaskBoundaryCall(
				ctx,
				toolCallId,
				"finish_task",
				codemodeCalls,
				codemodeTaskCallParents,
			);
			if (!Check(FinishTaskParams, params)) throw new Error("Invalid finish_task parameters.");
			const active = getActiveQueue(ctx);
			if (active === undefined) {
				throw taskError("no_queue", "No task queue is active. Call create_tasks first.");
			}
			const details = buildOutcome(active, {
				status: params.status,
				outcome: params.outcome,
				additions: params.addTasks,
				changedFiles: changedFilesForTask(ctx, active),
				checkpoint: isHeadlessMode(ctx) ? "inline" : "rewrite",
			});
			if (isHeadlessMode(ctx) && parentToolCallId === undefined) printTaskFinished = true;
			if (parentToolCallId !== undefined) {
				codemodeCalls.get(parentToolCallId)!.boundary!.outcome = details;
			}

			const projected = projectOutcome(active, details);
			const next = currentItem(projected);
			const completedCount = finishedCount(projected);
			const taskNumber = positionOf(active, details.taskId);
			const total = projected.queue.tasks.length;
			ctx.ui.setStatus(
				TASK_STATUS_KEY,
				details.checkpoint === "rewrite"
					? formatCompactionStatus(taskNumber, total)
					: `Task ${taskNumber}/${total} · recorded`,
			);
			return {
				content: [
					{
						type: "text",
						text: [
							`Task ${details.taskId} ${details.status} (${completedCount}/${total}).`,
							...(details.addedTasks.length === 0
								? []
								: [`Added: ${details.addedTasks.map(formatAddedTask).join("; ")}`]),
							parentToolCallId !== undefined && details.checkpoint === "rewrite"
								? "The task outcome is ready to checkpoint. Do not call more tools or start the next task."
								: next === undefined
									? finalSummaryPrompt(projected)
									: nextTaskPrompt(next),
						].join(" "),
					},
				],
				details,
				...(parentToolCallId === undefined ? { terminate: details.checkpoint === "rewrite" } : {}),
			};
		},
	});

	const onToolCall: TaskEventHandlers["toolCall"] = (event, ctx) => {
		if (event.parentToolCallId === undefined) {
			if (hasPendingTaskCompaction(ctx)) {
				return {
					block: true,
					reason: "A task checkpoint is pending. Stop tool use so the task can be compacted.",
					terminate: true,
				};
			}
			return undefined;
		}

		const parentToolCallId = event.parentToolCallId;
		const isCodemodeParent = getCurrentToolCalls(ctx).some(
			(toolCall) => toolCall.id === parentToolCallId && toolCall.name === "codemode",
		);
		if (!isCodemodeParent) {
			if (event.toolName !== "create_tasks" && event.toolName !== "finish_task") return undefined;
			return {
				block: true,
				reason: `${event.toolName} can run through codemode only when codemode is the assistant turn's sole tool call.`,
			};
		}

		const state: CodemodeCallState = codemodeCalls.get(parentToolCallId) ?? {
			nestedCallCount: 0,
			pendingMutationPaths: new Map(),
			changedFiles: new Set(),
		};
		state.nestedCallCount += 1;
		codemodeCalls.set(parentToolCallId, state);
		const mutationPaths = taskPaths(observeToolFiles(event.toolName, event.input, ctx.cwd).mutationPaths, ctx.cwd);
		if (mutationPaths.length > 0) state.pendingMutationPaths.set(event.toolCallId, mutationPaths);

		if (state.boundary !== undefined) {
			return {
				block: true,
				reason: `No nested tool calls may follow ${state.boundary.toolName} in the same codemode script.`,
			};
		}

		if (event.toolName !== "create_tasks" && event.toolName !== "finish_task") return undefined;
		if (state.nestedCallCount !== 1 || !isSingleToolCall(ctx, parentToolCallId, "codemode")) {
			return {
				block: true,
				reason: `${event.toolName} can run in codemode only as its sole nested tool call.`,
			};
		}

		state.boundary = { toolCallId: event.toolCallId, toolName: event.toolName };
		codemodeTaskCallParents.set(event.toolCallId, parentToolCallId);
		return undefined;
	};

	const toolResult: TaskEventHandlers["toolResult"] = (event, ctx) => {
		if (event.parentToolCallId !== undefined) {
			const state = codemodeCalls.get(event.parentToolCallId);
			const paths = state?.pendingMutationPaths.get(event.toolCallId);
			state?.pendingMutationPaths.delete(event.toolCallId);
			if (state !== undefined && !event.isError) {
				for (const path of paths ?? []) state.changedFiles.add(path);
			}
			return undefined;
		}
		if (event.toolName !== "codemode") return undefined;
		const state = codemodeCalls.get(event.toolCallId);
		codemodeCalls.delete(event.toolCallId);
		if (state === undefined) return undefined;

		const codemodeDetails = {
			...(Predicate.isObject(event.details) ? event.details : {}),
			...(state.changedFiles.size === 0 ? {} : { taskChangedFiles: [...state.changedFiles] }),
		};
		if (state.boundary === undefined) {
			return state.changedFiles.size === 0 ? undefined : { details: codemodeDetails };
		}

		codemodeTaskCallParents.delete(state.boundary.toolCallId);
		const boundary = state.boundary;
		const successfulCalls = hasOnlySuccessfulCodemodeBoundary(event.details, boundary.toolName);
		const hasBoundaryResult =
			boundary.toolName === "create_tasks" ? boundary.queue !== undefined : boundary.outcome !== undefined;
		if (event.isError || !successfulCalls || !hasBoundaryResult) {
			if (boundary.queue !== undefined) applyToolVisibility(toolSelection, tasksEnabled(ctx));
			refreshStatus(ctx);
			return {
				content: [
					...event.content,
					{
						type: "text",
						text: `Task boundary was not recorded. A codemode script must make exactly one nested tool call, and it must be ${boundary.toolName}.`,
					},
				],
				details: codemodeDetails,
				isError: true,
			};
		}

		if (boundary.toolName === "create_tasks") {
			return {
				details: { ...codemodeDetails, taskQueue: boundary.queue },
			};
		}

		if (isHeadlessMode(ctx)) printTaskFinished = true;
		return {
			content: [
				...event.content,
				...(boundary.outcome?.checkpoint === "rewrite"
					? [
							{
								type: "text" as const,
								text: "The task checkpoint is pending. Do not use tools or start the next task; the task extension will compact and resume it.",
							},
						]
					: []),
			],
			details: { ...codemodeDetails, taskOutcome: boundary.outcome },
		};
	};

	const input: TaskEventHandlers["input"] = (event, ctx) => {
		if (
			event.source === "extension" ||
			isHeadlessMode(ctx) ||
			!tasksEnabled(ctx) ||
			(!hasPendingTaskCompaction(ctx) && !hasFinishingTaskCall(ctx) && !hasCodemodeTaskBoundary(codemodeCalls))
		) {
			return undefined;
		}

		deferredInputs.inputs.push({
			text: event.text,
			...(event.images === undefined ? {} : { images: event.images }),
		});
		if (deferredInputs.inputs.length === 1 && !deferredInputs.replaying) {
			ctx.ui.notify("Holding your message until the task boundary is recorded.", "info");
		}
		return { action: "handled" };
	};

	pi.registerCommand("tasks", {
		description: "Open the task dashboard (/tasks), or control tasks ([status|on|off|commit|cancel <reason>]).",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const action = trimmed.toLowerCase();
			if (action === "" && ctx.mode === "tui") {
				await showTaskDashboard(
					ctx,
					() => replay(ctx.sessionManager.getBranch()).map(toDashboardQueue),
					(refresh) => {
						refreshDashboard = refresh;
					},
				);
				return;
			}
			if (action === "" || action === "status") {
				showTaskStatus(ctx);
				return;
			}
			if (action === "on" || action === "off") {
				setEnabled(pi, toolSelection, ctx, action === "on", () => refreshStatus(ctx));
				return;
			}
			if (action.startsWith("cancel")) {
				const reason = trimmed.slice("cancel".length).trim();
				if (reason.length === 0) {
					ctx.ui.notify("Usage: /tasks cancel <reason>", "warning");
					return;
				}
				cancelActiveQueue(pi, ctx, reason, () => refreshStatus(ctx));
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
			const next = currentItem(active);
			const continuation = next === undefined ? finalSummaryPrompt(active) : nextTaskPrompt(next);
			// Report the continuation verbatim: it is the instruction the model is about to
			// receive, so the notification cannot drift from what the model actually sees.
			ctx.ui.notify(`Task compacted: ${titleOf(active, finish.taskId)}. Model sees: ${continuation}`, "info");
			if (!isHeadlessMode(ctx)) {
				await applicationEffects.initiate(continueAfterTaskCompaction(pi, deferredInputs, continuation));
			}
		},
	});

	const sessionBeforeTree: TaskEventHandlers["sessionBeforeTree"] = (event, ctx) => {
		const active = getActiveQueue(ctx);
		const finish = pendingCompaction(active);
		if (active === undefined || finish === undefined || event.preparation.targetId !== active.checkpointEntryId)
			return undefined;
		return {
			summary: {
				summary: formatOutcome(active, finish),
				details: finish,
			},
			label: `task: ${titleOf(active, finish.taskId)}`,
		};
	};

	const sessionCompact: TaskEventHandlers["sessionCompact"] = (event, ctx) => {
		if (event.reason === "manual") return;
		const active = getActiveQueue(ctx);
		const current = active === undefined ? undefined : currentItem(active);
		if (active === undefined || current === undefined) return;
		pi.sendMessage(
			{
				customType: TASK_RECOVERY_MESSAGE_TYPE,
				content: nextTaskPrompt(current),
				display: false,
				details: {
					queueId: active.queue.queueId,
					taskId: current.id,
					compactionEntryId: event.compactionEntry.id,
				},
			},
			{ deliverAs: "steer" },
		);
	};

	const sessionStart: TaskEventHandlers["sessionStart"] = (_event, ctx) => {
		syncTaskToolVisibility(toolSelection, ctx);
		printTaskFinished = false;
		codemodeCalls.clear();
		codemodeTaskCallParents.clear();
		deferredInputs.inputs.length = 0;
		deferredInputs.replaying = false;
		deferredInputs.continuation = undefined;
		refreshStatus(ctx);
	};

	const agentStart: TaskEventHandlers["agentStart"] = () => {
		printTaskFinished = false;
		codemodeCalls.clear();
		codemodeTaskCallParents.clear();
	};

	const sessionTree: TaskEventHandlers["sessionTree"] = (_event, ctx) => {
		syncTaskToolVisibility(toolSelection, ctx);
		refreshStatus(ctx);
	};

	const agentSettled: TaskEventHandlers["agentSettled"] = (_event, ctx) => {
		refreshStatus(ctx);
	};

	const sessionShutdown: TaskEventHandlers["sessionShutdown"] = (_event, ctx) => {
		printTaskFinished = false;
		codemodeCalls.clear();
		codemodeTaskCallParents.clear();
		deferredInputs.inputs.length = 0;
		deferredInputs.replaying = false;
		deferredInputs.continuation = undefined;
		ctx.ui.setStatus(TASK_STATUS_KEY, undefined);
	};

	return {
		events: {
			toolCall: onToolCall,
			toolResult,
			input,
			sessionBeforeTree,
			sessionCompact,
			sessionStart,
			agentStart,
			sessionTree,
			agentSettled,
			sessionShutdown,
		},
		taskCheckpoint(ctx) {
			if (isHeadlessMode(ctx) || !hasPendingTaskCompaction(ctx) || !tasksEnabled(ctx)) return undefined;
			// Tree navigation is only available on command context, so retain the supported
			// /tasks commit bridge while making it the single selected settlement action.
			return Effect.sync(() => pi.sendUserMessage("/tasks commit", { expandPromptTemplates: true }));
		},
		taskInput(ctx) {
			if (isHeadlessMode(ctx) || hasPendingTaskCompaction(ctx)) return undefined;
			if (deferredInputs.replaying) {
				if (deferredInputs.inputs.length === 0 && deferredInputs.continuation === undefined) {
					deferredInputs.replaying = false;
					return undefined;
				}
				return finishDeferredInputReplay(pi, deferredInputs);
			}
			if (!tasksEnabled(ctx) || deferredInputs.inputs.length === 0) return undefined;
			return Effect.sync(() => {
				deferredInputs.replaying = true;
			}).pipe(Effect.andThen(scheduleDeferredUserInput(pi, deferredInputs)));
		},
		taskReminder(ctx) {
			if (
				isHeadlessMode(ctx) ||
				hasPendingTaskCompaction(ctx) ||
				deferredInputs.replaying ||
				deferredInputs.inputs.length > 0 ||
				!tasksEnabled(ctx)
			) {
				return undefined;
			}
			const active = getActiveQueue(ctx);
			const current = active === undefined ? undefined : currentItem(active);
			if (active === undefined || current === undefined) return undefined;
			const { queueId } = active.queue;
			if (wasReminded(ctx, queueId, current.id) || stoppedByUserOrError(ctx)) return undefined;
			return scheduleTaskReminder(pi, ctx);
		},
	};
}

function isHeadlessMode(ctx: Pick<ExtensionContext, "mode">): boolean {
	return ctx.mode === "json" || ctx.mode === "print";
}

function hasPendingTaskCompaction(ctx: BranchContext): boolean {
	return pendingCompaction(getActiveQueue(ctx)) !== undefined;
}

function hasFinishingTaskCall(ctx: BranchContext): boolean {
	const branch = ctx.sessionManager.getBranch();
	let assistantIndex = -1;
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry?.type === "message" && entry.message.role === "assistant") {
			assistantIndex = index;
			break;
		}
	}
	if (assistantIndex === -1) return false;

	const entry = branch[assistantIndex];
	if (entry?.type !== "message" || entry.message.role !== "assistant") return false;
	const finishCalls = entry.message.content.flatMap((block) =>
		block.type === "toolCall" && block.name === "finish_task" ? [block] : [],
	);
	if (finishCalls.length === 0) return false;

	return finishCalls.some(
		(call) =>
			!branch
				.slice(assistantIndex + 1)
				.some(
					(result) =>
						result.type === "message" && result.message.role === "toolResult" && result.message.toolCallId === call.id,
				),
	);
}

function continueAfterTaskCompaction(pi: ExtensionAPI, state: DeferredInputState, prompt: string): Effect.Effect<void> {
	if (state.inputs.length === 0 && !state.replaying) return scheduleContinuation(pi, prompt);

	state.replaying = true;
	state.continuation = prompt;
	return scheduleDeferredUserInput(pi, state);
}

function scheduleDeferredUserInput(pi: ExtensionAPI, state: DeferredInputState): Effect.Effect<void> {
	return Effect.sleep(Duration.millis(0)).pipe(
		Effect.andThen(
			Effect.suspend(() => {
				const input = state.inputs.shift();
				if (input === undefined) return finishDeferredInputReplay(pi, state);

				const content =
					input.images === undefined ? input.text : [{ type: "text" as const, text: input.text }, ...input.images];
				return Effect.sync(() => pi.sendUserMessage(content, { expandPromptTemplates: true }));
			}),
		),
	);
}

function finishDeferredInputReplay(pi: ExtensionAPI, state: DeferredInputState): Effect.Effect<void> {
	if (!state.replaying) return Effect.void;
	if (state.inputs.length > 0) return scheduleDeferredUserInput(pi, state);

	state.replaying = false;
	const prompt = state.continuation;
	state.continuation = undefined;
	return prompt === undefined ? Effect.void : scheduleContinuation(pi, prompt);
}

function updateTaskStatus(ctx: TaskStatusContext): void {
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
		ctx.ui.setStatus(
			TASK_STATUS_KEY,
			formatCompactionStatus(positionOf(active, finish.taskId), active.queue.tasks.length),
		);
		return;
	}

	const item = currentItem(active);
	if (item === undefined) {
		ctx.ui.setStatus(TASK_STATUS_KEY, formatQueueStatus(active));
		return;
	}

	ctx.ui.setStatus(TASK_STATUS_KEY, formatTaskLabel(finishedCount(active), active.queue.tasks.length, item.title));
}

function formatTaskLabel(completedCount: number, total: number, title: string): string {
	return `${completedCount}/${total} complete · ${title}`;
}

function formatCompactionStatus(taskNumber: number, total: number): string {
	return `${TASK_COMPACTION_MARKER} Task ${taskNumber}/${total} · compacting`;
}

function hasCodemodeTaskBoundary(codemodeCalls: ReadonlyMap<string, CodemodeCallState>): boolean {
	return [...codemodeCalls.values()].some((state) => state.boundary !== undefined);
}

function isSingleToolCall(ctx: BranchContext, toolCallId: string, toolName: string): boolean {
	const toolCalls = getCurrentToolCalls(ctx);
	return toolCalls.length === 1 && toolCalls[0]?.id === toolCallId && toolCalls[0].name === toolName;
}

function requireTaskBoundaryCall(
	ctx: BranchContext,
	toolCallId: string,
	toolName: TaskBoundaryToolName,
	codemodeCalls: ReadonlyMap<string, CodemodeCallState>,
	codemodeTaskCallParents: ReadonlyMap<string, string>,
): string | undefined {
	const parentToolCallId = codemodeTaskCallParents.get(toolCallId);
	if (parentToolCallId === undefined) {
		requireIsolatedTaskCall(ctx, toolCallId, toolName);
		return undefined;
	}

	const state = codemodeCalls.get(parentToolCallId);
	if (
		state?.nestedCallCount === 1 &&
		state.boundary?.toolCallId === toolCallId &&
		state.boundary.toolName === toolName
	) {
		return parentToolCallId;
	}

	throw taskError("not_isolated", `${toolName} can run through codemode only as its sole nested tool call.`);
}

function hasOnlySuccessfulCodemodeBoundary(details: unknown, toolName: TaskBoundaryToolName): boolean {
	if (!Predicate.isObject(details) || !Array.isArray(details.calls) || details.calls.length !== 1) return false;
	const call = details.calls[0];
	return Predicate.isObject(call) && call.name === toolName && call.status === "ok";
}

function formatQueueStatus(active: ActiveQueue): string {
	const counts = taskCounts(active);
	if (active.cancelled !== undefined) return `! Tasks canceled · ${formatTaskCounts(counts)}`;
	if (hasTaskIssues(counts)) return `! Tasks finished with issues · ${formatTaskCounts(counts)}`;
	return `✓ Tasks ${finishedCount(active)}/${active.queue.tasks.length} complete`;
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
				const paths = taskPaths(observeToolFiles(block.name, block.arguments, ctx.cwd).mutationPaths, ctx.cwd);
				if (paths.length > 0) mutationPaths.set(block.id, paths);
			}
			continue;
		}

		if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "codemode") {
			const details = entry.message.details;
			if (Predicate.isObject(details) && Array.isArray(details.taskChangedFiles)) {
				for (const path of details.taskChangedFiles) {
					if (typeof path === "string") changed.add(path);
				}
			}
		}

		if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.isError) continue;
		const callId = entry.message.toolCallId;
		if (typeof callId !== "string") continue;
		for (const path of mutationPaths.get(callId) ?? []) changed.add(path);
	}
	return [...changed];
}

function taskPaths(paths: readonly string[], cwd: string): string[] {
	return paths.map((path) => {
		const relativePath = relative(cwd, path).replaceAll("\\", "/");
		if (relativePath.length === 0) return ".";
		if (relativePath !== ".." && !relativePath.startsWith("../")) return relativePath;
		return path.replaceAll("\\", "/");
	});
}

function setEnabled(
	pi: ExtensionAPI,
	toolSelection: ToolSelection,
	ctx: ExtensionCommandContext,
	enabled: boolean,
	refresh?: () => void,
): void {
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
	syncTaskToolVisibility(toolSelection, ctx, enabled);
	refresh?.();
	if (!enabled) ctx.ui.setStatus(TASK_STATUS_KEY, "Tasks off");
}

function cancelActiveQueue(pi: ExtensionAPI, ctx: ExtensionCommandContext, reason: string, refresh?: () => void): void {
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
	const details = cancelQueue(active, reason);
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
	const counts = taskCounts(active);
	const countText = formatTaskCounts(counts);
	const finish = pendingCompaction(active);
	if (finish !== undefined) {
		ctx.ui.notify(`Task outcome recorded: ${titleOf(active, finish.taskId)} (${countText}).`, "info");
		return;
	}
	const item = currentItem(active);
	if (item === undefined) {
		ctx.ui.notify(
			active.cancelled !== undefined
				? `Task queue canceled (${countText}).`
				: hasTaskIssues(counts)
					? `Task queue finished with issues (${countText}).`
					: `Task queue complete (${finishedCount(active)}/${active.queue.tasks.length}).`,
			"info",
		);
		return;
	}
	ctx.ui.notify(
		hasTaskIssues(counts)
			? `Task queue: ${countText}. Current: ${item.title}`
			: `Task queue: ${finishedCount(active)}/${active.queue.tasks.length} complete. Current: ${item.title}`,
		"info",
	);
}

function ensureTasksEnabled(ctx: BranchContext): void {
	if (tasksEnabled(ctx)) return;
	throw taskError("tasks_disabled", "Tasks are disabled for this session. A user can re-enable them with /tasks on.");
}

/**
 * Ask for the current task's outcome once the model stops with it unfinished. The
 * reminder is recorded in the branch, so a task the model already declined to
 * finish is nudged once rather than every time it settles.
 */
function scheduleTaskReminder(pi: ExtensionAPI, ctx: BranchContext): Effect.Effect<void> {
	const active = getActiveQueue(ctx);
	const current = active === undefined ? undefined : currentItem(active);
	if (active === undefined || current === undefined) return Effect.void;
	const { queueId } = active.queue;
	if (wasReminded(ctx, queueId, current.id) || stoppedByUserOrError(ctx)) return Effect.void;

	return Effect.sleep(Duration.millis(0)).pipe(
		Effect.andThen(
			Effect.sync(() =>
				pi.sendMessage(
					{
						customType: TASK_REMINDER_TYPE,
						content: taskReminderPrompt(current),
						display: false,
						details: { queueId, taskId: current.id },
					},
					{ triggerTurn: true, deliverAs: "followUp" },
				),
			),
		),
	);
}

function wasReminded(ctx: BranchContext, queueId: string, taskId: string): boolean {
	return ctx.sessionManager
		.getBranch()
		.some(
			(entry) =>
				entry.type === "custom_message" &&
				entry.customType === TASK_REMINDER_TYPE &&
				Predicate.isObject(entry.details) &&
				entry.details.queueId === queueId &&
				entry.details.taskId === taskId,
		);
}

/** An interrupt or a failed request is a deliberate stop, not a pause to nudge. */
function stoppedByUserOrError(ctx: BranchContext): boolean {
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry?.type !== "message" || entry.message.role !== "assistant") continue;
		return entry.message.stopReason === "aborted" || entry.message.stopReason === "error";
	}
	return false;
}

function scheduleContinuation(pi: ExtensionAPI, text: string): Effect.Effect<void> {
	return Effect.sleep(Duration.millis(0)).pipe(
		Effect.andThen(
			Effect.sync(() =>
				pi.sendMessage(
					{
						customType: TASK_CONTINUE_TYPE,
						content: text,
						display: false,
					},
					{ triggerTurn: true, deliverAs: "followUp" },
				),
			),
		),
	);
}

function syncTaskToolVisibility(toolSelection: ToolSelection, ctx: BranchContext, enabled = tasksEnabled(ctx)): void {
	if (!conversationStarted(ctx)) {
		applyToolVisibility(toolSelection, enabled);
		return;
	}
	const active = getActiveQueue(ctx);
	if (enabled && active !== undefined && !queueIsClosed(active)) activateTaskTools(toolSelection);
}

function applyToolVisibility(toolSelection: ToolSelection, enabled: boolean): void {
	toolSelection.setTaskTools(enabled ? TASK_BOOTSTRAP_TOOL_NAMES : []);
}

/** Add the finish tool after the queue loader succeeds so Pi can defer its definition. */
function activateTaskTools(toolSelection: ToolSelection): void {
	toolSelection.setTaskTools(TASK_TOOL_NAMES);
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
	if (isSingleToolCall(ctx, toolCallId, toolName)) return;
	throw taskError(
		"not_isolated",
		`${toolName} must be the only tool call in its assistant turn, or the only nested tool call in a codemode script.`,
	);
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
	return latestActive(replay(ctx.sessionManager.getBranch()));
}
