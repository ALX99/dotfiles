import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { toError } from "../../_shared/errors.ts";
import { clipTextAtWord, sanitizeTerminalLine, sanitizeTerminalText } from "../../_shared/terminal-text.ts";
import type { AgentRegistry } from "../agent-registry.ts";
import type { AgentView } from "../agent-types.ts";
import { operationForKey, type DashboardOperation } from "./actions.ts";
import { renderDashboard } from "./render.ts";
import {
	createDashboardState,
	reduceDashboardState,
	visibleAgentViews,
	type CacheTarget,
	type DashboardState,
	type DashboardStateAction,
} from "./state.ts";
import { formatTranscript } from "./transcript.ts";
import { buildDashboardViewModel, formatAgentCounts } from "./view-model.ts";

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

export interface DashboardControllerOptions {
	readonly clock?: DashboardClock;
	readonly onOperation: (operation: DashboardOperation) => void;
}

export interface DashboardAgentReader {
	getMessages(): Promise<unknown[]>;
	loadFullOutput(): Promise<string>;
}

export interface DashboardDataSource {
	views(): AgentView[];
	get(id: string): DashboardAgentReader;
	subscribe(listener: () => void): () => void;
}

export class DashboardController {
	private state: DashboardState;
	private views: readonly AgentView[];
	private requestRender: (() => void) | undefined;
	private unsubscribe: (() => void) | undefined;
	private timer: DashboardTimer | undefined;
	private maxRows = 12;
	private disposed = false;
	private readonly clock: DashboardClock;
	private readonly registry: DashboardDataSource;
	private readonly onOperation: (operation: DashboardOperation) => void;

	constructor(registry: DashboardDataSource, options: DashboardControllerOptions) {
		this.registry = registry;
		this.clock = options.clock ?? SYSTEM_CLOCK;
		this.onOperation = options.onOperation;
		this.views = registry.views();
		this.state = reduceDashboardState(createDashboardState(), { type: "syncViews", views: this.views });
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
			if (this.state.screen === "transcript" || this.state.screen === "output" || this.state.screen === "diagnostics") {
				this.dispatch({ type: "setScreen", screen: "detail" });
			} else if (this.state.screen === "detail") this.dispatch({ type: "setScreen", screen: "list" });
			else this.onOperation({ kind: "dismiss" });
			return;
		}

