/**
 * Ask User Question — multiple choice with an automatic "Something else" option.
 *
 * The AI provides a question and 2-5 alternatives. The tool appends "Something else"
 * as the final option. If the user picks it, a free-form input prompt is shown.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@mariozechner/pi-tui";

const OTHER_OPTION = "Something else";
const NO_ANSWER_MSG = "The user did not answer the question. Wait until further input from the user.";

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
    description: "2 to 5 alternative answer options. Do NOT include 'Something else' — it is appended automatically.",
  }),
});

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "ask_user_question",
    label: "Ask User Question",
    description:
      "Ask the user a multiple-choice question. Provide 2-5 alternatives; a 'Something else' option is appended automatically. Use when you need the user to choose between specific options or provide a custom answer.",
    promptSnippet: "Ask the user a multiple-choice question with 2-5 alternatives",
    promptGuidelines: [
      "Use ask_user_question when you need the user to pick from specific options or provide a custom answer.",
      "Provide exactly the question and 2-5 concise alternatives. Do NOT include 'Something else' — it is added automatically.",
      "Keep alternatives short and mutually exclusive.",
    ],
    parameters: AskUserQuestionParams,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (!ctx.hasUI) {
        return makeResult(params, "Error: UI not available (running in non-interactive mode)", null, false);
      }

      const options = [...params.alternatives, OTHER_OPTION];
      const choice = await ctx.ui.select(params.question, options, { signal });

      if (choice === null) {
        return makeResult(params, NO_ANSWER_MSG, null, false);
      }

      if (choice === OTHER_OPTION) {
        const custom = await ctx.ui.input("Something else", "Type your answer...", { signal });
        if (custom === null) {
          return makeResult(params, NO_ANSWER_MSG, null, false);
        }
        return makeResult(params, `User answered (custom): ${custom}`, custom, true);
      }

      return makeResult(params, `User selected: ${choice}`, choice, false);
    },

    renderCall(args, theme, _context) {
      const opts = [...args.alternatives, OTHER_OPTION];
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
