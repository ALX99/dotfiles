import { Result, Schema } from "effect";
import { decodeLabDocument, labProcedures, labReleaseGate, replayLabDocument } from "./lab/state.ts";
import type { LabDocument } from "./lab/schema.ts";
import { candidateProcedureIds, sameProcedure, validateProcedurePool, type ProcedureEntry } from "./procedures.ts";
import {
	EVALUATION_REPEATS,
	HarnessDocumentSchema,
	HarnessError,
	HarnessEventSchema,
	MAX_EVENTS,
	type DecisionEvent,
	type EvaluationEvent,
	type EvidenceEvent,
	type HarnessDocument,
	type HarnessEvent,
	type LabReleaseEvent,
	type ProposalEvent,
	type SuiteEvent,
} from "./schema.ts";

export { renderGuidance } from "./procedures.ts";

export interface HarnessVersion {
	readonly id: string;
	readonly parentVersion: string | null;
	readonly candidateIds: readonly string[];
	readonly restoredFrom: string | null;
}

export interface HarnessState {
	readonly scope: string;
	readonly head: HarnessVersion;
	readonly versions: readonly HarnessVersion[];
	readonly evidence: readonly EvidenceEvent[];
	readonly proposals: readonly ProposalEvent[];
	readonly suites: readonly SuiteEvent[];
	readonly evaluations: readonly EvaluationEvent[];
	readonly decisions: readonly DecisionEvent[];
	readonly releases: readonly HarnessLabRelease[];
}

export interface HarnessLabRelease extends Omit<LabReleaseEvent, "lab"> {
	readonly lab: LabDocument;
	readonly procedures: readonly ProcedureEntry[];
}

export interface EvaluationPlan {
	readonly candidate: ProposalEvent;
	readonly suite: SuiteEvent;
	readonly baseline: HarnessVersion;
	readonly candidateIds: readonly string[];
}

const decodeDocument = Schema.decodeUnknownResult(HarnessDocumentSchema, { onExcessProperty: "error" });
const decodeEvent = Schema.decodeUnknownResult(HarnessEventSchema, { onExcessProperty: "error" });
const fail = (message: string) => Result.fail(new HarnessError({ message }));

export function decodeHarnessDocument(input: unknown): Result.Result<HarnessDocument, HarnessError> {
	return decodeDocument(input).pipe(Result.mapError((error) => new HarnessError({ message: error.message })));
}

/** A missing store starts empty; an invalid or incompatible store never does. */
export function emptyDocument(scope: string): Result.Result<HarnessDocument, HarnessError> {
	return decodeHarnessDocument({ format: 1, scope, events: [] });
}

/** Reconstruct all projections from one validated, ordered logical history. */
export function replayDocument(input: unknown): Result.Result<HarnessState, HarnessError> {
	const decoded = decodeDocument(input);
	if (Result.isFailure(decoded)) return fail(`Invalid harness history: ${decoded.failure.message}`);
	const root: HarnessVersion = { id: "root", parentVersion: null, candidateIds: [], restoredFrom: null };
	let state: HarnessState = {
		scope: decoded.success.scope,
		head: root,
		versions: [root],
		evidence: [],
		proposals: [],
		suites: [],
		evaluations: [],
		decisions: [],
		releases: [],
	};
	const ids = new Set(["root"]);
	for (const event of decoded.success.events) {
		if (ids.has(event.id)) return fail(`Duplicate history ID: ${event.id}`);
		const applied = applyEvent(state, event, ids);
		if (Result.isFailure(applied)) return applied;
		state = applied.success;
		ids.add(event.id);
		if (event.kind === "lab-release") for (const procedure of state.releases.at(-1)!.procedures) ids.add(procedure.id);
	}
	return Result.succeed(state);
}

/** Only an appended event can change the store; callers cannot replace its history. */
export function appendEvent(
	document: HarnessDocument,
	input: unknown,
): Result.Result<{ document: HarnessDocument; state: HarnessState }, HarnessError> {
	const event = decodeEvent(input);
	if (Result.isFailure(event)) return fail(`Invalid harness event: ${event.failure.message}`);
	if (document.events.length >= MAX_EVENTS) return fail(`History has reached its ${MAX_EVENTS}-event capacity`);
	const next = { ...document, events: [...document.events, event.success] };
	return replayDocument(next).pipe(Result.map((state) => ({ document: next, state })));
}

export function activeProcedures(state: HarnessState, version: HarnessVersion = state.head): readonly ProcedureEntry[] {
	return version.candidateIds.map((id) => {
		const proposal =
			state.proposals.find((candidate) => candidate.id === id) ??
			state.releases.flatMap((release) => release.procedures).find((candidate) => candidate.id === id);
		if (proposal === undefined) throw new Error(`Invalid internal version reference: ${id}`);
		return proposal;
	});
}

