/**
 * Footer Extension — Full custom footer replacement.
 *
 * Shows a responsive project/model trail on the left and a compact context
 * percentage on the right. When space is tight, location details yield to the
 * active model so the important state stays visible. The input border mirrors
 * context growth as a text-free progress bar.
 *
 * The percentage is right-aligned with space padding.
 */

import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { isAbsolute, relative, sep } from "node:path";
import { sanitizeTerminalText } from "./_shared/terminal-text.ts";

export function shortenCwd(cwd: string, home: string = homedir()): string {
	const pathFromHome = relative(home, cwd);
	if (pathFromHome === "") return "~";
	if (pathFromHome === ".." || pathFromHome.startsWith(`..${sep}`) || isAbsolute(pathFromHome)) return cwd;
	return `~${sep}${pathFromHome}`;
}

/* ─── thinking level color ramp ─── */

// Pi ships per-level theme colors. Map thinking level → theme color so
// minimal reads cool/dim and the strongest levels read hot, using the
// theme's palette. `max` is newer than the bundled type definitions, so use
// xhigh's color until the theme API exposes a dedicated thinkingMax token.
type ThinkingColor = "muted" | "thinkingMinimal" | "thinkingLow" | "thinkingMedium" | "thinkingHigh" | "thinkingXhigh";

export const THINKING_COLOR = {
	off: "muted",
	minimal: "thinkingMinimal",
	low: "thinkingLow",
	medium: "thinkingMedium",
	high: "thinkingHigh",
	xhigh: "thinkingXhigh",
	max: "thinkingXhigh",
} as const satisfies Readonly<Record<ModelThinkingLevel, ThinkingColor>>;

export interface FooterViewInput {
	readonly width: number;
	readonly leftParts: readonly string[];
	readonly contextBar?: string;
}

export interface FooterViewModel {
	readonly left: string;
	readonly right: string;
	readonly line: string;
}

const PART_SEPARATOR = " · ";
const CONTEXT_GRADIENT_STEPS = 24;

type Rgb = readonly [red: number, green: number, blue: number];

const CONTEXT_GRADIENT = [
	{ percent: 0, color: [86, 211, 100] },
	{ percent: 55, color: [227, 179, 65] },
	{ percent: 78, color: [240, 136, 62] },
	{ percent: 100, color: [248, 81, 73] },
] as const satisfies readonly { readonly percent: number; readonly color: Rgb }[];

function joinParts(parts: readonly string[]): string {
	return parts.filter((part) => part !== "").join(PART_SEPARATOR);
}

function fitLeftParts(parts: readonly string[], width: number): string {
	const retained = parts.filter((part) => part !== "");
	while (retained.length > 1 && visibleWidth(joinParts(retained)) > width) retained.shift();
	return truncateToWidth(joinParts(retained), width);
}

function clampPercent(percent: number): number {
	if (!Number.isFinite(percent)) return 0;
	return Math.min(100, Math.max(0, percent));
}

/** Returns the green → yellow → orange → red color for a context percentage. */
export function contextGradientColor(percent: number): Rgb {
	const clamped = clampPercent(percent);
	for (let index = 1; index < CONTEXT_GRADIENT.length; index++) {
		const start = CONTEXT_GRADIENT[index - 1]!;
		const end = CONTEXT_GRADIENT[index]!;
		if (clamped > end.percent) continue;

		const progress = (clamped - start.percent) / (end.percent - start.percent);
		return [
			Math.round(start.color[0] + (end.color[0] - start.color[0]) * progress),
			Math.round(start.color[1] + (end.color[1] - start.color[1]) * progress),
			Math.round(start.color[2] + (end.color[2] - start.color[2]) * progress),
		];
	}

	return CONTEXT_GRADIENT.at(-1)!.color;
}

function sameRgb(left: Rgb | undefined, right: Rgb): boolean {
	return left?.[0] === right[0] && left[1] === right[1] && left[2] === right[2];
}

function colorizeRgb(text: string, color: Rgb, theme: ExtensionContext["ui"]["theme"]): string {
	const [red, green, blue] = color;
	const ansi =
		theme.getColorMode() === "truecolor"
			? `\x1b[38;2;${red};${green};${blue}m`
			: `\x1b[38;5;${16 + 36 * Math.round((red / 255) * 5) + 6 * Math.round((green / 255) * 5) + Math.round((blue / 255) * 5)}m`;
	return `${ansi}${text}\x1b[39m`;
}

function renderContextGradient(
	percent: number,
	width: number,
	filledCharacter: string,
	theme: ExtensionContext["ui"]["theme"],
): string {
	const filled = Math.min(width, Math.max(0, Math.round((clampPercent(percent) / 100) * width)));
	let result = "";
	let segment = "";
	let segmentColor: Rgb | undefined;

	const flush = () => {
		if (segmentColor && segment !== "") result += colorizeRgb(segment, segmentColor, theme);
		segment = "";
	};

	for (let index = 0; index < filled; index++) {
		const position = width <= 1 ? clampPercent(percent) : (index / (width - 1)) * 100;
		const quantizedPosition =
			(Math.round((position / 100) * (CONTEXT_GRADIENT_STEPS - 1)) / (CONTEXT_GRADIENT_STEPS - 1)) * 100;
		const color = contextGradientColor(quantizedPosition);
		if (!sameRgb(segmentColor, color)) {
			flush();
			segmentColor = color;
		}
		segment += filledCharacter;
	}
	flush();

	return result;
}

