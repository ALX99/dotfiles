/**
 * Cost Tracker Extension for pi
 *
 * Tracks LLM token usage and cost per turn. Provides an interactive
 * /analyze-cost dashboard with tabs for day, week, and month — broken
 * down by model and tool invocation counts.
 *
 * Token/cost data comes from JSONL session logs. Tool invocations are
 * tracked in-memory and persisted across sessions in a minimal file
 * (just timestamps + tool call counts).
 */

import { getAgentDir, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	type Component,
	matchesKey,
	Key,
	truncateToWidth,
} from "@mariozechner/pi-tui";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const AGENT_DIR = getAgentDir();
const SESSIONS_DIR = join(AGENT_DIR, "sessions");
const TOOLS_FILE = join(AGENT_DIR, "cost-tracker-tools.json");

// Types

interface ToolRecord {
	ts: number;
	toolCounts: Record<string, number>;
}

interface TokenStats {
	inputTokens: number;
	outputTokens: number;
	cost: number;
}

interface BaseStats extends TokenStats {
	turns: number;
}

interface TurnRecord extends TokenStats {
	ts: number;
	model: string;
	cacheReadTokens: number;
	cacheWriteTokens: number;
}

interface Aggregated extends BaseStats {
	cacheReadTokens: number;
	cacheWriteTokens: number;
	models: Record<string, BaseStats>;
}

type Period = "day" | "week" | "month";

// JSONL scanning

function startOfDay(ts: number): number {
	const d = new Date(ts);
	d.setHours(0, 0, 0, 0);
	return d.getTime();
}

function startOfWeek(ts: number): number {
	const d = new Date(ts);
	const day = d.getDay();
	const diff = d.getDate() - day + (day === 0 ? -6 : 1);
	d.setDate(diff);
	d.setHours(0, 0, 0, 0);
	return d.getTime();
}

function startOfMonth(ts: number): number {
	const d = new Date(ts);
	d.setDate(1);
	d.setHours(0, 0, 0, 0);
	return d.getTime();
}

function getPeriodStart(period: Period): number {
	const now = Date.now();
	switch (period) {
		case "day":
			return startOfDay(now);
		case "week":
			return startOfWeek(now);
		case "month":
			return startOfMonth(now);
	}
}

async function findJsonlFiles(dir: string): Promise<string[]> {
	const out: string[] = [];
	try {
		for (const e of await readdir(dir, { withFileTypes: true })) {
			const p = join(dir, e.name);
			if (e.isDirectory()) out.push(...(await findJsonlFiles(p)));
			else if (e.name.endsWith(".jsonl")) out.push(p);
		}
	} catch { /* ignore permission errors */ }
	return out;
}

async function scanUsageRecords(): Promise<TurnRecord[]> {
	const records: TurnRecord[] = [];
	const monthCut = startOfMonth(Date.now());

	const files = await findJsonlFiles(SESSIONS_DIR);
	for (const file of files) {
		try {
			const s = await stat(file);
			if (s.mtime.getTime() < monthCut) continue;

			const raw = await readFile(file, "utf8");
			for (const line of raw.split("\n")) {
				if (!line.trim()) continue;
				try {
					const entry = JSON.parse(line);
					const ts = new Date(entry.timestamp).getTime();
					if (ts < monthCut) continue;
					if (
						entry.type === "message" &&
						entry.message?.role === "assistant" &&
						entry.message.usage
					) {
						const usage = entry.message.usage;
						records.push({
							ts,
							model: entry.message.model ?? "unknown",
							inputTokens: usage.input ?? 0,
							outputTokens: usage.output ?? 0,
							cacheReadTokens: usage.cacheRead ?? 0,
							cacheWriteTokens: usage.cacheWrite ?? 0,
							cost: usage.cost?.total ?? 0,
						});
					}
				} catch {
					// malformed line — skip
				}
			}
		} catch {
			// skip unreadable files
		}
	}

	return records;
}

// Tool persistence

async function loadToolRecords(): Promise<ToolRecord[]> {
	try {
		return JSON.parse(await readFile(TOOLS_FILE, "utf-8")) as ToolRecord[];
	} catch {
		return [];
	}
}

async function saveToolRecords(records: ToolRecord[]): Promise<void> {
	const cutoff = startOfMonth(Date.now());
	const recent = records.filter((r) => r.ts >= cutoff);

	await mkdir(dirname(TOOLS_FILE), { recursive: true });
	await writeFile(TOOLS_FILE, JSON.stringify(recent));
}

// Analysis helpers

function fmtNum(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return `${n}`;
}

function fmtCost(c: number): string {
	return `$${c.toFixed(3)}`;
}

