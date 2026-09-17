import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { sanitizeTerminalBlock, sanitizeTerminalText } from "../_shared/terminal-text.ts";
import { currentItem, formatAddedTask, formatTaskCounts, taskCounts, type ActiveQueue } from "./state.ts";

export interface TaskDashboardQueue {
	id: string;
	progress: string;
	tasks: Array<{ id: string; title: string; status: string; detail: string }>;
}

/** Project queue state into the read-only rows the dashboard renders. */
export function toDashboardQueue(active: ActiveQueue): TaskDashboardQueue {
	const current = currentItem(active);
	return {
		id: active.queue.queueId,
		progress: formatTaskCounts(taskCounts(active)),
		tasks: active.queue.tasks.map((task) => {
			const outcome = active.outcomes.get(task.id);
			const status =
				active.pendingCompaction?.taskId === task.id
					? "compacting"
					: (outcome?.status ?? (active.cancelled ? "cancelled" : task.id === current?.id ? "current" : "pending"));
			const detail =
				outcome === undefined
					? active.cancelled
						? `Cancellation reason\n${active.cancelled.reason}`
						: task.id === current?.id
							? "Current task. No outcome recorded yet."
							: "Waiting for earlier tasks."
					: [
							"Outcome",
							outcome.outcome,
							...(outcome.changedFiles.length ? ["", "Changed files", ...outcome.changedFiles] : []),
							...(outcome.addedTasks.length
								? ["", "Discovered tasks", ...outcome.addedTasks.map(formatAddedTask)]
								: []),
						].join("\n");
			return { ...task, status, detail };
		}),
	};
}

/** Read-only: navigation never changes queue state or sends model messages. */
export class TaskDashboard {
	private queueId: string | undefined;
	private taskId: string | undefined;
	private scroll = 0;
	private maxScroll = 0;
	private viewport = 1;

	private readonly readQueues: () => TaskDashboardQueue[];
	private readonly theme: Pick<Theme, "fg" | "bold">;
	private readonly rows: () => number;
	private readonly requestRender: () => void;
	private readonly close: () => void;

	constructor(
		readQueues: () => TaskDashboardQueue[],
		theme: Pick<Theme, "fg" | "bold">,
		rows: () => number,
		requestRender: () => void,
		close: () => void,
	) {
		this.readQueues = readQueues;
		this.theme = theme;
		this.rows = rows;
		this.requestRender = requestRender;
		this.close = close;
	}

