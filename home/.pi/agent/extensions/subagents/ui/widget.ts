import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "../../_shared/terminal-text.ts";
import type { AgentRegistry } from "../agent-registry.ts";
import type { AgentSummary, AgentView } from "../agent-types.ts";
import { formatContextPercentage } from "../render.ts";

export interface RegistryUiBinding {
	readonly refresh: () => void;
	readonly close: () => void;
}

const UI_TICK_MS = 1_000;
const ACTIVE_STATUSES = new Set(["starting", "running"]);

type WidgetTheme = ExtensionContext["ui"]["theme"];

/** Keep active background work visible next to the editor. */
export function bindRegistryUi(ctx: ExtensionContext, registry: AgentRegistry): RegistryUiBinding {
	let widgetVisible = false;
	let requestRender = () => {};
	let tick: NodeJS.Timeout | undefined;

	const showWidget = () => {
		if (widgetVisible) return;
		widgetVisible = true;
		ctx.ui.setWidget(
			"subagents",
			(tui, theme) => {
				requestRender = () => tui.requestRender();
				return {
					render: (width) => renderRunningAgentLines(registry.views(), Date.now(), width, theme),
					invalidate() {},
				};
			},
			{ placement: "belowEditor" },
		);
	};
	const hideWidget = () => {
		if (!widgetVisible) return;
		widgetVisible = false;
		requestRender = () => {};
		ctx.ui.setWidget("subagents", undefined);
	};
	const startTick = () => {
		if (tick) return;
		tick = setInterval(() => requestRender(), UI_TICK_MS).unref();
	};
	const stopTick = () => {
		if (!tick) return;
		clearInterval(tick);
		tick = undefined;
	};
	const refresh = () => {
		const running = registry.list().filter((summary) => ACTIVE_STATUSES.has(summary.status)).length;
		ctx.ui.setStatus("subagents", running ? `agents ${running} running` : undefined);
		if (running > 0) {
			showWidget();
			startTick();
			requestRender();
		} else {
			stopTick();
			hideWidget();
		}
	};
	const unsubscribe = registry.subscribe(refresh);
	return {
		refresh,
		close() {
			unsubscribe();
			stopTick();
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
	const running = views.filter((view) => ACTIVE_STATUSES.has(view.summary.status));
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
	const context = formatContextPercentage(details.tokens, details.contextWindow);
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
