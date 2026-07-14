import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import type { AgentRegistry, AgentStatus, AgentView } from "./host.ts";
import { formatContextUsage, formatDuration } from "./render.ts";

type DashboardAction =
	| { kind: "inspect"; agentId: string }
	| { kind: "steer"; agentId: string }
	| { kind: "followUp"; agentId: string }
	| { kind: "interrupt"; agentId: string }
	| { kind: "close"; agentId: string }
	| { kind: "dismiss" };

type DashboardScreen = "list" | "detail" | "transcript" | "diagnostics";

const MAX_VISIBLE_AGENTS = 5;

interface TranscriptSnapshot {
	generation: number;
	lines: string[];
}

export async function showAgentDashboard(ctx: ExtensionCommandContext, registry: AgentRegistry): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify(formatAgentCounts(registry.views()), "info");
		return;
	}

	let selectedId: string | undefined;
	let screen: DashboardScreen = "list";
	const transcripts = new Map<string, TranscriptSnapshot>();

	while (true) {
		const action = await ctx.ui.custom<DashboardAction>((tui, theme, _keybindings, done) => {
			const dashboard = new AgentDashboard(
				registry,
				theme,
				done,
				transcripts,
				selectedId,
				screen,
				(next) => { screen = next; },
				() => tui.requestRender(),
				() => Math.max(0, Math.min(Math.floor(tui.terminal.rows * 0.65), tui.terminal.rows - 5)),
			);
			return dashboard;
		}, {
			overlay: true,
			overlayOptions: {
				anchor: "bottom-center",
				width: "70%",
				minWidth: 60,
				maxHeight: "65%",
				margin: { top: 1, right: 1, bottom: 4, left: 1 },
			},
		});

		if (!action || action.kind === "dismiss") return;
		selectedId = action.agentId;

		try {
			const agent = registry.get(action.agentId);
			switch (action.kind) {
				case "inspect": {
					const messages = await agent.getMessages();
					transcripts.set(action.agentId, {
						generation: agent.summary().generation,
						lines: formatTranscript(messages),
					});
					screen = "transcript";
					break;
				}
				case "steer": {
					const message = await ctx.ui.input("Steer subagent", "Message delivered at the next turn boundary");
					if (message?.trim()) await agent.steer(message.trim());
					break;
				}
				case "followUp": {
					const message = await ctx.ui.input("Follow up", "New task for this subagent");
					if (message?.trim()) {
						agent.setOnUpdate(undefined);
						await agent.followUp(message.trim(), clipAtWord(message, 60), true);
					}
					break;
				}
				case "interrupt": {
					const taskName = sanitizeTerminalText(agent.summary().task_name);
					const ok = await ctx.ui.confirm("Interrupt subagent?", taskName || agent.id);
					if (ok) await agent.interrupt();
					break;
				}
				case "close": {
					const ok = await ctx.ui.confirm("Close subagent?", "Its retained context will be lost.");
					if (ok) await registry.close(agent.id);
					break;
				}
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(sanitizeTerminalText(message), "error");
		}
	}
}

class AgentDashboard {
	private selectedId?: string;
	private screen: DashboardScreen;
	private listOffset = 0;
	private transcriptOffset = 0;
	private showClosed = false;
	private readonly registry: AgentRegistry;
	private readonly theme: Theme;
	private readonly done: (action: DashboardAction) => void;
	private readonly transcripts: ReadonlyMap<string, TranscriptSnapshot>;
	private readonly onScreenChange: (screen: DashboardScreen) => void;
	private readonly requestRender: () => void;
	private readonly maxRows: () => number;
	private readonly unsubscribe: () => void;
	private readonly tick: NodeJS.Timeout;

