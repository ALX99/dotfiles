import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { toError } from "../_shared/errors.ts";
import { clipTextAtWord, sanitizeTerminalLine, sanitizeTerminalText } from "../_shared/terminal-text.ts";
import type { AgentRegistry } from "./agent-registry.ts";
import type { AgentView } from "./agent-types.ts";
import {
	MAX_VISIBLE_AGENTS,
	allowedDashboardActions,
	clampScroll,
	formatAgentCounts,
	isActiveStatus,
	renderDashboard,
	visibleAgentViews,
	type ContentSnapshot,
	type ContentTarget,
	type DashboardRenderState,
	type DashboardScreen,
} from "./dashboard-render.ts";
import { formatTranscript } from "./transcript.ts";

export type DashboardOperation =
	| { readonly kind: "steer"; readonly agentId: string }
	| { readonly kind: "followUp"; readonly agentId: string }
	| { readonly kind: "interrupt"; readonly agentId: string }
	| { readonly kind: "close"; readonly agentId: string }
	| { readonly kind: "jump"; readonly agentId: string }
	| { readonly kind: "dismiss" };

export interface DashboardTimer {
	cancel(): void;
}

export interface DashboardClock {
	readonly now: () => number;
	readonly setInterval: (callback: () => void, milliseconds: number) => DashboardTimer;
}

const SYSTEM_CLOCK: DashboardClock = {
	now: Date.now,
	setInterval(callback, milliseconds) {
		const timer = setInterval(callback, milliseconds);
		timer.unref();
		return { cancel: () => clearInterval(timer) };
	},
};

export interface DashboardAgentReader {
	getMessages(): Promise<unknown[]>;
	loadFullOutput(): Promise<string>;
}

export interface DashboardDataSource {
	views(): AgentView[];
	getLive(id: string): DashboardAgentReader;
	subscribe(listener: () => void): () => void;
}

export interface DashboardOptions {
	readonly clock?: DashboardClock;
	readonly onOperation: (operation: DashboardOperation) => void;
}

/** Imperative state owner for the single terminal dashboard modal. */
export class Dashboard {
	private screen: DashboardScreen = "list";
	private selectedId: string | undefined;
	private listOffset = 0;
	private transcriptOffset = 0;
	private outputOffset = 0;
	private showClosed = false;
	private transcript: ContentSnapshot | undefined;
	private output: ContentSnapshot | undefined;
	private views: readonly AgentView[];
	private requestRender: (() => void) | undefined;
	private unsubscribe: (() => void) | undefined;
	private timer: DashboardTimer | undefined;
	private maxRows = 12;
	private disposed = false;
	private readonly clock: DashboardClock;
	private readonly registry: DashboardDataSource;
	private readonly onOperation: (operation: DashboardOperation) => void;

	constructor(registry: DashboardDataSource, options: DashboardOptions) {
		this.registry = registry;
		this.clock = options.clock ?? SYSTEM_CLOCK;
		this.onOperation = options.onOperation;
		this.views = registry.views();
		this.reconcileSelection();
	}

	attach(requestRender: () => void, maxRows: () => number): void {
		this.detach();
		this.disposed = false;
		this.requestRender = requestRender;
		this.maxRows = maxRows();
		this.refreshViews();
		this.unsubscribe = this.registry.subscribe(() => {
			this.maxRows = maxRows();
			this.refreshViews();
			requestRender();
		});
		this.timer = this.clock.setInterval(() => {
			this.maxRows = maxRows();
			requestRender();
		}, 1_000);
	}

