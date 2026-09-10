import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import {
	COMPARE_OPTION,
	COMMENT_OPTION,
	OTHER_OPTION,
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
import {
	AskQuestionParamsSchema,
	prepareAskQuestionArguments,
	readAskQuestionDetails,
	type AskQuestionInput,
	type AskQuestionResponseDetails,
	type QuestionInput,
} from "./schema.ts";
import { sanitizeTerminalText } from "../_shared/terminal-text.ts";

export default function askQuestionExtension(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;

		pi.registerTool({
			name: "ask_question",
			label: "Ask Question",
			description:
				"Ask 1-3 sequential multiple-choice questions, each with 2-5 short labeled alternatives and optional descriptions. Put recommendations first with brief reasons in descriptions. TUI supports multiple selections; other interfaces one. Users may comment or give custom answers. Compare options compares selected alternatives, or all if none. Compare options, Something else, and Add comment are automatic; never supply them.",
			promptSnippet: "Ask up to three consequential questions with alternatives, comments, or comparison",
			promptGuidelines: [
				"Use ask_question only when the answer materially changes implementation, scope, or an authorization decision; resolve routine details from evidence.",
				"Group up to three independent questions; ask dependent ones only after their prerequisites are answered.",
				"Give each alternative a neutral, distinct, short label, with optional trade-off descriptions. Put recommended alternatives first and briefly explain why.",
				"Never add Compare, Something else, or Add comment as alternatives; ask_question supplies those options automatically.",
				"A comment qualifies an answer; it is not approval. Never treat cancellation, unanswered questions, or comparison requests as approval.",
			],
			parameters: AskQuestionParamsSchema,
			prepareArguments: prepareAskQuestionArguments,
			executionMode: "sequential",
			async execute(_toolCallId, params, signal, _onUpdate, toolContext) {
				return executeAskQuestion(params, signal, toolContext);
			},
			renderCall(args, theme, _context) {
				const text = (args.questions ?? [])
					.map((question, index) => {
						const optionsText = (question.alternatives ?? [])
							.map((option: string | Partial<QuestionInput["alternatives"][number]>) =>
								typeof option === "string"
									? `  ${option}`
									: `  ${option.label ?? ""}${option.description ? ` — ${option.description}` : ""}`,
							)
							.concat(`  ${COMPARE_OPTION} · ${OTHER_OPTION} · ${COMMENT_OPTION}`)
							.map(sanitizeTerminalText)
							.join("\n");
						return (
							(index === 0 ? theme.fg("toolTitle", theme.bold("ask_question ")) : "             ") +
							theme.fg("muted", sanitizeTerminalText(question.question)) +
							`\n${theme.fg("dim", optionsText)}`
						);
					})
					.join("\n");
				return new Text(text, 0, 0);
			},
			renderResult(result, _options, theme, context) {
				const details = readAskQuestionDetails(result.details);
				if (details === undefined) {
					const text = result.content
						.filter((item) => item.type === "text")
						.map((item) => sanitizeTerminalText(item.text))
						.join("\n");
					return new Text(theme.fg(context.isError ? "error" : "warning", text), 0, 0);
				}
				const text =
					details.questions.length === 1
						? renderAnswer(details.questions[0]!, theme)
						: details.questions
								.map(
									(question) =>
										`${theme.fg("muted", sanitizeTerminalText(question.question))}: ${renderAnswer(question, theme)}`,
								)
								.join("\n");
				return new Text(text, 0, 0);
			},
		});
	});
}

export async function executeAskQuestion(
	params: AskQuestionInput,
	signal: AbortSignal | undefined,
	ctx: ExtensionContext,
): Promise<AskQuestionResult> {
	const questions = params.questions.map((question) => ({
		...question,
		alternatives: normalizeAlternatives(question.alternatives),
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
	return makeAskQuestionResult(results);
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

function renderAnswer(details: AskQuestionResponseDetails, theme: { fg(color: string, text: string): string }): string {
	if (details.status === "not_asked") return theme.fg("muted", "Not asked");
	if (details.status === "aborted") return theme.fg("warning", "Interrupted");
	if (details.action === "compare") {
		const targets = details.comparisonAlternatives?.join(", ");
		return (
			theme.fg("success", "✓ ") +
			theme.fg("accent", `Comparison requested${targets ? `: ${sanitizeTerminalText(targets)}` : ""}`)
		);
	}
	if (details.answer === null) return theme.fg("warning", "Cancelled");

	const display = details.answers.length > 0 ? details.answers.join(", ") : details.answer;
	const safeDisplay =
		sanitizeTerminalText(display) +
		(details.comment ? theme.fg("muted", `\nComment: ${sanitizeTerminalText(details.comment)}`) : "");
	if (details.wasCustom) {
		return theme.fg("success", "✓ ") + theme.fg("muted", "(custom) ") + theme.fg("accent", safeDisplay);
	}
	return theme.fg("success", "✓ ") + theme.fg("accent", safeDisplay);
}
