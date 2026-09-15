import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Result } from "effect";

import {
	makeAskQuestionResult,
	makeQuestionOptions,
	makeResult,
	normalizeAlternatives,
	resolveChoices,
	trimCustomAnswer,
	type AskQuestionResult,
	type QuestionOption,
} from "./choices.ts";
import { selectMultiple } from "./multi-select.ts";
import { type AskQuestionInput, type QuestionInput } from "./schema.ts";

export async function executeAskQuestion(
	params: AskQuestionInput,
	signal: AbortSignal | undefined,
	ctx: ExtensionContext,
): Promise<AskQuestionResult> {
	const questions = params.questions.map((question) => ({
		...question,
		alternatives: Result.getOrThrow(normalizeAlternatives(question.alternatives)),
	}));
	const results = [];
	let stopped = false;
	for (const [index, question] of questions.entries()) {
		if (stopped || signal?.aborted) {
			const result = makeResult(question, "Question was not asked because the batch stopped.", null, false);
			result.details.status = "not_asked";
			results.push(result);
			continue;
		}
		const title =
			questions.length > 1 ? `Question ${index + 1} of ${questions.length}: ${question.question}` : question.question;
		let result = await executeQuestion(question, title, signal, ctx);
		if (signal?.aborted) {
			result = resolveChoices(question, null, undefined);
			result.details.status = "aborted";
			result.content = [{ type: "text", text: "Question interrupted; no answer submitted." }];
		}
		results.push(result);
		stopped = result.details.answer === null && result.details.action !== "compare";
	}
	return Result.getOrThrow(makeAskQuestionResult(results));
}

async function executeQuestion(
	question: QuestionInput,
	title: string,
	signal: AbortSignal | undefined,
	ctx: ExtensionContext,
): Promise<ReturnType<typeof resolveChoices>> {
	const options = makeQuestionOptions(question.alternatives);
	let selected: QuestionOption[] = [];
	while (true) {
		if (signal?.aborted) return resolveChoices(question, null, undefined);
		const choices = await selectChoices(title, options, signal, ctx, selected);
		selected = choices?.filter((choice) => choice.kind === "alternative") ?? [];
		if (choices?.some((choice) => choice.kind === "comment")) {
			const draft = await collectComment(title, options, selected, signal, ctx);
			selected = draft.choices;
			if (draft.comment === undefined) continue;
			return resolveChoices(question, selected, undefined, draft.comment);
		}
		if (!choices?.some((choice) => choice.kind === "other")) return resolveChoices(question, choices, undefined);
		const customAnswer = await ctx.ui.input(
			`${title} — Something else`,
			"Type your answer...",
			signal === undefined ? undefined : { signal },
		);
		if (trimCustomAnswer(customAnswer) !== undefined) return resolveChoices(question, choices, customAnswer);
	}
}

async function collectComment(
	title: string,
	options: readonly QuestionOption[],
	selected: QuestionOption[],
	signal: AbortSignal | undefined,
	ctx: ExtensionContext,
): Promise<{ choices: QuestionOption[]; comment: string | undefined }> {
	const choices =
		selected.length > 0
			? selected
			: ((await selectChoices(
					`${title} — Choose answers to comment on`,
					options.filter((option) => option.kind === "alternative"),
					signal,
					ctx,
				)) ?? []);
	if (choices.length === 0 || signal?.aborted) return { choices, comment: undefined };
	const comment = await ctx.ui.input(
		`${title} — Comment on: ${choices.map((choice) => choice.label).join(", ")}`,
		"Qualify your selection (optional)...",
		signal === undefined ? undefined : { signal },
	);
	return { choices, comment };
}

async function selectChoices(
	question: string,
	options: readonly QuestionOption[],
	signal: AbortSignal | undefined,
	ctx: ExtensionContext,
	selected: readonly QuestionOption[] = [],
): Promise<QuestionOption[] | null> {
	if (ctx.mode === "tui")
		return selectMultiple(
			question,
			options,
			signal,
			ctx.ui,
			selected.map((choice) => choice.label),
		);
	const labels = options.map(
		(option, index) => `${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ""}`,
	);
	const choice = await ctx.ui.select(question, labels, signal === undefined ? undefined : { signal });
	if (choice === undefined) return null;
	const option = options[labels.indexOf(choice)];
	return option === undefined ? null : [option];
}
