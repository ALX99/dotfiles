/**
 * Statusbar Extension — Full custom statusbar replacement.
 *
 * Shows the active model and working directory on the left and compact
 * generation speed, turns, compactions, token totals and mix, and context
 * usage on the right. Token totals span every reply recorded in the session
 * file, including branches that were later summarized, and count recorded
 * summary-generation usage. Right-side metrics are separated by whitespace
 * and drawn as dim labels over muted values, so the numbers lead and the
 * labels recede. Fast-changing fields keep fixed widths, and whole metrics
 * drop before any value is cut, so the bar does not reflow while numbers
 * grow. When space is tight, the directory yields to the model so the
 * important state stays visible. The input border mirrors context growth
 * while idle and becomes an activity wave while the agent runs.
 *
 * Right-side metrics are right-aligned with space padding.
 */

import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, ModelThinkingLevel, Usage } from "@earendil-works/pi-ai";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { isAbsolute, relative, sep } from "node:path";
import { sanitizeTerminalText } from "./_shared/terminal-text.ts";
import { registerAgentActivity } from "./_shared/agent-activity.ts";

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
const METRIC_SEPARATOR = "  ";
const CONTEXT_GRADIENT_STEPS = 24;

type StatusbarTheme = ExtensionContext["ui"]["theme"];
type Rgb = readonly [red: number, green: number, blue: number];

interface ContextUsage {
	readonly tokens: number | null;
	readonly percent: number | null;
}

const UNKNOWN_CONTEXT_USAGE: ContextUsage = { tokens: null, percent: null };

// The token field keeps a fixed width so its growth never jitters the cells to
// its left. Everything else is left natural: tps is the leftmost metric, and
// the rest only change width at digit boundaries.
const TOKEN_FIELD_WIDTH = 4;

const CONTEXT_GRADIENT = [
	{ percent: 0, color: [86, 211, 100] },
	{ percent: 55, color: [227, 179, 65] },
	{ percent: 78, color: [240, 136, 62] },
	{ percent: 100, color: [248, 81, 73] },
] as const satisfies readonly { readonly percent: number; readonly color: Rgb }[];

function joinParts(parts: readonly string[], separator: string): string {
	return parts.filter((part) => part !== "").join(separator);
}

function fitLeftParts(parts: readonly string[], width: number): string {
	const retained = parts.filter((part) => part !== "");
	while (retained.length > 1 && visibleWidth(joinParts(retained, PART_SEPARATOR)) > width) retained.shift();
	return truncateToWidth(joinParts(retained, PART_SEPARATOR), width);
}

function fitRightParts(parts: readonly string[], width: number): string {
	const retained = parts.filter((part) => part !== "");
	while (retained.length > 1 && visibleWidth(joinParts(retained, METRIC_SEPARATOR)) > width) retained.shift();
	return truncateToWidth(joinParts(retained, METRIC_SEPARATOR), width);
}

function formatTokensPerSecond(tokensPerSecond: number): string {
	if (!Number.isFinite(tokensPerSecond) || tokensPerSecond < 0) return "--";
	return Math.round(tokensPerSecond).toString();
}

function metricField(value: number | undefined, format: (value: number) => string, width: number): string {
	return (value === undefined ? "--" : format(value)).padStart(width);
}

const TOKEN_UNITS = [
	{ divisor: 1_000, suffix: "K" },
	{ divisor: 1_000_000, suffix: "M" },
	{ divisor: 1_000_000_000, suffix: "B" },
	{ divisor: 1_000_000_000_000, suffix: "T" },
] as const;

/** Formats a token count compactly: 950, 1.2K, 12K, 1.2M. Values fit the fixed token field. */
export function formatTokenCount(tokens: number): string {
	if (!Number.isFinite(tokens) || tokens < 0) return "--";
	const value = Math.round(tokens);
	if (value < TOKEN_UNITS[0].divisor) return String(value);

	// Start at the largest unit the value reaches; rounding may carry it upward.
	const next = TOKEN_UNITS.findIndex((unit) => value < unit.divisor);
	const startIndex = next === -1 ? TOKEN_UNITS.length - 1 : Math.max(next - 1, 0);
	for (let index = startIndex; index < TOKEN_UNITS.length; index++) {
		const unit = TOKEN_UNITS[index]!;
		const scaled = value / unit.divisor;
		// One decimal below ten keeps small counts readable; larger ones round.
		const rounded = scaled < 10 ? Math.round(scaled * 10) / 10 : Math.round(scaled);
		if (rounded < 1000) return `${rounded}${unit.suffix}`;
	}

	// The largest unit has nothing to carry into; clamp to keep the field width.
	return `999${TOKEN_UNITS.at(-1)!.suffix}`;
}

export interface SessionTotals {
	readonly turns: number;
	readonly compactions: number;
	readonly totalTokens: number;
	/** Prompt tokens: fresh input plus cache reads and writes. */
	readonly readTokens: number;
	/** Generated tokens. */
	readonly writeTokens: number;
	/** Prompt tokens served from cache. */
	readonly cachedTokens: number;
}

const EMPTY_SESSION_TOTALS: SessionTotals = {
	turns: 0,
	compactions: 0,
	totalTokens: 0,
	readTokens: 0,
	writeTokens: 0,
	cachedTokens: 0,
};

function addUsage(totals: SessionTotals, usage: Usage): SessionTotals {
	return {
		...totals,
		totalTokens: totals.totalTokens + usage.totalTokens,
		readTokens: totals.readTokens + usage.input + usage.cacheRead + usage.cacheWrite,
		writeTokens: totals.writeTokens + usage.output,
		cachedTokens: totals.cachedTokens + usage.cacheRead,
	};
}

