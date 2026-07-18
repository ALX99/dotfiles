import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "../../_shared/terminal-text.ts";
import type { AgentRegistry } from "../agent-registry.ts";
import type { AgentSummary, AgentView } from "../agent-types.ts";
import { formatAgentCounts } from "../dashboard-render.ts";
import { formatDuration } from "../render.ts";

const UI_REFRESH_MS = 1_000;

export interface RegistryUiBinding {
	readonly refresh: () => void;
	readonly close: () => void;
}

export function bindRegistryUi(
	ctx: ExtensionContext,
	registry: AgentRegistry,
	onRefresh: () => void,
): RegistryUiBinding {
	let tick: NodeJS.Timeout | undefined;
	const refresh = () => {
		updateAgentUi(ctx, registry);
		onRefresh();
		const active = registry.views().some(isActiveAgent);
		if (active && !tick) tick = setInterval(() => updateAgentUi(ctx, registry), UI_REFRESH_MS).unref();
		else if (!active && tick) {
			clearInterval(tick);
			tick = undefined;
		}
	};
	const unsubscribe = registry.subscribe(refresh);
	return {
		refresh,
		close() {
			unsubscribe();
			if (tick) clearInterval(tick);
			tick = undefined;
			ctx.ui.setStatus("subagents", undefined);
			ctx.ui.setWidget("subagents", undefined);
		},
	};
}

export function notifyCompletion(ctx: ExtensionContext | undefined, summary: AgentSummary): void {
	const label = sanitizeTerminalText(summary.task_name || summary.agent);
	ctx?.ui.notify(
		summary.status === "failed" ? `Subagent failed: ${label}` : `Subagent complete: ${label}`,
		summary.status === "failed" ? "error" : "info",
	);
}

export function isActiveAgent(view: AgentView): boolean {
	return view.summary.status === "starting" || view.summary.status === "running";
}

function updateAgentUi(ctx: ExtensionContext, registry: AgentRegistry): void {
	const views = registry.views().filter((view) => view.summary.status !== "closed");
	if (!views.length) {
		ctx.ui.setStatus("subagents", undefined);
		ctx.ui.setWidget("subagents", undefined);
		return;
	}
	const active = views.some(isActiveAgent);
	const failed = views.some((view) => view.summary.status === "failed" || view.summary.status === "aborted");
	const color = failed ? "error" : active ? "warning" : "success";
	ctx.ui.setStatus("subagents", ctx.ui.theme.fg(color, `agents ${formatAgentCounts(views)}`));

	const visible = views.filter(
		(view) => isActiveAgent(view) || view.summary.status === "failed" || view.summary.status === "aborted",
	);
	if (!visible.length) {
		ctx.ui.setWidget("subagents", undefined);
		return;
	}
	ctx.ui.setWidget(
		"subagents",
		(_tui, theme) => ({
			render(width: number): string[] {
				const lines = [theme.fg("muted", "SUBAGENTS")];
				for (const view of visible.slice(0, 3)) lines.push(renderAgentWidgetRow(view, width, theme));
				if (visible.length > 3) lines.push(theme.fg("dim", `  +${visible.length - 3} more`));
				return lines.map((line) => truncateToWidth(line, width, ""));
			},
			invalidate() {},
		}),
		{ placement: "belowEditor" },
	);
}

function renderAgentWidgetRow(view: AgentView, width: number, theme: Theme): string {
	const { summary, details } = view;
	const failed = summary.status === "failed" || summary.status === "aborted";
	const icon = failed ? theme.fg("error", "✗") : theme.fg("warning", "⟳");
	const task = sanitizeTerminalText(summary.task_name || summary.agent);
	const latest = details.recentTools.at(-1);
	const activity = latest
		? `${sanitizeTerminalText(latest.name)}${latest.argsPreview ? ` ${sanitizeTerminalText(latest.argsPreview)}` : ""}`
		: sanitizeTerminalText(details.lastMessage || (failed ? summary.status : "starting…"));
	const elapsed = formatDuration((details.endTime ?? Date.now()) - details.startTime);
	return truncateToWidth(
		`${icon} ${task} · ${summary.agent}/${summary.profile} · ${activity} · ${elapsed}`,
		width,
		"…",
	);
}
