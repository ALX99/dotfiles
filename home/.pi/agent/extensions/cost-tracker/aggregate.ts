import type { ToolRecord, TurnRecord } from "./schema.ts";

export type Period = "day" | "week" | "month";

export interface TokenStats {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cost: number;
}

export interface BaseStats extends TokenStats {
	readonly turns: number;
}

export interface AggregatedStats extends BaseStats {
	readonly cacheReadTokens: number;
	readonly cacheWriteTokens: number;
	readonly models: ReadonlyMap<string, BaseStats>;
}

export interface PeriodData {
	readonly stats: AggregatedStats;
	readonly tools: ReadonlyMap<string, number>;
}

export interface ScanDiagnosticCounts {
	readonly filesFound: number;
	readonly filesScanned: number;
	readonly filesSkipped: number;
	readonly unreadableFiles: number;
	readonly unreadableDirectories: number;
	readonly emptyLines: number;
	readonly acceptedRecords: number;
	readonly unrelatedRecords: number;
	readonly malformedRecords: number;
}

export interface DashboardDiagnostics {
	readonly scan: ScanDiagnosticCounts;
	readonly storeMessages: readonly string[];
}

export interface DashboardViewData {
	readonly periods: Readonly<Record<Period, PeriodData>>;
	readonly diagnostics: DashboardDiagnostics;
}

function localMidnight(timestamp: number): number {
	const date = new Date(timestamp);
	date.setHours(0, 0, 0, 0);
	return date.getTime();
}

export function startOfDay(timestamp: number): number {
	return localMidnight(timestamp);
}

/** Monday is the first day of the local calendar week. */
export function startOfWeek(timestamp: number): number {
	const date = new Date(timestamp);
	const day = date.getDay();
	date.setDate(date.getDate() - (day === 0 ? 6 : day - 1));
	date.setHours(0, 0, 0, 0);
	return date.getTime();
}

export function startOfMonth(timestamp: number): number {
	const date = new Date(timestamp);
	date.setDate(1);
	date.setHours(0, 0, 0, 0);
	return date.getTime();
}

export function periodStart(period: Period, now: number): number {
	switch (period) {
		case "day":
			return startOfDay(now);
		case "week":
			return startOfWeek(now);
		case "month":
			return startOfMonth(now);
	}
}

export function aggregateTurns(turns: readonly TurnRecord[]): AggregatedStats {
	const models = new Map<string, BaseStats>();
	let turnsCount = 0;
	let inputTokens = 0;
	let outputTokens = 0;
	let cacheReadTokens = 0;
	let cacheWriteTokens = 0;
	let cost = 0;

	for (const turn of turns) {
		turnsCount++;
		inputTokens += turn.inputTokens;
		outputTokens += turn.outputTokens;
		cacheReadTokens += turn.cacheReadTokens;
		cacheWriteTokens += turn.cacheWriteTokens;
		cost += turn.cost;
		const current = models.get(turn.model) ?? { turns: 0, inputTokens: 0, outputTokens: 0, cost: 0 };
		models.set(turn.model, {
			turns: current.turns + 1,
			inputTokens: current.inputTokens + turn.inputTokens,
			outputTokens: current.outputTokens + turn.outputTokens,
			cost: current.cost + turn.cost,
		});
	}

	return { turns: turnsCount, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, cost, models };
}

export function aggregateTools(records: readonly ToolRecord[], cutoff: number): ReadonlyMap<string, number> {
	const tools = new Map<string, number>();
	for (const record of records) {
		if (record.ts < cutoff) continue;
		for (const [name, count] of Object.entries(record.toolCounts)) {
			tools.set(name, (tools.get(name) ?? 0) + count);
		}
	}
	return tools;
}

export function buildDashboardView(
	turns: readonly TurnRecord[],
	tools: readonly ToolRecord[],
	now: number,
	diagnostics: DashboardDiagnostics,
): DashboardViewData {
	const buildPeriod = (period: Period): PeriodData => {
		const cutoff = periodStart(period, now);
		return {
			stats: aggregateTurns(turns.filter((turn) => turn.ts >= cutoff)),
			tools: aggregateTools(tools, cutoff),
		};
	};
	const periods: Record<Period, PeriodData> = {
		day: buildPeriod("day"),
		week: buildPeriod("week"),
		month: buildPeriod("month"),
	};
	return { periods, diagnostics };
}
