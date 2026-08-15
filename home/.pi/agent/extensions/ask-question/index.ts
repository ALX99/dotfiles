import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import {
	findQuestionOption,
	makeAskQuestionResult,
	makeQuestionOptions,
	resolveChoices,
	type AskQuestionResult,
	type QuestionOption,
} from "./choices.ts";
import { selectMultiple } from "./multi-select.ts";
import {
	AskQuestionParamsSchema,
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
				"Ask one to three multiple-choice questions in sequence. Each question needs 2-5 alternatives. In the TUI, the responder may select multiple alternatives; other interfaces accept one selection. The tool automatically adds 'Compare options' and 'Something else' to each question. Use when you need the responder to choose between specific options, ask for trade-offs, or provide a custom answer.",
			promptSnippet: "Ask one to three multiple-choice questions, each with 2-5 alternatives",
			promptGuidelines: [
				"Use ask_question when you need the responder to pick from specific options, ask for trade-offs, or provide a custom answer.",
				"Use ask_question to group related questions, but ask no more than three at once and keep alternatives short and distinct.",
			],
			parameters: AskQuestionParamsSchema,
			executionMode: "sequential",
			async execute(_toolCallId, params, signal, _onUpdate, toolContext) {
				return executeAskQuestion(params, signal, toolContext);
			},
			renderCall(args, theme, _context) {
				const text = args.questions
					.map((question, index) => {
						const options = makeQuestionOptions(question.alternatives);
						const optionsText = options.map((option) => sanitizeTerminalText(option.label)).join(", ");
						return (
							`${index === 0 ? theme.fg("toolTitle", theme.bold("ask_question ")) : "             "}` +
							theme.fg("muted", sanitizeTerminalText(question.question)) +
							`\n${theme.fg("dim", `  Options: ${optionsText}`)}`
						);
					})
					.join("\n");
				return new Text(text, 0, 0);
			},
			renderResult(result, _options, theme, _context) {
				const details = readAskQuestionDetails(result.details);
				if (details === undefined) {
					return new Text(theme.fg("warning", "Cancelled"), 0, 0);
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
	const results = [];
	for (const question of params.questions) {
		if (signal?.aborted) {
			results.push(resolveChoices(question, null, undefined));
			continue;
		}
		results.push(await executeQuestion(question, signal, ctx));
	}
	return makeAskQuestionResult(results);
}

async function executeQuestion(
	question: QuestionInput,
	signal: AbortSignal | undefined,
	ctx: ExtensionContext,
): Promise<ReturnType<typeof resolveChoices>> {
	const options = makeQuestionOptions(question.alternatives);
	const choices =
		ctx.mode === "tui"
			? await selectMultiple(question.question, options, signal, ctx.ui)
			: await selectSingle(question.question, options, signal, ctx);
	const customAnswer =
		choices?.some((choice) => choice.kind === "other") === true
			? await ctx.ui.input("Something else", "Type your answer...", signal === undefined ? undefined : { signal })
			: undefined;
	return resolveChoices(question, choices, customAnswer);
}

async function selectSingle(
	question: string,
	options: readonly QuestionOption[],
	signal: AbortSignal | undefined,
	ctx: ExtensionContext,
): Promise<QuestionOption[] | null> {
	const choice = await ctx.ui.select(
		question,
		options.map((option) => option.label),
		signal === undefined ? undefined : { signal },
	);
	if (choice === undefined) return null;
	const selected = findQuestionOption(options, choice);
	return selected === undefined ? null : [selected];
}

function renderAnswer(details: AskQuestionResponseDetails, theme: { fg(color: string, text: string): string }): string {
	if (details.action === "compare") {
		return theme.fg("success", "✓ ") + theme.fg("accent", "Comparison requested");
	}
	if (details.answer === null) return theme.fg("warning", "Cancelled");

	const display = details.answers.length > 0 ? details.answers.join(", ") : details.answer;
	const safeDisplay = sanitizeTerminalText(display);
	if (details.wasCustom) {
		return theme.fg("success", "✓ ") + theme.fg("muted", "(custom) ") + theme.fg("accent", safeDisplay);
	}
	return theme.fg("success", "✓ ") + theme.fg("accent", safeDisplay);
}
