import { StringEnum } from "@earendil-works/pi-ai";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

export const TASK_TOOL_NAMES = ["create_tasks", "finish_task"] as const;
export const TASK_OUTCOME_STATUSES = ["completed", "failed", "blocked"] as const;
export const MIN_TASKS = 1;
export const MAX_TASKS = 100;
export const MAX_ADDED_TASKS = 20;
export const MAX_TASK_TITLE_LENGTH = 400;

const TASK_TITLE_DESCRIPTION = `State an observable result and how completion will be checked, not just an activity. Keep the title at most ${MAX_TASK_TITLE_LENGTH} characters.`;

/**
 * These descriptions are re-sent on every request of every session, so they are a
 * fixed tax on the context window rather than a one-off. Every rule below is
 * load-bearing: `tests/tools.test.ts` pins each one, so trimming can remove
 * wording but not a requirement. Prose that restates another rule is the only
 * thing worth cutting.
 */
const OUTCOME_DESCRIPTION =
	"Handoff for whoever continues after this task's context is removed. Use Result, Verification, and Preserve/Next headings. State the result, the files and symbols involved, and decisions with their rationale. Report the checks you ran and their results; separate confirmed from assumed, and say what is unverified. Keep ruled-out approaches and why they failed, so later tasks do not retry them. Carry forward user constraints, scope and authorization limits, and unresolved blockers. Be concise; omit only what a later task needs. Do not narrate.";

export const CreateTasksParams = Type.Object(
	{
		tasks: Type.Array(
			Type.String({
				minLength: 1,
				maxLength: MAX_TASK_TITLE_LENGTH,
				description: TASK_TITLE_DESCRIPTION,
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
			description:
				"completed when the stated result is achieved, failed when the attempt did not achieve it, blocked when a prerequisite prevents progress. Disclose verification gaps in the outcome.",
		}),
		outcome: Type.String({
			minLength: 1,
			description: OUTCOME_DESCRIPTION,
		}),
		addTasks: Type.Optional(
			Type.Array(
				Type.Object(
					{
						title: Type.String({
							minLength: 1,
							maxLength: MAX_TASK_TITLE_LENGTH,
							description: TASK_TITLE_DESCRIPTION,
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
						"Add follow-up tasks discovered during this task; they need not be known upfront. Omit after to run them next, use end to append, or a pending task ID to insert after that task.",
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

/**
 * Tool-level descriptions are sent on every request. They carry the rules a model
 * needs *before* it calls the tool, because that is when those rules take effect:
 * what shape the first queue should take, and how the call itself is constrained.
 * Run #7 measured what happens when they do not: moving the planning guidance
 * into the create_tasks result left the model choosing a three-task queue before
 * it ever read the advice to start with one.
 */
export const CREATE_TASKS_DESCRIPTION =
	"Create an ordered task queue of 1\u2013100 titles. Use it to plan work before doing it and to track that work: create one planning task to work out the approach, then add the tasks the planning produced. Start with one discovery task if follow-ups are unknown, and add them with finish_task.addTasks as you learn what is needed. In codemode, make create_tasks the script's only nested tool call.";

export const FINISH_TASK_DESCRIPTION =
	"Record the outcome of the current task and optionally add newly discovered follow-up tasks. In codemode, make finish_task the script's only nested tool call.";

/**
 * The queue protocol, delivered when a queue exists rather than on every request.
 * Every rule here is pinned by `tests/tools.test.ts`.
 */
export function registerTaskTools(pi: ExtensionAPI, handlers: TaskToolHandlers): void {
	pi.registerTool({
		name: "create_tasks",
		label: "Create Tasks",
		description: CREATE_TASKS_DESCRIPTION,
		parameters: CreateTasksParams,
		executionMode: "sequential",
		execute(toolCallId, params, _signal, _onUpdate, ctx) {
			return handlers.create(toolCallId, params, ctx);
		},
	});

	pi.registerTool({
		name: "finish_task",
		label: "Finish Task",
		description: FINISH_TASK_DESCRIPTION,
		parameters: FinishTaskParams,
		executionMode: "sequential",
		execute(toolCallId, params, _signal, _onUpdate, ctx) {
			return handlers.finish(toolCallId, params, ctx);
		},
	});
}
