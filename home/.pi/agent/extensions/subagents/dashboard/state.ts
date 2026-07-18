import type { AgentView } from "../agent-types.ts";

export type DashboardScreen = "list" | "detail" | "transcript" | "output" | "diagnostics";
export type CacheTarget = "transcript" | "output";

export type LinesCacheEntry =
	| { readonly status: "loading"; readonly generation: number }
	| { readonly status: "ready"; readonly generation: number; readonly lines: readonly string[] }
	| {
			readonly status: "error";
			readonly generation: number;
			readonly message: string;
			readonly lines: readonly string[];
	  };

export interface DashboardState {
	readonly screen: DashboardScreen;
	readonly selectedId?: string;
	readonly listOffset: number;
	readonly transcriptOffset: number;
	readonly outputOffset: number;
	readonly showClosed: boolean;
	readonly transcripts: ReadonlyMap<string, LinesCacheEntry>;
	readonly outputs: ReadonlyMap<string, LinesCacheEntry>;
}

export type DashboardStateAction =
	| { readonly type: "syncViews"; readonly views: readonly AgentView[] }
	| { readonly type: "select"; readonly agentId: string; readonly visibleIndex: number; readonly visibleCount: number }
	| { readonly type: "toggleClosed"; readonly views: readonly AgentView[] }
	| { readonly type: "setScreen"; readonly screen: DashboardScreen }
	| {
			readonly type: "scroll";
			readonly target: "transcript" | "output";
			readonly delta: number;
			readonly maxOffset: number;
	  }
	| {
			readonly type: "cacheLoading";
			readonly target: CacheTarget;
			readonly agentId: string;
			readonly generation: number;
	  }
	| {
			readonly type: "cacheReady";
			readonly target: CacheTarget;
			readonly agentId: string;
			readonly generation: number;
			readonly lines: readonly string[];
	  }
	| {
			readonly type: "cacheError";
			readonly target: CacheTarget;
			readonly agentId: string;
			readonly generation: number;
			readonly message: string;
			readonly lines?: readonly string[];
	  };

export const MAX_VISIBLE_AGENTS = 5;

export function createDashboardState(selectedId?: string, screen: DashboardScreen = "list"): DashboardState {
	return {
		screen,
		...(selectedId === undefined ? {} : { selectedId }),
		listOffset: 0,
		transcriptOffset: 0,
		outputOffset: 0,
		showClosed: false,
		transcripts: new Map(),
		outputs: new Map(),
	};
}

export function reduceDashboardState(state: DashboardState, action: DashboardStateAction): DashboardState {
	switch (action.type) {
		case "syncViews":
			return reconcileSelection(state, action.views);
		case "select":
			return {
				...state,
				selectedId: action.agentId,
				listOffset: keepVisible(state.listOffset, action.visibleIndex, action.visibleCount),
			};
		case "toggleClosed":
			return reconcileSelection({ ...state, showClosed: !state.showClosed }, action.views);
		case "setScreen":
			return {
				...state,
				screen: action.screen,
				...(action.screen === "transcript" ? { transcriptOffset: 0 } : {}),
				...(action.screen === "output" ? { outputOffset: 0 } : {}),
			};
		case "scroll": {
			const key = action.target === "transcript" ? "transcriptOffset" : "outputOffset";
			return { ...state, [key]: clampScroll(state[key] + action.delta, action.maxOffset) };
		}
		case "cacheLoading":
			return updateCache(state, action.target, action.agentId, {
				status: "loading",
				generation: action.generation,
			});
		case "cacheReady":
			return updateCache(state, action.target, action.agentId, {
				status: "ready",
				generation: action.generation,
				lines: [...action.lines],
			});
		case "cacheError":
			return updateCache(state, action.target, action.agentId, {
				status: "error",
				generation: action.generation,
				message: action.message,
				lines: action.lines ?? [],
			});
	}
}

export function visibleAgentViews(state: Pick<DashboardState, "showClosed">, views: readonly AgentView[]): AgentView[] {
	return state.showClosed ? [...views] : views.filter((view) => view.summary.status !== "closed");
}

export function clampScroll(offset: number, maxOffset: number): number {
	return Math.max(0, Math.min(Math.max(0, offset), Math.max(0, maxOffset)));
}

function reconcileSelection(state: DashboardState, views: readonly AgentView[]): DashboardState {
	const candidates = state.screen === "list" ? visibleAgentViews(state, views) : [...views];
	const selected = candidates.find((view) => view.summary.agent_id === state.selectedId) ?? preferredView(candidates);
	const selectedId = selected?.summary.agent_id;
	const selectedIndex = selectedId ? candidates.findIndex((view) => view.summary.agent_id === selectedId) : 0;
	const { selectedId: _previousSelectedId, ...stateWithoutSelection } = state;
	return {
		...stateWithoutSelection,
		...(selectedId === undefined ? {} : { selectedId }),
		listOffset: keepVisible(state.listOffset, selectedIndex, candidates.length),
	};
}

function preferredView(views: readonly AgentView[]): AgentView | undefined {
	return views.find((view) => view.summary.status === "starting" || view.summary.status === "running") ?? views[0];
}

function keepVisible(offset: number, index: number, total: number): number {
	let next = offset;
	if (index < next) next = index;
	if (index >= next + MAX_VISIBLE_AGENTS) next = index - MAX_VISIBLE_AGENTS + 1;
	return Math.max(0, Math.min(next, Math.max(0, total - MAX_VISIBLE_AGENTS)));
}

function updateCache(
	state: DashboardState,
	target: CacheTarget,
	agentId: string,
	entry: LinesCacheEntry,
): DashboardState {
	const key = target === "transcript" ? "transcripts" : "outputs";
	const cache = new Map(state[key]);
	cache.set(agentId, entry);
	return { ...state, [key]: cache };
}
