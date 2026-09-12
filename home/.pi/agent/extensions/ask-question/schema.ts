import { Schema } from "effect";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";

export const QuestionAlternativeSchema = Type.Object(
	{
		label: Type.String({
			minLength: 1,
			maxLength: 100,
			description: "A short, distinct answer label. Do not use Compare options, Something else, or Add comment.",
		}),
		description: Type.Optional(
			Type.String({
				maxLength: 500,
				description:
					"Brief trade-offs or explanation. For recommended alternatives, explain why; list those alternatives first.",
			}),
		),
	},
	{ additionalProperties: false },
);

export type QuestionAlternative = Static<typeof QuestionAlternativeSchema>;

export const QuestionSchema = Type.Object(
	{
		question: Type.String({ description: "The question to ask the responder" }),
		alternatives: Type.Array(QuestionAlternativeSchema, {
			minItems: 2,
			maxItems: 5,
			description:
				"2 to 5 alternatives, recommended choices first. Automatic Compare options, Something else, and Add comment actions must not be included.",
		}),
	},
	{ additionalProperties: false },
);

export type QuestionInput = Static<typeof QuestionSchema>;

export const AskQuestionParamsSchema = Type.Object(
	{
		questions: Type.Array(QuestionSchema, {
			minItems: 1,
			maxItems: 3,
			description: "One to three questions to ask in sequence.",
		}),
	},
	{ additionalProperties: false },
);

export type AskQuestionInput = Static<typeof AskQuestionParamsSchema>;

/** Converts alternatives persisted by pre-object-schema sessions without widening the public tool schema. */
export function prepareAskQuestionArguments(args: unknown): AskQuestionInput {
	let prepared: unknown = args;
	if (args !== null && typeof args === "object" && "questions" in args && Array.isArray(args.questions)) {
		prepared = {
			...args,
			questions: args.questions.map((question: unknown) => {
				if (
					question === null ||
					typeof question !== "object" ||
					!("alternatives" in question) ||
					!Array.isArray(question.alternatives)
				)
					return question;
				return {
					...question,
					alternatives: question.alternatives.map((alternative: unknown) =>
						typeof alternative === "string" ? { label: alternative } : alternative,
					),
				};
			}),
		};
	}
	if (!Check(AskQuestionParamsSchema, prepared)) {
		// Pi calls this directly as the tool's argument boundary, so the tagged error is thrown.
		throw askQuestionError(
			"invalid_parameters",
			"ask_question requires 1-3 questions, each with 2-5 alternatives containing a label (1-100 characters) and optional description (up to 500 characters), with no extra fields.",
		);
	}
	return prepared;
}

/** Why a question or its alternatives were rejected. */
export const AskQuestionReason = Schema.Literals([
	"empty_alternative",
	"long_label",
	"long_description",
	"reserved_label",
	"duplicate_label",
	"no_results",
	"invalid_parameters",
]);
export type AskQuestionReason = Schema.Schema.Type<typeof AskQuestionReason>;

/** A rejected question request; `message` is the text the model sees. */
export class AskQuestionError extends Schema.TaggedError<AskQuestionError>()("AskQuestionError", {
	reason: AskQuestionReason,
	message: Schema.String,
}) {}

export function askQuestionError(reason: AskQuestionReason, message: string): AskQuestionError {
	return new AskQuestionError({ reason, message });
}

export const AskQuestionResponseDetailsSchema = Type.Object(
	{
		question: Type.String(),
		alternatives: Type.Array(Type.String()),
		optionDetails: Type.Optional(Type.Array(QuestionAlternativeSchema)),
		answer: Type.Union([Type.String(), Type.Null()]),
		answers: Type.Array(Type.String()),
		wasCustom: Type.Boolean(),
		action: Type.Union([Type.Literal("compare"), Type.Null()]),
		comparisonAlternatives: Type.Optional(Type.Array(Type.String())),
		comment: Type.Optional(Type.String()),
		status: Type.Optional(
			Type.Union([
				Type.Literal("answered"),
				Type.Literal("compare"),
				Type.Literal("cancelled"),
				Type.Literal("aborted"),
				Type.Literal("not_asked"),
			]),
		),
	},
	{ additionalProperties: false },
);

export type AskQuestionResponseDetails = Static<typeof AskQuestionResponseDetailsSchema>;

export const AskQuestionDetailsSchema = Type.Object(
	{
		questions: Type.Array(AskQuestionResponseDetailsSchema, { minItems: 1, maxItems: 3 }),
	},
	{ additionalProperties: false },
);

export type AskQuestionDetails = Static<typeof AskQuestionDetailsSchema>;

export function readAskQuestionDetails(value: unknown): AskQuestionDetails | undefined {
	return Check(AskQuestionDetailsSchema, value) ? value : undefined;
}
