import { Result, Schema } from "effect";
import { candidateProcedureIds, sameProcedure, type ProcedureEntry } from "../procedures.ts";
import {
	LabDocumentSchema,
	LabError,
	LabEventSchema,
	LabLimitsSchema,
	MAX_LAB_EVENTS,
	type LabCandidate,
	type LabConfig,
	type LabControllerStart,
	type LabDocument,
	type LabEvent,
	type LabFinished,
	type LabRequestEnd,
	type LabRequestStart,
	type LabSelection,
	type LabStarted,
	type LabTask,
	type LabTaskEvent,
} from "./schema.ts";

export interface LabVersion {
	readonly id: string;
	readonly parentVersion: string | null;
	readonly candidateId: string | null;
	readonly procedureIds: readonly string[];
}

export interface LabState {
	readonly scope: string;
	readonly runId: string;
	readonly started: LabStarted;
	readonly controller: LabControllerStart | null;
	readonly lastAt: number;
	readonly head: LabVersion;
	readonly versions: readonly LabVersion[];
	readonly candidates: readonly LabCandidate[];
	readonly tasks: readonly LabTaskEvent[];
	readonly requestStarts: readonly LabRequestStart[];
	readonly requestEnds: readonly LabRequestEnd[];
	readonly selections: readonly LabSelection[];
	readonly finished: LabFinished | null;
}

export interface LabGate {
	readonly eligible: boolean;
	readonly reasons: readonly string[];
}

export interface LabTaskPlan {
	readonly phase: LabTaskEvent["phase"];
	readonly candidateId: string | null;
	readonly baselineVersion: string;
	readonly tasks: readonly LabTask[];
	readonly repeats: number;
	readonly baseline: readonly ProcedureEntry[];
	readonly candidate: readonly ProcedureEntry[] | null;
}

const decodeDocument = Schema.decodeUnknownResult(LabDocumentSchema, { onExcessProperty: "error" });
const decodeEvent = Schema.decodeUnknownResult(LabEventSchema, { onExcessProperty: "error" });
const decodeRequestBudget = Schema.decodeUnknownResult(
	Schema.Struct({
		reservedTokens: LabLimitsSchema.fields.maxTotalTokens,
		at: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
	}),
	{ onExcessProperty: "error" },
);
const fail = (message: string) => Result.fail(new LabError({ message }));
const gate = (reasons: readonly string[]): LabGate => ({ eligible: reasons.length === 0, reasons });

export function decodeLabDocument(input: unknown): Result.Result<LabDocument, LabError> {
	return decodeDocument(input).pipe(Result.mapError((error) => new LabError({ message: error.message })));
}

/** Only creation can initialize a run. A missing or corrupt existing run never becomes an empty run. */
export function initialLabDocument(scope: string, runId: string): Result.Result<LabDocument, LabError> {
	return decodeLabDocument({ format: 1, scope, runId, events: [] });
}

export function replayLabDocument(input: unknown): Result.Result<LabState, LabError> {
	const decoded = decodeLabDocument(input);
	if (Result.isFailure(decoded)) return Result.fail(decoded.failure);
	const document = decoded.success;
	const started = document.events[0];
	if (started?.kind !== "started") return fail("Laboratory history must begin with its immutable configuration");
	const root: LabVersion = {
		id: "root",
		parentVersion: null,
		candidateId: null,
		procedureIds: started.config.baseline.procedures.map((entry) => entry.id),
	};
	let state: LabState = {
		scope: document.scope,
		runId: document.runId,
		started,
		controller: null,
		lastAt: started.at,
		head: root,
		versions: [root],
		candidates: [],
		tasks: [],
		requestStarts: [],
		requestEnds: [],
		selections: [],
		finished: null,
	};
	const ids = new Set(["root", ...root.procedureIds]);
	if (root.procedureIds.includes("root") || ids.has(started.id)) return fail("History IDs collide with the baseline");
	ids.add(started.id);
	for (const event of document.events.slice(1)) {
		if (ids.has(event.id)) return fail(`Duplicate laboratory history ID: ${event.id}`);
		if (event.at < state.lastAt) return fail("Laboratory event timestamps must be monotonic");
		if (state.finished !== null) return fail("A finished laboratory run cannot be changed or resumed");
		const applied = applyEvent(state, event);
		if (Result.isFailure(applied)) return applied;
		state = { ...applied.success, lastAt: event.at };
		ids.add(event.id);
	}
	return Result.succeed(state);
}