	detach(): void {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.timer?.cancel();
		this.timer = undefined;
		this.requestRender = undefined;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.detach();
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.ctrl("c"))) {
			this.onOperation({ kind: "dismiss" });
			return;
		}
		if (matchesKey(data, Key.escape)) {
			if (this.screen === "transcript" || this.screen === "output" || this.screen === "diagnostics") {
				this.setScreen("detail");
			} else if (this.screen === "detail") this.setScreen("list");
			else this.onOperation({ kind: "dismiss" });
			return;
		}

		const listViews = visibleAgentViews(this.showClosed, this.views);
		const selectionViews = this.screen === "list" ? listViews : this.views;
		const selected = selectionViews.find((view) => view.summary.agent_id === this.selectedId);
		if (this.screen === "list") {
			const index = selected ? listViews.findIndex((view) => view.summary.agent_id === selected.summary.agent_id) : -1;
			if (matchesKey(data, Key.up) && listViews.length) this.selectAt(listViews, Math.max(0, index - 1));
			else if (matchesKey(data, Key.down) && listViews.length) {
				this.selectAt(listViews, Math.min(listViews.length - 1, index + 1));
			} else if (matchesKey(data, "a") && this.views.some((view) => view.summary.status === "closed")) {
				this.showClosed = !this.showClosed;
				this.reconcileSelection();
				this.invalidate();
			} else if (matchesKey(data, Key.enter) && selected) this.setScreen("detail");
			else if (selected) this.emitOperation(data, selected);
			return;
		}
		if (!selected) return;
		if (this.screen === "detail") {
			if (matchesKey(data, "t")) {
				this.setScreen("transcript");
				void this.loadTranscript(selected);
			} else if (matchesKey(data, "o")) {
				this.setScreen("output");
				if (!isActiveStatus(selected.summary.status) && selected.summary.status !== "closed") {
					void this.loadOutput(selected);
				}
			} else if (matchesKey(data, "i")) this.setScreen("diagnostics");
			else this.emitOperation(data, selected);
			return;
		}
		if (this.screen === "transcript") {
			if (matchesKey(data, Key.up)) this.scroll("transcript", 1, selected);
			else if (matchesKey(data, Key.down)) this.scroll("transcript", -1, selected);
			else if (matchesKey(data, "r")) void this.loadTranscript(selected);
			else if (matchesKey(data, "s")) this.emitOperation(data, selected);
		} else if (this.screen === "output") {
			if (matchesKey(data, Key.up)) this.scroll("output", 1, selected);
			else if (matchesKey(data, Key.down)) this.scroll("output", -1, selected);
			else if (matchesKey(data, "r")) {
				if (selected.summary.status === "closed") {
					this.output = undefined;
					this.invalidate();
				} else void this.loadOutput(selected);
			}
		} else if (this.screen === "diagnostics" && matchesKey(data, "j")) {
			this.emitOperation(data, selected);
		}
	}

	render(theme: Theme, width: number): string[] {
		return renderDashboard(
			{
				state: this.getState(),
				views: this.views,
				maxRows: this.maxRows,
				now: this.clock.now(),
			},
			theme,
			width,
		);
	}

	invalidate(): void {
		this.requestRender?.();
	}

	getState(): DashboardRenderState {
		return {
			screen: this.screen,
			...(this.selectedId === undefined ? {} : { selectedId: this.selectedId }),
			listOffset: this.listOffset,
			transcriptOffset: this.transcriptOffset,
			outputOffset: this.outputOffset,
			showClosed: this.showClosed,
			...(this.transcript === undefined ? {} : { transcript: this.transcript }),
			...(this.output === undefined ? {} : { output: this.output }),
		};
	}

	private setScreen(screen: DashboardScreen): void {
		this.screen = screen;
		if (screen === "list") this.reconcileSelection();
		if (screen === "transcript") this.transcriptOffset = 0;
		if (screen === "output") this.outputOffset = 0;
		this.invalidate();
	}

	private refreshViews(): void {
		const previous = this.views.find((view) => view.summary.agent_id === this.selectedId);
		this.views = this.registry.views();
		this.reconcileSelection();
		const selected = this.views.find((view) => view.summary.agent_id === this.selectedId);
		if (!selected) return;
		const generationChanged =
			previous?.summary.agent_id !== selected.summary.agent_id ||
			previous.summary.generation !== selected.summary.generation;
		const justSettled =
			previous !== undefined &&
			isActiveStatus(previous.summary.status) &&
			!isActiveStatus(selected.summary.status) &&
			selected.summary.status !== "closed";
		const activeOutputChanged =
			this.screen === "output" &&
			previous?.summary.agent_id === selected.summary.agent_id &&
			previous.summary.generation === selected.summary.generation &&
			isActiveStatus(selected.summary.status) &&
			previous.details.finalText !== selected.details.finalText;
		if (activeOutputChanged) this.output = undefined;
		if (this.screen === "transcript" && (generationChanged || justSettled)) {
			void this.loadTranscript(selected);
		}
		if (this.screen === "output" && (generationChanged || justSettled)) {
			if (!isActiveStatus(selected.summary.status) && selected.summary.status !== "closed") {
				void this.loadOutput(selected);
			} else {
				this.output = undefined;
			}
		}
	}

	private reconcileSelection(): void {
		const candidates = this.screen === "list" ? visibleAgentViews(this.showClosed, this.views) : [...this.views];
		const selected =
			candidates.find((view) => view.summary.agent_id === this.selectedId) ??
			candidates.find((view) => isActiveStatus(view.summary.status)) ??
			candidates[0];
		this.selectedId = selected?.summary.agent_id;
		const index = selected ? candidates.indexOf(selected) : 0;
		this.listOffset = keepVisible(this.listOffset, index, candidates.length);
	}

	private selectAt(views: readonly AgentView[], index: number): void {
		const selected = views[index];
		if (!selected) return;
		this.selectedId = selected.summary.agent_id;
		this.listOffset = keepVisible(this.listOffset, index, views.length);
		this.invalidate();
	}

	private emitOperation(data: string, view: AgentView): void {
		const actions = allowedDashboardActions(view.summary);
		const agentId = view.summary.agent_id;
		if (matchesKey(data, "s") && actions.steer) this.onOperation({ kind: "steer", agentId });
		else if (matchesKey(data, "f") && actions.followUp) this.onOperation({ kind: "followUp", agentId });
		else if (matchesKey(data, "x") && actions.interrupt) this.onOperation({ kind: "interrupt", agentId });
		else if (matchesKey(data, "d") && actions.close) this.onOperation({ kind: "close", agentId });
		else if (matchesKey(data, "j") && actions.jump) this.onOperation({ kind: "jump", agentId });
	}

	private scroll(target: ContentTarget, delta: number, view: AgentView): void {
		const snapshot = target === "transcript" ? this.transcript : this.output;
		const lines =
			snapshot?.agentId === view.summary.agent_id &&
			snapshot.generation === view.summary.generation &&
			snapshot.status !== "loading"
				? snapshot.lines
				: target === "output" && view.details.finalText
					? view.details.finalText.split(/\r?\n/)
					: [];
		const maxOffset = Math.max(0, lines.length - Math.max(1, this.maxRows - 3));
		if (target === "transcript") this.transcriptOffset = clampScroll(this.transcriptOffset + delta, maxOffset);
		else this.outputOffset = clampScroll(this.outputOffset + delta, maxOffset);
		this.invalidate();
	}

	private async loadTranscript(view: AgentView): Promise<void> {
		const id = view.summary.agent_id;
		const generation = view.summary.generation;
		if (
			this.transcript?.agentId === id &&
			this.transcript.generation === generation &&
			this.transcript.status === "loading"
		) {
			return;
		}
		this.transcript = { status: "loading", agentId: id, generation };
		this.invalidate();
		try {
			const messages = await this.registry.getLive(id).getMessages();
			this.finishLoad("transcript", id, generation, formatTranscript(messages));
		} catch (error) {
			this.failLoad("transcript", id, generation, error);
		}
	}

	private async loadOutput(view: AgentView): Promise<void> {
		const id = view.summary.agent_id;
		const generation = view.summary.generation;
		if (this.output?.agentId === id && this.output.generation === generation && this.output.status === "loading") {
			return;
		}
		this.output = { status: "loading", agentId: id, generation };
		this.invalidate();
		try {
			const output = await this.registry.getLive(id).loadFullOutput();
			const current = this.currentView(id);
			const retained = output || current?.details.finalText || "";
			const lines = retained ? retained.split(/\r?\n/).map(sanitizeTerminalLine) : [];
			this.finishLoad("output", id, generation, lines);
		} catch (error) {
			const fallback = this.currentView(id)?.details.finalText;
			this.failLoad("output", id, generation, error, fallback ? fallback.split(/\r?\n/).map(sanitizeTerminalLine) : []);
		}
	}

	private finishLoad(target: ContentTarget, id: string, generation: number, lines: readonly string[]): void {
		if (this.currentView(id)?.summary.generation !== generation || !this.isLoadPending(target, id, generation)) return;
		const snapshot: ContentSnapshot = { status: "ready", agentId: id, generation, lines: [...lines] };
		if (target === "transcript") this.transcript = snapshot;
		else this.output = snapshot;
		this.invalidate();
	}

	private failLoad(
		target: ContentTarget,
		id: string,
		generation: number,
		error: unknown,
		lines: readonly string[] = [],
	): void {
		if (this.currentView(id)?.summary.generation !== generation || !this.isLoadPending(target, id, generation)) return;
		const snapshot: ContentSnapshot = {
			status: "error",
			agentId: id,
			generation,
			message: sanitizeTerminalText(toError(error).message),
			lines,
		};
		if (target === "transcript") this.transcript = snapshot;
		else this.output = snapshot;
		this.invalidate();
	}

	private currentView(id: string): AgentView | undefined {
		return this.views.find((view) => view.summary.agent_id === id);
	}

	private isLoadPending(target: ContentTarget, id: string, generation: number): boolean {
		const snapshot = target === "transcript" ? this.transcript : this.output;
		return snapshot?.status === "loading" && snapshot.agentId === id && snapshot.generation === generation;
	}
}

