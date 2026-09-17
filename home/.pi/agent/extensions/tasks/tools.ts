import { StringEnum } from "@earendil-works/pi-ai";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

export const TASK_TOOL_NAMES = ["create_tasks", "finish_task"] as const;
export const TASK_OUTCOME_STATUSES = ["completed", "failed", "blocked"] as const;
export const MIN_TASKS = 2;
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
			description: "Task outcome",
		}),
		summary: Type.String({
			minLength: 1,
			maxLength: 6000,
			description: "Outcome and context needed to continue",
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
		description: "Create an ordered task queue for multi-step work.",
		// promptGuidelines: ["Call create_tasks as the only tool in its turn."],
		parameters: CreateTasksParams,
		executionMode: "sequential",
		execute(toolCallId, params, _signal, _onUpdate, ctx) {
			return handlers.create(toolCallId, params, ctx);
		},
	});

	pi.registerTool({
		name: "finish_task",
		label: "Finish Task",
		description: "Record the outcome of the current task and optionally add newly discovered tasks.",
		// promptGuidelines: ["Call finish_task as the only tool in its turn."],
		parameters: FinishTaskParams,
		executionMode: "sequential",
		execute(toolCallId, params, _signal, _onUpdate, ctx) {
			return handlers.finish(toolCallId, params, ctx);
		},
	});
}
