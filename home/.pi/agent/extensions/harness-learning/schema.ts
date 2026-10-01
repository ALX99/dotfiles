import { isAbsolute } from "node:path";
import { Schema } from "effect";

export const MAX_EVENTS = 1000;
export const MAX_STORE_BYTES = 4 * 1024 * 1024;
export const MAX_ACTIVE_PROCEDURES = 5;
export const MAX_GUIDANCE_CHARS = 6000;
export const EVALUATION_REPEATS = 3;
export const MAX_PROBE_CASES = 12;
export const MAX_PROBE_OUTPUT_CHARS = 2048;

const text = (max: number) =>
	Schema.String.check(
		Schema.isMinLength(1),
		Schema.isMaxLength(max),
		Schema.makeFilter((value) =>
			value.trim() === value && value.length > 0 ? undefined : "must not be blank or padded",
		),
	);
const identifier = text(200).check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/));
const absolutePath = text(4096).check(
	Schema.makeFilter((value) => (isAbsolute(value) ? undefined : "must be absolute")),
);
const count = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }));
const behavior = text(100).check(Schema.isPattern(/^[a-z][a-z0-9/-]*$/));
const uniqueIds = (min: number, max: number) =>
	Schema.Array(identifier).check(
		Schema.isMinLength(min),
		Schema.isMaxLength(max),
		Schema.makeFilter((ids) => (new Set(ids).size === ids.length ? undefined : "IDs must be unique")),
	);

export const AttributionSchema = Schema.Literals([
	"HARNESS_DEFICIENCY",
	"KNOWLEDGE_DEFICIENCY",
	"RETRIEVAL_FAILURE",
	"MODEL_LIMITATION",
	"TOOL_FAILURE",
	"ENVIRONMENT_FAILURE",
	"EVALUATOR_FAILURE",
	"STOCHASTIC_FAILURE",
	"UNKNOWN",
]);

export const ProcedureSchema = Schema.Struct({
	behavior,
	title: text(100),
	trigger: text(300),
	action: text(700),
	verify: text(300),
	avoid: text(300),
});

const EvidenceSchema = Schema.Struct({
	sessionId: identifier,
	sessionFile: absolutePath,
	entryId: identifier,
	quote: text(1500),
	behavior,
	attribution: AttributionSchema,
});

const ProbeChoiceSchema = Schema.Struct({ id: identifier, text: text(500) });
const ProbeCaseSchema = Schema.Struct({
	id: identifier,
	behavior,
	kind: Schema.Literals(["target", "control", "regression", "holdout"]),
	prompt: text(2000),
	choices: Schema.Array(ProbeChoiceSchema).check(Schema.isMinLength(2), Schema.isMaxLength(6)),
	expectedChoice: identifier,
}).check(
	Schema.makeFilter((probe) =>
		new Set(probe.choices.map((choice) => choice.id)).size === probe.choices.length &&
		probe.choices.some((choice) => choice.id === probe.expectedChoice)
			? undefined
			: "choices must have unique IDs and contain the expected choice",
	),
);
export const ProbeSuiteSchema = Schema.Struct({
	name: text(100),
	cases: Schema.Array(ProbeCaseSchema).check(
		Schema.isMinLength(4),
		Schema.isMaxLength(MAX_PROBE_CASES),
		Schema.makeFilter((cases) =>
			new Set(cases.map((probe) => probe.id)).size === cases.length ? undefined : "case IDs must be unique",
		),
	),
});

const ProbePairSchema = Schema.Struct({
	caseId: identifier,
	repeat: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: EVALUATION_REPEATS - 1 })),
	baselineOutput: Schema.String.check(Schema.isMaxLength(MAX_PROBE_OUTPUT_CHARS)),
	candidateOutput: Schema.String.check(Schema.isMaxLength(MAX_PROBE_OUTPUT_CHARS)),
});

const envelope = { id: identifier, at: count };
const EvidenceEventSchema = Schema.Struct({ ...envelope, kind: Schema.Literal("evidence"), evidence: EvidenceSchema });
const ProposalEventSchema = Schema.Struct({
	...envelope,
	kind: Schema.Literal("proposal"),
	parentVersion: identifier,
	procedure: ProcedureSchema,
	replaces: Schema.NullOr(identifier),
	hypothesis: text(500),
	evidenceIds: uniqueIds(2, 12),
	authorModel: text(200),
});
export const EvidenceInputSchema = Schema.Union([
	Schema.Struct({ action: Schema.Literal("anchors") }),
	Schema.Struct({ action: Schema.Literal("list") }),
	Schema.Struct({
		action: Schema.Literal("record"),
		entryId: EvidenceSchema.fields.entryId,
		quote: EvidenceSchema.fields.quote,
		behavior: EvidenceSchema.fields.behavior,
		attribution: AttributionSchema,
	}),
]);
export const ProposalInputSchema = Schema.Struct({
	parentVersion: ProposalEventSchema.fields.parentVersion,
	replaces: ProposalEventSchema.fields.replaces,
	procedure: ProcedureSchema,
	hypothesis: ProposalEventSchema.fields.hypothesis,
	evidenceIds: ProposalEventSchema.fields.evidenceIds,
});
const SuiteEventSchema = Schema.Struct({ ...envelope, kind: Schema.Literal("suite"), suite: ProbeSuiteSchema });
const EvaluationEventSchema = Schema.Struct({
	...envelope,
	kind: Schema.Literal("evaluation"),
	candidateId: identifier,
	parentVersion: identifier,
	suiteId: identifier,
	model: text(200),
	pairs: Schema.Array(ProbePairSchema).check(
		Schema.isMinLength(4 * EVALUATION_REPEATS),
		Schema.isMaxLength(MAX_PROBE_CASES * EVALUATION_REPEATS),
	),
});
const DecisionEventSchema = Schema.Struct({
	...envelope,
	kind: Schema.Literal("decision"),
	candidateId: identifier,
	decision: Schema.Literals(["approve", "reject"]),
	evaluationId: Schema.NullOr(identifier),
	reason: text(1000),
});
const RollbackEventSchema = Schema.Struct({
	...envelope,
	kind: Schema.Literal("rollback"),
	versionId: identifier,
	reason: text(1000),
});

export const HarnessEventSchema = Schema.Union([
	EvidenceEventSchema,
	ProposalEventSchema,
	SuiteEventSchema,
	EvaluationEventSchema,
	DecisionEventSchema,
	RollbackEventSchema,
]);
export type HarnessEvent = typeof HarnessEventSchema.Type;
export type EvidenceEvent = typeof EvidenceEventSchema.Type;
export type ProposalEvent = typeof ProposalEventSchema.Type;
export type SuiteEvent = typeof SuiteEventSchema.Type;
export type EvaluationEvent = typeof EvaluationEventSchema.Type;
export type DecisionEvent = typeof DecisionEventSchema.Type;

export const HarnessDocumentSchema = Schema.Struct({
	format: Schema.Literal(1),
	scope: absolutePath,
	events: Schema.Array(HarnessEventSchema).check(Schema.isMaxLength(MAX_EVENTS)),
});
export type HarnessDocument = typeof HarnessDocumentSchema.Type;

export class HarnessError extends Schema.TaggedError<HarnessError>()("HarnessError", {
	message: Schema.String,
}) {}