export async function showAgentDashboard(ctx: ExtensionCommandContext, registry: AgentRegistry): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify(formatAgentCounts(registry.views()), "info");
		return;
	}
	let resolveOperation: ((operation: DashboardOperation) => void) | undefined;
	const dashboard = new Dashboard(registry, {
		onOperation(operation) {
			resolveOperation?.(operation);
		},
	});
	try {
		while (true) {
			const operation = await ctx.ui.custom<DashboardOperation>((tui, theme, _keybindings, done) => {
				resolveOperation = done;
				dashboard.attach(
					() => tui.requestRender(),
					() => Math.max(4, Math.min(16, tui.terminal.rows - 4)),
				);
				return {
					render: (width) => dashboard.render(theme, width),
					handleInput: (data) => dashboard.handleInput(data),
					invalidate: () => dashboard.invalidate(),
					dispose: () => dashboard.detach(),
				};
			});
			resolveOperation = undefined;
			if (!operation || operation.kind === "dismiss") return;
			await executeOperation(operation, ctx, registry);
		}
	} finally {
		dashboard.dispose();
	}
}

async function executeOperation(
	operation: Exclude<DashboardOperation, { readonly kind: "dismiss" }>,
	ctx: ExtensionCommandContext,
	registry: AgentRegistry,
): Promise<void> {
	try {
		switch (operation.kind) {
			case "steer": {
				const message = await ctx.ui.input("Steer subagent", "Message delivered at the next turn boundary");
				if (message?.trim()) await registry.getLive(operation.agentId).steer(message.trim());
				return;
			}
			case "followUp": {
				const message = await ctx.ui.input("Follow up", "New task for this subagent");
				if (message?.trim()) {
					await registry.getLive(operation.agentId).followUp(message.trim(), clipTextAtWord(message, 60), true);
				}
				return;
			}
			case "interrupt": {
				const summary = registry.summary(operation.agentId);
				const taskName = sanitizeTerminalText(summary.task_name);
				if (await ctx.ui.confirm("Interrupt subagent?", taskName || summary.agent_id)) {
					await registry.getLive(operation.agentId).interrupt();
				}
				return;
			}
			case "close":
				if (await ctx.ui.confirm("Close subagent?", "Its retained context will be lost.")) {
					await registry.close(operation.agentId);
				}
				return;
			case "jump": {
				const summary = registry.summary(operation.agentId);
				if (summary.status === "starting" || summary.status === "running") {
					throw new Error("Interrupt the subagent before taking over its session.");
				}
				if (!summary.session_file) throw new Error("This subagent has no session file.");
				const confirmed = await ctx.ui.confirm(
					"Take over subagent session?",
					"This leaves the parent session and closes every retained subagent.",
				);
				if (!confirmed) return;
				await registry.close(operation.agentId);
				await ctx.switchSession(summary.session_file);
			}
		}
	} catch (error) {
		ctx.ui.notify(sanitizeTerminalText(toError(error).message), "error");
	}
}

function keepVisible(offset: number, index: number, total: number): number {
	let next = offset;
	if (index < next) next = index;
	if (index >= next + MAX_VISIBLE_AGENTS) next = index - MAX_VISIBLE_AGENTS + 1;
	return Math.max(0, Math.min(next, Math.max(0, total - MAX_VISIBLE_AGENTS)));
}