/** A procedure is usable only by the model whose evaluation authorized its approval. */
export function modelProcedures(state: HarnessState, model: string, version: HarnessVersion = state.head) {
	return activeProcedures(state, version).filter((proposal) => {
		const release = state.releases.find((entry) => entry.procedures.some((procedure) => procedure.id === proposal.id));
		if (release !== undefined) return release.model === model;
		const decision = state.decisions.find((entry) => entry.candidateId === proposal.id && entry.decision === "approve");
		return state.evaluations.find((entry) => entry.id === decision?.evaluationId)?.model === model;
	});
}

/** Release eligibility is derived from exact retained laboratory evidence, never supplied scores. */
export function labReleasePlan(
	state: HarnessState,
	input: unknown,
	model: string,
): Result.Result<
	{
		lab: LabDocument;
		procedures: readonly ProcedureEntry[];
		baselineProcedureIds: readonly string[];
		evidenceAt: number;
	},
	HarnessError
> {
	const decoded = decodeLabDocument(input);
	if (Result.isFailure(decoded)) return fail(`Invalid laboratory release witness: ${decoded.failure.message}`);
	const replayed = replayLabDocument(decoded.success);
	if (Result.isFailure(replayed)) return fail(`Invalid laboratory release witness: ${replayed.failure.message}`);
	const lab = replayed.success;
	if (lab.scope !== state.scope) return fail("Laboratory release belongs to a different repository scope");
	if (lab.started.config.targetModel !== model)
		return fail("Select the laboratory's physical target model before release");
	if (state.releases.some((release) => release.lab.runId === lab.runId))
		return fail("Laboratory run has already been released");
	if (lab.started.config.baseline.productionVersion !== state.head.id)
		return fail("Laboratory production parent is stale; run a new experiment against the current version");
	const baseline = lab.started.config.baseline.procedures;
	const applicable = modelProcedures(state, model);
	const keys = ["behavior", "title", "trigger", "action", "verify", "avoid"] as const;
	if (
		baseline.length !== applicable.length ||
		baseline.some(
			(entry, index) =>
				entry.id !== applicable[index]?.id ||
				keys.some((key) => entry.procedure[key] !== applicable[index]?.procedure[key]),
		)
	)
		return fail("Laboratory frozen baseline does not match current model-applicable guidance");
	const gate = labReleaseGate(lab);
	if (!gate.eligible) return fail(`Laboratory release refused: ${gate.reasons.join("; ")}`);
	const procedures = labProcedures(lab);
	const preserved = activeProcedures(state).filter((entry) => !applicable.some((prior) => prior.id === entry.id));
	return validateProcedurePool([...preserved, ...procedures]).pipe(
		Result.map(() => ({
			lab: decoded.success,
			procedures,
			baselineProcedureIds: baseline.map((entry) => entry.id),
			evidenceAt: lab.lastAt,
		})),
	);
}

export function evaluationPlan(state: HarnessState, candidateId: string): Result.Result<EvaluationPlan, HarnessError> {
	const candidate = state.proposals.find((proposal) => proposal.id === candidateId);
	if (candidate === undefined) return fail(`Unknown candidate: ${candidateId}`);
	if (state.decisions.some((decision) => decision.candidateId === candidateId))
		return fail("Candidate is already decided");
	if (candidate.parentVersion !== state.head.id) return fail("Candidate is stale; propose against the current version");
	const suite = state.suites.at(-1);
	if (suite === undefined) return fail("Configure an independent probe suite before evaluating");
	return planFor(state, candidate, state.head, suite);
}

export interface PromotionGate {
	readonly eligible: boolean;
	readonly reasons: readonly string[];
}