	constructor(
		registry: AgentRegistry,
		theme: Theme,
		done: (action: DashboardAction) => void,
		transcripts: ReadonlyMap<string, TranscriptSnapshot>,
		selectedId: string | undefined,
		screen: DashboardScreen,
		onScreenChange: (screen: DashboardScreen) => void,
		requestRender: () => void,
		maxRows: () => number,
	) {
		this.registry = registry;
		this.theme = theme;
		this.done = done;
		this.transcripts = transcripts;
		this.screen = screen;
		this.onScreenChange = onScreenChange;
		this.requestRender = requestRender;
		this.maxRows = maxRows;
		this.selectedId = selectedId;
		this.unsubscribe = registry.subscribe(requestRender);
		this.tick = setInterval(requestRender, 1_000).unref();
	}

	handleInput(data: string): void {
		const allViews = this.registry.views();
		const views = this.listViews(allViews);
		const selected = this.selected(this.screen === "list" ? views : allViews);
		const index = selected ? views.findIndex((view) => view.summary.agent_id === selected.summary.agent_id) : -1;

		if (matchesKey(data, Key.ctrl("c"))) {
			this.done({ kind: "dismiss" });
			return;
		}
		if (matchesKey(data, Key.escape)) {
			if (this.screen === "transcript" || this.screen === "diagnostics") this.setScreen("detail");
			else if (this.screen === "detail") this.setScreen("list");
			else this.done({ kind: "dismiss" });
			return;
		}
		if (this.screen === "list") {
			if (matchesKey(data, Key.up) && views.length) this.selectAt(views, Math.max(0, index - 1));
			else if (matchesKey(data, Key.down) && views.length) this.selectAt(views, Math.min(views.length - 1, index + 1));
			else if (matchesKey(data, "a") && allViews.some((view) => view.summary.status === "closed")) {
				this.showClosed = !this.showClosed;
				this.requestRender();
			} else if (matchesKey(data, Key.enter) && selected) this.setScreen("detail");
			else if (selected) this.handleAction(data, selected);
			return;
		}
		if (!selected) return;
		if (this.screen === "detail") {
			if (matchesKey(data, "t")) {
				const transcript = this.transcripts.get(selected.summary.agent_id);
				if (transcript?.generation === selected.summary.generation) this.setScreen("transcript");
				else this.done({ kind: "inspect", agentId: selected.summary.agent_id });
			} else if (matchesKey(data, "i")) this.setScreen("diagnostics");
			else this.handleAction(data, selected);
			return;
		}
		if (this.screen === "transcript") {
			if (matchesKey(data, Key.up)) this.transcriptOffset++;
			else if (matchesKey(data, Key.down)) this.transcriptOffset = Math.max(0, this.transcriptOffset - 1);
			else if (matchesKey(data, "s") && isActive(selected.summary.status)) this.done({ kind: "steer", agentId: selected.summary.agent_id });
			this.requestRender();
		}
	}

	render(width: number): string[] {
		if (width < 4) return [" ".repeat(Math.max(0, width))];
		const allViews = this.registry.views();
		const views = this.listViews(allViews);
		const selected = this.selected(this.screen === "list" ? views : allViews);
		const innerWidth = Math.max(1, width - 2);
		const border = (text: string) => this.theme.fg("border", text);
		const row = (text = "") => border("│") + padToWidth(text, innerWidth) + border("│");
		const lines = this.screen === "list"
			? this.renderList(allViews, views, selected, innerWidth, row, border)
			: this.renderAgentScreen(selected, innerWidth, row, border);
		return fitDashboardHeight(lines, this.maxRows());
	}

	invalidate(): void {}

	dispose(): void {
		clearInterval(this.tick);
		this.unsubscribe();
	}

