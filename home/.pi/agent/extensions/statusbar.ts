/**
 * Statusbar Extension — Full custom statusbar replacement.
 *
 * Shows a responsive project/model trail on the left and compact generation
 * speed and context usage on the right. When space is tight, location details
 * yield to the active model so the important state stays visible. The input
 * border mirrors context growth while idle and becomes an activity wave while
 * the agent runs.
 *
 * Right-side metrics are right-aligned with space padding.
 */

import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { isAbsolute, relative, sep } from "node:path";
import { sanitizeTerminalText } from "./_shared/terminal-text.ts";
import { registerAgentActivity } from "./_shared/agent-activity.ts";
import { getProcessReaper } from "./process-reaper/index.ts";

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

export interface StatusbarViewInput {
	readonly width: number;
	readonly leftParts: readonly string[];
	readonly rightParts?: readonly string[];
	readonly contextPercentage?: string;
}

export interface StatusbarViewModel {
	readonly left: string;
	readonly right: string;
	readonly line: string;
}

/* ─── context gradient ─── */

const PART_SEPARATOR = " · ";
const CONTEXT_GRADIENT_STEPS = 24;

type StatusbarTheme = ExtensionContext["ui"]["theme"];
type Rgb = readonly [red: number, green: number, blue: number];

interface ContextUsage {
	readonly tokens: number | null;
	readonly percent: number | null;
}

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

function formatTokensPerSecond(tokensPerSecond: number): string {
	if (!Number.isFinite(tokensPerSecond) || tokensPerSecond < 0) return "--";
	return tokensPerSecond < 100 ? tokensPerSecond.toFixed(1) : Math.round(tokensPerSecond).toString();
}

export function calculateTokensPerSecond(outputTokens: number, durationMs: number): number | undefined {
	if (!Number.isFinite(outputTokens) || outputTokens <= 0 || !Number.isFinite(durationMs) || durationMs <= 0) {
		return undefined;
	}
	return outputTokens / (durationMs / 1000);
}

export function renderTokensPerSecond(
	tokensPerSecond: number | undefined,
	averageTokensPerSecond: number | undefined,
	theme: StatusbarTheme,
): string {
	const current = tokensPerSecond === undefined ? "--" : formatTokensPerSecond(tokensPerSecond);
	const average = averageTokensPerSecond === undefined ? "" : ` avg:${formatTokensPerSecond(averageTokensPerSecond)}`;
	return theme.fg("dim", `tps:${current}${average}`);
}

function createTokensPerSecondTracker(requestRender: () => void) {
	let generationStartedAt: number | undefined;
	let tokensPerSecond: number | undefined;
	let totalOutputTokens = 0;
	let totalGenerationMs = 0;

	return {
		current() {
			return tokensPerSecond;
		},
		average() {
			return calculateTokensPerSecond(totalOutputTokens, totalGenerationMs);
		},
		start: () => {
			generationStartedAt = performance.now();
			// Keep the prior measurement visible while the next response or tool calls run.
			requestRender();
		},
		finish(outputTokens: number) {
			const startedAt = generationStartedAt;
			generationStartedAt = undefined;
			if (startedAt === undefined) return;

			const durationMs = performance.now() - startedAt;
			const measured = calculateTokensPerSecond(outputTokens, durationMs);
			if (measured === undefined) return;

			tokensPerSecond = measured;
			totalOutputTokens += outputTokens;
			totalGenerationMs += durationMs;
			requestRender();
		},
	};
}

function setupTokensPerSecond(pi: ExtensionAPI, requestRender: () => void) {
	const tracker = createTokensPerSecondTracker(requestRender);
	pi.on("turn_start", tracker.start);
	pi.on("message_end", (event) => {
		if (event.message.role === "assistant") tracker.finish(event.message.usage.output);
	});
	return tracker;
}

function clampPercent(percent: number): number {
	if (!Number.isFinite(percent)) return 0;
	return Math.min(100, Math.max(0, percent));
}

function columnCount(width: number): number {
	return Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
}

function filledColumns(percent: number, width: number): number {
	return Math.round((clampPercent(percent) / 100) * width);
}

