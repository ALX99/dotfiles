import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Key, matchesKey, Text, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

const PROS_CONS_OPTION = "Ask AI for pros and cons";
const OTHER_OPTION = "Something else";
const NO_ANSWER_MSG = "User declined to answer, await further instructions.";

interface AskQuestionDetails {
  question: string;
  alternatives: string[];
  answer: string | null;
  answers: string[];
  wasCustom: boolean;
}

const AskQuestionParams = Type.Object({
  question: Type.String({ description: "The question to ask the user" }),
  alternatives: Type.Array(Type.String({ description: "One alternative answer option" }), {
    minItems: 2,
    maxItems: 5,
    description: "2 to 5 alternative answer options."
  }),
});

export default function(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;

    pi.registerTool({
      name: "ask_question",
      label: "Ask Question",
      description:
        "Ask the user a multiple-choice question. Provide 2-5 alternatives. The user may select one or more options. The tool automatically adds 'Ask AI for pros and cons' and 'Something else'. Use when you need the user to choose between specific options, ask for trade-offs, or provide a custom answer.",
      promptSnippet: "Ask the user a multiple-choice question with 2-5 alternatives",
      promptGuidelines: [
        "Use ask_question when you need the user to pick from specific options, ask for trade-offs, or provide a custom answer.",
        "Keep alternatives short and mutually exclusive.",
      ],
      parameters: AskQuestionParams,
      executionMode: "sequential",

      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const options = [...params.alternatives, PROS_CONS_OPTION, OTHER_OPTION];
        const choices = ctx.mode === "tui"
          ? await selectMultiple(params.question, options, signal, ctx)
          : await selectSingle(params.question, options, signal, ctx);

        if (choices == null || choices.length === 0) {
          return makeResult(params, NO_ANSWER_MSG, null, false);
        }

        if (choices.includes(PROS_CONS_OPTION)) {
          return makeResult(
            params,
            "User asked for pros and cons. Explain the pros and cons of each alternative, then call ask_question again with the same question and alternatives.",
            choices,
            false,
          );
        }

        let answers = choices.filter((choice) => choice !== OTHER_OPTION);
        let wasCustom = false;

        if (choices.includes(OTHER_OPTION)) {
          const custom = await ctx.ui.input("Something else", "Type your answer...", { signal });
          if (custom == null) {
            return makeResult(params, NO_ANSWER_MSG, null, false);
          }
          answers = [...answers, custom];
          wasCustom = true;
        }

        if (answers.length === 0) {
          return makeResult(params, NO_ANSWER_MSG, null, false);
        }

        const prefix = wasCustom && answers.length === 1 ? "User answered (custom): " : "User selected: ";
        return makeResult(params, `${prefix}${answers.join(", ")}`, answers, wasCustom);
      },

      renderCall(args, theme, _context) {
        const opts = [...args.alternatives, PROS_CONS_OPTION, OTHER_OPTION];
        const optsText = opts.join(", ");
        const text =
          theme.fg("toolTitle", theme.bold("ask_question ")) +
          theme.fg("muted", args.question) +
          `\n${theme.fg("dim", `  Options: ${optsText}`)}`;
        return new Text(text, 0, 0);
      },

      renderResult(result, _options, theme, _context) {
        const details = result.details as AskQuestionDetails | undefined;
        if (!details || details.answer === null) {
          return new Text(theme.fg("warning", "Cancelled"), 0, 0);
        }
        const display = details.answers.length > 0 ? details.answers.join(", ") : details.answer;
        if (details.wasCustom) {
          return new Text(
            theme.fg("success", "✓ ") +
            theme.fg("muted", "(custom) ") +
            theme.fg("accent", display),
            0,
            0,
          );
        }
        return new Text(theme.fg("success", "✓ ") + theme.fg("accent", display), 0, 0);
      },
    });
  });
}

async function selectSingle(
  question: string,
  options: string[],
  signal: AbortSignal | undefined,
  ctx: { ui: { select: (question: string, options: string[], opts?: { signal?: AbortSignal }) => Promise<string | undefined | null> } },
): Promise<string[] | null> {
  const choice = await ctx.ui.select(question, options, { signal });
  return choice == null ? null : [choice];
}

