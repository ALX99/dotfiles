/**
 * UI rendering for spawn_agent — the tool-call header (renderCall) and the
 * streaming/final result block (renderResult). Pure formatting plus a 1Hz
 * tick interval to keep the elapsed counter alive between tool events.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import type { AgentSummary } from "./host.ts";
import { DEPTH_ENV, type NestedRunDetails, type RunDetails } from "./process.ts";

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
	args: { message?: string; handoff?: string; agent?: string; task_name?: string; profile?: string; thinking?: string; cwd?: string; background?: boolean },
	expanded: boolean,
	theme: Theme,
): void {
	const agentLabel = args.agent ? ` ${theme.fg("accent", args.agent)}` : "";
	const parentDepth = Number.parseInt(process.env[DEPTH_ENV] ?? "0", 10) || 0;
	const meta: string[] = [theme.fg("muted", `[d${parentDepth + 1}]`)];
	if (args.task_name) meta.push(theme.fg("muted", `· ${args.task_name}`));
	if (args.profile) meta.push(theme.fg("muted", `· profile=${args.profile}`));
	if (args.thinking) meta.push(theme.fg("muted", `· thinking=${args.thinking}`));
	if (args.cwd) meta.push(theme.fg("muted", `· cwd=${args.cwd}`));
	if (args.handoff?.trim()) meta.push(theme.fg("muted", "· handoff"));
	if (args.background) meta.push(theme.fg("muted", "· background"));
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

// ── management tools ──────────────────────────────────────────────────

export interface AgentSummaryDetails {
	summaries: AgentSummary[];
}

export function renderManagementCall(
	toolName: string,
	agentId: string | undefined,
	message: string | undefined,
	expanded: boolean,
	summaries: AgentSummary[],
	theme: Theme,
): Container {
	const c = new Container();
	const summary = agentId ? summaries.find((candidate) => candidate.agent_id === agentId) : undefined;
	const target = summary
		? ` · ${summary.task_name || summary.agent} · ${summary.agent_id.slice(0, 8)}`
		: agentId
			? ` · ${agentId.slice(0, 8)}`
			: " · all session agents";
	c.addChild(new Text(
		`${theme.fg("toolTitle", theme.bold(toolName))}${theme.fg("muted", target)}`,
		0,
		0,
	));
	if (message) {
		const body = expanded ? message : taskPreview(message);
		c.addChild(new Text(theme.fg(expanded ? "text" : "dim", `  ${body}`), 0, 0));
	}
	return c;
}

export function renderAgentSummaries(toolName: string, summaries: AgentSummary[], expanded: boolean, theme: Theme): Container {
	const c = new Container();
	const failed = summaries.some((summary) => summary.status === "failed");
	const icon = failed ? theme.fg("error", "✗") : theme.fg("success", "✓");
	const showCount = summaries.length !== 1 || toolName === "list_agents";
	const count = showCount ? theme.fg("muted", ` · ${summaries.length} agent${summaries.length === 1 ? "" : "s"}`) : "";
	c.addChild(new Text(`${icon} ${theme.fg("toolTitle", theme.bold(toolName))}${count}`, 0, 0));
	if (!summaries.length) {
		c.addChild(new Text(theme.fg("dim", "  No subagents in this session."), 0, 0));
		return c;
	}
	for (const summary of summaries) {
		const running = summary.status === "starting" || summary.status === "running";
		const statusIcon = summary.status === "failed"
			? theme.fg("error", "✗")
			: running
				? theme.fg("warning", "⟳")
				: summary.status === "idle"
					? theme.fg("success", "✓")
					: theme.fg("dim", "–");
		c.addChild(new Text(
			`  ${statusIcon} ${theme.fg("text", summary.task_name || summary.agent)} ${theme.fg("dim", `· ${summary.agent} · ${summary.profile} · ${summary.model} · ${summary.effective_thinking} · ${summary.agent_id.slice(0, 8)} · ${summary.status}`)}`,
			0,
			0,
		));
		if (expanded) {
			const output = summary.final_text || summary.error;
			if (output) c.addChild(new Text(theme.fg(summary.status === "failed" ? "error" : "toolOutput", output), 2, 0));
		}
	}
	return c;
}

// ── wait tool ─────────────────────────────────────────────────────────

export interface WaitDetails {
	summaries: AgentSummary[];
	elapsedMs: number;
	timeoutMs?: number;
}

export function renderWaitCall(agentIds: string[], timeoutMs: number | undefined, summaries: AgentSummary[], theme: Theme): Container {
	const c = new Container();
	const summaryById = new Map(summaries.map((summary) => [summary.agent_id, summary]));
	const count = agentIds.length;
	const deadline = timeoutMs === undefined ? "" : ` · up to ${formatDuration(timeoutMs)}`;
	c.addChild(new Text(
		`${theme.fg("toolTitle", theme.bold("wait_agent"))} ${theme.fg("muted", `· waiting for ${count} agent${count === 1 ? "" : "s"} to settle${deadline}`)}`,
		0,
		0,
	));
	for (const id of agentIds) {
		const summary = summaryById.get(id);
		const label = summary?.task_name || summary?.agent || id.slice(0, 8);
		c.addChild(new Text(
			`${theme.fg("warning", "  ⟳")} ${theme.fg("text", label)} ${theme.fg("dim", `· ${id.slice(0, 8)}`)}`,
			0,
			0,
		));
	}
	return c;
}

export function renderWaitResult(details: WaitDetails, expanded: boolean, theme: Theme): Container {
	const c = new Container();
	const settled = details.summaries.filter((summary) => summary.status !== "starting" && summary.status !== "running").length;
	const allSettled = settled === details.summaries.length;
	const icon = allSettled ? theme.fg("success", "✓") : theme.fg("warning", "!");
	const suffix = allSettled
		? `${settled}/${details.summaries.length} settled`
		: `${settled}/${details.summaries.length} settled · ${details.summaries.length - settled} still running`;
	c.addChild(new Text(
		`${icon} ${theme.fg("toolTitle", theme.bold("wait_agent"))} ${theme.fg("muted", `· ${suffix} · ${formatDuration(details.elapsedMs)}`)}`,
		0,
		0,
	));

	for (const summary of details.summaries) {
		const failed = summary.status === "failed";
		const running = summary.status === "starting" || summary.status === "running";
		const statusIcon = failed
			? theme.fg("error", "✗")
			: running
				? theme.fg("warning", "⟳")
				: summary.status === "idle"
					? theme.fg("success", "✓")
					: theme.fg("dim", "–");
		const label = summary.task_name || summary.agent;
		c.addChild(new Text(
			`  ${statusIcon} ${theme.fg("text", label)} ${theme.fg("dim", `· ${summary.agent} · ${summary.profile} · ${summary.agent_id.slice(0, 8)} · ${summary.status}`)}`,
			0,
			0,
		));
		if (expanded) {
			const output = summary.final_text || summary.error;
			if (output) c.addChild(new Text(theme.fg(failed ? "error" : "toolOutput", output), 2, 0));
		}
	}
	return c;
}

// ── result block ──────────────────────────────────────────────────────

export interface RenderOptions {
	expanded: boolean;
	isPartial: boolean;
}

export function renderResultBlock(details: RunDetails, options: RenderOptions, theme: Theme): Container {
	const c = new Container();
	const failed = details.aborted || details.exitCode !== 0 || details.status === "failed" || details.status === "aborted";
	const isRunning = !failed && (options.isPartial || details.status === "launched" || details.status === "starting" || details.status === "running");
	const elapsed = formatDuration((details.endTime ?? Date.now()) - details.startTime);

	const icon = isRunning
		? theme.fg("warning", "⟳")
		: failed
			? theme.fg("error", "✗")
			: theme.fg("success", "✓");

	const headerParts = [
		`${icon} ${theme.fg("toolTitle", theme.bold(details.taskName || details.agent))}`,
		theme.fg("muted", `· ${details.agent}`),
	];
	if (options.expanded) {
		headerParts.push(theme.fg("muted", `[d${details.depth}]`));
		if (details.agentId) headerParts.push(theme.fg("muted", `· ${details.agentId.slice(0, 8)}`));
		headerParts.push(theme.fg("muted", `· ${details.profile} · ${details.model} · thinking=${details.effectiveThinking}`));
		headerParts.push(theme.fg("dim", `· ${details.toolCount} tools · ${elapsed}${isRunning ? " running" : ""}`));
	} else {
		headerParts.push(theme.fg("muted", `· ${details.profile}`));
		headerParts.push(theme.fg("dim", `· ${elapsed}${isRunning ? " running" : ""}`));
	}
	c.addChild(new Text(headerParts.join(" "), 0, 0));

	const tools = details.recentTools;
	if (options.expanded) {
		if (details.toolCount > tools.length) {
			c.addChild(new Text(theme.fg("dim", `… ${details.toolCount - tools.length} earlier actions`), 0, 0));
		}
		for (const tool of tools) {
			const body = tool.argsPreview ? `${tool.name}: ${tool.argsPreview}` : tool.name;
			c.addChild(new Text(theme.fg("muted", `  ${clipLine(body, 100)}`), 0, 0));
		}
	} else if (isRunning) {
		const latest = tools.at(-1);
		const activity = latest
			? `${latest.name}${latest.argsPreview ? `: ${latest.argsPreview}` : ""}`
			: details.lastMessage || "waiting for first response…";
		c.addChild(new Text(theme.fg("dim", `  ${clipLine(activity, 100)}`), 0, 0));
	}

	if (details.nestedRuns.length) {
		if (options.expanded) {
			c.addChild(new Spacer(1));
			renderNestedRuns(c, details.nestedRuns, true, theme);
		} else {
			const nested = countNestedRuns(details.nestedRuns);
			c.addChild(new Text(theme.fg("dim", `  ↳ ${nested.total} subagent${nested.total === 1 ? "" : "s"}${nested.running ? ` · ${nested.running} running` : ""}`), 0, 0));
		}
	}

	if (options.expanded && details.lastMessage && tools.length > 0) {
		c.addChild(new Spacer(1));
		c.addChild(new Text(theme.fg("text", details.lastMessage), 0, 0));
	}

	if (options.expanded) {
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
	}

	if (!isRunning && details.finalText) {
		c.addChild(new Spacer(1));
		const preview = options.expanded ? details.finalText : details.finalText.split("\n").slice(0, 3).join("\n");
		c.addChild(new Text(theme.fg("toolOutput", preview), 0, 0));
	}

	if (options.expanded && details.sessionFile) {
		c.addChild(new Spacer(1));
		c.addChild(new Text(theme.fg("dim", `session: ${details.sessionFile}`), 0, 0));
	}

	if (failed && details.stderr.trim()) {
		c.addChild(new Spacer(1));
		c.addChild(new Text(theme.fg("error", details.stderr.trim()), 0, 0));
	}

	return c;
}

function countNestedRuns(runs: NestedRunDetails[]): { total: number; running: number } {
	let total = 0;
	let running = 0;
	for (const run of runs) {
		total++;
		if (run.status === "running") running++;
		const children = countNestedRuns(run.nestedRuns);
		total += children.total;
		running += children.running;
	}
	return { total, running };
}

function renderNestedRuns(c: Container, runs: NestedRunDetails[], expanded: boolean, theme: Theme, indent = "  "): void {
	const visible = expanded ? runs : runs.slice(-2);
	if (runs.length > visible.length) {
		c.addChild(new Text(theme.fg("dim", `${indent}… ${runs.length - visible.length} earlier subagents`), 0, 0));
	}

	for (const run of visible) {
		const icon = run.status === "running"
			? theme.fg("warning", "⟳")
			: run.status === "completed"
				? theme.fg("success", "✓")
				: theme.fg("error", "✗");
		c.addChild(new Text(
			`${indent}${theme.fg("muted", "↳")} ${icon} ${theme.fg("accent", run.agent)} ${theme.fg("muted", `[d${run.depth}] · ${run.taskName}`)}`,
			0,
			0,
		));

		const tools = expanded ? run.recentTools : run.recentTools.slice(-2);
		for (const tool of tools) {
			const body = tool.argsPreview ? `${tool.name}: ${tool.argsPreview}` : tool.name;
			c.addChild(new Text(theme.fg("dim", `${indent}    ${clipLine(body, 92)}`), 0, 0));
		}
		if (!tools.length && run.lastMessage) {
			c.addChild(new Text(theme.fg("dim", `${indent}    ${clipLine(run.lastMessage, 92)}`), 0, 0));
		}
		if (run.nestedRuns.length) renderNestedRuns(c, run.nestedRuns, expanded, theme, `${indent}    `);
	}
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
