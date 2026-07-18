import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { sanitizeTerminalLine, sanitizeTerminalText } from "../_shared/terminal-text.ts";
import type { AgentStatus, AgentSummary, AgentView } from "./agent-types.ts";
import { formatContextUsage, formatDuration } from "./render.ts";

export type DashboardTheme = Pick<Theme, "fg" | "bg">;
export type DashboardScreen = "list" | "detail" | "transcript" | "output" | "diagnostics";
export type ContentTarget = "transcript" | "output";

export interface AllowedDashboardActions {
	readonly steer: boolean;
	readonly followUp: boolean;
	readonly interrupt: boolean;
	readonly close: boolean;
	readonly jump: boolean;
}

export type ContentSnapshot =
	| { readonly status: "loading"; readonly agentId: string; readonly generation: number }
	| {
			readonly status: "ready";
			readonly agentId: string;
			readonly generation: number;
			readonly lines: readonly string[];
	  }
	| {
			readonly status: "error";
			readonly agentId: string;
			readonly generation: number;
			readonly message: string;
			readonly lines: readonly string[];
	  };

export interface DashboardRenderState {
	readonly screen: DashboardScreen;
	readonly selectedId?: string;
	readonly listOffset: number;
	readonly transcriptOffset: number;
	readonly outputOffset: number;
	readonly showClosed: boolean;
	readonly transcript?: ContentSnapshot;
	readonly output?: ContentSnapshot;
}

export interface RenderDashboardOptions {
	readonly state: DashboardRenderState;
	readonly views: readonly AgentView[];
	readonly maxRows: number;
	readonly now: number;
}

export const MAX_VISIBLE_AGENTS = 5;

