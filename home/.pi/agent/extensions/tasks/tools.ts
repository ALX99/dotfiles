import { StringEnum } from "@earendil-works/pi-ai";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

export const TASK_TOOL_NAMES = ["create_tasks", "finish_task"] as const;
export const TASK_OUTCOME_STATUSES = ["completed", "failed", "blocked"] as const;
export const MIN_TASKS = 1;
export const MAX_TASKS = 100;
export const MAX_ADDED_TASKS = 20;

export const CreateTasksParams = Type.Object(
	{
		tasks: Type.Array(
			Type.String({
				minLength: 1,
				maxLength: 200,
				description: "Task title",
			}),
			{
				minItems: MIN_TASKS,
				maxItems: MAX_TASKS,
				description: "Ordered task titles",
			},
		),
	},
	{ additionalProperties: false },
);

export type CreateTasksParams = Static<typeof CreateTasksParams>;

export const FinishTaskParams = Type.Object(
	{
		status: StringEnum(TASK_OUTCOME_STATUSES, {
			description: "Task status",
		}),
		outcome: Type.String({
			minLength: 1,
			description:
				"Write a handoff for an agent continuing after this task's working context is removed. Include the concrete result, relevant files and symbols, decisions and why they matter, verification performed and its result, and anything the next task must preserve or resolve. Be concise, but do not omit details needed to continue. Do not narrate the work.",
		}),
		addTasks: Type.Optional(
			Type.Array(
				Type.Object(
					{
						title: Type.String({
							minLength: 1,
							maxLength: 200,
							description: "Task title",
						}),
						after: Type.Optional(
							Type.Union([
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
						"Add follow-up tasks discovered during this task; they need not be known when the queue is created. Omit after to run them next, use end to append, or a pending task ID to insert after that task.",
				},
			),
		),
	},
	{ additionalProperties: false },
);

export type FinishTaskParams = Static<typeof FinishTaskParams>;

export interface TaskToolHandlers {
	readonly create: (
		toolCallId: string,
		params: CreateTasksParams,
		ctx: ExtensionContext,
	) => Promise<AgentToolResult<unknown>>;
	readonly finish: (
		toolCallId: string,
		params: FinishTaskParams,
		ctx: ExtensionContext,
	) => Promise<AgentToolResult<unknown>>;
}

export function registerTaskTools(pi: ExtensionAPI, handlers: TaskToolHandlers): void {
	pi.registerTool({
		name: "create_tasks",
		label: "Create Tasks",
		description:
			"Create an ordered task queue of 1–100 titles. Start with one discovery task if follow-ups are unknown; add them with finish_task.addTasks as you learn what is needed.",
		parameters: CreateTasksParams,
		executionMode: "sequential",
		execute(toolCallId, params, _signal, _onUpdate, ctx) {
			return handlers.create(toolCallId, params, ctx);
		},
	});

	pi.registerTool({
		name: "finish_task",
		label: "Finish Task",
		description: "Record the outcome of the current task and optionally add newly discovered follow-up tasks.",
		parameters: FinishTaskParams,
		executionMode: "sequential",
		execute(toolCallId, params, _signal, _onUpdate, ctx) {
			return handlers.finish(toolCallId, params, ctx);
		},
	});
}