	private selection() {
		const queues = this.readQueues();
		const queue = queues.find((item) => item.id === this.queueId) ?? queues.at(-1);
		if (queue?.id !== this.queueId) {
			this.queueId = queue?.id;
			this.taskId = undefined;
			this.scroll = 0;
		}
		const task =
			queue?.tasks.find((item) => item.id === this.taskId) ??
			queue?.tasks.find((item) => item.status === "current" || item.status === "compacting") ??
			queue?.tasks[0];
		this.taskId = task?.id;
		return { queues, queue, task };
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) return this.close();
		const { queues, queue, task } = this.selection();
		if (!queue || !task) return;
		if (matchesKey(data, "left") || matchesKey(data, "right")) {
			const direction = matchesKey(data, "left") ? -1 : 1;
			const index = Math.max(0, Math.min(queues.length - 1, queues.indexOf(queue) + direction));
			this.queueId = queues[index]!.id;
			this.taskId = undefined;
			this.scroll = 0;
		} else if (matchesKey(data, "up") || matchesKey(data, "down")) {
			const direction = matchesKey(data, "up") ? -1 : 1;
			const index = Math.max(0, Math.min(queue.tasks.length - 1, queue.tasks.indexOf(task) + direction));
			this.taskId = queue.tasks[index]!.id;
			this.scroll = 0;
		} else if (data === "[" || data === "]" || matchesKey(data, "pageUp") || matchesKey(data, "pageDown")) {
			// Pi's fullscreen host consumes paging keys; brackets also work in inline panels.
			this.scroll = Math.max(
				0,
				Math.min(
					this.maxScroll,
					this.scroll + (data === "[" || matchesKey(data, "pageUp") ? -this.viewport : this.viewport),
				),
			);
		} else if (matchesKey(data, "home")) {
			this.scroll = 0;
		} else if (matchesKey(data, "end")) {
			this.scroll = this.maxScroll;
		} else return;
		this.requestRender();
	}

	invalidate(): void {}

	render(width: number): string[] {
		const { queues, queue, task } = this.selection();
		const maxHeight = Math.max(1, this.rows());
		const footer =
			width < 65
				? ["Esc close · ↑↓ tasks", "←→ queues · [ ] scroll"]
				: ["↑↓ tasks · ←→ queues · [ ] scroll outcome · Esc close"];
		const fixedLines = 6 + footer.length;
		// Measure all queues, not the selection, so browsing cannot resize the panel.
		const maxTasks = Math.max(0, ...queues.map((item) => item.tasks.length));
		const listHeight = Math.max(1, Math.min(maxTasks, 6, Math.floor((maxHeight - fixedLines) / 3)));
		const details = new Map(
			queues.flatMap((item) =>
				item.tasks.map(
					(entry) => [entry, wrapTextWithAnsi(sanitizeTerminalBlock(entry.detail), Math.max(1, width))] as const,
				),
			),
		);
		const longestOutcome = Math.max(1, ...Array.from(details.values(), (lines) => lines.length));
		const height = Math.min(maxHeight, task === undefined ? 3 : listHeight + fixedLines + longestOutcome);
		const fit = (lines: string[]) =>
			Array.from({ length: height }, (_, index) => truncateToWidth(lines[index] ?? "", width));
		const accent = (text: string) => this.theme.fg("accent", text);
		const dim = (text: string) => this.theme.fg("dim", text);
		if (!queue || !task)
			return fit([
				accent("Tasks"),
				"No task queues on this branch.",
				...Array(Math.max(0, height - 3)).fill(""),
				dim("Esc close"),
			]);
		const selected = queue.tasks.indexOf(task);
		const start = Math.max(0, Math.min(selected - Math.floor(listHeight / 2), queue.tasks.length - listHeight));
		const lines = [
			accent(
				this.theme.bold(
					`─ Tasks${queues.length > 1 ? ` · Queue ${queues.indexOf(queue) + 1}/${queues.length}` : ""} ─`,
				),
			),
			sanitizeTerminalText(queue.progress),
			...Array.from({ length: listHeight }, (_, index) => {
				const item = queue.tasks[start + index];
				if (item === undefined) return "";
				const marker =
					item.status === "completed"
						? "✓"
						: item.status === "current"
							? "→"
							: item.status === "pending"
								? "·"
								: item.status === "compacting"
									? "⟳"
									: item.status === "cancelled"
										? "–"
										: "!";
				const label = `${item.id === task.id ? "›" : " "} ${marker} ${sanitizeTerminalText(item.title)}`;
				return item.id === task.id ? accent(label) : label;
			}),
			dim(`Tasks ${start + 1}–${Math.min(queue.tasks.length, start + listHeight)} of ${queue.tasks.length}`),
			dim("─".repeat(Math.max(0, width))),
			accent(this.theme.bold(`${task.status} · ${sanitizeTerminalText(task.title)}`)),
		];
		const detail = details.get(task)!;
		const available = Math.max(1, height - lines.length - 1 - footer.length);
		this.viewport = available;
		this.maxScroll = Math.max(0, detail.length - available);
		this.scroll = Math.min(this.scroll, this.maxScroll);
		lines.push(...Array.from({ length: available }, (_, index) => detail[this.scroll + index] ?? ""));
		lines.push(
			dim(
				this.maxScroll > 0
					? `${this.scroll + 1}–${Math.min(detail.length, this.scroll + available)} / ${detail.length} lines · ${this.scroll === this.maxScroll ? "end" : "more ↓"}`
					: "",
			),
		);
		lines.push(...footer.map(dim));
		return fit(lines);
	}
}

export async function showTaskDashboard(
	ctx: ExtensionCommandContext,
	readQueues: () => TaskDashboardQueue[],
	onRender: (refresh: (() => void) | undefined) => void,
): Promise<void> {
	try {
		await ctx.ui.custom<void>((tui, theme, _keys, done) => {
			onRender(() => tui.requestRender());
			return new TaskDashboard(
				readQueues,
				theme,
				() => Math.max(1, Math.floor(tui.terminal.rows * 0.65)),
				() => tui.requestRender(),
				() => done(),
			);
		});
	} finally {
		onRender(undefined);
	}
}
