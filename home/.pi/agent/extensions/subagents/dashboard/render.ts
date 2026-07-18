import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentStatus } from "../agent-types.ts";
import type { ContentViewModel, DashboardAgentRow, DashboardAgentViewModel, DashboardViewModel } from "./view-model.ts";

export type DashboardTheme = Pick<Theme, "fg" | "bg">;

export function renderDashboard(view: DashboardViewModel, theme: DashboardTheme, width: number): string[] {
	if (width < 4) return [" ".repeat(Math.max(0, width))];
	const row = (text = "") => padToWidth(text, width);
	const border = (text: string) => theme.fg("border", truncateToWidth(text, width, ""));
	const lines =
		view.screen === "list"
			? renderList(view, theme, width, row, border)
			: renderAgentScreen(view, theme, width, row, border);
	return fitDockedPanel(lines, view.maxRows, width);
}

function renderList(
	view: DashboardViewModel,
	theme: DashboardTheme,
	width: number,
	row: (text?: string) => string,
	border: (text: string) => string,
): string[] {
	const lines = [topBorder(` Agents ─ ${view.counts} `, width, border)];
	if (!view.rows.length) lines.push(row(theme.fg("dim", " No active or ready agents.")));
	else for (const agent of view.rows) lines.push(row(renderAgentRow(agent, theme, width)));
	const selected = view.rows.find((agent) => agent.selected);
	lines.push(
		row(
			theme.fg(
				"dim",
				` ↑↓ · ↵ open${selected ? actionHints(selected.actions, true) : ""}${view.hasClosed ? ` · a ${view.showClosed ? "hide" : "closed"}` : ""} · esc`,
			),
		),
	);
	lines.push(border("─".repeat(width)));
	return lines;
}

function renderAgentScreen(
	view: DashboardViewModel,
	theme: DashboardTheme,
	width: number,
	row: (text?: string) => string,
	border: (text: string) => string,
): string[] {
	const agent = view.selected;
	if (!agent) {
		return [
			topBorder(" Agent ", width, border),
			row(theme.fg("dim", " Agent is no longer available.")),
			border("─".repeat(width)),
		];
	}
	if (view.screen === "transcript")
		return renderContent(agent, agent.transcript, "Transcript", theme, width, row, border);
	if (view.screen === "output") return renderContent(agent, agent.output, "Output", theme, width, row, border);
	if (view.screen === "diagnostics") return renderDiagnostics(agent, theme, width, row, border);

	const lines = [topBorder(` ${agent.task} ─ ${agent.statusLabel} · ${agent.elapsed} `, width, border)];
	lines.push(row(theme.fg("muted", " CURRENT")));
	lines.push(row(` ${truncateToWidth(agent.current, Math.max(1, width - 1))}`));
	lines.push(row());
	lines.push(row(theme.fg("muted", " RECENT")));
	if (agent.recent.length) {
		for (const activity of agent.recent) {
			lines.push(row(` ${theme.fg("dim", "›")} ${truncateToWidth(activity, Math.max(1, width - 3))}`));
		}
	} else lines.push(row(theme.fg("dim", " No tool activity yet.")));
	lines.push(row(theme.fg("dim", ` esc back · t transcript · o output · i info${actionHints(agent.actions)}`)));
	lines.push(border("─".repeat(width)));
	return lines;
}

function renderContent(
	agent: DashboardAgentViewModel,
	content: ContentViewModel,
	label: "Transcript" | "Output",
	theme: DashboardTheme,
	width: number,
	row: (text?: string) => string,
	border: (text: string) => string,
): string[] {
	const lines = [topBorder(` ${agent.task} / ${label} `, width, border)];
	if (content.status === "loading") lines.push(row(theme.fg("dim", ` Loading ${label.toLowerCase()}…`)));
	else if (content.status === "error") {
		lines.push(row(theme.fg("error", ` Could not load ${label.toLowerCase()}:`)));
		for (const line of content.lines) lines.push(row(` ${truncateToWidth(line, Math.max(1, width - 1))}`));
	} else if (content.lines.length) {
		for (const line of content.lines) lines.push(row(` ${truncateToWidth(line, Math.max(1, width - 1))}`));
	} else lines.push(row(theme.fg("dim", ` No ${label === "Output" ? "return output" : "transcript messages"} yet.`)));
	const steer = label === "Transcript" && agent.actions.steer ? " · s steer" : "";
	lines.push(row(theme.fg("dim", ` ↑↓ scroll${steer} · esc back`)));
	lines.push(border("─".repeat(width)));
	return lines;
}

function renderDiagnostics(
	agent: DashboardAgentViewModel,
	theme: DashboardTheme,
	width: number,
	row: (text?: string) => string,
	border: (text: string) => string,
): string[] {
	const lines = [topBorder(" Agent info ", width, border)];
	for (const [label, value] of agent.diagnostics) {
		lines.push(
			row(` ${theme.fg("muted", `${label}:`)} ${truncateToWidth(value, Math.max(1, width - label.length - 3))}`),
		);
	}
	lines.push(row(theme.fg("dim", ` esc back${agent.actions.jump ? " · j take over session" : ""}`)));
	lines.push(border("─".repeat(width)));
	return lines;
}

function renderAgentRow(agent: DashboardAgentRow, theme: DashboardTheme, width: number): string {
	const cursor = agent.selected ? theme.fg("accent", "›") : " ";
	const icon = statusIcon(agent.status, theme);
	const right = `${agent.activity}  ${agent.elapsed}`;
	const rightWidth = width >= 30 ? Math.min(Math.floor(width * 0.48), visibleWidth(right), width - 12) : 0;
	const gap = rightWidth ? 2 : 0;
	const leftWidth = Math.max(1, width - rightWidth - gap);
	const left = truncateToWidth(`${cursor} ${icon} ${agent.task}`, leftWidth, "…");
	const content = `${padToWidth(left, leftWidth)}${rightWidth ? `  ${truncateToWidth(right, rightWidth, "…")}` : ""}`;
	return agent.selected ? theme.bg("selectedBg", padToWidth(content, width)) : padToWidth(content, width);
}

function actionHints(actions: DashboardAgentViewModel["actions"], compact = false): string {
	const hints: string[] = [];
	if (actions.steer) hints.push("s steer", "x stop");
	else if (actions.followUp) hints.push("f follow-up");
	if (!compact && actions.close) hints.push("d close");
	if (!compact && actions.jump) hints.push("j take over");
	return hints.length ? ` · ${hints.join(" · ")}` : "";
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
