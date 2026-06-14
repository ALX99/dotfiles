/**
 * Goals — autonomous supervisor for ad-hoc goals.
 *
 * Commands:
 *   /goal <text>      Start a goal; current session becomes the supervisor
 *   /goal-status      Show current goal's progress (tail of progress.md)
 *   /goal-cancel      Mark current goal as cancelled
 *   /goals            List all goals (past and current)
 *
 * Protocol:
 *   The supervisor protocol lives at ~/.pi/agent/supervisor.md.
 *   When /goal is invoked, the current session's model is told (via a directive
 *   message) to read the protocol and operate as supervisor. State is written
 *   to ~/.pi/agent/goals/<id>/ following the protocol's file conventions.
 *
 * Lifecycle:
 *   The active goal id is tracked in a closure variable. The footer status
 *   badge reflects it. A goal is "active" until final-report.md, stuck.md, or
 *   cancelled.md is written — the user can run /goal-cancel to mark one as
 *   cancelled explicitly, or the supervisor writes the other two itself.
 *
 * Non-goals (v1):
 *   - Spawning a fresh session via ctx.newSession (current session IS the supervisor)
 *   - Auto-detecting goal completion (supervisor reports via final-report.md; user checks /goal-status)
 *   - Backgrounded / detached supervisor runs
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const GOALS_DIR = path.join(homedir(), ".pi/agent/goals");

function shortId(): string {
	return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

async function ensureGoalsDir(): Promise<void> {
	await fs.mkdir(GOALS_DIR, { recursive: true });
}

async function fileExists(file: string): Promise<boolean> {
	try {
		await fs.access(file);
		return true;
	} catch {
		return false;
	}
}

async function readFirstLine(file: string): Promise<string> {
	try {
		const content = await fs.readFile(file, "utf-8");
		const first = content.split("\n").find((line) => line.trim().length > 0) ?? "";
		return first.replace(/^#+\s*/, "").trim();
	} catch {
		return "(not yet written)";
	}
}

async function readTail(file: string, lines: number): Promise<string> {
	try {
		const content = await fs.readFile(file, "utf-8");
		return content.split("\n").slice(-lines).join("\n");
	} catch {
		return "(not yet written)";
	}
}

type GoalStatus = "running" | "completed" | "stuck" | "cancelled";

async function goalStatus(id: string): Promise<GoalStatus> {
	const dir = path.join(GOALS_DIR, id);
	if (await fileExists(path.join(dir, "cancelled.md"))) return "cancelled";
	if (await fileExists(path.join(dir, "final-report.md"))) return "completed";
	if (await fileExists(path.join(dir, "stuck.md"))) return "stuck";
	return "running";
}

export default function(pi: ExtensionAPI) {
	let activeGoalId: string | undefined;

	function setStatus(ctx: ExtensionContext): void {
		if (activeGoalId) {
			ctx.ui.setStatus("goal", ctx.ui.theme.fg("warning", `goal:${activeGoalId}`));
		} else {
			ctx.ui.setStatus("goal", undefined);
		}
	}

	pi.on("session_start", (_event, ctx) => {
		setStatus(ctx);
	});

	pi.registerCommand("goal", {
		description: "Start an autonomous goal: current session becomes the supervisor with no budget caps",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();

			let text = args.trim();
			if (!text && ctx.hasUI) {
				const input = await ctx.ui.input("What is the goal?", "Describe the goal for the supervisor...");
				text = input?.trim() ?? "";
			}
			if (!text) {
				ctx.ui.notify("Usage: /goal <text>", "error");
				return;
			}

			await ensureGoalsDir();
			const id = shortId();
			const dir = path.join(GOALS_DIR, id);
			await fs.mkdir(dir, { recursive: true });
			await fs.writeFile(
				path.join(dir, "goal.md"),
				`# Goal\n\n${text}\n\n## Restated\n\n(Supervisor will restate this in concrete terms here.)\n`,
				"utf-8",
			);

			activeGoalId = id;
			setStatus(ctx);
			ctx.ui.notify(`Goal ${id} started. State at ~/.pi/agent/goals/${id}/`, "info");

			const directive = `You are now the supervisor for a new goal.

Goal: ${text}

Goal state directory: ~/.pi/agent/goals/${id}/

Required first actions:
1. Read ~/.pi/agent/supervisor.md — the supervisor protocol (read fully).
2. Read ~/.pi/agent/goals/${id}/goal.md and restate the goal concretely.
3. Ask 2-4 clarifying questions via ctx.ui.ask before dispatching anything; write answers to clarifications.md.

Then operate per the protocol: plan → dispatch via the subagent tool (scout/worker/reviewer) → verify gates yourself → iterate. No budget caps. Mark each item resolved or stuck; do not stop early. When complete, write final-report.md to the goal state directory and give me a one-paragraph summary.`;

			pi.sendUserMessage(directive);
		},
	});

	pi.registerCommand("goal-status", {
		description: "Show the current goal's status and latest progress entries",
		handler: async (_args, ctx) => {
			if (!activeGoalId) {
				ctx.ui.notify("No active goal. Use /goal <text> to start one.", "warning");
				return;
			}
			const dir = path.join(GOALS_DIR, activeGoalId);
			const status = await goalStatus(activeGoalId);
			const goal = await readFirstLine(path.join(dir, "goal.md"));
			const progress = await readTail(path.join(dir, "progress.md"), 12);

			const output = `Goal ${activeGoalId} — ${status}\n${goal}\n\n--- latest progress ---\n${progress}`;
			ctx.ui.notify(output, "info");
		},
	});

	pi.registerCommand("goal-cancel", {
		description: "Mark the current goal as cancelled (writes cancelled.md; does not delete state)",
		handler: async (_args, ctx) => {
			if (!activeGoalId) {
				ctx.ui.notify("No active goal to cancel.", "warning");
				return;
			}
			const id = activeGoalId;
			const dir = path.join(GOALS_DIR, id);
			await fs.writeFile(
				path.join(dir, "cancelled.md"),
				`# Cancelled at ${new Date().toISOString()}\n`,
				"utf-8",
			);
			activeGoalId = undefined;
			setStatus(ctx);
			ctx.ui.notify(`Goal ${id} marked as cancelled.`, "info");
		},
	});

	pi.registerCommand("goals", {
		description: "List all goals with status (most recent first)",
		handler: async (_args, ctx) => {
			await ensureGoalsDir();
			const entries = await fs.readdir(GOALS_DIR, { withFileTypes: true });
			const dirs = entries.filter((e) => e.isDirectory());
			if (dirs.length === 0) {
				ctx.ui.notify("No goals yet. Use /goal <text> to start one.", "info");
				return;
			}

			const lines: string[] = [];
			const sorted = await Promise.all(
				dirs.map(async (entry) => {
					const stat = await fs.stat(path.join(GOALS_DIR, entry.name));
					return { entry, mtime: stat.mtimeMs };
				}),
			);
			sorted.sort((a, b) => b.mtime - a.mtime);

			for (const { entry } of sorted) {
				const id = entry.name;
				const dir = path.join(GOALS_DIR, id);
				const stat = await fs.stat(dir);
				const goal = await readFirstLine(path.join(dir, "goal.md"));
				const status = await goalStatus(id);
				const active = id === activeGoalId ? " (active)" : "";
				const date = stat.mtime.toISOString().slice(0, 10);
				lines.push(`${date}  ${status.padEnd(10)}  ${id}${active}  — ${goal.slice(0, 60)}`);
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