	private renderList(
		allViews: AgentView[],
		views: AgentView[],
		selected: AgentView | undefined,
		width: number,
		row: (text?: string) => string,
		border: (text: string) => string,
	): string[] {
		const lines = [topBorder(` Agents ─ ${formatAgentCounts(allViews)} `, width, border)];
		if (!views.length) {
			lines.push(row(this.theme.fg("dim", " No active or ready agents.")));
		} else {
			const selectedIndex = selected ? views.findIndex((view) => view.summary.agent_id === selected.summary.agent_id) : 0;
			this.keepSelectedVisible(selectedIndex, views.length);
			for (const view of views.slice(this.listOffset, this.listOffset + MAX_VISIBLE_AGENTS)) {
				lines.push(row(renderAgentRow(view, view.summary.agent_id === selected?.summary.agent_id, this.theme, width)));
			}
		}
		const hasClosed = allViews.some((view) => view.summary.status === "closed");
		lines.push(row(this.theme.fg("dim", ` ↑↓ · ↵ open${selected ? actionHints(selected.summary.status, true) : ""}${hasClosed ? ` · a ${this.showClosed ? "hide" : "closed"}` : ""} · esc`)));
		lines.push(border(`╰${"─".repeat(width)}╯`));
		return lines;
	}

	private renderAgentScreen(
		view: AgentView | undefined,
		width: number,
		row: (text?: string) => string,
		border: (text: string) => string,
	): string[] {
		if (!view) return [topBorder(" Agent ", width, border), row(this.theme.fg("dim", " Agent is no longer available.")), border(`╰${"─".repeat(width)}╯`)];
		if (this.screen === "transcript") return this.renderTranscript(view, width, row, border);
		if (this.screen === "diagnostics") return this.renderDiagnostics(view, width, row, border);

		const { summary, details } = view;
		const elapsed = formatDuration((details.endTime ?? Date.now()) - details.startTime);
		const task = sanitizeTerminalText(summary.task_name || summary.agent_type);
		const lines = [topBorder(` ${task} ─ ${statusLabel(summary.status)} · ${elapsed} `, width, border)];
		lines.push(row(this.theme.fg("muted", " CURRENT")));
		lines.push(row(` ${truncateToWidth(currentActivity(view), Math.max(1, width - 1))}`));
		lines.push(row());
		lines.push(row(this.theme.fg("muted", " RECENT")));
		const recent = details.recentTools.slice(-3);
		if (recent.length) {
			for (const tool of recent) {
				const activity = `${sanitizeTerminalText(tool.name)}${tool.argsPreview ? `  ${sanitizeTerminalText(tool.argsPreview)}` : ""}`;
				lines.push(row(` ${this.theme.fg("dim", "›")} ${truncateToWidth(activity, Math.max(1, width - 3))}`));
			}
		} else {
			lines.push(row(this.theme.fg("dim", " No tool activity yet.")));
		}
		lines.push(row(this.theme.fg("dim", ` esc back · t transcript · i info${actionHints(summary.status)}`)));
		lines.push(border(`╰${"─".repeat(width)}╯`));
		return lines;
	}

	private renderTranscript(view: AgentView, width: number, row: (text?: string) => string, border: (text: string) => string): string[] {
		const task = sanitizeTerminalText(view.summary.task_name || view.summary.agent_type);
		const transcript = this.transcripts.get(view.summary.agent_id);
		const source = transcript?.generation === view.summary.generation ? transcript.lines : [];
		const available = Math.max(1, this.maxRows() - 3);
		const maxOffset = Math.max(0, source.length - available);
		this.transcriptOffset = Math.min(this.transcriptOffset, maxOffset);
		const end = source.length - this.transcriptOffset;
		const visible = source.slice(Math.max(0, end - available), end);
		const lines = [topBorder(` ${task} / Transcript `, width, border)];
		if (visible.length) {
			for (const line of visible) lines.push(row(` ${truncateToWidth(line, Math.max(1, width - 1))}`));
		} else lines.push(row(this.theme.fg("dim", " No transcript messages yet.")));
		lines.push(row(this.theme.fg("dim", ` ↑↓ scroll${isActive(view.summary.status) ? " · s steer" : ""} · esc back`)));
		lines.push(border(`╰${"─".repeat(width)}╯`));
		return lines;
	}

