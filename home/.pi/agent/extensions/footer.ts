/**
 * Footer Extension — Full custom footer replacement.
 *
 * Shows on the left:  cwd, git branch, model + thinking level, context bar
 * Shows on the right: extension statuses, session tokens, latest cache hit rate, session length
 *
 * Right-aligned with space padding so stats stay flush to the terminal edge.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { isAbsolute, relative, sep } from "node:path";
import { sanitizeTerminalText } from "./_shared/terminal-text.ts";

/* ─── formatting ─── */

function fmt(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 10_000) return `${(n / 1_000).toFixed(0)}k`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return `${n}`;
}

export function shortenCwd(cwd: string, home: string = homedir()): string {
	const pathFromHome = relative(home, cwd);
	if (pathFromHome === "") return "~";
	if (pathFromHome === ".." || pathFromHome.startsWith(`..${sep}`) || isAbsolute(pathFromHome)) return cwd;
	return `~${sep}${pathFromHome}`;
}

function parseTimestamp(timestamp: string | undefined): number | undefined {
	if (!timestamp) return undefined;
	const parsed = Date.parse(timestamp);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function getSessionStartedAt(ctx: ExtensionContext): number {
	const headerStartedAt = parseTimestamp(ctx.sessionManager.getHeader()?.timestamp);
	if (headerStartedAt !== undefined) return headerStartedAt;

	for (const entry of ctx.sessionManager.getBranch()) {
		const entryStartedAt = parseTimestamp(entry.timestamp);
		if (entryStartedAt !== undefined) return entryStartedAt;
	}

	return Date.now();
}

function formatSessionLength(startedAt: number): string {
	const elapsedMinutes = Math.max(0, Math.floor((Date.now() - startedAt) / 60_000));
	const hours = Math.floor(elapsedMinutes / 60);
	const minutes = elapsedMinutes % 60;

	if (hours < 1) return `${minutes}m`;

	const days = Math.floor(hours / 24);
	const remainingHours = hours % 24;
	if (days < 1) return `${hours}h`;

	return `${days}d${remainingHours}h`;
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
	readonly tokens: string;
	readonly contextBar?: string;
	readonly sessionLength: string;
	readonly statuses: readonly string[];
}

export interface FooterViewModel {
	readonly left: string;
	readonly right: string;
	readonly line: string;
}

function joinParts(parts: readonly string[]): string {
	return parts.filter((part) => part !== "").join("  ");
}

/**
 * Chooses footer content without reading session/UI state. Right-side context
 * pressure and token totals win when the terminal is too narrow for every
 * footer detail; extension status and elapsed time are useful but expendable.
 */
export function buildFooterViewModel(input: FooterViewInput): FooterViewModel {
	const width = Math.max(0, input.width);
	const rightCandidates = [input.contextBar, input.tokens, input.sessionLength, joinParts(input.statuses)].filter(
		(part): part is string => part !== undefined && part !== "",
	);
	const rightParts: string[] = [];

	for (const candidate of rightCandidates) {
		const next = joinParts([...rightParts, candidate]);
		if (visibleWidth(next) <= width) rightParts.push(candidate);
	}

	let right = joinParts(rightParts);
	if (right === "" && rightCandidates[0]) {
		right = truncateToWidth(rightCandidates[0], width);
	}

	if (right === "") {
		return {
			left: truncateToWidth(joinParts(input.leftParts), width),
			right,
			line: truncateToWidth(joinParts(input.leftParts), width),
		};
	}

	const left = joinParts(input.leftParts);
	const availableLeftWidth = width - visibleWidth(right) - 1;
	if (availableLeftWidth < 3) {
		return { left: "", right, line: truncateToWidth(right, width) };
	}

	const shortenedLeft = truncateToWidth(left, availableLeftWidth);
	const padding = width - visibleWidth(shortenedLeft) - visibleWidth(right);
	if (padding > 0) {
		return { left: shortenedLeft, right, line: truncateToWidth(shortenedLeft + " ".repeat(padding) + right, width) };
	}
	return { left: shortenedLeft, right, line: truncateToWidth(`${shortenedLeft} ${right}`, width) };
}

/* ─── context bar ─── */

export function renderContextBar(
	usage: { tokens: number | null; contextWindow: number; percent: number | null },
	theme: ExtensionContext["ui"]["theme"],
): string {
	if (usage.tokens === null || usage.percent === null) {
		return theme.fg("dim", "[░░░░░░░░░░]--%");
	}

	const width = 10;
	const filled = Math.min(width, Math.max(0, Math.round((usage.percent / 100) * width)));
	const empty = width - filled;

	let color: "accent" | "warning" | "error";
	if (usage.percent < 50) color = "accent";
	else if (usage.percent < 80) color = "warning";
	else color = "error";

	const bar = theme.fg(color, "█".repeat(filled)) + theme.fg("dim", "░".repeat(empty));
	return `[${bar}]${theme.fg(color, `${Math.round(usage.percent)}%`)}`;
}

/* ─── footer ─── */

export default function (pi: ExtensionAPI) {
	let requestRender: (() => void) | undefined;

	pi.on("session_start", (_event, ctx) => {
		requestRender = setupFooter(ctx, pi);
		requestRender();
	});

	pi.on("model_select", () => {
		requestRender?.();
	});
}

function setupFooter(ctx: ExtensionContext, pi: ExtensionAPI): () => void {
	// Cache tokens between renders — recomputed on turn_end (O(1)), not on
	// every render. invalidate() resets the counter to rebuild from scratch
	// (used by session_compact and explicit refresh paths).
	const sessionStartedAt = getSessionStartedAt(ctx);
	let cachedTokens = "";
	let lastBranchRevision = "";
	let requestRender: (() => void) | undefined;

	function rebuildTokens() {
		const branch = ctx.sessionManager.getBranch();
		cachedTokens = buildSessionTokens(ctx, branch);
		lastBranchRevision = branchRevision(branch);
	}

	function recheckTokens() {
		const branch = ctx.sessionManager.getBranch();
		if (branchRevision(branch) !== lastBranchRevision) {
			cachedTokens = buildSessionTokens(ctx, branch);
			lastBranchRevision = branchRevision(branch);
		}
	}

	// Build once at attach time, then keep current via turn_end deltas.
	rebuildTokens();

	pi.on("turn_end", () => {
		rebuildTokens();
		requestRender?.();
	});

	ctx.ui.setFooter((tui, theme, footerData) => {
		requestRender = () => tui.requestRender();
		const unsubBranch = footerData.onBranchChange(requestRender);
		const renderInterval = setInterval(requestRender, 60_000);

		return {
			dispose() {
				clearInterval(renderInterval);
				unsubBranch();
			},
			invalidate() {
				rebuildTokens();
			},
			render(width: number): string[] {
				recheckTokens();

				/* left: cwd, branch, model, context bar */
				const leftParts: string[] = [];
				leftParts.push(theme.fg("muted", sanitizeTerminalText(shortenCwd(ctx.cwd))));

				const branchName = footerData.getGitBranch();
				if (branchName) {
					leftParts.push(
						theme.fg("dim", "(") + theme.fg("accent", sanitizeTerminalText(branchName)) + theme.fg("dim", ")"),
					);
				}

				const model = ctx.model;
				if (model) {
					let modelText =
						theme.fg("text", sanitizeTerminalText(model.id)) +
						theme.fg("dim", "(") +
						theme.fg("muted", sanitizeTerminalText(model.provider)) +
						theme.fg("dim", ")");
					const thinking = pi.getThinkingLevel();
					if (thinking) {
						modelText += theme.fg(THINKING_COLOR[thinking], ` · ${thinking}`);
					}
					leftParts.push(modelText);
				}

				const statuses = footerData.getExtensionStatuses();
				const statusParts: string[] = [];
				for (const [, text] of statuses) {
					statusParts.push(text);
				}

				const ctxUsage = ctx.getContextUsage();
				const viewInput: FooterViewInput = {
					width,
					leftParts,
					statuses: statusParts,
					tokens: cachedTokens,
					sessionLength: formatSessionLength(sessionStartedAt),
					...(ctxUsage ? { contextBar: renderContextBar(ctxUsage, theme) } : {}),
				};
				const view = buildFooterViewModel(viewInput);
				return [view.line];
			},
		};
	});

	return () => requestRender?.();
}

/** Stable identity for the selected session branch, including same-length switches. */
export function branchRevision(branch: readonly { readonly id: string }[]): string {
	return JSON.stringify(branch.map((entry) => entry.id));
}

function buildSessionTokens(
	ctx: ExtensionContext,
	branch: ReturnType<ExtensionContext["sessionManager"]["getBranch"]>,
): string {
	let input = 0;
	let output = 0;
	let latestCacheHitRate: number | undefined;

	for (const e of branch) {
		if (e.type === "message" && e.message.role === "assistant" && e.message.usage) {
			const usage = e.message.usage;
			input += usage.input ?? 0;
			output += usage.output ?? 0;

			const latestPromptTokens = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
			latestCacheHitRate = latestPromptTokens > 0 ? ((usage.cacheRead ?? 0) / latestPromptTokens) * 100 : undefined;
		}
	}

	// Always show CH (with ??.?% placeholder when unknown) so the right-side
	// width is stable and the layout doesn't shift as cache data appears.
	const sep = ctx.ui.theme.fg("dim", "/");
	const chStr = latestCacheHitRate !== undefined ? `${latestCacheHitRate.toFixed(1)}%` : "??.?%";
	return `${ctx.ui.theme.fg("accent", "↑")}${fmt(input)}${sep}${ctx.ui.theme.fg("accent", "↓")}${fmt(output)}${sep}${ctx.ui.theme.fg("accent", "CH")}${chStr}`;
}
