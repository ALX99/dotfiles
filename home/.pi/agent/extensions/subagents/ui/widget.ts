import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "../../_shared/terminal-text.ts";
import type { AgentRegistry } from "../agent-registry.ts";
import { isAgentActive, type AgentSummary, type AgentView } from "../agent-types.ts";
import { formatContextPercentage } from "./format.ts";

export interface RegistryUiBinding {
	readonly refresh: () => void;
	readonly close: () => void;
}

const UI_TICK_MS = 1_000;
type WidgetTheme = ExtensionContext["ui"]["theme"];

class RunningAgentsWidget implements Component {
	private tick: NodeJS.Timeout | undefined;
	private readonly registry: AgentRegistry;
	private readonly tui: TUI;
	private readonly theme: WidgetTheme;

	constructor(registry: AgentRegistry, tui: TUI, theme: WidgetTheme) {
		this.registry = registry;
		this.tui = tui;
		this.theme = theme;
		this.tick = setInterval(() => this.tui.requestRender(), UI_TICK_MS).unref();
	}

	render(width: number): string[] {
		return renderRunningAgentLines(this.registry.views(), Date.now(), width, this.theme);
	}

	invalidate(): void {}

	refresh(): void {
		this.tui.requestRender();
	}

	dispose(): void {
		if (!this.tick) return;
		clearInterval(this.tick);
		this.tick = undefined;
	}
}

/** Keep active background work visible next to the editor. */
export function bindRegistryUi(ctx: ExtensionContext, registry: AgentRegistry): RegistryUiBinding {
	let widgetVisible = false;
	let widget: RunningAgentsWidget | undefined;

	const showWidget = () => {
		if (widgetVisible) return;
		widgetVisible = true;
		ctx.ui.setWidget(
			"subagents",
			(tui, theme) => {
				widget?.dispose();
				widget = new RunningAgentsWidget(registry, tui, theme);
				return widget;
			},
			{ placement: "belowEditor" },
		);
	};
	const hideWidget = () => {
		if (!widgetVisible) return;
		widgetVisible = false;
		widget?.dispose();
		widget = undefined;
		ctx.ui.setWidget("subagents", undefined);
	};
	const refresh = () => {
		const running = registry.list().filter((summary) => isAgentActive(summary.status)).length;
		ctx.ui.setStatus("subagents", running ? `agents ${running} running` : undefined);
		if (running > 0) {
			showWidget();
			widget?.refresh();
		} else {
			hideWidget();
		}
	};
	const unsubscribe = registry.subscribe(refresh);
	return {
		refresh,
		close() {
			unsubscribe();
			hideWidget();
			ctx.ui.setStatus("subagents", undefined);
		},
	};
}

export function renderRunningAgentLines(
	views: readonly AgentView[],
	now: number,
	width: number,
	theme: WidgetTheme,
): string[] {
	const running = views.filter((view) => isAgentActive(view.summary.status));
	if (running.length === 0 || width <= 0) return [];
	const noun = running.length === 1 ? "subagent" : "subagents";
	const lines = [
		truncateToWidth(`${theme.fg("accent", "●")} ${theme.fg("muted", `${running.length} ${noun} running`)}`, width),
	];
	for (const view of running) lines.push(renderAgentLine(view, now, width, theme));
	return lines;
}

export function formatActivityAge(elapsedMs: number): string {
	const seconds = Math.floor(Math.max(0, elapsedMs) / 1_000);
	if (seconds < 1) return "1s ago";
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

function renderAgentLine(view: AgentView, now: number, width: number, theme: WidgetTheme): string {
	const summary = view.summary;
	const details = view.details;
	const label = sanitizeTerminalText(
		summary.task_name ? `${summary.agent_id} · ${summary.task_name}` : summary.agent_id,
	);
	const latestTool = details.recentTools.at(-1);
	const activity = summary.pending_question
		? theme.fg("warning", "waiting for input")
		: latestTool
			? theme.fg(
					"accent",
					sanitizeTerminalText(`${latestTool.name}${latestTool.argsPreview ? ` ${latestTool.argsPreview}` : ""}`),
				)
			: theme.fg("dim", summary.status === "starting" ? "starting" : "thinking");
	const left = `${theme.fg("dim", "  ")}${theme.fg("text", label)}${theme.fg("dim", " · ")}${activity}`;
	const context = formatContextPercentage(details.contextUsage);
	const suffix = theme.fg(
		"dim",
		`${context ? ` · context ${context}` : ""} · ${formatActivityAge(now - details.lastActivityTime)}`,
	);
	const availableLeft = width - visibleWidth(suffix);
	if (availableLeft <= 0) return truncateToWidth(suffix, width);
	return `${truncateToWidth(left, availableLeft)}${suffix}`;
}

export function notifyCompletion(ctx: ExtensionContext | undefined, summary: AgentSummary): void {
	const label = sanitizeTerminalText(summary.task_name || summary.agent);
	ctx?.ui.notify(
		summary.status === "failed" ? `Subagent failed: ${label}` : `Subagent complete: ${label}`,
		summary.status === "failed" ? "error" : "info",
	);
}