	private renderDiagnostics(view: AgentView, width: number, row: (text?: string) => string, border: (text: string) => string): string[] {
		const { summary, details } = view;
		const nested = countNested(details.nestedRuns);
		const lines = [topBorder(" Agent info ", width, border)];
		const values = [
			["Role", summary.agent_type], ["Model", summary.model ?? details.model ?? "default"],
			["ID", summary.agent_id], ["Generation", String(summary.generation)], ["Depth", String(summary.depth)],
			["Usage", `${details.toolCount} tools · ${details.usage.turns} turns${details.tokens ? ` · context ${formatContextUsage(details.tokens, details.contextWindow)}` : ""}`],
			["Nested", nested.total ? `${nested.running}/${nested.total} running` : "none"],
		];
		for (const [label, value] of values) lines.push(row(` ${this.theme.fg("muted", `${label}:`)} ${truncateToWidth(sanitizeTerminalText(value), Math.max(1, width - label.length - 3))}`));
		lines.push(row(this.theme.fg("dim", " esc back")));
		lines.push(border(`╰${"─".repeat(width)}╯`));
		return lines;
	}

	private handleAction(data: string, view: AgentView): void {
		const { status, agent_id: agentId } = view.summary;
		if (matchesKey(data, "s") && isActive(status)) this.done({ kind: "steer", agentId });
		else if (matchesKey(data, "f") && isFollowUpAvailable(status)) this.done({ kind: "followUp", agentId });
		else if (matchesKey(data, "x") && isActive(status)) this.done({ kind: "interrupt", agentId });
		else if (matchesKey(data, "d") && status !== "closed") this.done({ kind: "close", agentId });
	}

	private listViews(views: AgentView[]): AgentView[] {
		return this.showClosed ? views : views.filter((view) => view.summary.status !== "closed");
	}

	private selected(views: AgentView[]): AgentView | undefined {
		let selected = views.find((view) => view.summary.agent_id === this.selectedId);
		if (!selected) {
			selected = views.find((view) => isActive(view.summary.status)) ?? views[0];
			this.selectedId = selected?.summary.agent_id;
		}
		return selected;
	}

	private selectAt(views: AgentView[], index: number): void {
		this.selectedId = views[index]?.summary.agent_id;
		this.keepSelectedVisible(index, views.length);
		this.requestRender();
	}

	private setScreen(screen: DashboardScreen): void {
		this.screen = screen;
		this.onScreenChange(screen);
		this.requestRender();
	}

	private keepSelectedVisible(index: number, total: number): void {
		if (index < this.listOffset) this.listOffset = index;
		if (index >= this.listOffset + MAX_VISIBLE_AGENTS) this.listOffset = index - MAX_VISIBLE_AGENTS + 1;
		this.listOffset = Math.max(0, Math.min(this.listOffset, Math.max(0, total - MAX_VISIBLE_AGENTS)));
	}
}