function aggregate(turns: TurnRecord[]): Aggregated {
	const out: Aggregated = {
		turns: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		cost: 0,
		models: {},
	};
	for (const t of turns) {
		out.turns++;
		out.inputTokens += t.inputTokens;
		out.outputTokens += t.outputTokens;
		out.cacheReadTokens += t.cacheReadTokens;
		out.cacheWriteTokens += t.cacheWriteTokens;
		out.cost += t.cost;
		const m = (out.models[t.model] ??= { turns: 0, inputTokens: 0, outputTokens: 0, cost: 0 });
		m.turns++;
		m.inputTokens += t.inputTokens;
		m.outputTokens += t.outputTokens;
		m.cost += t.cost;
	}
	return out;
}

function aggregateTools(toolRecords: ToolRecord[], cutoff: number): Record<string, number> {
	const tools: Record<string, number> = {};
	for (const tr of toolRecords) {
		if (tr.ts < cutoff) continue;
		for (const [name, count] of Object.entries(tr.toolCounts)) {
			tools[name] = (tools[name] ?? 0) + count;
		}
	}
	return tools;
}

// Dashboard component

type Theme = {
	fg: (color: string, text: string) => string;
	bold: (text: string) => string;
};

const TABS: Period[] = ["day", "week", "month"];
const TAB_LABELS: Record<Period, string> = { day: "Day", week: "Week", month: "Month" };

type PeriodData = {
	stats: Aggregated;
	tools: Record<string, number>;
};

function buildPeriodData(period: Period, turns: TurnRecord[], tools: ToolRecord[]): PeriodData {
	const cutoff = getPeriodStart(period);
	return {
		stats: aggregate(turns.filter((t) => t.ts >= cutoff)),
		tools: aggregateTools(tools, cutoff),
	};
}

const VIEWPORT_LINES = 20;

class Dashboard implements Component {
	private data: Record<Period, PeriodData>;
	private activeTab: Period = "day";
	private scrollOffset = 0;
	private cachedLines: { width: number; lines: string[] } | undefined;
	private numLines = 0;
	private onClose: () => void;
	private requestRender: () => void;
	private theme: Theme;

	constructor(
		scannedRecords: TurnRecord[],
		toolRecords: ToolRecord[],
		theme: Theme,
		requestRender: () => void,
		onClose: () => void,
	) {
		this.theme = theme;
		this.requestRender = requestRender;
		this.onClose = onClose;
		this.data = Object.fromEntries(
			TABS.map((period) => [period, buildPeriodData(period, scannedRecords, toolRecords)]),
		) as Record<Period, PeriodData>;
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) {
			this.onClose();
			return;
		}

		let changed = false;
		const idx = TABS.indexOf(this.activeTab);

		if (matchesKey(data, Key.left)) {
			this.activeTab = TABS[idx - 1] ?? TABS[TABS.length - 1];
			this.scrollOffset = 0;
			changed = true;
		} else if (matchesKey(data, Key.right)) {
			this.activeTab = TABS[(idx + 1) % TABS.length];
			this.scrollOffset = 0;
			changed = true;
		} else if (matchesKey(data, Key.up)) {
			if (this.scrollOffset > 0) {
				this.scrollOffset--;
				changed = true;
			}
		} else if (matchesKey(data, Key.down)) {
			const maxScroll = Math.max(0, this.numLines - VIEWPORT_LINES);
			if (this.scrollOffset < maxScroll) {
				this.scrollOffset++;
				changed = true;
			}
		}

