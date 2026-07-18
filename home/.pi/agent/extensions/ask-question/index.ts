import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import {
	findQuestionOption,
	makeQuestionOptions,
	resolveChoices,
	type AskQuestionResult,
	type QuestionOption,
} from "./choices.ts";
import { selectMultiple } from "./multi-select.ts";
import { AskQuestionParamsSchema, readAskQuestionDetails, type AskQuestionInput } from "./schema.ts";
import { sanitizeTerminalText } from "../_shared/terminal-text.ts";

export default function askQuestionExtension(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;

		pi.registerTool({
			name: "ask_question",
			label: "Ask Question",
			description:
				"Ask the user a multiple-choice question. Provide 2-5 alternatives. In the TUI, the user may select multiple alternatives; other interfaces accept one selection. The tool automatically adds 'Compare options' and 'Something else'. Use when you need the user to choose between specific options, ask for trade-offs, or provide a custom answer.",
			promptSnippet: "Ask the user a multiple-choice question with 2-5 alternatives",
			promptGuidelines: [
				"Use ask_question when you need the user to pick from specific options, ask for trade-offs, or provide a custom answer.",
				"Keep alternatives short and distinct.",
			],
			parameters: AskQuestionParamsSchema,
			executionMode: "sequential",
			async execute(_toolCallId, params, signal, _onUpdate, toolContext) {
				return executeAskQuestion(params, signal, toolContext);
			},
			renderCall(args, theme, _context) {
				const options = makeQuestionOptions(args.alternatives);
				const optionsText = options.map((option) => sanitizeTerminalText(option.label)).join(", ");
				const text =
					theme.fg("toolTitle", theme.bold("ask_question ")) +
					theme.fg("muted", sanitizeTerminalText(args.question)) +
					`\n${theme.fg("dim", `  Options: ${optionsText}`)}`;
				return new Text(text, 0, 0);
			},
			renderResult(result, _options, theme, _context) {
				const details = readAskQuestionDetails(result.details);
				if (details === undefined) {
					return new Text(theme.fg("warning", "Cancelled"), 0, 0);
				}
				if (details.action === "compare") {
					return new Text(theme.fg("success", "✓ ") + theme.fg("accent", "Comparison requested"), 0, 0);
				}
				if (details.answer === null) {
					return new Text(theme.fg("warning", "Cancelled"), 0, 0);
				}
				const display = details.answers.length > 0 ? details.answers.join(", ") : details.answer;
				const safeDisplay = sanitizeTerminalText(display);
				if (details.wasCustom) {
					return new Text(
						theme.fg("success", "✓ ") + theme.fg("muted", "(custom) ") + theme.fg("accent", safeDisplay),
						0,
						0,
					);
				}
				return new Text(theme.fg("success", "✓ ") + theme.fg("accent", safeDisplay), 0, 0);
			},
		});
	});
}

export async function executeAskQuestion(
	params: AskQuestionInput,
	signal: AbortSignal | undefined,
	ctx: ExtensionContext,
): Promise<AskQuestionResult> {
	if (signal?.aborted) return resolveChoices(params, null, undefined);
	const options = makeQuestionOptions(params.alternatives);

	const choices =
		ctx.mode === "tui"
			? await selectMultiple(params.question, options, signal, ctx.ui)
			: await selectSingle(params.question, options, signal, ctx);
	const customAnswer =
		choices?.some((choice) => choice.kind === "other") === true
			? await ctx.ui.input("Something else", "Type your answer...", signal === undefined ? undefined : { signal })
			: undefined;
	return resolveChoices(params, choices, customAnswer);
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