export function formatAgentCounts(views: AgentView[]): string {
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

export function formatTranscript(messages: unknown[]): string[] {
	return messages.slice(-50).flatMap((message) => {
		if (!isRecord(message)) return [];
		const role = sanitizeTerminalText(typeof message.role === "string" ? message.role : "message");
		const content = Array.isArray(message.content) ? message.content : [];
		const parts = content.flatMap((part) => {
			if (!isRecord(part)) return [];
			if (part.type === "text" && typeof part.text === "string") {
				const oneLine = sanitizeTerminalText(part.text.slice(0, 1_000));
				return oneLine ? [oneLine] : [];
			}
			if (part.type === "toolCall" && typeof part.name === "string") return [`→ ${sanitizeTerminalText(part.name)}`];
			return [];
		});
		if (!parts.length) return [];
		return [`${role}: ${parts.join(" · ")}`];
	}).slice(-20);
}

function renderAgentRow(view: AgentView, selected: boolean, theme: Theme, width: number): string {
	const { summary, details } = view;
	const cursor = selected ? theme.fg("accent", "›") : " ";
	const icon = statusIcon(summary.status, theme);
	const task = sanitizeTerminalText(summary.task_name || summary.agent_type);
	const elapsed = formatDuration((details.endTime ?? Date.now()) - details.startTime);
	const right = `${currentActivity(view)}  ${elapsed}`;
	const rightWidth = width >= 30 ? Math.min(Math.floor(width * 0.48), visibleWidth(right), width - 12) : 0;
	const gap = rightWidth ? 2 : 0;
	const leftWidth = Math.max(1, width - rightWidth - gap);
	const left = truncateToWidth(`${cursor} ${icon} ${task}`, leftWidth, "…");
	const content = `${padToWidth(left, leftWidth)}${rightWidth ? `  ${truncateToWidth(right, rightWidth, "…")}` : ""}`;
	return selected ? theme.bg("selectedBg", padToWidth(content, width)) : padToWidth(content, width);
}

function currentActivity(view: AgentView): string {
	const { summary, details } = view;
	const latest = details.recentTools.at(-1);
	if (latest) {
		const tool = sanitizeTerminalText(latest.name);
		const args = latest.argsPreview ? ` ${sanitizeTerminalText(latest.argsPreview)}` : "";
		return `${tool}${args}`;
	}
	if (isActive(summary.status)) return details.lastMessage ? sanitizeTerminalText(details.lastMessage) : "starting…";
	if (summary.status === "idle") return "ready";
	return statusLabel(summary.status);
}

function actionHints(status: AgentStatus, compact = false): string {
	const actions: string[] = [];
	if (isActive(status)) actions.push("s steer", "x stop");
	else if (isFollowUpAvailable(status)) actions.push("f follow-up");
	if (!compact && status !== "closed") actions.push("d close");
	return actions.length ? ` · ${actions.join(" · ")}` : "";
}

function statusLabel(status: AgentStatus): string {
	if (status === "idle") return "ready";
	if (status === "starting" || status === "running") return "running";
	return status;
}

function topBorder(title: string, width: number, border: (text: string) => string): string {
	const label = truncateToWidth(title, width, "");
	return border(`╭${label}${"─".repeat(Math.max(0, width - visibleWidth(label)))}╮`);
}

function statusIcon(status: AgentStatus, theme: Theme): string {
	if (status === "starting" || status === "running") return theme.fg("warning", "●");
	if (status === "idle") return theme.fg("success", "✓");
	if (status === "closed") return theme.fg("dim", "○");
	return theme.fg("error", "✗");
}

function isActive(status: AgentStatus): boolean {
	return status === "starting" || status === "running";
}

function isFollowUpAvailable(status: AgentStatus): boolean {
	return status === "idle" || status === "failed" || status === "aborted";
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

export function fitDashboardHeight(lines: string[], maxRows: number): string[] {
	const height = Math.max(0, maxRows);
	if (lines.length <= height) return lines;
	if (height === 0) return [];
	if (height <= 2) return lines.slice(-height);
	return [
		lines[0] ?? "",
		...lines.slice(1, height - 2),
		lines.at(-2) ?? "",
		lines.at(-1) ?? "",
	];
}

export function sanitizeTerminalText(value: string): string {
	const stripped = stripVTControlCharacters(value);
	let safe = "";
	for (const character of stripped) {
		const code = character.codePointAt(0) ?? 0;
		safe += code < 32 || (code >= 127 && code <= 159) ? " " : character;
	}
	return safe.replace(/\s+/g, " ").trim();
}

function padToWidth(text: string, width: number): string {
	const clipped = truncateToWidth(text, width, "");
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function clipAtWord(value: string, max: number): string {
	const oneLine = value.replace(/\s+/g, " ").trim();
	if (oneLine.length <= max) return oneLine;
	const cut = oneLine.slice(0, max);
	const space = cut.lastIndexOf(" ");
	return `${space > max * 0.5 ? oneLine.slice(0, space) : cut}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
