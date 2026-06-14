/**
 * Ask User Question — multiple choice with automatic follow-up options.
 *
 * The AI provides a question and 2-5 alternatives. The tool appends "Ask AI for pros and cons"
 * and "Something else" as final options. If the user asks for pros/cons, the AI should
 * explain the trade-offs and call this tool again with the same question/alternatives.
 * If the user picks "Something else", a free-form input prompt is shown.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";

const PROS_CONS_OPTION = "Ask AI for pros and cons";
const OTHER_OPTION = "Something else";
const NO_ANSWER_MSG = "User declined to answer, await further instructions.";

interface AskUserQuestionDetails {
  question: string;
  alternatives: string[];
  answer: string | null;
  wasCustom: boolean;
}

const AskUserQuestionParams = Type.Object({
  question: Type.String({ description: "The question to ask the user" }),
  alternatives: Type.Array(Type.String({ description: "One alternative answer option" }), {
    minItems: 2,
    maxItems: 5,
    description: "2 to 5 alternative answer options."
  }),
});

export default function(pi: ExtensionAPI) {
  pi.registerTool({
    name: "ask_user_question",
    label: "Ask User Question",
    description:
      "Ask the user a multiple-choice question. Provide 2-5 alternatives. The tool automatically adds 'Ask AI for pros and cons' and 'Something else'. Use when you need the user to choose between specific options, ask for trade-offs, or provide a custom answer.",
    promptSnippet: "Ask the user a multiple-choice question with 2-5 alternatives",
    promptGuidelines: [
      "Use ask_user_question when you need the user to pick from specific options, ask for trade-offs, or provide a custom answer.",
      "Keep alternatives short and mutually exclusive.",
    ],
    parameters: AskUserQuestionParams,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (!ctx.hasUI) {
        return makeResult(params, "Error: UI not available (running in non-interactive mode)", null, false);
      }

      const options = [...params.alternatives, PROS_CONS_OPTION, OTHER_OPTION];
      const choice = await ctx.ui.select(params.question, options, { signal });

      if (choice == null) {
        return makeResult(params, NO_ANSWER_MSG, null, false);
      }

      if (choice === PROS_CONS_OPTION) {
        return makeResult(
          params,
          "User asked for pros and cons. Explain the pros and cons of each alternative, then call ask_user_question again with the same question and alternatives.",
          choice,
          false,
        );
      }

      if (choice === OTHER_OPTION) {
        const custom = await ctx.ui.input("Something else", "Type your answer...", { signal });
        if (custom == null) {
          return makeResult(params, NO_ANSWER_MSG, null, false);
        }
        return makeResult(params, `User answered (custom): ${custom}`, custom, true);
      }

      return makeResult(params, `User selected: ${choice}`, choice, false);
    },

    renderCall(args, theme, _context) {
      const opts = [...args.alternatives, PROS_CONS_OPTION, OTHER_OPTION];
      const optsText = opts.map((o, i) => `${i + 1}. ${o}`).join(", ");
      const text =
        theme.fg("toolTitle", theme.bold("ask_user_question ")) +
        theme.fg("muted", args.question) +
        `\n${theme.fg("dim", `  Options: ${optsText}`)}`;
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme, _context) {
      const details = result.details as AskUserQuestionDetails | undefined;
      if (!details || details.answer === null) {
        return new Text(theme.fg("warning", "Cancelled"), 0, 0);
      }
      if (details.wasCustom) {
        return new Text(
          theme.fg("success", "✓ ") +
          theme.fg("muted", "(custom) ") +
          theme.fg("accent", details.answer),
          0,
          0,
        );
      }
      return new Text(theme.fg("success", "✓ ") + theme.fg("accent", details.answer), 0, 0);
    },
  });
}

function makeResult(
  params: { question: string; alternatives: string[] },
  text: string,
  answer: string | null,
  wasCustom: boolean,
) {
  return {
    content: [{ type: "text" as const, text }],
    details: {
      question: params.question,
      alternatives: params.alternatives,
      answer,
      wasCustom,
    } satisfies AskUserQuestionDetails,
  };
}
