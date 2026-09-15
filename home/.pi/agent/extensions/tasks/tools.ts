import { StringEnum } from "@earendil-works/pi-ai";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

export const TASK_TOOL_NAMES = ["create_tasks", "finish_task"] as const;
export const TASK_OUTCOME_STATUSES = ["completed", "failed", "blocked"] as const;
export const MIN_TASKS = 4;
export const MAX_TASKS = 100;
export const MAX_ADDED_TASKS = 20;

export const CreateTasksParams = Type.Object(
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

export type CreateTasksParams = Static<typeof CreateTasksParams>;

export const FinishTaskParams = Type.Object(
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
			"Create a task queue for genuinely complex multi-phase work, then work the tasks in order with finish_task.",
		promptSnippet: "Create a task queue for genuinely complex multi-phase work",
		promptGuidelines: [
			"Use create_tasks rarely, only for genuinely complex work with at least four substantial, independently useful phases that need separate checkpoints. Never pad to four items or split routine reading, coding, testing, review, or verification; complete small or straightforward edits directly.",
		],
		parameters: CreateTasksParams,
		executionMode: "sequential",
		execute(toolCallId, params, _signal, _onUpdate, ctx) {
			return handlers.create(toolCallId, params, ctx);
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
		execute(toolCallId, params, _signal, _onUpdate, ctx) {
			return handlers.finish(toolCallId, params, ctx);
		},
	});
}