/** Executable checks, not a model's opinion, determine promotion eligibility. */
export function promotionGate(state: HarnessState, candidateId: string, evaluationId: string): PromotionGate {
	const plan = evaluationPlan(state, candidateId);
	if (Result.isFailure(plan)) return { eligible: false, reasons: [plan.failure.message] };
	const evaluation = state.evaluations.find((entry) => entry.id === evaluationId);
	if (evaluation === undefined) return { eligible: false, reasons: ["Unknown evaluation"] };
	const { candidate, suite } = plan.success;
	const reasons: string[] = [];
	if (evaluation.candidateId !== candidateId) reasons.push("Evaluation belongs to a different candidate");
	if (evaluation.parentVersion !== state.head.id) reasons.push("Evaluation uses a stale baseline version");
	if (evaluation.suiteId !== suite.id) reasons.push("Evaluation uses a stale probe suite");
	if (state.evaluations.findLast((entry) => entry.candidateId === candidateId)?.id !== evaluationId)
		reasons.push("Only the latest evaluation can authorize promotion");
	if (reasons.length > 0) return { eligible: false, reasons };
	let improvedTarget = false;
	for (const probe of suite.suite.cases) {
		const pairs = evaluation.pairs.filter((pair) => pair.caseId === probe.id);
		if (pairs.some((pair) => !probe.choices.some((choice) => choice.id === pair.baselineOutput.trim())))
			reasons.push(`Baseline did not produce valid choices for case ${probe.id}; rerun the evaluation`);
		if (pairs.some((pair) => pair.candidateOutput.trim() !== probe.expectedChoice))
			reasons.push(`Candidate did not pass all repeats of ${probe.kind} case ${probe.id}`);
		if (
			probe.kind === "target" &&
			probe.behavior === candidate.procedure.behavior &&
			pairs.some(
				(pair) =>
					pair.baselineOutput.trim() !== probe.expectedChoice && pair.candidateOutput.trim() === probe.expectedChoice,
			)
		)
			improvedTarget = true;
	}
	if (!improvedTarget) reasons.push("No measured improvement on a targeted case");
	return { eligible: reasons.length === 0, reasons };
}

function planFor(
	state: HarnessState,
	candidate: ProposalEvent,
	baseline: HarnessVersion,
	suite: SuiteEvent,
): Result.Result<EvaluationPlan, HarnessError> {
	const coverage = new Set(suite.suite.cases.map((probe) => `${probe.behavior}:${probe.kind}`));
	for (const kind of ["target", "control", "holdout"]) {
		if (!coverage.has(`${candidate.procedure.behavior}:${kind}`))
			return fail(`Probe suite needs a ${kind} case for ${candidate.procedure.behavior}`);
	}
	if (!suite.suite.cases.some((probe) => probe.kind === "regression"))
		return fail("Probe suite needs a regression case");
	for (const procedure of activeProcedures(state, baseline)) {
		if (
			!coverage.has(`${procedure.procedure.behavior}:regression`) &&
			!coverage.has(`${procedure.procedure.behavior}:target`)
		)
			return fail(`Probe suite lacks regression coverage for active behavior ${procedure.procedure.behavior}`);
	}
	return candidatePool(state, candidate, baseline).pipe(
		Result.map((candidateIds) => ({ candidate, baseline, suite, candidateIds })),
	);
}

function candidatePool(
	state: HarnessState,
	candidate: ProposalEvent,
	baseline: HarnessVersion,
): Result.Result<readonly string[], HarnessError> {
	return candidateProcedureIds(activeProcedures(state, baseline), candidate);
}

