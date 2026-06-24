/**
 * UI rendering for spawn_agent — the tool-call header (renderCall) and the
 * streaming/final result block (renderResult). Pure formatting plus a 1Hz
 * tick interval to keep the elapsed counter alive between tool events.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { DEPTH_ENV, getFinalText, type RunDetails } from "./process.ts";

const TICK_INTERVAL_MS = 1000;

// ── formatters ────────────────────────────────────────────────────────

export function formatDuration(ms: number): string {
	const s = ms / 1000;
	return s < 10 ? `${s.toFixed(1)}s` : `${Math.round(s)}s`;
}

export function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

export function formatContextUsage(tokens: number, window?: number): string {
	if (!window) return formatTokens(tokens);
	return `${Math.round((tokens / window) * 100)}%/${formatTokens(window)}`;
}

export function taskPreview(s: string): string {
	const one = s.replace(/\s+/g, " ").trim();
	return one.length > 80 ? `${one.slice(0, 77)}...` : one;
}

function clipLine(s: string, max: number): string {
	return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// ── tool-call header ──────────────────────────────────────────────────

export function renderCallHeader(
	c: Container,
	args: { message?: string; agent_type?: string; task_name?: string; reasoning_effort?: string; model?: string; cwd?: string },
	expanded: boolean,
	theme: Theme,
): void {
	const agentLabel = args.agent_type ? ` ${theme.fg("accent", args.agent_type)}` : "";
	const parentDepth = Number.parseInt(process.env[DEPTH_ENV] ?? "0", 10) || 0;
	const meta: string[] = [theme.fg("muted", `[d${parentDepth + 1}]`)];
	if (args.task_name) meta.push(theme.fg("muted", `· ${args.task_name}`));
	if (args.reasoning_effort) meta.push(theme.fg("muted", `· effort=${args.reasoning_effort}`));
	if (args.model) meta.push(theme.fg("muted", `· model=${args.model}`));
	if (args.cwd) meta.push(theme.fg("muted", `· cwd=${args.cwd}`));
	c.addChild(new Text(`${theme.fg("toolTitle", theme.bold("spawn_agent"))}${agentLabel} ${meta.join(" ")}`, 0, 0));

	if (args.message) {
		if (!expanded) {
			c.addChild(new Text(theme.fg("dim", `  ${taskPreview(args.message)}`), 0, 0));
		} else {
			c.addChild(new Spacer(1));
			c.addChild(new Text(theme.fg("text", args.message), 0, 0));
		}
	}
}

// ── result block ──────────────────────────────────────────────────────

export interface RenderOptions {
	expanded: boolean;
	isPartial: boolean;
}

export function renderResultBlock(details: RunDetails, options: RenderOptions, theme: Theme): Container {
	const c = new Container();
	const failed = details.aborted || details.exitCode !== 0;
	const isRunning = options.isPartial && !failed;
	const elapsed = formatDuration((details.endTime ?? Date.now()) - details.startTime);

	const icon = isRunning
		? theme.fg("warning", "⟳")
		: failed
			? theme.fg("error", "✗")
			: theme.fg("success", "✓");

	const headerParts = [
		`${icon} ${theme.fg("toolTitle", theme.bold(details.agent))}`,
		theme.fg("muted", `[d${details.depth}]`),
		theme.fg("muted", `· ${details.taskName}`),
	];
	if (details.model) headerParts.push(theme.fg("muted", `(${details.model})`));
	headerParts.push(theme.fg("dim", `· ${details.toolCount} tools · ${elapsed}${isRunning ? " running" : ""}`));
	c.addChild(new Text(headerParts.join(" "), 0, 0));

	// Tool log: last 8 collapsed, all expanded; earlier entries summarized.
	const tools = details.recentTools;
	const visibleCount = options.expanded ? tools.length : Math.min(tools.length, 8);
	if (details.toolCount > visibleCount) {
		c.addChild(new Text(theme.fg("dim", `… ${details.toolCount - visibleCount} earlier actions`), 0, 0));
	}
	for (let i = tools.length - visibleCount; i < tools.length; i++) {
		const t = tools[i];
		const body = t.argsPreview ? `${t.name}: ${t.argsPreview}` : t.name;
		c.addChild(new Text(theme.fg("muted", `  ${clipLine(body, 100)}`), 0, 0));
	}

	// Waiting indicator for the long first-turn gap before any tool event.
	if (isRunning && details.toolCount === 0 && !details.lastMessage) {
		c.addChild(new Spacer(1));
		c.addChild(new Text(theme.fg("dim", "waiting for first response…"), 0, 0));
	}

	// Latest thinking line. Skip when the tool log is empty — nothing to think about yet.
	if (details.lastMessage && tools.length > 0) {
		c.addChild(new Spacer(1));
		c.addChild(new Text(theme.fg("text", details.lastMessage), 0, 0));
	}

	// Usage line — meaningful only after the first turn, or with a context gauge.
	const usageParts: string[] = [];
	if (details.usage.input) usageParts.push(theme.fg("dim", `↑${formatTokens(details.usage.input)}`));
	if (details.usage.output) usageParts.push(theme.fg("dim", `↓${formatTokens(details.usage.output)}`));
	if (details.usage.cacheRead) usageParts.push(theme.fg("dim", `R${formatTokens(details.usage.cacheRead)}`));
	if (details.usage.cacheWrite) usageParts.push(theme.fg("dim", `W${formatTokens(details.usage.cacheWrite)}`));
	if (details.usage.cost) usageParts.push(theme.fg("dim", `$${details.usage.cost.toFixed(3)}`));
	if (details.tokens > 0) {
		const pct = details.contextWindow ? (details.tokens / details.contextWindow) * 100 : 0;
		const color = pct > 90 ? "error" : pct > 70 ? "warning" : "dim";
		usageParts.push(theme.fg(color, formatContextUsage(details.tokens, details.contextWindow)));
	}
	if (usageParts.length) {
		c.addChild(new Spacer(1));
		c.addChild(new Text(usageParts.join(" "), 0, 0));
	}

	// Final output, only when done. 8 lines collapsed, full expanded.
	if (!isRunning) {
		const finalText = getFinalText(details.messages);
		if (finalText) {
			c.addChild(new Spacer(1));
			const preview = options.expanded ? finalText : finalText.split("\n").slice(0, 8).join("\n");
			c.addChild(new Text(theme.fg("toolOutput", preview), 0, 0));
		}
	}

	if (failed && details.stderr.trim()) {
		c.addChild(new Spacer(1));
		c.addChild(new Text(theme.fg("error", details.stderr.trim()), 0, 0));
	}

	return c;
}

/** Set up (and tear down) a 1Hz invalidation tick while the result is partial.
 * `ticks` is keyed by toolCallId so concurrent spawns don't share a slot. */
export function manageTick(
	ticks: Map<string, NodeJS.Timeout>,
	id: string,
	isPartial: boolean,
	invalidate: () => void,
): void {
	if (isPartial) {
		if (ticks.has(id)) return;
		// .unref() so a missed cleanup (process exits before final renderResult
		// fires) can't keep the agent alive indefinitely.
		ticks.set(id, setInterval(invalidate, TICK_INTERVAL_MS).unref()!);
	} else {
		const t = ticks.get(id);
		if (t) {
			clearInterval(t);
			ticks.delete(id);
		}
	}
}
