import { sanitizeTerminalLine, sanitizeTerminalText } from "../../_shared/terminal-text.ts";
import type { AgentStatus, AgentView } from "../agent-types.ts";
import { formatContextUsage, formatDuration } from "../render.ts";
import { allowedDashboardActions, isActiveStatus, type AllowedDashboardActions } from "./actions.ts";
import {
	MAX_VISIBLE_AGENTS,
	clampScroll,
	visibleAgentViews,
	type DashboardScreen,
	type DashboardState,
	type LinesCacheEntry,
} from "./state.ts";

export interface DashboardAgentRow {
	readonly id: string;
	readonly selected: boolean;
	readonly status: AgentStatus;
	readonly task: string;
	readonly activity: string;
	readonly elapsed: string;
	readonly actions: AllowedDashboardActions;
}

export interface DashboardViewModel {
	readonly screen: DashboardScreen;
	readonly counts: string;
	readonly rows: readonly DashboardAgentRow[];
	readonly selected?: DashboardAgentViewModel;
	readonly hasClosed: boolean;
	readonly showClosed: boolean;
	readonly listOffset: number;
	readonly maxRows: number;
}

export interface DashboardAgentViewModel {
	readonly id: string;
	readonly task: string;
	readonly status: AgentStatus;
	readonly statusLabel: string;
	readonly elapsed: string;
	readonly current: string;
	readonly recent: readonly string[];
	readonly actions: AllowedDashboardActions;
	readonly transcript: ContentViewModel;
	readonly output: ContentViewModel;
	readonly diagnostics: readonly (readonly [string, string])[];
}

export type ContentViewModel =
	| { readonly status: "loading"; readonly lines: readonly string[]; readonly offset: number }
	| { readonly status: "error"; readonly lines: readonly string[]; readonly offset: number }
	| { readonly status: "ready"; readonly lines: readonly string[]; readonly offset: number };

export interface BuildDashboardViewModelOptions {
	readonly state: DashboardState;
	readonly views: readonly AgentView[];
	readonly maxRows: number;
	readonly now: number;
}

export function buildDashboardViewModel(options: BuildDashboardViewModelOptions): DashboardViewModel {
	const { state, views, now } = options;
	const listViews = visibleAgentViews(state, views);
	const selectionViews = state.screen === "list" ? listViews : views;
	const selected = selectionViews.find((view) => view.summary.agent_id === state.selectedId);
	const rows = listViews
		.slice(state.listOffset, state.listOffset + MAX_VISIBLE_AGENTS)
		.map((view) => agentRow(view, view.summary.agent_id === state.selectedId, now));
	return {
		screen: state.screen,
		counts: formatAgentCounts(views),
		rows,
		...(selected === undefined ? {} : { selected: selectedView(selected, state, options.maxRows, now) }),
		hasClosed: views.some((view) => view.summary.status === "closed"),
		showClosed: state.showClosed,
		listOffset: state.listOffset,
		maxRows: options.maxRows,
	};
}

export function formatAgentCounts(views: readonly AgentView[]): string {
	const counts = new Map<AgentStatus, number>();
	for (const view of views) counts.set(view.summary.status, (counts.get(view.summary.status) ?? 0) + 1);
	const active = (counts.get("starting") ?? 0) + (counts.get("running") ?? 0);
	const parts = [`${active} running`];
	const ready = counts.get("idle") ?? 0;
	if (ready) parts.push(`${ready} ready`);
	for (const status of ["failed", "aborted"] as const) {
		const count = counts.get(status) ?? 0;
		if (count) parts.push(`${count} ${status}`);
	}
	return parts.join(" · ");
}

function agentRow(view: AgentView, selected: boolean, now: number): DashboardAgentRow {
	return {
		id: view.summary.agent_id,
		selected,
		status: view.summary.status,
		task: sanitizeTerminalText(view.summary.task_name || view.summary.agent),
		activity: currentActivity(view),
		elapsed: formatDuration((view.details.endTime ?? now) - view.details.startTime),
		actions: allowedDashboardActions(view.summary),
	};
}

