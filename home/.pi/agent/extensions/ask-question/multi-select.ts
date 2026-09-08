import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

import {
	getOptionColor,
	getSubmittedChoices,
	makeOptionLabel,
	toggleOptionSelection,
	type QuestionOption,
} from "./choices.ts";
import { sanitizeTerminalText } from "../_shared/terminal-text.ts";

export type MultiSelectUi = Pick<ExtensionContext["ui"], "custom">;

export function once<T>(complete: (value: T) => void): (value: T) => void {
	let completed = false;
	return (value) => {
		if (completed) return;
		completed = true;
		complete(value);
	};
}

export async function selectMultiple(
	question: string,
	options: readonly QuestionOption[],
	signal: AbortSignal | undefined,
	ui: MultiSelectUi,
	initialSelected: readonly string[] = [],
): Promise<QuestionOption[] | null> {
	if (signal?.aborted) return null;

	let complete: ((value: QuestionOption[] | null) => void) | undefined;
	const onAbort = () => complete?.(null);
	signal?.addEventListener("abort", onAbort, { once: true });

	try {
		return await ui.custom<QuestionOption[] | null>((tui, theme, keybindings, done) => {
			const finish = once(done);
			complete = finish;
			if (signal?.aborted) {
				finish(null);
				return emptyComponent();
			}

			let current = 0;
			const selected = new Set(
				options.flatMap((option, index) =>
					option.kind === "alternative" && initialSelected.includes(option.label) ? [index] : [],
				),
			);
			let cachedLines: string[] | undefined;
			let cachedWidth = 0;

			const refresh = () => {
				cachedLines = undefined;
				tui.requestRender();
			};
			const submit = () => finish(getSubmittedChoices([...selected], current, options));

			return {
				handleInput(data: string) {
					if (keybindings.matches(data, "tui.select.up")) {
						current = Math.max(0, current - 1);
						refresh();
						return;
					}
					if (keybindings.matches(data, "tui.select.down")) {
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
					if (keybindings.matches(data, "tui.select.confirm")) {
						submit();
						return;
					}
					if (keybindings.matches(data, "tui.select.cancel")) finish(null);
				},
				invalidate() {
					cachedLines = undefined;
				},
				render(width: number) {
					if (cachedLines !== undefined && cachedWidth === width) return cachedLines;

					const renderWidth = Math.max(1, width);
					const lines = renderQuestionOptions(question, options, { current, selected }, renderWidth, theme);
					addWrappedWithPrefix(lines, renderWidth, " ", theme.fg("dim", makeHelpText(keybindings)));
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

function renderQuestionOptions(
	question: string,
	options: readonly QuestionOption[],
	selection: { current: number; selected: ReadonlySet<number> },
	renderWidth: number,
	theme: Pick<Theme, "fg">,
): string[] {
	const lines: string[] = [theme.fg("accent", "─".repeat(renderWidth))];
	addWrappedWithPrefix(lines, renderWidth, " ", theme.fg("text", sanitizeTerminalText(question)));
	lines.push("");

	for (let index = 0; index < options.length; index++) {
		const option = options[index];
		if (option === undefined) continue;
		const isCurrent = index === selection.current;
		const cursor = isCurrent ? theme.fg("accent", "> ") : "  ";
		const label = makeOptionLabel(selection.selected.has(index), option);
		addWrappedWithPrefix(lines, renderWidth, cursor, theme.fg(getOptionColor(isCurrent), sanitizeTerminalText(label)));
		if (option.description) {
			addWrappedWithPrefix(lines, renderWidth, "      ", theme.fg("muted", sanitizeTerminalText(option.description)));
		}
	}

	lines.push("");
	if (options.some((option) => option.kind === "compare")) {
		addWrappedWithPrefix(
			lines,
			renderWidth,
			" ",
			theme.fg(
				"dim",
				selection.selected.size > 0
					? "Compare options / Add comment use checked answers."
					: "Compare options compares all. Add comment lets you choose answers first.",
			),
		);
	}
	return lines;
}

function makeHelpText(keybindings: Pick<KeybindingsManager, "getKeys">): string {
	const navigation = (["tui.select.up", "tui.select.down"] as const)
		.flatMap((keybinding) => keybindings.getKeys(keybinding))
		.join("/");
	const controls = [
		navigation === "" ? undefined : `${navigation} navigate`,
		"Space toggle",
		makeBindingHint(keybindings, "tui.select.confirm", "submit"),
		makeBindingHint(keybindings, "tui.select.cancel", "cancel"),
	];
	return controls.filter((control) => control !== undefined).join(" • ");
}

function makeBindingHint(
	keybindings: Pick<KeybindingsManager, "getKeys">,
	keybinding: "tui.select.confirm" | "tui.select.cancel",
	description: string,
): string | undefined {
	const keys = keybindings.getKeys(keybinding);
	return keys.length === 0 ? undefined : `${keys.join("/")} ${description}`;
}

function emptyComponent() {
	return {
		handleInput() {},
		invalidate() {},
		render() {
			return [];
		},
	};
}

function addWrapped(lines: string[], width: number, text: string): void {
	lines.push(...wrapTextWithAnsi(text, width));
}

function addWrappedWithPrefix(lines: string[], width: number, prefix: string, text: string): void {
	const prefixWidth = visibleWidth(prefix);
	if (prefixWidth >= width) {
		addWrapped(lines, width, prefix + text);
		return;
	}
	const wrapped = wrapTextWithAnsi(text, width - prefixWidth);
	const continuationPrefix = " ".repeat(prefixWidth);
	for (let index = 0; index < wrapped.length; index++) {
		const line = wrapped[index];
		if (line !== undefined) lines.push(`${index === 0 ? prefix : continuationPrefix}${line}`);
	}
}