function quantizeGradientPosition(percent: number): number {
	return (Math.round((percent / 100) * (CONTEXT_GRADIENT_STEPS - 1)) / (CONTEXT_GRADIENT_STEPS - 1)) * 100;
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

function rgbToAnsi256(color: Rgb): number {
	const [red, green, blue] = color;
	const redIndex = Math.round((red / 255) * 5);
	const greenIndex = Math.round((green / 255) * 5);
	const blueIndex = Math.round((blue / 255) * 5);
	return 16 + 36 * redIndex + 6 * greenIndex + blueIndex;
}

function colorizeRgb(text: string, color: Rgb, theme: StatusbarTheme): string {
	const [red, green, blue] = color;
	const ansi =
		theme.getColorMode() === "truecolor" ? `\x1b[38;2;${red};${green};${blue}m` : `\x1b[38;5;${rgbToAnsi256(color)}m`;
	return `${ansi}${text}\x1b[39m`;
}

function renderGradientFill(percent: number, width: number, filledCharacter: string, theme: StatusbarTheme): string {
	const columns = columnCount(width);
	const filled = filledColumns(percent, columns);
	let result = "";
	let segment = "";
	let segmentColor: Rgb | undefined;

	const flush = () => {
		if (segmentColor && segment !== "") result += colorizeRgb(segment, segmentColor, theme);
		segment = "";
	};

	for (let index = 0; index < filled; index++) {
		const position = columns <= 1 ? clampPercent(percent) : (index / (columns - 1)) * 100;
		const color = contextGradientColor(quantizeGradientPosition(position));
		if (!sameRgb(segmentColor, color)) {
			flush();
			segmentColor = color;
		}
		segment += filledCharacter;
	}
	flush();

	return result;
}

/* ─── statusbar layout ─── */

/** Chooses statusbar content without reading session/UI state. */
export function buildStatusbarViewModel(input: StatusbarViewInput): StatusbarViewModel {
	const width = columnCount(input.width);
	const rightParts = input.rightParts ?? (input.contextPercentage ? [input.contextPercentage] : []);
	const right = truncateToWidth(joinParts(rightParts), width);

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

export function renderContextPercentage(usage: ContextUsage, theme: StatusbarTheme): string {
	if (usage.tokens === null || usage.percent === null) {
		return theme.fg("dim", "--%");
	}

	const normalizedPercent = clampPercent(usage.percent);
	return colorizeRgb(`${Math.round(usage.percent)}%`, contextGradientColor(normalizedPercent), theme);
}

/** Shows the process groups that process-reaper currently retains for cleanup. */
export function renderBackgroundProcessCount(backgroundGroups: number, theme: StatusbarTheme): string {
	if (backgroundGroups <= 0) return "";
	return theme.fg("dim", `bg:${backgroundGroups}`);
}

/**
 * Draws a full-width editor border that fills from left to right as context
 * grows through a smooth green → yellow → orange → red ramp. The statusbar
 * remains the precise percentage readout.
 */
export function renderContextBorder(percent: number | null | undefined, width: number, theme: StatusbarTheme): string {
	const borderWidth = columnCount(width);
	if (percent === null || percent === undefined || !Number.isFinite(percent)) {
		return theme.fg("borderMuted", "─".repeat(borderWidth));
	}

	const normalizedPercent = clampPercent(percent);
	const filled = filledColumns(normalizedPercent, borderWidth);
	return (
		renderGradientFill(normalizedPercent, borderWidth, "━", theme) +
		theme.fg("borderMuted", "─".repeat(borderWidth - filled))
	);
}

const THINKING_WAVE_COLORS = [
	"dim",
	"muted",
	"thinkingMinimal",
	"thinkingLow",
	"thinkingMedium",
	"thinkingHigh",
	"thinkingXhigh",
	"accent",
	"thinkingXhigh",
	"thinkingHigh",
	"thinkingMedium",
	"thinkingLow",
	"thinkingMinimal",
	"muted",
] as const;

type ThinkingWaveColor = (typeof THINKING_WAVE_COLORS)[number];

/** Renders one horizontal pass of the full-width thinking wave. */
export function renderThinkingWaveBorder(width: number, position: number, theme: StatusbarTheme): string {
	const borderWidth = columnCount(width);
	if (borderWidth === 0) return "";

	const paletteLength = THINKING_WAVE_COLORS.length;
	let result = "";

	for (let index = 0; index < borderWidth; index++) {
		const paletteIndex = (((index + position) % paletteLength) + paletteLength) % paletteLength;
		const color: ThinkingWaveColor = THINKING_WAVE_COLORS[paletteIndex]!;
		result += theme.fg(color, "━");
	}
	return result;
}

/* ─── statusbar ─── */

const requestRenderNoop = (): void => {};

export default function (pi: ExtensionAPI) {
	let requestRender: (() => void) | undefined;

	pi.on("session_start", (_event, ctx) => {
		requestRender = setupStatusbar(ctx, pi);
		if (ctx.mode === "tui") setupInputBorder(ctx, pi);
		requestRender();
	});

	pi.on("model_select", () => {
		requestRender?.();
	});
}

function setupInputBorder(ctx: ExtensionContext, pi: ExtensionAPI): void {
	ctx.ui.setWorkingVisible(false);

	let agentActive = false;
	let wavePosition = 0;
	let waveTimer: ReturnType<typeof setInterval> | undefined;
	let requestRender: () => void = requestRenderNoop;

	const startAgentActivity = () => {
		if (agentActive) return;

		agentActive = true;
		wavePosition = 0;
		waveTimer = setInterval(() => {
			wavePosition++;
			requestRender();
		}, 100);
		requestRender();
	};
	const stopAgentActivity = () => {
		if (!agentActive) return;

		agentActive = false;
		if (waveTimer) clearInterval(waveTimer);
		waveTimer = undefined;
		requestRender();
	};

	registerAgentActivity(pi, {
		settleEvent: "agent_settled",
		onActiveChange: (active) => (active ? startAgentActivity() : stopAgentActivity()),
	});
	pi.on("session_shutdown", () => {
		stopAgentActivity();
		ctx.ui.setWorkingVisible(true);
	});

	class ContextBorderEditor extends CustomEditor {
		override render(width: number): string[] {
			// Pi normally recolors this border for the thinking level. Render the
			// base editor with raw borders, then replace only its horizontal
			// borders so editing, scrolling, and autocomplete continue to work.
			this.borderColor = (text) => text;
			const lines = super.render(width);
			const plainBorder = "─".repeat(columnCount(width));
			const topBorder = agentActive
				? renderThinkingWaveBorder(width, -wavePosition, ctx.ui.theme)
				: renderContextBorder(ctx.getContextUsage()?.percent, width, ctx.ui.theme);
			const bottomWaveBorder = agentActive ? renderThinkingWaveBorder(width, wavePosition, ctx.ui.theme) : topBorder;

			if (lines[0] === plainBorder) lines[0] = topBorder;
			else if (lines[0]) lines[0] = ctx.ui.theme.fg("borderMuted", lines[0]);

			const bottomBorderIndex = lines.findIndex(
				(line, index) => index > 0 && (line === plainBorder || line.startsWith("─── ↓ ")),
			);
			if (bottomBorderIndex !== -1) {
				const line = lines[bottomBorderIndex]!;
				lines[bottomBorderIndex] = line === plainBorder ? bottomWaveBorder : ctx.ui.theme.fg("borderMuted", line);
			}

			return lines;
		}
	}

	ctx.ui.setEditorComponent((tui, theme, keybindings) => {
		requestRender = () => tui.requestRender();
		return new ContextBorderEditor(tui, theme, keybindings);
	});
}

function setupStatusbar(ctx: ExtensionContext, pi: ExtensionAPI): () => void {
	let requestRender: (() => void) | undefined;
	const processReaper = getProcessReaper();
	const tpsTracker = setupTokensPerSecond(pi, () => requestRender?.());

	pi.on("turn_end", () => {
		requestRender?.();
	});

	ctx.ui.setFooter((tui, theme, statusbarData) => {
		const statusbarRequestRender = () => tui.requestRender();
		requestRender = statusbarRequestRender;
		let backgroundGroups = 0;
		const unsubBranch = statusbarData.onBranchChange(statusbarRequestRender);
		const unsubProcessReaper = processReaper.onBackgroundGroupChange((count) => {
			backgroundGroups = count;
			statusbarRequestRender();
		});

		return {
			dispose: () => {
				unsubBranch();
				unsubProcessReaper();
			},
			invalidate() {},
			render(width: number): string[] {
				/* left: cwd, branch, model/thinking */
				const leftParts: string[] = [];
				leftParts.push(theme.fg("muted", sanitizeTerminalText(shortenCwd(ctx.cwd))));

				const branchName = statusbarData.getGitBranch();
				if (branchName) {
					leftParts.push(theme.fg("dim", "git:") + theme.fg("accent", sanitizeTerminalText(branchName)));
				}

				const processCount = renderBackgroundProcessCount(backgroundGroups, theme);
				if (processCount) leftParts.push(processCount);

				const model = ctx.model;
				if (model) {
					let modelText = theme.fg("text", sanitizeTerminalText(model.id));
					const thinking = pi.getThinkingLevel();
					if (thinking) {
						modelText += theme.fg("dim", "/") + theme.fg(THINKING_COLOR[thinking], thinking);
					}
					leftParts.push(modelText);
				}

				const taskStatus = statusbarData.getExtensionStatuses().get("tasks");
				if (taskStatus) leftParts.push(renderTaskStatus(taskStatus, theme));

				const ctxUsage = ctx.getContextUsage();
				const viewInput: StatusbarViewInput = {
					width,
					leftParts,
					rightParts: [
						renderTokensPerSecond(tpsTracker.current(), tpsTracker.average(), theme),
						...(ctxUsage ? [renderContextPercentage(ctxUsage, theme)] : []),
					],
				};
				const view = buildStatusbarViewModel(viewInput);
				return [view.line];
			},
		};
	});

	return () => requestRender?.();
}

function renderTaskStatus(status: string, theme: StatusbarTheme): string {
	const text = sanitizeTerminalText(status);
	if (text.startsWith("✓")) return theme.fg("success", text);
	if (text === "Tasks off") return theme.fg("muted", text);
	return theme.fg("accent", text);
}
