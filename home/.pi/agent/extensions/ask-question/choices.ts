import { Result } from "effect";
import {
	askQuestionError,
	type AskQuestionDetails,
	type AskQuestionError,
	type AskQuestionResponseDetails,
	type QuestionAlternative,
	type QuestionInput,
} from "./schema.ts";

export const COMPARE_OPTION = "Compare options";
export const OTHER_OPTION = "Something else";
export const COMMENT_OPTION = "Add comment";
export const NO_ANSWER_MSG = "Responder declined to answer, await further instructions.";

export type QuestionOptionKind = "alternative" | "compare" | "other" | "comment";

export interface QuestionOption {
	readonly kind: QuestionOptionKind;
	readonly label: string;
	readonly description?: string;
}

export type AskQuestionAction = "compare";

export interface AskQuestionResult {
	content: Array<{ type: "text"; text: string }>;
	details: AskQuestionDetails;
}

export interface QuestionResult {
	content: Array<{ type: "text"; text: string }>;
	details: AskQuestionResponseDetails;
}

export function normalizeAlternatives(
	alternatives: readonly QuestionAlternative[],
): Result.Result<QuestionAlternative[], AskQuestionError> {
	const normalized = alternatives.map((alternative) => ({
		label: alternative.label.trim(),
		...(alternative.description === undefined ? {} : { description: alternative.description.trim() }),
	}));
	if (normalized.some((alternative) => alternative.label.length === 0)) {
		return Result.fail(askQuestionError("empty_alternative", "ask_question alternatives must not be empty"));
	}
	if (normalized.some((alternative) => alternative.label.length > 100)) {
		return Result.fail(
			askQuestionError("long_label", "ask_question alternative labels must be at most 100 characters"),
		);
	}
	if (normalized.some((alternative) => alternative.description !== undefined && alternative.description.length > 500)) {
		return Result.fail(
			askQuestionError("long_description", "ask_question alternative descriptions must be at most 500 characters"),
		);
	}

	const reserved = new Set([COMPARE_OPTION, OTHER_OPTION, COMMENT_OPTION]);
	if (normalized.some((alternative) => reserved.has(alternative.label))) {
		return Result.fail(
			askQuestionError("reserved_label", "ask_question alternatives must not use reserved option labels"),
		);
	}

	const labels = normalized.map((alternative) => alternative.label);
	if (new Set(labels).size !== labels.length) {
		return Result.fail(askQuestionError("duplicate_label", "ask_question alternatives must be distinct"));
	}

	return Result.succeed(normalized);
}

export function makeQuestionOptions(alternatives: readonly QuestionAlternative[]): QuestionOption[] {
	return [
		...Result.getOrThrow(normalizeAlternatives(alternatives)).map((alternative) => ({
			kind: "alternative" as const,
			...alternative,
		})),
		{ kind: "compare", label: COMPARE_OPTION },
		{ kind: "other", label: OTHER_OPTION },
		{ kind: "comment", label: COMMENT_OPTION },
	];
}

