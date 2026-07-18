import type { AskQuestionDetails, AskQuestionInput } from "./schema.ts";

export const COMPARE_OPTION = "Compare options";
export const OTHER_OPTION = "Something else";
export const NO_ANSWER_MSG = "User declined to answer, await further instructions.";

export type QuestionOptionKind = "alternative" | "compare" | "other";

export interface QuestionOption {
	readonly kind: QuestionOptionKind;
	readonly label: string;
}

export type AskQuestionAction = "compare";

export interface AskQuestionResult {
	content: Array<{ type: "text"; text: string }>;
	details: AskQuestionDetails;
}

export function normalizeAlternatives(alternatives: readonly string[]): string[] {
	const labels = alternatives.map((alternative) => alternative.trim());
	if (labels.some((label) => label.length === 0)) {
		throw new Error("ask_question alternatives must not be empty");
	}

	const reserved = new Set([COMPARE_OPTION, OTHER_OPTION]);
	if (labels.some((label) => reserved.has(label))) {
		throw new Error("ask_question alternatives must not use reserved option labels");
	}

	if (new Set(labels).size !== labels.length) {
		throw new Error("ask_question alternatives must be distinct");
	}

	return labels;
}

export function validateAlternatives(alternatives: readonly string[]): void {
	normalizeAlternatives(alternatives);
}

export function makeQuestionOptions(alternatives: readonly string[]): QuestionOption[] {
	return [
		...normalizeAlternatives(alternatives).map((label) => ({ kind: "alternative" as const, label })),
		{ kind: "compare", label: COMPARE_OPTION },
		{ kind: "other", label: OTHER_OPTION },
	];
}

export function findQuestionOption(options: readonly QuestionOption[], label: string): QuestionOption | undefined {
	return options.find((option) => option.label === label);
}

export function trimCustomAnswer(answer: string | null | undefined): string | undefined {
	const trimmed = answer?.trim();
	return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

export function resolveChoices(
	params: AskQuestionInput,
	choices: readonly QuestionOption[] | null,
	customAnswer: string | null | undefined,
): AskQuestionResult {
	if (choices === null || choices.length === 0) {
		return makeResult(params, NO_ANSWER_MSG, null, false);
	}

	if (choices.some((choice) => choice.kind === "compare")) {
		return makeResult(
			params,
			"The user requested a comparison of the alternatives. Explain the key pros, cons, and trade-offs for each alternative, then call ask_question again with the same question and alternatives.",
			null,
			false,
			"compare",
		);
	}

	const answers = choices.filter((choice) => choice.kind === "alternative").map((choice) => choice.label);
	const hasCustomAnswer = choices.some((choice) => choice.kind === "other");
	const custom = hasCustomAnswer ? trimCustomAnswer(customAnswer) : undefined;
	if (hasCustomAnswer && custom === undefined) {
		return makeResult(params, NO_ANSWER_MSG, null, false);
	}
	if (custom !== undefined) answers.push(custom);

	if (answers.length === 0) {
		return makeResult(params, NO_ANSWER_MSG, null, false);
	}

	const prefix = custom !== undefined && answers.length === 1 ? "User answered (custom): " : "User selected: ";
	return makeResult(params, `${prefix}${answers.join(", ")}`, answers, custom !== undefined);
}

export function makeResult(
	params: AskQuestionInput,
	text: string,
	answer: string | readonly string[] | null,
	wasCustom: boolean,
	action: AskQuestionAction | null = null,
): AskQuestionResult {
	const answers = answer === null ? [] : typeof answer === "string" ? [answer] : [...answer];
	return {
		content: [{ type: "text", text }],
		details: {
			question: params.question,
			alternatives: normalizeAlternatives(params.alternatives),
			answer: answers[0] ?? null,
			answers,
			wasCustom,
			action,
		},
	};
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
	return [...selectedIndices, currentIndex].sort((left, right) => left - right);
}

export function getSubmittedChoices(
	selectedIndices: readonly number[],
	currentIndex: number,
	options: readonly QuestionOption[],
): QuestionOption[] {
	const currentOption = options[currentIndex];
	if (currentOption !== undefined && currentOption.kind !== "alternative") return [currentOption];

	const submittedIndices = selectedIndices.length === 0 ? [currentIndex] : selectedIndices;
	return [...submittedIndices]
		.sort((left, right) => left - right)
		.map((index) => options[index])
		.filter((option): option is QuestionOption => option?.kind === "alternative");
}
