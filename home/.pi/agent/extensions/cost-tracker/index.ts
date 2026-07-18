import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { buildDashboardView, type DashboardDiagnostics } from "./aggregate.ts";
import { CostDashboard } from "./dashboard.ts";
import type { ToolRecord } from "./schema.ts";
import { scanUsageRecords } from "./scan.ts";
import { CostTrackerStore, type StoreOptions } from "./store.ts";

export interface CostTrackerPaths {
	readonly sessionsDir: string;
	readonly toolsFile: string;
}

export interface CostTrackerDependencies {
	readonly now?: () => number;
	readonly paths?: CostTrackerPaths;
	readonly createStore?: (options: StoreOptions) => CostTrackerStore;
}

export function defaultCostTrackerPaths(agentDir = getAgentDir()): CostTrackerPaths {
	return {
		sessionsDir: join(agentDir, "sessions"),
		toolsFile: join(agentDir, "cost-tracker-tools.json"),
	};
}

export function createCostTracker(pi: ExtensionAPI, dependencies: CostTrackerDependencies = {}): void {
	const now = dependencies.now ?? Date.now;
	const paths = dependencies.paths ?? defaultCostTrackerPaths();
	const createStore = dependencies.createStore ?? ((options) => new CostTrackerStore(options));
	const store = createStore({ file: paths.toolsFile, now });
	const currentTurnToolCounts = new Map<string, number>();
	const sessionToolRecords: ToolRecord[] = [];

	pi.on("session_start", () => {
		currentTurnToolCounts.clear();
		sessionToolRecords.length = 0;
	});
	pi.on("tool_execution_start", (event) => {
		if (!pi.getActiveTools().includes(event.toolName)) return;
		currentTurnToolCounts.set(event.toolName, (currentTurnToolCounts.get(event.toolName) ?? 0) + 1);
	});
	pi.on("turn_start", () => currentTurnToolCounts.clear());
	pi.on("turn_end", (event) => {
		if (event.message.role !== "assistant" || currentTurnToolCounts.size === 0) return;
		sessionToolRecords.push({ ts: now(), toolCounts: Object.fromEntries(currentTurnToolCounts) });
		currentTurnToolCounts.clear();
	});
	pi.on("session_shutdown", async () => {
		if (sessionToolRecords.length === 0) return;
		const loaded = await store.load();
		if (!loaded.writable) {
			console.warn(`Cost tracker did not save tool counts: ${loaded.messages.join("; ")}`);
			return;
		}
		await store.save([...loaded.records, ...sessionToolRecords]);
	});

	pi.registerCommand("analyze-cost", {
		description: "Open interactive cost dashboard (day, week, month)",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("Cost tracker requires TUI mode", "error");
				return;
			}
			const timestamp = now();
			const [scan, stored] = await Promise.all([
				scanUsageRecords({ sessionsDir: paths.sessionsDir, now: timestamp }),
				store.load(),
			]);
			const diagnostics: DashboardDiagnostics = {
				scan: scan.diagnostics,
				storeMessages: [...scan.messages, ...stored.messages],
			};
			const view = buildDashboardView(scan.records, [...stored.records, ...sessionToolRecords], timestamp, diagnostics);
			await ctx.ui.custom((tui, theme, _kb, done) => {
				return new CostDashboard(
					view,
					theme,
					() => tui.requestRender(),
					() => done(undefined),
				);
			});
		},
	});
}

export default function costTracker(pi: ExtensionAPI): void {
	createCostTracker(pi);
}