function selectedView(view: AgentView, state: DashboardState, maxRows: number, now: number): DashboardAgentViewModel {
	const { summary, details } = view;
	const available = Math.max(1, maxRows - 3);
	return {
		id: summary.agent_id,
		task: sanitizeTerminalText(summary.task_name || summary.agent),
		status: summary.status,
		statusLabel: statusLabel(summary.status),
		elapsed: formatDuration((details.endTime ?? now) - details.startTime),
		current: currentActivity(view),
		recent: details.recentTools.slice(-3).map((tool) => {
			const name = sanitizeTerminalText(tool.name);
			const args = tool.argsPreview ? `  ${sanitizeTerminalText(tool.argsPreview)}` : "";
			return `${name}${args}`;
		}),
		actions: allowedDashboardActions(summary),
		transcript: contentView(
			state.transcripts.get(summary.agent_id),
			summary.generation,
			state.transcriptOffset,
			available,
		),
		output: contentView(state.outputs.get(summary.agent_id), summary.generation, state.outputOffset, available),
		diagnostics: diagnostics(view),
	};
}

function contentView(
	entry: LinesCacheEntry | undefined,
	generation: number,
	offset: number,
	available: number,
): ContentViewModel {
	if (!entry || entry.generation !== generation || entry.status === "loading") {
		return { status: "loading", lines: [], offset: 0 };
	}
	if (entry.status === "error") {
		return {
			status: "error",
			lines: [sanitizeTerminalLine(entry.message), ...entry.lines.map(sanitizeTerminalLine)],
			offset: 0,
		};
	}
	const clamped = clampScroll(offset, Math.max(0, entry.lines.length - available));
	const end = entry.lines.length - clamped;
	return {
		status: "ready",
		lines: entry.lines.slice(Math.max(0, end - available), end),
		offset: clamped,
	};
}

function currentActivity(view: AgentView): string {
	const latest = view.details.recentTools.at(-1);
	if (latest) {
		const args = latest.argsPreview ? ` ${sanitizeTerminalText(latest.argsPreview)}` : "";
		return `${sanitizeTerminalText(latest.name)}${args}`;
	}
	if (isActiveStatus(view.summary.status)) {
		return view.details.lastMessage ? sanitizeTerminalText(view.details.lastMessage) : "starting…";
	}
	if (view.summary.status === "idle") return "ready";
	return statusLabel(view.summary.status);
}

function diagnostics(view: AgentView): readonly (readonly [string, string])[] {
	const { summary, details } = view;
	const nested = countNested(details.nestedRuns);
	return [
		["Agent", sanitizeTerminalText(summary.agent)],
		["Profile", sanitizeTerminalText(summary.profile)],
		["Model", sanitizeTerminalText(summary.model)],
		["Thinking", sanitizeTerminalText(summary.effective_thinking)],
		["Session", sanitizeTerminalText(summary.session_file ?? details.sessionFile ?? "unavailable")],
		["ID", sanitizeTerminalText(summary.agent_id)],
		["Generation", String(summary.generation)],
		["Depth", String(summary.depth)],
		[
			"Usage",
			`${details.toolCount} tools · ${details.usage.turns} turns${details.tokens ? ` · context ${formatContextUsage(details.tokens, details.contextWindow)}` : ""}`,
		],
		["Nested", nested.total ? `${nested.running}/${nested.total} running` : "none"],
	];
}

function countNested(runs: AgentView["details"]["nestedRuns"]): { total: number; running: number } {
	let total = 0;
	let running = 0;
	for (const run of runs) {
		total++;
		if (run.status === "running") running++;
		const child = countNested(run.nestedRuns);
		total += child.total;
		running += child.running;
	}
	return { total, running };
}

function statusLabel(status: AgentStatus): string {
	if (status === "idle") return "ready";
	if (status === "starting" || status === "running") return "running";
	return status;
}