export function appendLabEvent(
	document: LabDocument,
	input: unknown,
): Result.Result<{ document: LabDocument; state: LabState }, LabError> {
	const event = decodeEvent(input);
	if (Result.isFailure(event)) return fail(`Invalid laboratory event: ${event.failure.message}`);
	if (document.events.length >= MAX_LAB_EVENTS)
		return fail(`Laboratory history has reached its ${MAX_LAB_EVENTS}-event capacity`);
	const next = { ...document, events: [...document.events, event.success] };
	return replayLabDocument(next).pipe(Result.map((state) => ({ document: next, state })));
}

export function labProcedures(state: LabState, version: LabVersion = state.head): readonly ProcedureEntry[] {
	const entries: readonly ProcedureEntry[] = [...state.started.config.baseline.procedures, ...state.candidates];
	return version.procedureIds.map((id) => {
		const entry = entries.find((candidate) => candidate.id === id);
		if (entry === undefined) throw new Error(`Invalid internal laboratory procedure reference: ${id}`);
		return entry;
	});
}

/** Current-pool evidence excludes holdouts, infrastructure errors, and weaknesses repaired by an ancestor. */
export function labResearchEvidence(state: LabState): readonly LabTaskEvent[] {
	const failures = state.tasks.filter(
		(task) =>
			task.phase !== "holdout" &&
			task.outcome.status === "completed" &&
			task.outcome.verificationExitCode !== 0 &&
			((task.arm === "baseline" && task.baselineVersion === state.head.id) ||
				(task.arm === "candidate" && task.candidateId === state.head.candidateId)),
	);
	const behaviorFor = (task: LabTaskEvent) =>
		state.started.config.suite.tasks.find((entry) => entry.id === task.taskId)!.behavior;
	return failures.filter(
		(task) =>
			new Set(failures.filter((other) => behaviorFor(other) === behaviorFor(task)).map((other) => other.taskId)).size >=
			2,
	);
}

export function labBudget(state: LabState) {
	return {
		requests: state.requestStarts.length,
		tokens: state.requestEnds.reduce((sum, request) => sum + (request.usage?.tokens ?? 0), 0),
		reportedCostUsd: state.requestEnds.reduce((sum, request) => sum + (request.usage?.costUsd ?? 0), 0),
		pending: state.requestStarts.filter((request) => !state.requestEnds.some((end) => end.requestId === request.id)),
		unreported: state.requestEnds.filter((request) => request.usage === null).map((request) => request.requestId),
	};
}

/** Reserve conservative input-plus-output tokens before the call; actual reported usage is retained even on overshoot. */
export function requestGate(state: LabState, reservedTokens: number, at: number): LabGate {
	const input = decodeRequestBudget({ reservedTokens, at });
	if (Result.isFailure(input)) return gate([input.failure.message]);
	const budget = labBudget(state);
	const limits = state.started.config.limits;
	const reasons = integrityReasons(state, at);
	if (state.finished !== null) reasons.push("The laboratory run is finished");
	if (at < state.lastAt) reasons.push("Request time predates the current history");
	if (at - state.started.at >= limits.maxWallTimeMs) reasons.push("The laboratory wall-time budget is exhausted");
	if (budget.pending.length > 0) reasons.push("Only one model request may be outstanding");
	if (budget.requests >= limits.maxRequests) reasons.push("The model request budget is exhausted");
	if (reservedTokens < limits.maxOutputTokens)
		reasons.push("A request must reserve at least its configured output limit");
	if (budget.tokens + reservedTokens > limits.maxTotalTokens)
		reasons.push("The token reservation exceeds the remaining budget");
	if (budget.reportedCostUsd >= limits.maxReportedCostUsd) reasons.push("The reported cost budget is exhausted");
	return gate(reasons);
}

/** Useful upper bounds, not a promise that a smaller request budget can finish every candidate. */
export function labRequestBounds(config: LabConfig) {
	const developmentTasks = config.suite.tasks.filter((task) => task.kind !== "holdout").length;
	const holdoutTasks = config.suite.tasks.length - developmentTasks;
	const seed = developmentTasks * config.limits.maxTurnsPerTask;
	const developmentPerCandidate = 1 + developmentTasks * config.limits.repeats * 2 * config.limits.maxTurnsPerTask;
	const holdout = holdoutTasks * config.limits.repeats * 2 * config.limits.maxTurnsPerTask;
	return {
		seed,
		developmentPerCandidate,
		holdout,
		total: seed + config.limits.maxCandidates * developmentPerCandidate + holdout,
	};
}