		const allViews = this.views;
		const listViews = visibleAgentViews(this.state, allViews);
		const selectionViews = this.state.screen === "list" ? listViews : allViews;
		const selected = selectionViews.find((view) => view.summary.agent_id === this.state.selectedId);
		if (this.state.screen === "list") {
			const index = selected ? listViews.findIndex((view) => view.summary.agent_id === selected.summary.agent_id) : -1;
			if (matchesKey(data, Key.up) && listViews.length) this.selectAt(listViews, Math.max(0, index - 1));
			else if (matchesKey(data, Key.down) && listViews.length) {
				this.selectAt(listViews, Math.min(listViews.length - 1, index + 1));
			} else if (matchesKey(data, "a") && allViews.some((view) => view.summary.status === "closed")) {
				this.dispatch({ type: "toggleClosed", views: allViews });
			} else if (matchesKey(data, Key.enter) && selected) this.dispatch({ type: "setScreen", screen: "detail" });
			else if (selected) this.emitOperation(data, selected);
			return;
		}
		if (!selected) return;
		if (this.state.screen === "detail") {
			if (matchesKey(data, "t")) {
				this.dispatch({ type: "setScreen", screen: "transcript" });
				void this.loadTranscript(selected);
			} else if (matchesKey(data, "o")) {
				this.dispatch({ type: "setScreen", screen: "output" });
				void this.loadOutput(selected);
			} else if (matchesKey(data, "i")) this.dispatch({ type: "setScreen", screen: "diagnostics" });
			else this.emitOperation(data, selected);
			return;
		}
		if (this.state.screen === "transcript") {
			if (matchesKey(data, Key.up)) this.scroll("transcript", 1, selected);
			else if (matchesKey(data, Key.down)) this.scroll("transcript", -1, selected);
			else if (matchesKey(data, "s")) this.emitOperation(data, selected);
		} else if (this.state.screen === "output") {
			if (matchesKey(data, Key.up)) this.scroll("output", 1, selected);
			else if (matchesKey(data, Key.down)) this.scroll("output", -1, selected);
		} else if (this.state.screen === "diagnostics" && matchesKey(data, "j")) {
			this.emitOperation(data, selected);
		}
	}

	render(theme: Theme, width: number): string[] {
		return renderDashboard(
			buildDashboardViewModel({
				state: this.state,
				views: this.views,
				maxRows: this.maxRows,
				now: this.clock.now(),
			}),
			theme,
			width,
		);
	}

	invalidate(): void {
		this.requestRender?.();
	}

	getState(): DashboardState {
		return this.state;
	}

	private dispatch(action: DashboardStateAction): void {
		this.state = reduceDashboardState(this.state, action);
		this.requestRender?.();
	}

	private refreshViews(): void {
		const previousSelection = this.state.selectedId;
		const previousGeneration = previousSelection
			? this.views.find((view) => view.summary.agent_id === previousSelection)?.summary.generation
			: undefined;
		this.views = this.registry.views();
		this.state = reduceDashboardState(this.state, { type: "syncViews", views: this.views });
		const selected = this.views.find((view) => view.summary.agent_id === this.state.selectedId);
		if (
			this.state.screen === "transcript" &&
			selected &&
			(previousSelection !== selected.summary.agent_id || previousGeneration !== selected.summary.generation)
		) {
			void this.loadTranscript(selected);
		}
	}

	private selectAt(views: readonly AgentView[], index: number): void {
		const selected = views[index];
		if (!selected) return;
		this.dispatch({
			type: "select",
			agentId: selected.summary.agent_id,
			visibleIndex: index,
			visibleCount: views.length,
		});
	}

	private emitOperation(data: string, view: AgentView): void {
		for (const key of ["s", "f", "x", "d", "j"] as const) {
			if (!matchesKey(data, key)) continue;
			const operation = operationForKey(key, view.summary);
			if (operation) this.onOperation(operation);
			return;
		}
	}

	private scroll(target: CacheTarget, delta: number, view: AgentView): void {
		const cache = target === "transcript" ? this.state.transcripts : this.state.outputs;
		const entry = cache.get(view.summary.agent_id);
		const available = Math.max(1, this.maxRows - 3);
		const maxOffset =
			entry?.status === "ready" && entry.generation === view.summary.generation
				? Math.max(0, entry.lines.length - available)
				: 0;
		this.dispatch({ type: "scroll", target, delta, maxOffset });
	}

	private async loadTranscript(view: AgentView): Promise<void> {
		const id = view.summary.agent_id;
		const generation = view.summary.generation;
		const cached = this.state.transcripts.get(id);
		if (cached?.generation === generation && (cached.status === "ready" || cached.status === "loading")) return;
		this.dispatch({ type: "cacheLoading", target: "transcript", agentId: id, generation });
		try {
			const messages = await this.registry.get(id).getMessages();
			this.finishLoad("transcript", id, generation, formatTranscript(messages));
		} catch (error) {
			this.failLoad("transcript", id, generation, error);
		}
	}

	private async loadOutput(view: AgentView): Promise<void> {
		const id = view.summary.agent_id;
		const generation = view.summary.generation;
		this.dispatch({ type: "cacheLoading", target: "output", agentId: id, generation });
		try {
			const output = await this.registry.get(id).loadFullOutput();
			const retained = output || view.details.finalText;
			const lines = retained ? retained.split(/\r?\n/).map(sanitizeTerminalLine) : [];
			this.finishLoad("output", id, generation, lines);
		} catch (error) {
			const fallback = view.details.finalText ? view.details.finalText.split(/\r?\n/).map(sanitizeTerminalLine) : [];
			this.failLoad("output", id, generation, error, fallback);
		}
	}

	private finishLoad(target: CacheTarget, id: string, generation: number, lines: readonly string[]): void {
		if (this.currentGeneration(id) !== generation) return;
		this.dispatch({ type: "cacheReady", target, agentId: id, generation, lines });
	}

	private failLoad(
		target: CacheTarget,
		id: string,
		generation: number,
		error: unknown,
		lines: readonly string[] = [],
	): void {
		if (this.currentGeneration(id) !== generation) return;
		this.dispatch({
			type: "cacheError",
			target,
			agentId: id,
			generation,
			message: sanitizeTerminalText(toError(error).message),
			lines,
		});
	}

	private currentGeneration(id: string): number | undefined {
		return this.views.find((view) => view.summary.agent_id === id)?.summary.generation;
	}
}