export function trimCustomAnswer(answer: string | null | undefined): string | undefined {
	const trimmed = answer?.trim();
	return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

export function resolveChoices(
	params: QuestionInput,
	choices: readonly QuestionOption[] | null,
	customAnswer: string | null | undefined,
	commentAnswer?: string | null,
): QuestionResult {
	if (choices === null || choices.length === 0) {
		return makeResult(params, NO_ANSWER_MSG, null, false);
	}

	const alternatives = choices.filter((choice) => choice.kind === "alternative").map((choice) => choice.label);
	if (choices.some((choice) => choice.kind === "compare")) return makeComparisonResult(params, alternatives);
	if (choices.some((choice) => choice.kind === "comment") || commentAnswer !== undefined) {
		return makeCommentResult(params, alternatives, commentAnswer);
	}

	const hasCustomAnswer = choices.some((choice) => choice.kind === "other");
	const custom = hasCustomAnswer ? trimCustomAnswer(customAnswer) : undefined;
	if (hasCustomAnswer && custom === undefined) {
		return makeResult(params, NO_ANSWER_MSG, null, false);
	}
	if (custom !== undefined) alternatives.push(custom);

	if (alternatives.length === 0) {
		return makeResult(params, NO_ANSWER_MSG, null, false);
	}

	const prefix =
		custom !== undefined && alternatives.length === 1 ? "Responder answered (custom): " : "Responder selected: ";
	return makeResult(params, `${prefix}${alternatives.join(", ")}`, alternatives, custom !== undefined);
}

function makeComparisonResult(params: QuestionInput, alternatives: readonly string[]): QuestionResult {
	const comparisonAlternatives =
		alternatives.length > 0
			? [...alternatives]
			: Result.getOrThrow(normalizeAlternatives(params.alternatives)).map(({ label }) => label);
	const result = makeResult(
		params,
		`The responder requested a comparison of: ${comparisonAlternatives.join(", ")}. Compare only these target options, explain their key pros, cons, and trade-offs, and do not treat the comparison as approval. Then call ask_question again with the same question and alternatives.`,
		null,
		false,
		"compare",
	);
	result.details.comparisonAlternatives = comparisonAlternatives;
	return result;
}

function makeCommentResult(
	params: QuestionInput,
	alternatives: readonly string[],
	commentAnswer: string | null | undefined,
): QuestionResult {
	if (alternatives.length === 0) return makeResult(params, NO_ANSWER_MSG, null, false);
	const comment = trimCustomAnswer(commentAnswer);
	const result = makeResult(
		params,
		`Responder selected: ${alternatives.join(", ")}${comment === undefined ? "" : `\nResponder comment (qualifies these selections): ${comment}`}`,
		alternatives,
		false,
	);
	if (comment !== undefined) result.details.comment = comment;
	return result;
}

export function makeResult(
	params: QuestionInput,
	text: string,
	answer: string | readonly string[] | null,
	wasCustom: boolean,
	action: AskQuestionAction | null = null,
): QuestionResult {
	const answers = answer === null ? [] : typeof answer === "string" ? [answer] : [...answer];
	const optionDetails = Result.getOrThrow(normalizeAlternatives(params.alternatives));
	return {
		content: [{ type: "text", text }],
		details: {
			question: params.question,
			alternatives: optionDetails.map(({ label }) => label),
			optionDetails,
			answer: answers[0] ?? null,
			answers,
			wasCustom,
			action,
			status: action === "compare" ? "compare" : answer === null ? "cancelled" : "answered",
		},
	};
}

export function makeAskQuestionResult(
	results: readonly QuestionResult[],
): Result.Result<AskQuestionResult, AskQuestionError> {
	if (results.length === 0) {
		return Result.fail(askQuestionError("no_results", "ask_question requires at least one result"));
	}

	const text =
		results.length === 1
			? results[0]!.content[0]!.text
			: results
					.map((result, index) => `Question ${index + 1}: ${result.details.question}\n${result.content[0]!.text}`)
					.join("\n\n");
	return Result.succeed({
		content: [{ type: "text", text }],
		details: { questions: results.map((result) => result.details) },
	});
}

export function makeOptionLabel(selected: boolean, option: QuestionOption): string {
	if (option.kind !== "alternative") return option.label;
	return `${selected ? "[x]" : "[ ]"} ${option.label}`;
}

export function getOptionColor(isCurrent: boolean): "accent" | "text" {
	return isCurrent ? "accent" : "text";
}

export function toggleOptionSelection(
	selectedIndices: readonly number[],
	currentIndex: number,
	options: readonly QuestionOption[],
): number[] {
	if (options[currentIndex]?.kind !== "alternative") return [...selectedIndices];

	if (selectedIndices.includes(currentIndex)) {
		return selectedIndices.filter((index) => index !== currentIndex);
	}
	return [...selectedIndices, currentIndex].toSorted((left, right) => left - right);
}

export function getSubmittedChoices(
	selectedIndices: readonly number[],
	currentIndex: number,
	options: readonly QuestionOption[],
): QuestionOption[] {
	const currentOption = options[currentIndex];
	if (currentOption === undefined) return [];
	if (currentOption.kind === "other") return [currentOption];
	if (currentOption.kind === "compare" || currentOption.kind === "comment") {
		return [
			...selectedIndices
				.toSorted((left, right) => left - right)
				.map((index) => options[index])
				.filter((option): option is QuestionOption => option?.kind === "alternative"),
			currentOption,
		];
	}

	const submittedIndices = selectedIndices.length === 0 ? [currentIndex] : selectedIndices;
	return [...submittedIndices]
		.toSorted((left, right) => left - right)
		.map((index) => options[index])
		.filter((option): option is QuestionOption => option?.kind === "alternative");
}