/** Holdout plans always compare the frozen production baseline with the complete shortlisted pool. */
export function labTaskPlan(
	state: LabState,
	phase: LabTaskEvent["phase"],
	candidateId: string | null = null,
): Result.Result<LabTaskPlan, LabError> {
	if (state.finished !== null) return fail("The laboratory run is finished");
	const config = state.started.config;
	if (phase === "seed") {
		if (candidateId !== null || state.candidates.length > 0 || state.tasks.some((task) => task.phase === "holdout"))
			return fail("Seed tasks run only before proposing candidates");
		return Result.succeed({
			phase,
			candidateId: null,
			baselineVersion: "root",
			tasks: config.suite.tasks.filter((task) => task.kind !== "holdout"),
			repeats: 1,
			baseline: config.baseline.procedures,
			candidate: null,
		});
	}
	if (phase === "development") {
		const candidate = state.candidates.find((entry) => entry.id === candidateId);
		if (candidate === undefined) return fail("Unknown laboratory candidate");
		if (state.selections.some((selection) => selection.candidateId === candidateId))
			return fail("Candidate is already decided");
		if (candidate.parentVersion !== state.head.id) return fail("Candidate uses a stale experimental parent");
		if (state.tasks.some((task) => task.phase === "holdout"))
			return fail("Holdout evaluation freezes further development");
		const pool = candidateProcedureIds(labProcedures(state), candidate);
		if (Result.isFailure(pool)) return fail(pool.failure.message);
		return Result.succeed({
			phase,
			candidateId: candidate.id,
			baselineVersion: state.head.id,
			tasks: config.suite.tasks.filter((task) => task.kind !== "holdout"),
			repeats: config.limits.repeats,
			baseline: labProcedures(state),
			candidate: labProcedures(state, { ...state.head, procedureIds: pool.success }),
		});
	}
	if (state.head.candidateId === null) return fail("Holdout evaluation requires an accepted experimental version");
	if (candidateId !== null && candidateId !== state.head.candidateId)
		return fail("Holdout must evaluate the shortlisted version");
	if (pendingCandidate(state) !== undefined) return fail("Decide the pending candidate before holdout evaluation");
	return Result.succeed({
		phase,
		candidateId: state.head.candidateId,
		baselineVersion: "root",
		tasks: config.suite.tasks.filter((task) => task.kind === "holdout"),
		repeats: config.limits.repeats,
		baseline: config.baseline.procedures,
		candidate: labProcedures(state),
	});
}

export function developmentGate(state: LabState, candidateId: string): LabGate {
	const plan = labTaskPlan(state, "development", candidateId);
	if (Result.isFailure(plan)) return gate([plan.failure.message]);
	const candidate = state.candidates.find((entry) => entry.id === candidateId)!;
	return pairedGate(state, plan.success, candidate.procedure.behavior);
}

export function finalGate(state: LabState): LabGate {
	// A completed run replays the same final gate without opening another evaluation.
	const plan = labTaskPlan({ ...state, finished: null }, "holdout");
	if (Result.isFailure(plan)) return gate([plan.failure.message]);
	return pairedGate(state, plan.success, null);
}

/** A final holdout failure, interruption, or partial matrix can never authorize production release. */
export function labReleaseGate(state: LabState): LabGate {
	const reasons = [...finalGate(state).reasons];
	if (state.finished?.status !== "completed") reasons.push("Only a completed, passing laboratory run can be released");
	return gate(reasons);
}

function integrityReasons(state: LabState, at: number): string[] {
	const budget = labBudget(state);
	const limits = state.started.config.limits;
	const reasons: string[] = [];
	if (budget.unreported.length > 0)
		reasons.push("Some requests have unreported usage; no further paid work or promotion is authorized");
	if (state.requestEnds.some((request) => request.status !== "completed"))
		reasons.push("A model request failed or was interrupted");
	if (budget.tokens > limits.maxTotalTokens) reasons.push("Observed token usage exceeded the budget");
	if (budget.reportedCostUsd > limits.maxReportedCostUsd) reasons.push("Reported cost exceeded the budget");
	if (at - state.started.at > limits.maxWallTimeMs) reasons.push("The laboratory wall-time budget was exceeded");
	return reasons;
}

