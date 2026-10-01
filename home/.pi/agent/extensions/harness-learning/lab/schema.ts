import { isAbsolute } from "node:path";
import { Result, Schema } from "effect";
import { validateProcedurePool } from "../procedures.ts";
import { MAX_ACTIVE_PROCEDURES, ProcedureSchema } from "../schema.ts";

export const MAX_LAB_EVENTS = 2000;
export const MAX_LAB_STORE_BYTES = 16 * 1024 * 1024;
export const MAX_LAB_SUITE_BYTES = 512 * 1024;
export const MAX_TASK_FILES_BYTES = 64 * 1024;
export const MAX_TASK_FILE_CHARS = 16_384;
export const MAX_TASK_TRACE_CHARS = 16_384;
export const MAX_VERIFICATION_OUTPUT_CHARS = 8192;

const text = (max: number) =>
	Schema.String.check(
		Schema.isMinLength(1),
		Schema.isMaxLength(max),
		Schema.makeFilter((value) => (value.trim() === value ? undefined : "must not be blank or padded")),
	);
export const LabIdSchema = text(100).check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/));
const reference = text(200);
const model = text(200).check(Schema.isPattern(/^[^/\s]+\/\S+$/));
const count = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }));
const boundedCount = (minimum: number, maximum: number) => Schema.Int.check(Schema.isBetween({ minimum, maximum }));
const cost = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0));
const uniqueReferences = Schema.Array(reference).check(
	Schema.isMinLength(2),
	Schema.isMaxLength(12),
	Schema.makeFilter((ids) => (new Set(ids).size === ids.length ? undefined : "references must be unique")),
);

/** Portable, relative paths only; file names are never host paths or shell expressions. */
export const LabFilePathSchema = text(200).check(
	Schema.isPattern(/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/),
	Schema.makeFilter((path) =>
		path.split("/").every((part) => part !== "." && part !== "..") ? undefined : "dot path segments are forbidden",
	),
);
const TaskFileSchema = Schema.Struct({
	path: LabFilePathSchema,
	content: Schema.String.check(Schema.isMaxLength(MAX_TASK_FILE_CHARS)),
});

function uniqueFilePaths(paths: readonly string[]): boolean {
	return paths.every(
		(path, index) =>
			!paths.some((other, otherIndex) => otherIndex !== index && (path === other || path.startsWith(`${other}/`))),
	);
}

const files = (minimum: number, maximum: number) =>
	Schema.Array(TaskFileSchema).check(
		Schema.isMinLength(minimum),
		Schema.isMaxLength(maximum),
		Schema.makeFilter((entries) =>
			uniqueFilePaths(entries.map((file) => file.path)) &&
			entries.reduce((bytes, file) => bytes + Buffer.byteLength(file.content, "utf8"), 0) <= MAX_TASK_FILES_BYTES
				? undefined
				: "files need unique non-overlapping paths and a bounded UTF-8 byte total",
		),
	);

export const LabTaskSchema = Schema.Struct({
	id: LabIdSchema,
	behavior: ProcedureSchema.fields.behavior,
	kind: Schema.Literals(["target", "control", "regression", "holdout"]),
	prompt: text(4000),
	files: files(1, 24),
	solutionPaths: Schema.Array(LabFilePathSchema).check(
		Schema.isMinLength(1),
		Schema.isMaxLength(8),
		Schema.makeFilter((paths) =>
			uniqueFilePaths(paths) ? undefined : "solution paths must be unique and non-overlapping",
		),
	),
	verify: Schema.Struct({
		files: files(1, 24),
		argv: Schema.Array(text(1024)).check(Schema.isMinLength(2), Schema.isMaxLength(16)),
	}),
}).check(
	Schema.makeFilter((task) =>
		task.verify.argv[0] === "node" &&
		task.verify.files.some((file) => task.verify.argv.includes(`/verify/${file.path}`))
			? undefined
			: "verification must run node with an explicitly supplied /verify/ file",
	),
);
export type LabTask = typeof LabTaskSchema.Type;
export const LabArtifactsSchema = files(0, 8);

