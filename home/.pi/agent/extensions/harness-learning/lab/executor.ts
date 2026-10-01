import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/pi-ai";
import { Cause, DateTime, Effect, Exit, Result } from "effect";
import { renderGuidance } from "../procedures.ts";
import { LAB_CODING_TOOLS, type LabSandbox } from "./docker.ts";
import { LabRequestError, requestLabModel, type LabModels } from "./model.ts";
import { LabError, MAX_TASK_TRACE_CHARS, type LabTaskEvent, type LabTaskOutcome } from "./schema.ts";
import { appendLabEvent, labTaskPlan } from "./state.ts";
import { appendLabStoreEvent, loadLabStore, type LabStore } from "./store.ts";

export type LabTrial = Pick<LabTaskEvent, "phase" | "candidateId" | "taskId" | "repeat" | "arm">;
const MAX_TOOLS_PER_RESPONSE = 8;
const EXECUTOR_PROMPT =
	"You are a coding agent working only in an isolated /workspace. Solve the supplied task using the available tools. " +
	"Read the relevant files before editing. Use relative paths for read/write and argv for exec. " +
	"The evaluator is separate and unavailable. Finish with a short report after making the solution. " +
	"Do not seek credentials, network access, hidden tests, or host resources.";

/** Full coding execution, artifact export, and fresh-container verification; no production state is changed. */
export const executeLabTask = Effect.fn("harnessLearning.executeLabTask")(
	(store: LabStore, models: LabModels, sandbox: LabSandbox, trial: LabTrial) =>
		Effect.uninterruptibleMask((restore) =>
			Effect.gen(function* () {
				const loaded = yield* loadLabStore(store);
				const state = loaded.state;
				const plan = yield* Effect.fromResult(labTaskPlan(state, trial.phase, trial.candidateId));
				const task = plan.tasks.find((entry) => entry.id === trial.taskId);
				if (task === undefined) return yield* new LabError({ message: "Task is not in the current evaluation plan" });
				const at = DateTime.toEpochMillis(yield* DateTime.now);
				const event: LabTaskEvent = {
					id: randomUUID(),
					at,
					kind: "task",
					...trial,
					candidateId: plan.candidateId,
					baselineVersion: plan.baselineVersion,
					model: state.started.config.targetModel,
					requestIds: [],
					trace: "",
					outcome: { status: "error", failure: "environment", message: "Task has not executed" },
				};
				// Exercise the owning domain's exact matrix/duplicate checks before spending on any request.
				yield* Effect.fromResult(appendLabEvent(loaded.document, event));
				const limits = state.started.config.limits;
				const timeoutMs = Math.min(limits.maxTaskTimeMs, state.started.at + limits.maxWallTimeMs - at);
				if (timeoutMs <= 0)
					return yield* new LabRequestError({ failure: "budget", message: "Task wall-time budget exhausted" });
				const requestIds: string[] = [];
				let trace = "";
				const addTrace = (text: string): void => {
					const marker = "\n[Remaining execution trace elided at the storage limit]";
					const remaining = MAX_TASK_TRACE_CHARS - marker.length - trace.length;
					if (remaining > 0) trace += text.slice(0, remaining);
					if (text.length > remaining && !trace.endsWith(marker)) trace += marker;
				};
				const body = Effect.gen(function* () {
					const artifacts = yield* sandbox.withWorkspace(task.files, (workspace) =>
						Effect.gen(function* () {
							const guidance = renderGuidance(trial.arm === "baseline" ? plan.baseline : (plan.candidate ?? []));
							const context: Context = {
								systemPrompt: `${EXECUTOR_PROMPT}${guidance ? `\n\n${guidance}` : ""}`,
								messages: [
									{
										role: "user",
										content: `${task.prompt}\n\nInitial files:\n${task.files.map((file) => file.path).join("\n")}`,
										timestamp: at,
									},
								],
								tools: LAB_CODING_TOOLS,
							};
							for (let turn = 0; turn < limits.maxTurnsPerTask; turn++) {
								const response = yield* requestLabModel(store, models, "executor", context, (id) =>
									requestIds.push(id),
								);
								const calls = response.message.content.filter((block) => block.type === "toolCall");
								if (calls.length > MAX_TOOLS_PER_RESPONSE)
									return yield* new LabRequestError({
										failure: "model",
										message: "Model exceeded the tool-call limit",
									});
								context.messages.push(response.message);
								for (const block of response.message.content) {
									if (block.type === "text") addTrace(`assistant: ${block.text}\n`);
									if (block.type === "toolCall") addTrace(`tool ${block.name}: ${JSON.stringify(block.arguments)}\n`);
								}
								if (calls.length === 0) {
									if (response.message.stopReason !== "stop")
										return yield* new LabRequestError({
											failure: "model",
											message: "Model requested tools without supplying a call",
										});
									return yield* workspace.export(task.solutionPaths);
								}
								if (response.message.stopReason !== "toolUse")
									return yield* new LabRequestError({
										failure: "model",
										message: "Model returned calls without a tool-use stop",
									});
								for (const call of calls) {
									const result = yield* workspace.call(call);
									addTrace(`${call.name}: ${result.text}\n`);
									context.messages.push({
										role: "toolResult",
										toolCallId: call.id,
										toolName: call.name,
										content: [{ type: "text", text: result.text }],
										isError: result.isError,
										timestamp: DateTime.toEpochMillis(yield* DateTime.now),
									});
								}
							}
							return yield* new LabRequestError({
								failure: "model",
								message: "Coding task exhausted its model-turn limit",
							});
						}),
					);
					const verification = yield* sandbox.verify(task, artifacts);
					return { status: "completed" as const, artifacts, ...verification };
				}).pipe(
					Effect.timeout(timeoutMs),
					Effect.mapError((error) =>
						error instanceof LabError || error instanceof LabRequestError
							? error
							: new LabError({ message: "Coding task timed out" }),
					),
				);
				const result = yield* Effect.exit(restore(body));
				let outcome: LabTaskOutcome;
				if (Exit.isSuccess(result)) outcome = result.value;
				else {
					const failure = Cause.findError(result.cause);
					const error = Result.isSuccess(failure) ? failure.success : undefined;
					outcome = {
						status: "error",
						failure: Cause.hasInterrupts(result.cause)
							? "cancelled"
							: error instanceof LabRequestError
								? error.failure
								: "environment",
						message: (error?.message ?? Cause.pretty(result.cause)).slice(0, 1000).trim() || "Task failed",
					};
				}
				const current = yield* loadLabStore(store);
				const completed: LabTaskEvent = {
					...event,
					at: Math.max(current.state.lastAt, DateTime.toEpochMillis(yield* DateTime.now)),
					requestIds,
					trace,
					outcome,
				};
				yield* appendLabStoreEvent(store, completed);
				if (Exit.isFailure(result) && Cause.hasInterrupts(result.cause)) return yield* Effect.failCause(result.cause);
				return completed;
			}),
		),
);