function pairedGate(state: LabState, plan: LabTaskPlan, behavior: string | null): LabGate {
	const reasons = integrityReasons(state, state.lastAt);
	if (labBudget(state).pending.length > 0) reasons.push("Model requests are still outstanding");
	let improved = false;
	for (const task of plan.tasks) {
		for (let repeat = 0; repeat < plan.repeats; repeat++) {
			const baseline = state.tasks.find((entry) => trialMatches(entry, plan, task.id, repeat, "baseline"));
			const candidate = state.tasks.find((entry) => trialMatches(entry, plan, task.id, repeat, "candidate"));
			if (baseline === undefined || candidate === undefined) {
				reasons.push(`Incomplete paired ${plan.phase} result for ${task.id}, repeat ${repeat}`);
				continue;
			}
			if (baseline.outcome.status !== "completed")
				reasons.push(`Baseline execution was invalid for ${task.id}, repeat ${repeat}`);
			if (!taskPassed(candidate)) reasons.push(`Candidate failed ${task.kind} task ${task.id}, repeat ${repeat}`);
			const targeted = plan.phase === "holdout" || (task.kind === "target" && task.behavior === behavior);
			if (targeted && baseline.outcome.status === "completed" && !taskPassed(baseline) && taskPassed(candidate))
				improved = true;
		}
	}
	if (!improved) reasons.push(`No measured ${plan.phase === "holdout" ? "held-out" : "targeted"} improvement`);
	return gate(reasons);
}

function trialMatches(
	event: LabTaskEvent,
	plan: LabTaskPlan,
	taskId: string,
	repeat: number,
	arm: LabTaskEvent["arm"],
): boolean {
	return (
		event.phase === plan.phase &&
		event.candidateId === plan.candidateId &&
		event.baselineVersion === plan.baselineVersion &&
		event.taskId === taskId &&
		event.repeat === repeat &&
		event.arm === arm
	);
}

function taskPassed(task: LabTaskEvent): boolean {
	return task.outcome.status === "completed" && task.outcome.verificationExitCode === 0;
}

function pendingCandidate(state: LabState): LabCandidate | undefined {
	return state.candidates.find(
		(candidate) => !state.selections.some((selection) => selection.candidateId === candidate.id),
	);
}

function seedComplete(state: LabState): boolean {
	return state.started.config.suite.tasks
		.filter((task) => task.kind !== "holdout")
		.every((task) =>
			state.tasks.some(
				(entry) => entry.phase === "seed" && entry.taskId === task.id && entry.outcome.status === "completed",
			),
		);
}