export const LabSuiteSchema = Schema.Struct({
	name: text(100),
	tasks: Schema.Array(LabTaskSchema).check(Schema.isMinLength(6), Schema.isMaxLength(12)),
}).check(
	Schema.makeFilter((suite) => {
		if (new Set(suite.tasks.map((task) => task.id)).size !== suite.tasks.length) return "task IDs must be unique";
		if (suite.tasks.filter((task) => task.kind === "holdout").length < 2)
			return "at least two holdout tasks are required";
		if (!suite.tasks.some((task) => task.kind === "control")) return "a negative-control task is required";
		if (!suite.tasks.some((task) => task.kind === "regression")) return "a regression task is required";
		if (suite.tasks.filter((task) => task.kind === "target").length < 2)
			return "at least two target tasks are required";
		if (Buffer.byteLength(JSON.stringify(suite), "utf8") > MAX_LAB_SUITE_BYTES)
			return "suite exceeds its byte capacity";
		return undefined;
	}),
);

export const LabLimitsSchema = Schema.Struct({
	maxCandidates: boundedCount(1, 10),
	repeats: boundedCount(3, 5),
	maxRequests: boundedCount(1, 400),
	maxOutputTokens: boundedCount(64, 8192),
	maxTotalTokens: boundedCount(64, 5_000_000),
	maxReportedCostUsd: cost.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1000)),
	maxWallTimeMs: boundedCount(1000, 3_600_000),
	maxRequestTimeMs: boundedCount(1000, 120_000),
	maxTaskTimeMs: boundedCount(1000, 600_000),
	maxTurnsPerTask: boundedCount(1, 30),
}).check(
	Schema.makeFilter((limits) =>
		limits.maxOutputTokens <= limits.maxTotalTokens &&
		limits.maxRequestTimeMs <= limits.maxTaskTimeMs &&
		limits.maxTaskTimeMs <= limits.maxWallTimeMs
			? undefined
			: "token limits and request/task/run deadlines must be nested",
	),
);

const ProcedureEntrySchema = Schema.Struct({ id: reference, procedure: ProcedureSchema });
export const LabConfigSchema = Schema.Struct({
	researcherModel: model,
	targetModel: model,
	image: text(300).check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}$/)),
	baseline: Schema.Struct({
		productionVersion: reference,
		procedures: Schema.Array(ProcedureEntrySchema).check(Schema.isMaxLength(MAX_ACTIVE_PROCEDURES)),
	}),
	suite: LabSuiteSchema,
	limits: LabLimitsSchema,
}).check(
	Schema.makeFilter((config) => {
		const pool = validateProcedurePool(config.baseline.procedures);
		if (Result.isFailure(pool)) return pool.failure.message;
		for (const entry of config.baseline.procedures) {
			if (!config.suite.tasks.some((task) => task.kind === "regression" && task.behavior === entry.procedure.behavior))
				return `regression coverage is required for baseline behavior ${entry.procedure.behavior}`;
		}
		return undefined;
	}),
);
export type LabConfig = typeof LabConfigSchema.Type;

/** A launch file cannot supply or override the production baseline. */
export const LabExperimentSchema = Schema.Struct({
	researcherModel: LabConfigSchema.fields.researcherModel,
	targetModel: LabConfigSchema.fields.targetModel,
	image: LabConfigSchema.fields.image,
	suite: LabSuiteSchema,
	limits: LabLimitsSchema,
});

const envelope = { id: LabIdSchema, at: count };
const StartedSchema = Schema.Struct({ ...envelope, kind: Schema.Literal("started"), config: LabConfigSchema });
const ControllerSchema = Schema.Struct({ ...envelope, kind: Schema.Literal("controller-start") });
const CandidateSchema = Schema.Struct({
	...envelope,
	kind: Schema.Literal("candidate"),
	parentVersion: reference,
	requestId: reference,
	replaces: Schema.NullOr(reference),
	procedure: ProcedureSchema,
	hypothesis: text(500),
	attribution: Schema.Literals(["HARNESS_DEFICIENCY", "KNOWLEDGE_DEFICIENCY", "RETRIEVAL_FAILURE"]),
	evidenceIds: uniqueReferences,
});
/** The researcher supplies no IDs, model identity, timestamps, scores, or evaluator configuration. */
export const LabProposalSchema = Schema.Struct({
	parentVersion: CandidateSchema.fields.parentVersion,
	replaces: CandidateSchema.fields.replaces,
	procedure: ProcedureSchema,
	hypothesis: CandidateSchema.fields.hypothesis,
	attribution: CandidateSchema.fields.attribution,
	evidenceIds: CandidateSchema.fields.evidenceIds,
});
export type LabCandidate = typeof CandidateSchema.Type;

