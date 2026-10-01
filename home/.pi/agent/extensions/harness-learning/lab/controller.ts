import { randomUUID } from "node:crypto";
import { Cause, DateTime, Effect, Exit, Result } from "effect";
import type { LabSandbox } from "./docker.ts";
import { executeLabTask } from "./executor.ts";
import { LabRequestError, requestLabModel, type LabModels } from "./model.ts";
import { decodeLabProposal, labResearchContext } from "./research.ts";
import { LabError, type LabFinished, type LabTaskEvent } from "./schema.ts";
import { developmentGate, finalGate, labBudget, labRequestBounds, labResearchEvidence, labTaskPlan } from "./state.ts";
import { appendLabStoreEvent, loadLabStore, type LabStore } from "./store.ts";

type Conclusion = Pick<LabFinished, "status" | "reason">;

const envelope = Effect.fnUntraced(function* (store: LabStore) {
	const { state } = yield* loadLabStore(store);
	return { id: randomUUID(), at: Math.max(state.lastAt, DateTime.toEpochMillis(yield* DateTime.now)) };
});

const evaluatePlan = Effect.fn("harnessLearning.labEvaluatePlan")(function* (
	store: LabStore,
	models: LabModels,
	sandbox: LabSandbox,
	phase: LabTaskEvent["phase"],
	candidateId: string | null = null,
) {
	const { state } = yield* loadLabStore(store);
	const plan = yield* Effect.fromResult(labTaskPlan(state, phase, candidateId));
	for (const [index, task] of plan.tasks.entries()) {
		for (let repeat = 0; repeat < plan.repeats; repeat++) {
			const arms =
				phase === "seed"
					? (["baseline"] as const)
					: (index + repeat) % 2 === 0
						? (["baseline", "candidate"] as const)
						: (["candidate", "baseline"] as const);
			for (const arm of arms) {
				const result = yield* executeLabTask(store, models, sandbox, {
					phase,
					candidateId: plan.candidateId,
					taskId: task.id,
					repeat,
					arm,
				});
				if (result.outcome.status === "error")
					return yield* new LabRequestError({
						failure: result.outcome.failure === "budget" ? "budget" : "model",
						message: `Invalid ${phase} execution for ${task.id}: ${result.outcome.message}`,
					});
			}
		}
	}
	return undefined;
});

const improve = Effect.fn("harnessLearning.labImprove")(function* (
	store: LabStore,
	models: LabModels,
	sandbox: LabSandbox,
): Effect.fn.Return<Conclusion, LabError | LabRequestError> {
	yield* evaluatePlan(store, models, sandbox, "seed");
	let stopReason = "Candidate limit reached";
	while (true) {
		const { state } = yield* loadLabStore(store);
		if (labResearchEvidence(state).length === 0) {
			stopReason = "No recurring current development failure remains";
			break;
		}
		if (state.candidates.length >= state.started.config.limits.maxCandidates) break;
		const bounds = labRequestBounds(state.started.config);
		if (
			labBudget(state).requests + bounds.developmentPerCandidate + bounds.holdout >
			state.started.config.limits.maxRequests
		) {
			stopReason = "Insufficient request capacity for another candidate plus the reserved final holdout";
			break;
		}
		const now = DateTime.toEpochMillis(yield* DateTime.now);
		const response = yield* requestLabModel(store, models, "researcher", labResearchContext(state, now));
		const proposal = yield* decodeLabProposal(
			response.message.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("\n"),
		);
		const eligible = new Set(labResearchEvidence(state).map((task) => task.id));
		if (proposal.evidenceIds.some((id) => !eligible.has(id)))
			return yield* new LabError({ message: "Researcher cited evidence outside the current experimental failures" });
		const candidateId = randomUUID();
		yield* appendLabStoreEvent(store, {
			...proposal,
			...(yield* envelope(store)),
			id: candidateId,
			kind: "candidate",
			requestId: response.requestId,
		});
		yield* evaluatePlan(store, models, sandbox, "development", candidateId);
		const evaluated = (yield* loadLabStore(store)).state;
		const gate = developmentGate(evaluated, candidateId);
		yield* appendLabStoreEvent(store, {
			...(yield* envelope(store)),
			kind: "selection",
			candidateId,
			decision: gate.eligible ? "accept" : "reject",
			reason: gate.eligible
				? "Complete repeated paired development gate passed"
				: gate.reasons.join("; ").slice(0, 1000),
		});
	}
	const { state } = yield* loadLabStore(store);
	if (state.head.candidateId === null) return { status: "stopped", reason: stopReason };
	yield* evaluatePlan(store, models, sandbox, "holdout");
	const gate = finalGate((yield* loadLabStore(store)).state);
	return gate.eligible
		? { status: "completed", reason: "Shortlisted pool passed the one-shot repeated paired final holdout gate" }
		: { status: "failed", reason: gate.reasons.join("; ").slice(0, 1000) };
});

/** A durable single-controller claim forbids concurrent launch and crash resumption. Production is never written. */
export const runLabController = Effect.fn("harnessLearning.runLabController")(
	(store: LabStore, models: LabModels, sandbox: LabSandbox) =>
		Effect.uninterruptibleMask((restore) =>
			Effect.gen(function* () {
				const claimed = yield* appendLabStoreEvent(store, {
					...(yield* envelope(store)),
					kind: "controller-start",
				});
				const remaining = claimed.started.at + claimed.started.config.limits.maxWallTimeMs - claimed.lastAt;
				const exit = yield* Effect.exit(
					restore(
						improve(store, models, sandbox).pipe(
							Effect.timeout(Math.max(1, remaining)),
							Effect.mapError((error) =>
								error instanceof LabError || error instanceof LabRequestError
									? error
									: new LabRequestError({ failure: "budget", message: "Laboratory wall-time deadline elapsed" }),
							),
						),
					),
				);
				let conclusion: Conclusion;
				if (Exit.isSuccess(exit)) conclusion = exit.value;
				else {
					const error = Cause.findError(exit.cause);
					const value = Result.isSuccess(error) ? error.success : undefined;
					conclusion = {
						status: Cause.hasInterrupts(exit.cause)
							? "cancelled"
							: value instanceof LabRequestError && value.failure === "budget"
								? "stopped"
								: "failed",
						reason: (value?.message ?? Cause.pretty(exit.cause)).slice(0, 1000).trim() || "Laboratory run failed",
					};
				}
				const finalEnvelope = yield* envelope(store);
				if (conclusion.status === "completed") {
					const current = (yield* loadLabStore(store)).state;
					const gate = finalGate({ ...current, lastAt: finalEnvelope.at });
					if (!gate.eligible) conclusion = { status: "failed", reason: gate.reasons.join("; ").slice(0, 1000) };
				}
				const finished = yield* appendLabStoreEvent(store, {
					...finalEnvelope,
					kind: "finished",
					...conclusion,
				});
				if (Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)) return yield* Effect.failCause(exit.cause);
				return finished;
			}),
		),
);