/** Chooses footer content without reading session/UI state. */
export function buildFooterViewModel(input: FooterViewInput): FooterViewModel {
	const width = Math.max(0, input.width);
	const right = input.contextBar ? truncateToWidth(input.contextBar, width) : "";

	if (right === "") {
		const left = fitLeftParts(input.leftParts, width);
		return {
			left,
			right,
			line: left,
		};
	}

	const availableLeftWidth = width - visibleWidth(right) - 1;
	if (availableLeftWidth < 3) {
		return { left: "", right, line: truncateToWidth(right, width) };
	}

	const left = fitLeftParts(input.leftParts, availableLeftWidth);
	const padding = width - visibleWidth(left) - visibleWidth(right);
	if (padding > 0) {
		return { left, right, line: truncateToWidth(left + " ".repeat(padding) + right, width) };
	}
	return { left, right, line: truncateToWidth(`${left} ${right}`, width) };
}

/* ─── context percentage ─── */

export function renderContextBar(
	usage: { tokens: number | null; contextWindow: number; percent: number | null },
	theme: ExtensionContext["ui"]["theme"],
): string {
	if (usage.tokens === null || usage.percent === null) {
		return theme.fg("dim", "--%");
	}

	const normalizedPercent = clampPercent(usage.percent);
	return colorizeRgb(`${Math.round(usage.percent)}%`, contextGradientColor(normalizedPercent), theme);
}

/**
 * Draws a full-width editor border that fills from left to right as context
 * grows through a smooth green → yellow → orange → red ramp. The footer
 * remains the precise percentage readout.
 */
export function renderContextBorder(
	percent: number | null | undefined,
	width: number,
	theme: ExtensionContext["ui"]["theme"],
): string {
	const borderWidth = Math.max(0, Math.floor(width));
	if (percent === null || percent === undefined || !Number.isFinite(percent)) {
		return theme.fg("borderMuted", "─".repeat(borderWidth));
	}

	const normalizedPercent = clampPercent(percent);
	const filled = Math.min(borderWidth, Math.max(0, Math.round((normalizedPercent / 100) * borderWidth)));
	return (
		renderContextGradient(normalizedPercent, borderWidth, "━", theme) +
		theme.fg("borderMuted", "─".repeat(borderWidth - filled))
	);
}

/* ─── footer ─── */

export default function (pi: ExtensionAPI) {
	let requestRender: (() => void) | undefined;

	pi.on("session_start", (_event, ctx) => {
		requestRender = setupFooter(ctx, pi);
		if (ctx.mode === "tui") setupContextBorder(ctx);
		requestRender();
	});

	pi.on("model_select", () => {
		requestRender?.();
	});
}

function setupContextBorder(ctx: ExtensionContext): void {
	class ContextBorderEditor extends CustomEditor {
		override render(width: number): string[] {
			// Pi normally recolors this border for the thinking level. Render the
			// base editor with raw borders, then replace only its horizontal
			// borders so editing, scrolling, and autocomplete continue to work.
			this.borderColor = (text) => text;
			const lines = super.render(width);
			const plainBorder = "─".repeat(Math.max(0, Math.floor(width)));
			const contextBorder = renderContextBorder(ctx.getContextUsage()?.percent, width, ctx.ui.theme);

			if (lines[0] === plainBorder) lines[0] = contextBorder;
			else if (lines[0]) lines[0] = ctx.ui.theme.fg("borderMuted", lines[0]);

			const bottomBorder = lines.findIndex(
				(line, index) => index > 0 && (line === plainBorder || line.startsWith("─── ↓ ")),
			);
			if (bottomBorder !== -1) {
				const line = lines[bottomBorder]!;
				lines[bottomBorder] = line === plainBorder ? contextBorder : ctx.ui.theme.fg("borderMuted", line);
			}

			return lines;
		}
	}

	ctx.ui.setEditorComponent((tui, theme, keybindings) => new ContextBorderEditor(tui, theme, keybindings));
}

function setupFooter(ctx: ExtensionContext, pi: ExtensionAPI): () => void {
	let requestRender: (() => void) | undefined;

	pi.on("turn_end", () => {
		requestRender?.();
	});

	ctx.ui.setFooter((tui, theme, footerData) => {
		requestRender = () => tui.requestRender();
		const unsubBranch = footerData.onBranchChange(requestRender);

		return {
			dispose: unsubBranch,
			invalidate() {},
			render(width: number): string[] {
				/* left: cwd, branch, model/thinking */
				const leftParts: string[] = [];
				leftParts.push(theme.fg("muted", sanitizeTerminalText(shortenCwd(ctx.cwd))));

				const branchName = footerData.getGitBranch();
				if (branchName) {
					leftParts.push(theme.fg("dim", "git:") + theme.fg("accent", sanitizeTerminalText(branchName)));
				}

				const model = ctx.model;
				if (model) {
					let modelText = theme.fg("text", sanitizeTerminalText(model.id));
					const thinking = pi.getThinkingLevel();
					if (thinking) {
						modelText += theme.fg("dim", "/") + theme.fg(THINKING_COLOR[thinking], thinking);
					}
					leftParts.push(modelText);
				}

				const ctxUsage = ctx.getContextUsage();
				const viewInput: FooterViewInput = {
					width,
					leftParts,
					...(ctxUsage ? { contextBar: renderContextBar(ctxUsage, theme) } : {}),
				};
				const view = buildFooterViewModel(viewInput);
				return [view.line];
			},
		};
	});

	return () => requestRender?.();
}