export async function showAgentDashboard(ctx: ExtensionCommandContext, registry: AgentRegistry): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify(formatAgentCounts(registry.views()), "info");
		return;
	}
	let resolveOperation: ((operation: DashboardOperation) => void) | undefined;
	const controller = new DashboardController(registry, {
		onOperation(operation) {
			resolveOperation?.(operation);
		},
	});
	try {
		while (true) {
			const operation = await ctx.ui.custom<DashboardOperation>((tui, theme, _keybindings, done) => {
				resolveOperation = done;
				controller.attach(
					() => tui.requestRender(),
					() => Math.max(4, Math.min(16, tui.terminal.rows - 4)),
				);
				return {
					render: (width) => controller.render(theme, width),
					handleInput: (data) => controller.handleInput(data),
					invalidate: () => controller.invalidate(),
					dispose: () => controller.detach(),
				};
			});
			resolveOperation = undefined;
			if (!operation || operation.kind === "dismiss") return;
			await executeOperation(operation, ctx, registry);
		}
	} finally {
		controller.dispose();
	}
}

async function executeOperation(
	operation: Exclude<DashboardOperation, { readonly kind: "dismiss" }>,
	ctx: ExtensionCommandContext,
	registry: AgentRegistry,
): Promise<void> {
	try {
		const agent = registry.get(operation.agentId);
		switch (operation.kind) {
			case "steer": {
				const message = await ctx.ui.input("Steer subagent", "Message delivered at the next turn boundary");
				if (message?.trim()) await agent.steer(message.trim());
				return;
			}
			case "followUp": {
				const message = await ctx.ui.input("Follow up", "New task for this subagent");
				if (message?.trim()) await agent.followUp(message.trim(), clipTextAtWord(message, 60), true);
				return;
			}
			case "interrupt": {
				const taskName = sanitizeTerminalText(agent.summary().task_name);
				if (await ctx.ui.confirm("Interrupt subagent?", taskName || agent.id)) await agent.interrupt();
				return;
			}
			case "close":
				if (await ctx.ui.confirm("Close subagent?", "Its retained context will be lost.")) {
					await registry.close(agent.id);
				}
				return;
			case "jump": {
				const summary = agent.summary();
				if (summary.status === "starting" || summary.status === "running") {
					throw new Error("Interrupt the subagent before taking over its session.");
				}
				if (!summary.session_file) throw new Error("This subagent has no session file.");
				const confirmed = await ctx.ui.confirm(
					"Take over subagent session?",
					"This leaves the parent session and closes every retained subagent.",
				);
				if (!confirmed) return;
				const sessionFile = summary.session_file;
				await registry.close(agent.id);
				await ctx.switchSession(sessionFile);
			}
		}
	} catch (error) {
		ctx.ui.notify(sanitizeTerminalText(toError(error).message), "error");
	}
}