const TaskOutcomeSchema = Schema.Union([
	Schema.Struct({
		status: Schema.Literal("completed"),
		artifacts: LabArtifactsSchema,
		verificationExitCode: boundedCount(0, 255),
		verificationOutput: Schema.String.check(Schema.isMaxLength(MAX_VERIFICATION_OUTPUT_CHARS)),
	}),
	Schema.Struct({
		status: Schema.Literal("error"),
		failure: Schema.Literals(["model", "environment", "budget", "cancelled"]),
		message: text(1000),
	}),
]);
export type LabTaskOutcome = typeof TaskOutcomeSchema.Type;

const TaskEventSchema = Schema.Struct({
	...envelope,
	kind: Schema.Literal("task"),
	phase: Schema.Literals(["seed", "development", "holdout"]),
	candidateId: Schema.NullOr(reference),
	baselineVersion: reference,
	taskId: LabIdSchema,
	repeat: boundedCount(0, 4),
	arm: Schema.Literals(["baseline", "candidate"]),
	model,
	requestIds: Schema.Array(reference).check(
		Schema.isMaxLength(30),
		Schema.makeFilter((ids) => (new Set(ids).size === ids.length ? undefined : "request IDs must be unique")),
	),
	trace: Schema.String.check(Schema.isMaxLength(MAX_TASK_TRACE_CHARS)),
	outcome: TaskOutcomeSchema,
}).check(
	Schema.makeFilter((event) =>
		event.outcome.status !== "completed" || event.requestIds.length > 0
			? undefined
			: "completed tasks need executor requests",
	),
);
export type LabTaskEvent = typeof TaskEventSchema.Type;

const RequestStartSchema = Schema.Struct({
	...envelope,
	kind: Schema.Literal("request-start"),
	role: Schema.Literals(["researcher", "executor"]),
	reservedTokens: boundedCount(64, 5_000_000),
});
export type LabRequestStart = typeof RequestStartSchema.Type;
const RequestEndSchema = Schema.Struct({
	...envelope,
	kind: Schema.Literal("request-end"),
	requestId: reference,
	status: Schema.Literals(["completed", "failed", "cancelled"]),
	usage: Schema.NullOr(Schema.Struct({ tokens: count, costUsd: cost })),
}).check(
	Schema.makeFilter((event) =>
		event.status !== "completed" || event.usage !== null ? undefined : "completed requests need reported usage",
	),
);
export type LabRequestEnd = typeof RequestEndSchema.Type;
const SelectionSchema = Schema.Struct({
	...envelope,
	kind: Schema.Literal("selection"),
	candidateId: reference,
	decision: Schema.Literals(["accept", "reject"]),
	reason: text(1000),
});
export type LabSelection = typeof SelectionSchema.Type;
const FinishedSchema = Schema.Struct({
	...envelope,
	kind: Schema.Literal("finished"),
	status: Schema.Literals(["completed", "stopped", "failed", "cancelled"]),
	reason: text(1000),
});
export type LabFinished = typeof FinishedSchema.Type;

export const LabEventSchema = Schema.Union([
	StartedSchema,
	ControllerSchema,
	CandidateSchema,
	TaskEventSchema,
	RequestStartSchema,
	RequestEndSchema,
	SelectionSchema,
	FinishedSchema,
]);
export type LabEvent = typeof LabEventSchema.Type;
export type LabStarted = typeof StartedSchema.Type;
export type LabControllerStart = typeof ControllerSchema.Type;
export const LabDocumentSchema = Schema.Struct({
	format: Schema.Literal(1),
	scope: text(4096).check(Schema.makeFilter((path) => (isAbsolute(path) ? undefined : "scope must be absolute"))),
	runId: LabIdSchema,
	events: Schema.Array(LabEventSchema).check(Schema.isMaxLength(MAX_LAB_EVENTS)),
});
export type LabDocument = typeof LabDocumentSchema.Type;

export class LabError extends Schema.TaggedError<LabError>()("LabError", { message: Schema.String }) {}
