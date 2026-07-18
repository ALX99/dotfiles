import { type Static, Type } from "typebox";
import { Check } from "typebox/value";

export const AskQuestionParamsSchema = Type.Object(
	{
		question: Type.String({ description: "The question to ask the user" }),
		alternatives: Type.Array(Type.String({ minLength: 1, description: "One alternative answer option" }), {
			minItems: 2,
			maxItems: 5,
			description: "2 to 5 alternative answer options.",
		}),
	},
	{ additionalProperties: false },
);

export type AskQuestionInput = Static<typeof AskQuestionParamsSchema>;

export const AskQuestionDetailsSchema = Type.Object(
	{
		question: Type.String(),
		alternatives: Type.Array(Type.String()),
		answer: Type.Union([Type.String(), Type.Null()]),
		answers: Type.Array(Type.String()),
		wasCustom: Type.Boolean(),
		action: Type.Union([Type.Literal("compare"), Type.Null()]),
	},
	{ additionalProperties: false },
);

export type AskQuestionDetails = Static<typeof AskQuestionDetailsSchema>;

export function readAskQuestionDetails(value: unknown): AskQuestionDetails | undefined {
	return Check(AskQuestionDetailsSchema, value) ? value : undefined;
}