async function selectMultiple(
  question: string,
  options: string[],
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
): Promise<string[] | null> {
  let finish: ((value: string[] | null) => void) | undefined;
  const onAbort = () => finish?.(null);
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    return await ctx.ui.custom<string[] | null>((tui, theme, _keybindings, done) => {
      finish = done;
      if (signal?.aborted) done(null);
    let current = 0;
    const selected = new Set<number>();
    let cachedLines: string[] | undefined;
    let cachedWidth = 0;

    function refresh() {
      cachedLines = undefined;
      tui.requestRender();
    }

    function submit() {
      done(getSubmittedChoices([...selected], current, options));
    }

    function addWrapped(lines: string[], width: number, text: string) {
      lines.push(...wrapTextWithAnsi(text, width));
    }

    function addWrappedWithPrefix(lines: string[], width: number, prefix: string, text: string) {
      const prefixWidth = visibleWidth(prefix);
      if (prefixWidth >= width) {
        addWrapped(lines, width, prefix + text);
        return;
      }
      const wrapped = wrapTextWithAnsi(text, width - prefixWidth);
      const continuationPrefix = " ".repeat(prefixWidth);
      for (let i = 0; i < wrapped.length; i++) {
        lines.push(`${i === 0 ? prefix : continuationPrefix}${wrapped[i]}`);
      }
    }

    return {
      handleInput(data: string) {
        if (matchesKey(data, Key.up)) {
          current = Math.max(0, current - 1);
          refresh();
          return;
        }
        if (matchesKey(data, Key.down)) {
          current = Math.min(options.length - 1, current + 1);
          refresh();
          return;
        }
        if (matchesKey(data, Key.space)) {
          const nextSelected = toggleOptionSelection([...selected], current, options);
          selected.clear();
          for (const index of nextSelected) selected.add(index);
          refresh();
          return;
        }
        if (matchesKey(data, Key.enter)) {
          submit();
          return;
        }
        if (matchesKey(data, Key.escape)) {
          done(null);
        }
      },
      invalidate() {
        cachedLines = undefined;
      },
      render(width: number) {
        if (cachedLines && cachedWidth === width) return cachedLines;

        const renderWidth = Math.max(1, width);
        const lines: string[] = [];
        lines.push(theme.fg("accent", "─".repeat(renderWidth)));
        addWrappedWithPrefix(lines, renderWidth, " ", theme.fg("text", question));
        lines.push("");

        for (let i = 0; i < options.length; i++) {
          const isCurrent = i === current;
          const isSelected = selected.has(i);
          const cursor = isCurrent ? theme.fg("accent", "> ") : "  ";
          const label = makeOptionLabel(isSelected, options[i]);
          addWrappedWithPrefix(lines, renderWidth, cursor, theme.fg(getOptionColor(isCurrent), label));
        }

        lines.push("");
        addWrappedWithPrefix(
          lines,
          renderWidth,
          " ",
          theme.fg("dim", "↑↓ navigate • Space toggle • Enter submit • Esc cancel"),
        );
        lines.push(theme.fg("accent", "─".repeat(renderWidth)));

        cachedLines = lines;
        cachedWidth = width;
        return lines;
      },
    };
    });
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

function isSpecialOption(option: string): boolean {
  return option === PROS_CONS_OPTION || option === OTHER_OPTION;
}

export function getOptionColor(isCurrent: boolean): "accent" | "text" {
  return isCurrent ? "accent" : "text";
}

export function makeOptionLabel(selected: boolean, option: string): string {
  if (isSpecialOption(option)) return option;
  return `${selected ? "[x]" : "[ ]"} ${option}`;
}

export function toggleOptionSelection(selectedIndices: number[], currentIndex: number, options: string[]): number[] {
  if (isSpecialOption(options[currentIndex] ?? "")) return selectedIndices;

  if (selectedIndices.includes(currentIndex)) {
    return selectedIndices.filter((index) => index !== currentIndex);
  }
  return [...selectedIndices, currentIndex].sort((a, b) => a - b);
}

export function getSubmittedChoices(selectedIndices: number[], currentIndex: number, options: string[]): string[] {
  const currentOption = options[currentIndex];
  if (currentOption && isSpecialOption(currentOption)) return [currentOption];

  const submittedIndices = selectedIndices.length === 0 ? [currentIndex] : selectedIndices;
  return submittedIndices
    .sort((a, b) => a - b)
    .map((index) => options[index])
    .filter((option): option is string => option !== undefined && !isSpecialOption(option));
}

export function makeResult(
  params: { question: string; alternatives: string[] },
  text: string,
  answer: string | string[] | null,
  wasCustom: boolean,
) {
  const answers = answer == null ? [] : Array.isArray(answer) ? answer : [answer];
  return {
    content: [{ type: "text" as const, text }],
    details: {
      question: params.question,
      alternatives: params.alternatives,
      answer: answers[0] ?? null,
      answers,
      wasCustom,
    } satisfies AskQuestionDetails,
  };
}