export function renderDashboard(options: RenderDashboardOptions, theme: DashboardTheme, width: number): string[] {
	if (width < 4) return [" ".repeat(Math.max(0, width))];
	const row = (text = ""): string => padToWidth(text, width);
	const border = (text: string): string => theme.fg("border", truncateToWidth(text, width, ""));
	const lines =
		options.state.screen === "list"
			? renderList(options, theme, width, row, border)
			: renderAgentScreen(options, theme, width, row, border);
	return fitDockedPanel(lines, options.maxRows, width);
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

export function visibleAgentViews(showClosed: boolean, views: readonly AgentView[]): AgentView[] {
	return showClosed ? [...views] : views.filter((view) => view.summary.status !== "closed");
}

export function allowedDashboardActions(summary: AgentSummary): AllowedDashboardActions {
	const active = isActiveStatus(summary.status);
	return {
		steer: active,
		followUp: summary.status === "idle" || summary.status === "failed" || summary.status === "aborted",
		interrupt: active,
		close: summary.status !== "closed",
		jump: !active && Boolean(summary.session_file),
	};
}

export function clampScroll(offset: number, maxOffset: number): number {
	return Math.max(0, Math.min(Math.max(0, offset), Math.max(0, maxOffset)));
}

export function isActiveStatus(status: AgentStatus): boolean {
	return status === "starting" || status === "running";
}

function renderList(
	options: RenderDashboardOptions,
	theme: DashboardTheme,
	width: number,
	row: (text?: string) => string,
	border: (text: string) => string,
): string[] {
	const listViews = visibleAgentViews(options.state.showClosed, options.views);
	const rows = listViews.slice(options.state.listOffset, options.state.listOffset + MAX_VISIBLE_AGENTS);
	const lines = [topBorder(` Agents ─ ${formatAgentCounts(options.views)} `, width, border)];
	if (!rows.length) lines.push(row(theme.fg("dim", " No active or ready agents.")));
	else {
		for (const view of rows) {
			lines.push(
				row(renderAgentRow(view, view.summary.agent_id === options.state.selectedId, options.now, theme, width)),
			);
		}
	}
	const selected = rows.find((view) => view.summary.agent_id === options.state.selectedId);
	lines.push(
		row(
			theme.fg(
				"dim",
				` ↑↓ · ↵ open${selected ? actionHints(allowedDashboardActions(selected.summary), true) : ""}${options.views.some((view) => view.summary.status === "closed") ? ` · a ${options.state.showClosed ? "hide" : "closed"}` : ""} · esc`,
			),
		),
	);
	lines.push(border("─".repeat(width)));
	return lines;
}

function renderAgentScreen(
	options: RenderDashboardOptions,
	theme: DashboardTheme,
	width: number,
	row: (text?: string) => string,
	border: (text: string) => string,
): string[] {
	const agent = options.views.find((view) => view.summary.agent_id === options.state.selectedId);
	if (!agent) {
		return [
			topBorder(" Agent ", width, border),
			row(theme.fg("dim", " Agent is no longer available.")),
			border("─".repeat(width)),
		];
	}
	if (options.state.screen === "transcript") {
		return renderContent(
			agent,
			contentForSnapshot(
				options.state.transcript,
				agent,
				options.state.transcriptOffset,
				options.maxRows,
				"transcript",
			),
			"Transcript snapshot",
			theme,
			width,
			row,
			border,
		);
	}
	if (options.state.screen === "output") {
		return renderContent(agent, outputContent(options, agent), "Output", theme, width, row, border);
	}
	if (options.state.screen === "diagnostics") return renderDiagnostics(agent, theme, width, row, border);

	const actions = allowedDashboardActions(agent.summary);
	const lines = [
		topBorder(
			` ${taskLabel(agent)} ─ ${statusLabel(agent.summary.status)} · ${elapsed(agent, options.now)} `,
			width,
			border,
		),
	];
	lines.push(row(theme.fg("muted", " CURRENT")));
	lines.push(row(` ${truncateToWidth(currentActivity(agent), Math.max(1, width - 1))}`));
	lines.push(row());
	lines.push(row(theme.fg("muted", " RECENT")));
	const recent = agent.details.recentTools.slice(-3);
	if (recent.length) {
		for (const activity of recent) {
			const args = activity.argsPreview ? `  ${sanitizeTerminalText(activity.argsPreview)}` : "";
			lines.push(
				row(
					` ${theme.fg("dim", "›")} ${truncateToWidth(`${sanitizeTerminalText(activity.name)}${args}`, Math.max(1, width - 3))}`,
				),
			);
		}
	} else lines.push(row(theme.fg("dim", " No tool activity yet.")));
	lines.push(row(theme.fg("dim", ` esc back · t transcript · o output · i info${actionHints(actions)}`)));
	lines.push(border("─".repeat(width)));
	return lines;
}

interface Content {
	readonly status: "loading" | "ready" | "error";
	readonly lines: readonly string[];
}

function outputContent(options: RenderDashboardOptions, agent: AgentView): Content {
	const snapshot = options.state.output;
	if (snapshot && snapshot.agentId === agent.summary.agent_id && snapshot.generation === agent.summary.generation) {
		return contentForSnapshot(snapshot, agent, options.state.outputOffset, options.maxRows, "output");
	}
	const lines = agent.details.finalText ? agent.details.finalText.split(/\r?\n/).map(sanitizeTerminalLine) : [];
	return sliceContent(lines, options.state.outputOffset, options.maxRows);
}

function contentForSnapshot(
	snapshot: ContentSnapshot | undefined,
	agent: AgentView,
	offset: number,
	maxRows: number,
	_target: ContentTarget,
): Content {
	if (!snapshot || snapshot.agentId !== agent.summary.agent_id || snapshot.generation !== agent.summary.generation) {
		return { status: "loading", lines: [] };
	}
	if (snapshot.status === "loading") return { status: "loading", lines: [] };
	if (snapshot.status === "error") {
		return { status: "error", lines: [sanitizeTerminalLine(snapshot.message), ...snapshot.lines] };
	}
	return sliceContent(snapshot.lines, offset, maxRows);
}

function sliceContent(lines: readonly string[], offset: number, maxRows: number): Content {
	const available = Math.max(1, maxRows - 3);
	const clamped = clampScroll(offset, Math.max(0, lines.length - available));
	const end = lines.length - clamped;
	return {
		status: "ready",
		lines: lines.slice(Math.max(0, end - available), end),
	};
}

function renderContent(
	agent: AgentView,
	content: Content,
	label: "Transcript snapshot" | "Output",
	theme: DashboardTheme,
	width: number,
	row: (text?: string) => string,
	border: (text: string) => string,
): string[] {
	const lines = [topBorder(` ${taskLabel(agent)} / ${label} `, width, border)];
	if (content.status === "loading") lines.push(row(theme.fg("dim", ` Loading ${label.toLowerCase()}…`)));
	else if (content.status === "error") {
		lines.push(row(theme.fg("error", ` Could not load ${label.toLowerCase()}:`)));
		for (const line of content.lines) lines.push(row(` ${truncateToWidth(line, Math.max(1, width - 1))}`));
	} else if (content.lines.length) {
		for (const line of content.lines) lines.push(row(` ${truncateToWidth(line, Math.max(1, width - 1))}`));
	} else {
		lines.push(row(theme.fg("dim", ` No ${label === "Output" ? "return output" : "transcript messages"} yet.`)));
	}
	const steer = label === "Transcript snapshot" && allowedDashboardActions(agent.summary).steer ? " · s steer" : "";
	lines.push(row(theme.fg("dim", ` ↑↓ scroll · r refresh${steer} · esc back`)));
	lines.push(border("─".repeat(width)));
	return lines;
}

function renderDiagnostics(
	agent: AgentView,
	theme: DashboardTheme,
	width: number,
	row: (text?: string) => string,
	border: (text: string) => string,
): string[] {
	const nested = countNested(agent.details.nestedRuns);
	const diagnostics: readonly (readonly [string, string])[] = [
		["Agent", sanitizeTerminalText(agent.summary.agent)],
		["Profile", sanitizeTerminalText(agent.summary.profile)],
		["Model", sanitizeTerminalText(agent.summary.model)],
		["Thinking", sanitizeTerminalText(agent.summary.effective_thinking)],
		["Session", sanitizeTerminalText(agent.summary.session_file ?? agent.details.sessionFile ?? "unavailable")],
		["ID", sanitizeTerminalText(agent.summary.agent_id)],
		["Generation", String(agent.summary.generation)],
		["Depth", String(agent.summary.depth)],
		[
			"Usage",
			`${agent.details.toolCount} tools · ${agent.details.usage.turns} turns${agent.details.tokens ? ` · context ${formatContextUsage(agent.details.tokens, agent.details.contextWindow)}` : ""}`,
		],
		["Nested", nested.total ? `${nested.running}/${nested.total} running` : "none"],
	];
	const lines = [topBorder(" Agent info ", width, border)];
	for (const [label, value] of diagnostics) {
		lines.push(
			row(` ${theme.fg("muted", `${label}:`)} ${truncateToWidth(value, Math.max(1, width - label.length - 3))}`),
		);
	}
	lines.push(
		row(theme.fg("dim", ` esc back${allowedDashboardActions(agent.summary).jump ? " · j take over session" : ""}`)),
	);
	lines.push(border("─".repeat(width)));
	return lines;
}

function renderAgentRow(
	agent: AgentView,
	selected: boolean,
	now: number,
	theme: DashboardTheme,
	width: number,
): string {
	const cursor = selected ? theme.fg("accent", "›") : " ";
	const icon = statusIcon(agent.summary.status, theme);
	const right = `${currentActivity(agent)}  ${elapsed(agent, now)}`;
	const rightWidth = width >= 30 ? Math.min(Math.floor(width * 0.48), visibleWidth(right), width - 12) : 0;
	const gap = rightWidth ? 2 : 0;
	const leftWidth = Math.max(1, width - rightWidth - gap);
	const left = truncateToWidth(`${cursor} ${icon} ${taskLabel(agent)}`, leftWidth, "…");
	const content = `${padToWidth(left, leftWidth)}${rightWidth ? `  ${truncateToWidth(right, rightWidth, "…")}` : ""}`;
	return selected ? theme.bg("selectedBg", padToWidth(content, width)) : padToWidth(content, width);
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

function taskLabel(view: AgentView): string {
	return sanitizeTerminalText(view.summary.task_name || view.summary.agent);
}

function elapsed(view: AgentView, now: number): string {
	return formatDuration((view.details.endTime ?? now) - view.details.startTime);
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

function actionHints(actions: AllowedDashboardActions, compact = false): string {
	const hints: string[] = [];
	if (actions.steer) hints.push("s steer", "x stop");
	else if (actions.followUp) hints.push("f follow-up");
	if (!compact && actions.close) hints.push("d close");
	if (!compact && actions.jump) hints.push("j take over");
	return hints.length ? ` · ${hints.join(" · ")}` : "";
}

function statusLabel(status: AgentStatus): string {
	if (status === "idle") return "ready";
	if (status === "starting" || status === "running") return "running";
	return status;
}

function statusIcon(status: AgentStatus, theme: DashboardTheme): string {
	if (status === "starting" || status === "running") return theme.fg("warning", "●");
	if (status === "idle") return theme.fg("success", "✓");
	if (status === "closed") return theme.fg("dim", "○");
	return theme.fg("error", "✗");
}

function topBorder(title: string, width: number, border: (text: string) => string): string {
	const label = truncateToWidth(title.trim().toUpperCase(), width, "");
	return border(`${label}${"─".repeat(Math.max(0, width - visibleWidth(label)))}`);
}

export function fitDockedPanel(lines: string[], maxRows: number, width: number): string[] {
	const fitted = fitDashboardHeight(lines, maxRows);
	if (fitted.length >= maxRows) return fitted;
	const padding = Array.from({ length: maxRows - fitted.length }, () => " ".repeat(Math.max(0, width)));
	return [...fitted.slice(0, -2), ...padding, ...fitted.slice(-2)];
}

export function fitDashboardHeight(lines: string[], maxRows: number): string[] {
	const height = Math.max(0, maxRows);
	if (lines.length <= height) return lines;
	if (height === 0) return [];
	if (height <= 2) return lines.slice(-height);
	return [lines[0] ?? "", ...lines.slice(1, height - 2), lines.at(-2) ?? "", lines.at(-1) ?? ""];
}

function padToWidth(text: string, width: number): string {
	const clipped = truncateToWidth(text, width, "");
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}
