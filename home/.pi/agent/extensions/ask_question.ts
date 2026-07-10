import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Key, matchesKey, Text, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

const COMPARE_OPTION = "Compare options";
const OTHER_OPTION = "Something else";
const NO_ANSWER_MSG = "User declined to answer, await further instructions.";

export type QuestionOptionKind = "alternative" | "compare" | "other";

export interface QuestionOption {
  kind: QuestionOptionKind;
  label: string;
}

export type AskQuestionAction = "compare";

interface AskQuestionDetails {
  question: string;
  alternatives: string[];
  answer: string | null;
  answers: string[];
  wasCustom: boolean;
  action: AskQuestionAction | null;
}

interface AskQuestionInput {
  question: string;
  alternatives: string[];
}

const AskQuestionParams = Type.Object({
  question: Type.String({ description: "The question to ask the user" }),
  alternatives: Type.Array(Type.String({ minLength: 1, description: "One alternative answer option" }), {
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
        "Ask the user a multiple-choice question. Provide 2-5 alternatives. In the TUI, the user may select multiple alternatives; other interfaces accept one selection. The tool automatically adds 'Compare options' and 'Something else'. Use when you need the user to choose between specific options, ask for trade-offs, or provide a custom answer.",
      promptSnippet: "Ask the user a multiple-choice question with 2-5 alternatives",
      promptGuidelines: [
        "Use ask_question when you need the user to pick from specific options, ask for trade-offs, or provide a custom answer.",
        "Keep alternatives short and distinct.",
      ],
      parameters: AskQuestionParams,
      executionMode: "sequential",

      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        validateAlternatives(params.alternatives);
        const options = makeQuestionOptions(params.alternatives);
        const choices = ctx.mode === "tui"
          ? await selectMultiple(params.question, options, signal, ctx)
          : await selectSingle(params.question, options, signal, ctx);

        return resolveChoices(params, choices, () =>
          ctx.ui.input("Something else", "Type your answer...", { signal }),
        );
      },

      renderCall(args, theme, _context) {
        const opts = makeQuestionOptions(args.alternatives);
        const optsText = opts.map((option) => option.label).join(", ");
        const text =
          theme.fg("toolTitle", theme.bold("ask_question ")) +
          theme.fg("muted", args.question) +
          `\n${theme.fg("dim", `  Options: ${optsText}`)}`;
        return new Text(text, 0, 0);
      },

      renderResult(result, _options, theme, _context) {
        const details = result.details as AskQuestionDetails | undefined;
        if (!details) {
          return new Text(theme.fg("warning", "Cancelled"), 0, 0);
        }
        if (details.action === "compare") {
          return new Text(
            theme.fg("success", "✓ ") + theme.fg("accent", "Comparison requested"),
            0,
            0,
          );
        }
        if (details.answer === null) {
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

function normalizedAlternatives(alternatives: string[]): string[] {
  return alternatives.map((alternative) => alternative.trim());
}

export function validateAlternatives(alternatives: string[]): void {
  const labels = normalizedAlternatives(alternatives);
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
}

export function makeQuestionOptions(alternatives: string[]): QuestionOption[] {
  return [
    ...normalizedAlternatives(alternatives).map((label) => ({ kind: "alternative" as const, label })),
    { kind: "compare", label: COMPARE_OPTION },
    { kind: "other", label: OTHER_OPTION },
  ];
}

export async function resolveChoices(
  params: AskQuestionInput,
  choices: QuestionOption[] | null,
  requestCustom: () => Promise<string | undefined | null>,
) {
  if (choices == null || choices.length === 0) {
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

  let answers = choices
    .filter((choice) => choice.kind === "alternative")
    .map((choice) => choice.label);
  let wasCustom = false;

  if (choices.some((choice) => choice.kind === "other")) {
    const custom = await requestCustom();
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
}

async function selectSingle(
  question: string,
  options: QuestionOption[],
  signal: AbortSignal | undefined,
  ctx: { ui: { select: (question: string, options: string[], opts?: { signal?: AbortSignal }) => Promise<string | undefined | null> } },
): Promise<QuestionOption[] | null> {
  const choice = await ctx.ui.select(question, options.map((option) => option.label), { signal });
  if (choice == null) return null;
  const selected = options.find((option) => option.label === choice);
  return selected ? [selected] : null;
}

async function selectMultiple(
  question: string,
  options: QuestionOption[],
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
): Promise<QuestionOption[] | null> {
  let finish: ((value: QuestionOption[] | null) => void) | undefined;
  const onAbort = () => finish?.(null);
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    return await ctx.ui.custom<QuestionOption[] | null>((tui, theme, _keybindings, done) => {
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

export function getOptionColor(isCurrent: boolean): "accent" | "text" {
  return isCurrent ? "accent" : "text";
}

export function makeOptionLabel(selected: boolean, option: QuestionOption): string {
  if (option.kind !== "alternative") return option.label;
  return `${selected ? "[x]" : "[ ]"} ${option.label}`;
}

export function toggleOptionSelection(
  selectedIndices: number[],
  currentIndex: number,
  options: QuestionOption[],
): number[] {
  if (options[currentIndex]?.kind !== "alternative") return selectedIndices;

  if (selectedIndices.includes(currentIndex)) {
    return selectedIndices.filter((index) => index !== currentIndex);
  }
  return [...selectedIndices, currentIndex].sort((a, b) => a - b);
}

export function getSubmittedChoices(
  selectedIndices: number[],
  currentIndex: number,
  options: QuestionOption[],
): QuestionOption[] {
  const currentOption = options[currentIndex];
  if (currentOption && currentOption.kind !== "alternative") return [currentOption];

  const submittedIndices = selectedIndices.length === 0 ? [currentIndex] : selectedIndices;
  return [...submittedIndices]
    .sort((a, b) => a - b)
    .map((index) => options[index])
    .filter((option): option is QuestionOption => option?.kind === "alternative");
}

export function makeResult(
  params: AskQuestionInput,
  text: string,
  answer: string | string[] | null,
  wasCustom: boolean,
  action: AskQuestionAction | null = null,
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
      action,
    } satisfies AskQuestionDetails,
  };
}