		if (changed) {
			this.invalidate();
			this.requestRender();
		}
	}

	invalidate(): void {
		this.cachedLines = undefined;
	}

	private buildLines(): string[] {
		const { theme, activeTab } = this;
		const { stats, tools } = this.data[activeTab];
		const lines: string[] = [];

		// Tab bar
		const tabParts = TABS.map((p) => {
			const label = TAB_LABELS[p];
			return p === activeTab
				? theme.fg("accent", theme.bold(`[${label}]`))
				: theme.fg("dim", label);
		});
		lines.push("  " + tabParts.join(theme.fg("muted", "  │  ")));
		lines.push("");

		// Summary
		lines.push(theme.fg("accent", theme.bold("  Summary")));
		lines.push(
			`    ${theme.fg("text", String(stats.turns))} turns    ${theme.fg("text", fmtNum(stats.inputTokens + stats.outputTokens))} tokens    ${theme.fg("text", fmtCost(stats.cost))}`,
		);
		lines.push(
			`    ${theme.fg("muted", "in")} ${theme.fg("text", fmtNum(stats.inputTokens))}  ${theme.fg("muted", "out")} ${theme.fg("text", fmtNum(stats.outputTokens))}  ${theme.fg("muted", "cr")} ${theme.fg("text", fmtNum(stats.cacheReadTokens))}  ${theme.fg("muted", "cw")} ${theme.fg("text", fmtNum(stats.cacheWriteTokens))}`,
		);
		lines.push("");

		// Models
		const modelNames = Object.keys(stats.models).sort(
			(a, b) => stats.models[b].cost - stats.models[a].cost,
		);
		if (modelNames.length > 0) {
			lines.push(theme.fg("accent", theme.bold("  Models")));
			for (const m of modelNames) {
				const ms = stats.models[m];
				const totalTok = ms.inputTokens + ms.outputTokens;
				const efficiency =
					ms.cost > 0 && totalTok > 0
						? fmtNum(Math.round(totalTok / ms.cost)) + " tok/$"
						: theme.fg("dim", "—");
				const label = m.length > 24 ? m.slice(0, 21) + "…" : m;
				lines.push(
					`    ${theme.fg("text", label.padEnd(24))} ${theme.fg("text", String(ms.turns).padStart(4))}t  ${theme.fg("text", fmtNum(totalTok).padStart(7))}tok  ${theme.fg("text", fmtCost(ms.cost).padStart(9))}  ${theme.fg("muted", efficiency)}`,
				);
			}
			lines.push("");
		}

		// Tools
		const toolNames = Object.keys(tools).sort((a, b) => tools[b] - tools[a]);
		if (toolNames.length > 0) {
			lines.push(theme.fg("accent", theme.bold("  Tools (by calls)")));
			for (const t of toolNames) {
				const label = t.length > 24 ? t.slice(0, 21) + "…" : t;
				lines.push(
					`    ${theme.fg("text", label.padEnd(24))} ${theme.fg("text", String(tools[t]).padStart(6))}x`,
				);
			}
			lines.push("");
		} else {
			lines.push(theme.fg("dim", "  No tool data yet (will appear after saving a session)."));
			lines.push("");
		}

		return lines;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedLines.width === width) {
			return this.cachedLines.lines;
		}

		const lines = this.buildLines();
		this.numLines = lines.length;

		// Navigation footer
		if (this.numLines <= VIEWPORT_LINES) {
			lines.push(this.theme.fg("dim", "  ← → tabs  ·  esc close"));
		} else {
			const pct = Math.min(100, Math.round(((this.scrollOffset + VIEWPORT_LINES) / this.numLines) * 100));
			lines.push(this.theme.fg("dim", `  ← → tabs  ·  ↑↓ scroll (${pct}%)  ·  esc close`));
		}
		lines.push("");

		const displayLines = lines.slice(this.scrollOffset);
		while (displayLines.length < 5) displayLines.push("");

		const result = displayLines.map((l) => truncateToWidth(l, width));
		this.cachedLines = { width, lines: result };
		return result;
	}
}

// Extension factory

export default function costTracker(pi: ExtensionAPI) {
	const currentTurnToolCounts = new Map<string, number>();
	const sessionToolRecords: ToolRecord[] = [];

	pi.on("session_start", () => {
		currentTurnToolCounts.clear();
		sessionToolRecords.length = 0;
	});
	pi.on("tool_execution_start", (event) => {
		const name = event.toolName;
		// pi emits tool_execution_start before validating the tool name against the
		// registry, so the LLM can hallucinate invalid names (e.g. "ls -la ...").
		// Only count tools that are actually registered and active.
		if (!pi.getActiveTools().includes(name)) return;
		currentTurnToolCounts.set(
			name,
			(currentTurnToolCounts.get(name) ?? 0) + 1,
		);
	});

	pi.on("turn_start", () => {
		currentTurnToolCounts.clear();
	});

	pi.on("turn_end", (event) => {
		const msg = event.message;
		if (msg.role !== "assistant" || currentTurnToolCounts.size === 0) return;

		sessionToolRecords.push({
			ts: Date.now(),
			toolCounts: Object.fromEntries(currentTurnToolCounts),
		});
		currentTurnToolCounts.clear();
	});

	pi.on("session_shutdown", async () => {
		if (sessionToolRecords.length === 0) return;
		try {
			const existing = await loadToolRecords();
			await saveToolRecords(existing.concat(sessionToolRecords));
		} catch {
			// Cost tracking should not block shutdown.
		}
	});

	// /analyze-cost command

	pi.registerCommand("analyze-cost", {
		description: "Open interactive cost dashboard (day, week, month)",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("Cost tracker requires interactive mode", "error");
				return;
			}

			const [scanned, persistedTools] = await Promise.all([
				scanUsageRecords(),
				loadToolRecords(),
			]);

			const allTools = persistedTools.concat(sessionToolRecords);

			await ctx.ui.custom((tui, theme, _kb, done) => {
				return new Dashboard(scanned, allTools, theme, () => tui.requestRender(), () => done(undefined));
			});
		},
	});
}
