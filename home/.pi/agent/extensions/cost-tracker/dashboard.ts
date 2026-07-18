import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { DashboardViewData, Period } from "./aggregate.ts";
import { clipTerminalText } from "../_shared/terminal-text.ts";

const TABS: readonly Period[] = ["day", "week", "month"];
const TAB_LABELS: Readonly<Record<Period, string>> = { day: "Day", week: "Week", month: "Month" };
export const DASHBOARD_VIEWPORT_LINES = 20;

export type CostDashboardTheme = Pick<Theme, "fg" | "bold">;

function fmtNum(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
	return String(value);
}

function fmtCost(value: number): string {
	return `$${value.toFixed(3)}`;
}

/** Rendering consumes an already-built view and never reads the filesystem. */
export class CostDashboard implements Component {
	private activeTab: Period = "day";
	private scrollOffset = 0;
	private cachedLines: { readonly width: number; readonly lines: string[] } | undefined;
	private readonly data: DashboardViewData;
	private readonly theme: CostDashboardTheme;
	private readonly requestRender: () => void;
	private readonly onClose: () => void;

	constructor(data: DashboardViewData, theme: CostDashboardTheme, requestRender: () => void, onClose: () => void) {
		this.data = data;
		this.theme = theme;
		this.requestRender = requestRender;
		this.onClose = onClose;
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) {
			this.onClose();
			return;
		}
		let changed = false;
		const index = TABS.indexOf(this.activeTab);
		if (matchesKey(data, Key.left)) {
			this.activeTab = TABS[index - 1] ?? "month";
			this.scrollOffset = this.clampScroll(0);
			changed = true;
		} else if (matchesKey(data, Key.right)) {
			this.activeTab = TABS[(index + 1) % TABS.length] ?? "day";
			this.scrollOffset = this.clampScroll(0);
			changed = true;
		} else if (matchesKey(data, Key.up) && this.scrollOffset > 0) {
			this.scrollOffset--;
			changed = true;
		} else if (matchesKey(data, Key.down)) {
			const maxScroll = this.maxScroll();
			if (this.scrollOffset < maxScroll) {
				this.scrollOffset++;
				changed = true;
			}
		}
		if (changed) {
			this.cachedLines = undefined;
			this.requestRender();
		}
	}

	invalidate(): void {
		this.cachedLines = undefined;
		this.scrollOffset = this.clampScroll(this.scrollOffset);
	}

	private maxScroll(): number {
		return Math.max(0, this.buildContentLines().length - DASHBOARD_VIEWPORT_LINES);
	}

	private clampScroll(offset: number): number {
		return Math.max(0, Math.min(offset, this.maxScroll()));
	}

	private buildTabs(): string {
		const tabs = TABS.map((period) => {
			const label = TAB_LABELS[period];
			return period === this.activeTab
				? this.theme.fg("accent", this.theme.bold(`[${label}]`))
				: this.theme.fg("dim", label);
		});
		return `  ${tabs.join(this.theme.fg("muted", "  │  "))}`;
	}

	private buildContentLines(): string[] {
		const data = this.data.periods[this.activeTab];
		const { stats, tools } = data;
		const lines: string[] = [];
		lines.push(this.theme.fg("accent", this.theme.bold("  Summary")));
		lines.push(
			`    ${this.theme.fg("text", String(stats.turns))} turns    ${this.theme.fg("text", fmtNum(stats.inputTokens + stats.outputTokens))} tokens    ${this.theme.fg("text", fmtCost(stats.cost))}`,
		);
		lines.push(
			`    ${this.theme.fg("muted", "in")} ${this.theme.fg("text", fmtNum(stats.inputTokens))}  ${this.theme.fg("muted", "out")} ${this.theme.fg("text", fmtNum(stats.outputTokens))}  ${this.theme.fg("muted", "cr")} ${this.theme.fg("text", fmtNum(stats.cacheReadTokens))}  ${this.theme.fg("muted", "cw")} ${this.theme.fg("text", fmtNum(stats.cacheWriteTokens))}`,
			"",
		);

		const models = [...stats.models.entries()].sort(([, left], [, right]) => right.cost - left.cost);
		if (models.length > 0) {
			lines.push(this.theme.fg("accent", this.theme.bold("  Models")));
			for (const [model, modelStats] of models) {
				const tokens = modelStats.inputTokens + modelStats.outputTokens;
				const efficiency =
					modelStats.cost > 0 && tokens > 0
						? `${fmtNum(Math.round(tokens / modelStats.cost))} tok/$`
						: this.theme.fg("dim", "—");
				const label = clipTerminalText(model, 24);
				lines.push(
					`    ${this.theme.fg("text", label.padEnd(24))} ${this.theme.fg("text", String(modelStats.turns).padStart(4))}t  ${this.theme.fg("text", fmtNum(tokens).padStart(7))}tok  ${this.theme.fg("text", fmtCost(modelStats.cost).padStart(9))}  ${this.theme.fg("muted", efficiency)}`,
				);
			}
			lines.push("");
		}

		const toolEntries = [...tools.entries()].sort(([, left], [, right]) => right - left);
		if (toolEntries.length > 0) {
			lines.push(this.theme.fg("accent", this.theme.bold("  Tools (by calls)")));
			for (const [tool, count] of toolEntries) {
				lines.push(
					`    ${this.theme.fg("text", clipTerminalText(tool, 24).padEnd(24))} ${this.theme.fg("text", String(count).padStart(6))}x`,
				);
			}
			lines.push("");
		} else {
			lines.push(this.theme.fg("dim", "  No tool data yet (will appear after saving a session)."), "");
		}

		const scan = this.data.diagnostics.scan;
		const unreadable = scan.unreadableFiles + scan.unreadableDirectories;
		lines.push(
			this.theme.fg(
				"muted",
				`  Data diagnostics: ${scan.acceptedRecords} accepted · ${scan.filesSkipped} skipped · ${scan.malformedRecords} malformed · ${unreadable} unreadable`,
			),
		);
		if (scan.filesFound > 0 || scan.unrelatedRecords > 0 || scan.emptyLines > 0) {
			lines.push(
				this.theme.fg(
					"muted",
					`    ${scan.filesScanned}/${scan.filesFound} files scanned · ${scan.unrelatedRecords} unrelated · ${scan.emptyLines} empty`,
				),
			);
		}
		for (const message of this.data.diagnostics.storeMessages) {
			lines.push(this.theme.fg("muted", `    ${clipTerminalText(message, 160)}`));
		}
		lines.push("");
		return lines;
	}

	render(width: number): string[] {
		if (this.cachedLines?.width === width) return this.cachedLines.lines;
		const content = this.buildContentLines();
		this.scrollOffset = this.clampScroll(this.scrollOffset);
		const viewport = content.slice(this.scrollOffset, this.scrollOffset + DASHBOARD_VIEWPORT_LINES);
		while (viewport.length < DASHBOARD_VIEWPORT_LINES) viewport.push("");
		const controls =
			content.length <= DASHBOARD_VIEWPORT_LINES
				? this.theme.fg("dim", "  ← → tabs  ·  esc close")
				: this.theme.fg(
						"dim",
						`  ← → tabs  ·  ↑↓ scroll (${Math.min(100, Math.round(((this.scrollOffset + DASHBOARD_VIEWPORT_LINES) / content.length) * 100))}%)  ·  esc close`,
					);
		const rendered = [this.buildTabs(), "", ...viewport, controls, ""].map((line) => truncateToWidth(line, width));
		this.cachedLines = { width, lines: rendered };
		return rendered;
	}
}
