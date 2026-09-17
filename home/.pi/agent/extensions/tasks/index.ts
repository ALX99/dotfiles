import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { isAbsolute, relative } from "node:path";
import { Check } from "typebox/value";
import { Predicate } from "effect";
import { FinishTaskParams, registerTaskTools, TASK_TOOL_NAMES } from "./tools.ts";
import { showTaskDashboard, toDashboardQueue } from "./dashboard.ts";
import {
	buildOutcome,
	cancelQueue,
	createQueue,
	currentItem,
	finalSummaryPrompt,
	finishQueueMessage,
	finishedCount,
	formatAddedTask,
	formatOutcome,
	formatQueueProgress,
	formatTaskCounts,
	formatTaskRecovery,
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
	titleOf,
	type ActiveQueue,
} from "./state.ts";

export { TASK_TOOL_NAMES };

const TASK_RECOVERY_MESSAGE_TYPE = "tasks:recovery";
const TASK_CONTINUE_TYPE = "tasks:continue";
const TASK_TOGGLE_TYPE = "tasks:toggle";
const TASK_STATUS_KEY = "tasks";

const TASK_BOOTSTRAP_TOOL_NAMES = ["create_tasks"] as const;
const TASK_TOOL_SET = new Set<string>(TASK_TOOL_NAMES);
const TASK_COMPACTION_MARKER = "⟳";

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

export default function tasksExtension(pi: ExtensionAPI): void {
	let printTaskFinished = false;

	let refreshDashboard: (() => void) | undefined;
	const refreshStatus = (ctx: TaskStatusContext): void => {
		updateTaskStatus(ctx);
		refreshDashboard?.();
	};

	registerTaskTools(pi, {
		async create(toolCallId, params, ctx) {
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

			const details = createQueue(params.tasks);
			const { tasks } = details;
			activateTaskTools(pi);
			ctx.ui.setStatus(TASK_STATUS_KEY, formatTaskLabel(0, tasks.length, tasks[0]!.title));
			return {
				content: [
					{
						type: "text",
						text: [
							`Queued ${tasks.length} tasks.`,
							...tasks.map((task, index) => `${index + 1}. ${task.id}: ${task.title}`),
							"Work them in order and call finish_task alone after each task to record its outcome.",
						].join("\n"),
					},
				],
				details,
			};
		},
		async finish(toolCallId, params, ctx) {
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
				throw taskError("no_queue", "No task queue is active. Call create_tasks first.");
			}
			const details = buildOutcome(active, {
				status: params.status,
				outcome: params.outcome,
				additions: params.addTasks,
				changedFiles: changedFilesForTask(ctx, active),
				checkpoint: ctx.mode === "print" ? "inline" : "rewrite",
			});
			if (ctx.mode === "print") printTaskFinished = true;

			const projected = projectOutcome(active, details);
			const next = currentItem(projected);
			const completedCount = finishedCount(projected);
			const taskNumber = positionOf(active, details.taskId);
			const total = projected.queue.tasks.length;
			ctx.ui.setStatus(
				TASK_STATUS_KEY,
				details.checkpoint === "rewrite"
					? `${TASK_COMPACTION_MARKER} Task ${taskNumber}/${total} · compacting`
					: `Task ${taskNumber}/${total} · recorded`,
			);
			return {
				content: [
					{
						type: "text",
						text: [
							`Task outcome recorded (${completedCount}/${total}).`,
							...(details.addedTasks.length === 0
								? []
								: [`Added: ${details.addedTasks.map(formatAddedTask).join("; ")}`]),
							next === undefined ? finishQueueMessage(projected, params.status) : `Next: ${next.id}: ${next.title}.`,
						].join(" "),
					},
				],
				details,
				terminate: details.checkpoint === "rewrite",
			};
		},
	});

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
				setEnabled(pi, ctx, action === "on", () => refreshStatus(ctx));
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
			ctx.ui.notify(`Task compacted: ${titleOf(active, finish.taskId)}. Continue from its outcome.`, "info");
			const next = currentItem(active);
			if (ctx.mode !== "print") {
				scheduleContinuation(pi, next === undefined ? finalSummaryPrompt(active) : nextTaskPrompt(next));
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
		refreshStatus(ctx);
	});

	pi.on("agent_start", () => {
		printTaskFinished = false;
	});

	pi.on("session_tree", (_event, ctx) => {
		refreshStatus(ctx);
	});

	pi.on("agent_settled", (_event, ctx) => {
		refreshStatus(ctx);
		if (ctx.mode === "print" || !tasksEnabled(ctx) || pendingCompaction(getActiveQueue(ctx)) === undefined) return;
		pi.sendUserMessage("/tasks commit", { expandPromptTemplates: true });
	});

	pi.on("session_shutdown", (_event, ctx) => {
		printTaskFinished = false;
		ctx.ui.setStatus(TASK_STATUS_KEY, undefined);
	});
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

	ctx.ui.setStatus(TASK_STATUS_KEY, formatTaskLabel(finishedCount(active), active.queue.tasks.length, item.title));
}

function formatTaskLabel(completedCount: number, total: number, title: string): string {
	return `${completedCount}/${total} complete · ${title}`;
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
		pi.sendMessage(
			{
				customType: TASK_CONTINUE_TYPE,
				content: text,
				display: false,
			},
			{ triggerTurn: true, deliverAs: "followUp" },
		);
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
	return latestActive(replay(ctx.sessionManager.getBranch()));
}