function applyEvent(state: LabState, event: LabEvent): Result.Result<LabState, LabError> {
	switch (event.kind) {
		case "started":
			return fail("A laboratory run's configuration cannot be changed");
		case "controller-start":
			if (
				state.controller !== null ||
				state.requestStarts.length > 0 ||
				state.tasks.length > 0 ||
				state.candidates.length > 0
			)
				return fail("The controller can claim only a fresh run, once; interrupted runs cannot resume");
			return Result.succeed({ ...state, controller: event });
		case "request-start": {
			const result = requestGate(state, event.reservedTokens, event.at);
			if (!result.eligible) return fail(`Request refused: ${result.reasons.join("; ")}`);
			if (
				event.role === "researcher" &&
				(!seedComplete(state) ||
					pendingCandidate(state) !== undefined ||
					state.candidates.length >= state.started.config.limits.maxCandidates ||
					state.tasks.some((task) => task.phase === "holdout"))
			)
				return fail(
					"Researcher requests require seed evidence, a free candidate slot, and an unfrozen development phase",
				);
			return Result.succeed({ ...state, requestStarts: [...state.requestStarts, event] });
		}
		case "request-end": {
			if (
				!state.requestStarts.some((request) => request.id === event.requestId) ||
				state.requestEnds.some((request) => request.requestId === event.requestId)
			)
				return fail("Request completion must reference an outstanding reservation exactly once");
			return Result.succeed({ ...state, requestEnds: [...state.requestEnds, event] });
		}
		case "task": {
			const plan = labTaskPlan(state, event.phase, event.candidateId);
			if (Result.isFailure(plan)) return Result.fail(plan.failure);
			const task = plan.success.tasks.find((entry) => entry.id === event.taskId);
			if (
				task === undefined ||
				event.baselineVersion !== plan.success.baselineVersion ||
				event.repeat >= plan.success.repeats ||
				(event.arm === "candidate" && plan.success.candidate === null)
			)
				return fail("Task does not belong to the current phase, parent, and repeat matrix");
			if (event.model !== state.started.config.targetModel) return fail("Task used a different target model");
			if (state.tasks.some((prior) => trialMatches(prior, plan.success, event.taskId, event.repeat, event.arm)))
				return fail("A task arm and repeat can be recorded only once; holdouts cannot be retried");
			if (event.requestIds.length > state.started.config.limits.maxTurnsPerTask)
				return fail("Task exceeded its model-turn limit");
			if (
				event.requestIds.some(
					(id) =>
						!state.requestStarts.some((request) => request.id === id && request.role === "executor") ||
						!state.requestEnds.some((request) => request.requestId === id) ||
						state.tasks.some((prior) => prior.requestIds.includes(id)),
				)
			)
				return fail("Tasks must reference their own completed executor request reservations");
			if (event.outcome.status === "completed") {
				if (
					event.requestIds.some((id) => state.requestEnds.find((end) => end.requestId === id)?.status !== "completed")
				)
					return fail("A failed model request cannot produce a completed task");
				if (event.outcome.artifacts.some((file) => !task.solutionPaths.includes(file.path)))
					return fail("Task artifacts must be explicitly listed solution files");
			}
			return Result.succeed({ ...state, tasks: [...state.tasks, event] });
		}
		case "candidate": {
			if (!seedComplete(state)) return fail("Complete development seed tasks before proposing a candidate");
			if (state.tasks.some((task) => task.phase === "holdout"))
				return fail("Holdout evaluation freezes further proposals");
			if (pendingCandidate(state) !== undefined) return fail("Decide the pending candidate before proposing another");
			if (state.candidates.length >= state.started.config.limits.maxCandidates)
				return fail("The candidate budget is exhausted");
			if (event.parentVersion !== state.head.id) return fail("Candidate must name the current experimental parent");
			if (
				!state.requestStarts.some((request) => request.id === event.requestId && request.role === "researcher") ||
				!state.requestEnds.some((request) => request.requestId === event.requestId && request.status === "completed") ||
				state.candidates.some((candidate) => candidate.requestId === event.requestId)
			)
				return fail("A candidate must reference its own completed researcher request");
			if (
				[...state.started.config.baseline.procedures, ...state.candidates].some(
					(prior) =>
						sameProcedure(prior, event) &&
						(state.head.procedureIds.includes(prior.id) ||
							("parentVersion" in prior && prior.parentVersion === event.parentVersion)),
				)
			)
				return fail("Duplicate procedure; rejected candidates and their hypotheses remain in history");
			const evidence = event.evidenceIds.map((id) => state.tasks.find((task) => task.id === id));
			if (
				evidence.some(
					(task) =>
						task === undefined ||
						task.phase === "holdout" ||
						task.outcome.status !== "completed" ||
						taskPassed(task) ||
						state.started.config.suite.tasks.find((entry) => entry.id === task.taskId)?.behavior !==
							event.procedure.behavior,
				)
			)
				return fail("Candidate evidence must be completed, failing development tasks for the proposed behavior");
			if (new Set(evidence.map((task) => task?.taskId)).size < 2)
				return fail("A candidate needs recurring evidence from at least two distinct tasks");
			const suite = state.started.config.suite.tasks;
			if (
				suite.filter((task) => task.kind === "target" && task.behavior === event.procedure.behavior).length < 2 ||
				!suite.some((task) => task.kind === "control" && task.behavior === event.procedure.behavior) ||
				!suite.some((task) => task.kind === "holdout" && task.behavior === event.procedure.behavior)
			)
				return fail("Candidate behavior needs two targets, a negative control, and held-out coverage");
			const pool = candidateProcedureIds(labProcedures(state), event);
			if (Result.isFailure(pool)) return fail(pool.failure.message);
			return Result.succeed({ ...state, candidates: [...state.candidates, event] });
		}
		case "selection": {
			const candidate = state.candidates.find((entry) => entry.id === event.candidateId);
			if (candidate === undefined) return fail("Unknown laboratory candidate");
			if (state.selections.some((selection) => selection.candidateId === event.candidateId))
				return fail("Candidate is already decided");
			const next = { ...state, selections: [...state.selections, event] };
			if (event.decision === "reject") return Result.succeed(next);
			const result = developmentGate({ ...state, lastAt: event.at }, candidate.id);
			if (!result.eligible) return fail(`Experimental selection refused: ${result.reasons.join("; ")}`);
			const pool = candidateProcedureIds(labProcedures(state), candidate);
			if (Result.isFailure(pool)) return fail(pool.failure.message);
			const head: LabVersion = {
				id: event.id,
				parentVersion: state.head.id,
				candidateId: candidate.id,
				procedureIds: pool.success,
			};
			return Result.succeed({ ...next, head, versions: [...state.versions, head] });
		}
		case "finished": {
			if (event.status === "completed") {
				const result = finalGate({ ...state, lastAt: event.at });
				if (!result.eligible) return fail(`Completed run refused: ${result.reasons.join("; ")}`);
			}
			return Result.succeed({ ...state, finished: event });
		}
		default:
			return fail("Unsupported laboratory history event");
	}
}