function applyEvent(
	state: HarnessState,
	event: HarnessEvent,
	historyIds: ReadonlySet<string>,
): Result.Result<HarnessState, HarnessError> {
	switch (event.kind) {
		case "evidence": {
			const { evidence } = event;
			for (const prior of state.evidence) {
				if ((prior.evidence.sessionId === evidence.sessionId) !== (prior.evidence.sessionFile === evidence.sessionFile))
					return fail("Evidence session ID and file must identify the same session consistently");
				if (
					prior.evidence.sessionId === evidence.sessionId &&
					prior.evidence.entryId === evidence.entryId &&
					prior.evidence.behavior === evidence.behavior
				)
					return fail("This entry already supplies evidence for that behavior");
			}
			return Result.succeed({ ...state, evidence: [...state.evidence, event] });
		}
		case "proposal": {
			if (event.parentVersion !== state.head.id) return fail("Proposal must name the current parent version");
			if (
				activeProcedures(state).some((prior) => sameProcedure(prior, event)) ||
				state.proposals.some(
					(prior) =>
						sameProcedure(prior, event) &&
						(prior.parentVersion === event.parentVersion || state.head.candidateIds.includes(prior.id)),
				)
			)
				return fail("Duplicate procedure; prior candidates, including rejected ones, are retained");
			const evidence = event.evidenceIds.map((id) => state.evidence.find((entry) => entry.id === id));
			if (evidence.some((entry) => entry === undefined || entry.evidence.behavior !== event.procedure.behavior))
				return fail("Evidence must exist and match the proposed behavior");
			if (
				evidence.some(
					(entry) =>
						entry !== undefined &&
						!["HARNESS_DEFICIENCY", "KNOWLEDGE_DEFICIENCY", "RETRIEVAL_FAILURE"].includes(entry.evidence.attribution),
				)
			)
				return fail(
					"Model, tool, environment, evaluator, stochastic, or unknown failures do not authorize procedural learning",
				);
			if (new Set(evidence.map((entry) => entry?.evidence.sessionId)).size < 2)
				return fail("A durable procedure needs evidence from at least two distinct sessions");
			const next = { ...state, proposals: [...state.proposals, event] };
			return candidatePool(next, event, state.head).pipe(Result.map(() => next));
		}
		case "suite":
			return Result.succeed({ ...state, suites: [...state.suites, event] });
		case "evaluation": {
			const candidate = state.proposals.find((proposal) => proposal.id === event.candidateId);
			const baseline = state.versions.find((version) => version.id === event.parentVersion);
			const suite = state.suites.find((entry) => entry.id === event.suiteId);
			if (
				candidate === undefined ||
				baseline === undefined ||
				suite === undefined ||
				candidate.parentVersion !== baseline.id
			)
				return fail("Evaluation must reference an existing candidate, its parent, and an existing suite");
			const plan = planFor(state, candidate, baseline, suite);
			if (Result.isFailure(plan)) return Result.fail(plan.failure);
			const keys = new Set(event.pairs.map((pair) => `${pair.caseId}:${pair.repeat}`));
			const expectedKeys = suite.suite.cases.flatMap((probe) =>
				Array.from({ length: EVALUATION_REPEATS }, (_, repeat) => `${probe.id}:${repeat}`),
			);
			if (
				keys.size !== event.pairs.length ||
				keys.size !== expectedKeys.length ||
				expectedKeys.some((key) => !keys.has(key))
			)
				return fail("Evaluation must contain exactly one paired result for every case and repeat");
			return Result.succeed({ ...state, evaluations: [...state.evaluations, event] });
		}
		case "decision": {
			if (!state.proposals.some((candidate) => candidate.id === event.candidateId)) return fail("Unknown candidate");
			if (state.decisions.some((decision) => decision.candidateId === event.candidateId))
				return fail("Candidate is already decided");
			if (
				event.evaluationId !== null &&
				!state.evaluations.some(
					(evaluation) => evaluation.id === event.evaluationId && evaluation.candidateId === event.candidateId,
				)
			)
				return fail("Decision must reference an evaluation of this candidate");
			const next = { ...state, decisions: [...state.decisions, event] };
			if (event.decision === "reject") return Result.succeed(next);
			if (event.evaluationId === null) return fail("Approval requires a passing evaluation");
			const gate = promotionGate(state, event.candidateId, event.evaluationId);
			if (!gate.eligible) return fail(`Promotion refused: ${gate.reasons.join("; ")}`);
			const plan = evaluationPlan(state, event.candidateId);
			if (Result.isFailure(plan)) return Result.fail(plan.failure);
			const head: HarnessVersion = {
				id: event.id,
				parentVersion: state.head.id,
				candidateIds: plan.success.candidateIds,
				restoredFrom: null,
			};
			return Result.succeed({ ...next, head, versions: [...state.versions, head] });
		}
		case "rollback": {
			const target = state.versions.find((version) => version.id === event.versionId);
			if (target === undefined) return fail("Unknown rollback version");
			if (target.id === state.head.id) return fail("Rollback target is already current");
			const head: HarnessVersion = {
				id: event.id,
				parentVersion: state.head.id,
				candidateIds: target.candidateIds,
				restoredFrom: target.id,
			};
			return Result.succeed({ ...state, head, versions: [...state.versions, head] });
		}
		case "lab-release": {
			if (event.parentVersion !== state.head.id)
				return fail("Laboratory release must name the current production parent");
			const plan = labReleasePlan(state, event.lab, event.model);
			if (Result.isFailure(plan)) return Result.fail(plan.failure);
			if (event.at < plan.success.evidenceAt) return fail("Release cannot precede its laboratory evidence");
			const baselineIds = new Set(plan.success.baselineProcedureIds);
			const procedures = plan.success.procedures
				.filter((entry) => !baselineIds.has(entry.id))
				.map((entry) => ({ id: `${event.id}/lab/${entry.id}`, procedure: entry.procedure }));
			if (procedures.some((entry) => entry.id.length > 200))
				return fail("Released procedure IDs exceed the identifier limit");
			if (procedures.some((entry) => historyIds.has(entry.id) || entry.id === event.id))
				return fail("Released procedure IDs collide with history");
			const applicable = modelProcedures(state, event.model);
			const retained = state.head.candidateIds.filter((id) => !applicable.some((entry) => entry.id === id));
			const released = plan.success.procedures.map((entry) =>
				baselineIds.has(entry.id) ? entry.id : `${event.id}/lab/${entry.id}`,
			);
			const release: HarnessLabRelease = { ...event, lab: plan.success.lab, procedures };
			const head: HarnessVersion = {
				id: event.id,
				parentVersion: state.head.id,
				candidateIds: [...retained, ...released],
				restoredFrom: null,
			};
			return Result.succeed({
				...state,
				head,
				versions: [...state.versions, head],
				releases: [...state.releases, release],
			});
		}
		default:
			return fail("Unsupported history event");
	}
}
