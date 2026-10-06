import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text, stripTerminalSequences, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { renderToolDuration, type ToolStatusState } from "./tool-status.ts";

/** Reserve a separate right column without allowing ANSI or wide text to overflow. */
export function withToolDuration(component: Component, state: ToolStatusState, theme: Theme): Component {
	return {
		invalidate() {
			component.invalidate();
		},
		render(width) {
			const duration = renderToolDuration(theme, state);
			const cells = duration === undefined ? 0 : visibleWidth(duration);
			if (duration === undefined || width < cells + 5) return component.render(width);
			const lines = component.render(width - cells - 1);
			if (lines.length === 0) return lines;
			const first = lines[0]!;
			return [first + " ".repeat(width - cells - visibleWidth(first)) + duration, ...lines.slice(1)];
		},
	};
}

export function plainChangeText(text: string): string {
	return stripTerminalSequences(text)
		.replaceAll(/[^\P{Cc}\n\t]/gu, "")
		.replaceAll("\t", "    ");
}

export function changeHeader(
	status: string,
	label: string,
	summary: () => string,
	theme: Theme,
	state: ToolStatusState,
): Component {
	return withToolDuration(
		{
			invalidate() {},
			render(width) {
				const title = theme.fg("toolTitle", theme.bold(plainChangeText(label).replaceAll(/\s+/gu, " ")));
				const detail = summary();
				const suffix = detail ? theme.fg("dim", ` · ${detail}`) : "";
				const prefix = `${status} `;
				const budget = width - visibleWidth(prefix) - visibleWidth(suffix);
				return [budget < 4 ? truncateToWidth(prefix + title, width) : prefix + truncateToWidth(title, budget) + suffix];
			},
		},
		state,
		theme,
	);
}

export function changeFailure(output: string, expanded: boolean, theme: Theme): Component {
	const text = plainChangeText(output);
	if (expanded) return new Text(theme.fg("error", text), 0, 0);
	const lines = text
		.split("\n")
		.filter((line) => line.trim() !== "")
		.slice(0, 3);
	return {
		invalidate() {},
		render: (width) => lines.map((line) => truncateToWidth(theme.fg("error", `  ${line}`), width)),
	};
}

export function colorChange(text: string, theme: Theme): string {
	return plainChangeText(text)
		.split("\n")
		.map((line) => theme.fg(line.startsWith("+") ? "success" : line.startsWith("-") ? "error" : "toolOutput", line))
		.join("\n");
}