/**
 * Counts completed assistant turns, compaction events, and token usage across
 * session entries. Summarized branches still count because the tokens were
 * spent, and recorded summary-generation usage counts with their event.
 */
export function sessionTotals(entries: readonly SessionEntry[]): SessionTotals {
	let totals = EMPTY_SESSION_TOTALS;
	for (const entry of entries) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			// Auto-retry removes failed attempts from agent state but keeps them in the
			// session file, so excluding them keeps the counts on real responses.
			if (entry.message.stopReason === "error") continue;
			totals = { ...addUsage(totals, entry.message.usage), turns: totals.turns + 1 };
			continue;
		}
		if (entry.type !== "compaction" && entry.type !== "branch_summary") continue;
		totals = {
			...(entry.usage ? addUsage(totals, entry.usage) : totals),
			compactions: totals.compactions + 1,
		};
	}
	return totals;
}

function metricText(theme: StatusbarTheme, label: string, value: string): string {
	return `${theme.fg("dim", label)}${theme.fg("muted", value)}`;
}

export function renderSessionCounts(totals: SessionTotals, theme: StatusbarTheme): string[] {
	return [metricText(theme, "turns:", String(totals.turns)), metricText(theme, "comp:", String(totals.compactions))];
}

export function renderTotalTokens(totals: SessionTotals, theme: StatusbarTheme): string {
	return metricText(theme, "tok:", metricField(totals.totalTokens, formatTokenCount, TOKEN_FIELD_WIDTH));
}

function percentOf(part: number, whole: number): number {
	if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return 0;
	return Math.round((part / whole) * 100);
}

/** Splits session tokens into prompt reads and cache hits; writes are the remainder. */
export function renderTokenMix(totals: SessionTotals, theme: StatusbarTheme): string[] {
	const prompt = totals.readTokens + totals.writeTokens;
	return [
		metricText(theme, "read:", `${percentOf(totals.readTokens, prompt)}%`),
		metricText(theme, "cache:", `${percentOf(totals.cachedTokens, totals.readTokens)}%`),
	];
}

export function calculateTokensPerSecond(outputTokens: number, durationMs: number): number | undefined {
	if (!Number.isFinite(outputTokens) || outputTokens <= 0 || !Number.isFinite(durationMs) || durationMs <= 0) {
		return undefined;
	}
	return outputTokens / (durationMs / 1000);
}

/** Renders the average generation rate across measured turns. */
export function renderTokensPerSecond(averageTokensPerSecond: number | undefined, theme: StatusbarTheme): string {
	const average = averageTokensPerSecond === undefined ? "--" : formatTokensPerSecond(averageTokensPerSecond);
	return `${theme.fg("dim", "tps:")}${theme.fg(averageTokensPerSecond === undefined ? "dim" : "muted", average)}`;
}

function createStatusbarMetrics(requestRender: () => void) {
	let generationStartedAt: number | undefined;
	let totalOutputTokens = 0;
	let totalGenerationMs = 0;
	let recorded = EMPTY_SESSION_TOTALS;

	return {
		tps() {
			return calculateTokensPerSecond(totalOutputTokens, totalGenerationMs);
		},
		totals(): SessionTotals {
			return recorded;
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
			if (calculateTokensPerSecond(outputTokens, durationMs) === undefined) return;

			totalOutputTokens += outputTokens;
			totalGenerationMs += durationMs;
		},
		account(message: AssistantMessage) {
			if (message.stopReason === "error") return;
			recorded = { ...addUsage(recorded, message.usage), turns: recorded.turns + 1 };
		},
		restore(entries: readonly SessionEntry[]) {
			recorded = sessionTotals(entries);
		},
	};
}

function setupStatusbarMetrics(pi: ExtensionAPI, requestRender: () => void, entries: readonly SessionEntry[]) {
	const metrics = createStatusbarMetrics(requestRender);
	metrics.restore(entries);

	pi.on("turn_start", metrics.start);
	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return;
		metrics.account(event.message);
		metrics.finish(event.message.usage.output);
		requestRender();
	});
	// Compactions and branch summaries arrive as session entries, so re-read
	// them to pick up the event count and any recorded generation usage.
	const resync = (ctx: ExtensionContext): void => {
		metrics.restore(ctx.sessionManager.getEntries());
		requestRender();
	};
	pi.on("session_compact", (_event, ctx) => resync(ctx));
	pi.on("session_tree", (_event, ctx) => resync(ctx));
	return metrics;
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
	const right = fitRightParts(rightParts, width);

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
	const metrics = setupStatusbarMetrics(pi, () => requestRender?.(), ctx.sessionManager.getEntries());

	pi.on("turn_end", () => {
		requestRender?.();
	});

	ctx.ui.setFooter((tui, theme) => {
		const statusbarRequestRender = () => tui.requestRender();
		requestRender = statusbarRequestRender;

		return {
			dispose: () => {},
			invalidate() {},
			render(width: number): string[] {
				/* left: cwd, model/thinking */
				const leftParts: string[] = [];
				leftParts.push(theme.fg("muted", sanitizeTerminalText(shortenCwd(ctx.cwd))));

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
				const totals = metrics.totals();
				const viewInput: StatusbarViewInput = {
					width,
					leftParts,
					rightParts: [
						renderTokensPerSecond(metrics.tps(), theme),
						...renderSessionCounts(totals, theme),
						...renderTokenMix(totals, theme),
						renderTotalTokens(totals, theme),
						renderContextPercentage(ctxUsage ?? UNKNOWN_CONTEXT_USAGE, theme),
					],
				};
				const view = buildStatusbarViewModel(viewInput);
				return [view.line];
			},
		};
	});

	return () => requestRender?.();
}
