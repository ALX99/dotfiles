import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { COMPARE_OPTION, COMMENT_OPTION, OTHER_OPTION } from "./choices.ts";
import { executeAskQuestion } from "./execution.ts";
import {
	AskQuestionParamsSchema,
	prepareAskQuestionArguments,
	readAskQuestionDetails,
	type AskQuestionDetails,
	type AskQuestionResponseDetails,
	type QuestionInput,
} from "./schema.ts";
import { sanitizeTerminalText } from "../_shared/terminal-text.ts";

export function registerAskQuestionTool(pi: ExtensionAPI): void {
	pi.registerTool(createAskQuestionTool());
}

export function createAskQuestionTool(): ToolDefinition<typeof AskQuestionParamsSchema, AskQuestionDetails> {
	return {
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
		executionMode: "sequential" as const,
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
						theme.fg("muted", sanitizeTerminalText(question.question ?? "")) +
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
	};
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
