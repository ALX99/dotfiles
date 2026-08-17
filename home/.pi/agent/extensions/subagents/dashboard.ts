import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { toError } from "../_shared/errors.ts";
import { sanitizeTerminalText } from "../_shared/terminal-text.ts";
import type { AgentRegistry } from "./agent-registry.ts";
import { isAgentActive, type AgentSummary } from "./agent-types.ts";
import { isTruncatedResultPreview, validateChildSessionPath } from "./result-store.ts";

const BACK = "← Back";

/** A small sequence of native dialogs, rather than a second TUI framework. */
export async function showAgentDashboard(ctx: ExtensionCommandContext, registry: AgentRegistry): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify(agentCounts(registry.list()), "info");
		return;
	}
	while (true) {
		const views = registry.views();
		const selected = await ctx.ui.select("Subagents", [
			...views.map((view) => dashboardAgentLabel(view.summary)),
			BACK,
		]);
		if (!selected || selected === BACK) return;
		const id = selected.split(" · ", 1)[0];
		if (!id) continue;
		if (await showAgent(ctx, registry, id)) return;
	}
}

async function showAgent(ctx: ExtensionCommandContext, registry: AgentRegistry, id: string): Promise<boolean> {
	while (true) {
		const view = registry.view(id);
		const summary = view.summary;
		const actions = ["Inspect output", "Inspect transcript"];
		const active = isAgentActive(summary.status);
		if (active && !summary.pending_question) actions.push("Steer");
		if (active) actions.push("Interrupt");
		if (summary.retained && summary.status !== "closed" && !active) {
			actions.push("Follow up");
		}
		if (summary.status !== "closed") actions.push("Close");
		if (summary.session_file && !active) actions.push("Take over session");
		const action = await ctx.ui.select(
			`${dashboardAgentLabel(summary)}\n${sanitizeTerminalText(summary.model)} · generation ${summary.generation}`,
			[...actions, BACK],
		);
		if (!action || action === BACK) return false;
		try {
			switch (action) {
				case "Inspect output":
					await inspectOutput(ctx, registry, id);
					break;
				case "Inspect transcript":
					await inspectTranscript(ctx, registry, id);
					break;
				case "Steer": {
					const message = await ctx.ui.input("Steer subagent", "Message delivered at the next turn boundary");
					if (message?.trim()) await registry.getLive(id).steer(message.trim());
					break;
				}
				case "Follow up": {
					const message = await ctx.ui.input("Follow up", "New task for this subagent");
					if (message?.trim()) await registry.getLive(id).followUp(message.trim(), message.trim().slice(0, 60), true);
					break;
				}
				case "Interrupt":
					if (await ctx.ui.confirm("Interrupt subagent?", sanitizeTerminalText(summary.task_name || id)))
						await registry.getLive(id).interrupt();
					break;
				case "Close":
					if (
						await ctx.ui.confirm(
							"Close subagent?",
							`Close ${sanitizeTerminalText(summary.task_name || id)}. Its retained context will be lost.`,
						)
					)
						await registry.close(id);
					return false;
				case "Take over session":
					return takeOver(ctx, summary.session_file);
			}
		} catch (error) {
			ctx.ui.notify(sanitizeTerminalText(toError(error).message), "error");
		}
	}
}

async function inspectOutput(ctx: ExtensionCommandContext, registry: AgentRegistry, id: string): Promise<void> {
	const summary = registry.summary(id);
	let text = summary.final_text ?? "";
	if (!text || isTruncatedResultPreview(text)) {
		let cursor: string | undefined;
		text = "";
		do {
			const page = await registry.readResult(id, {
				generation: summary.generation,
				...(cursor ? { cursor } : {}),
			});
			text += page.text;
			cursor = page.next_cursor;
		} while (cursor);
	}
	await displayText(ctx, `${id} output`, text || "(no output)");
}

async function inspectTranscript(ctx: ExtensionCommandContext, registry: AgentRegistry, id: string): Promise<void> {
	const messages = await registry.readTranscript(id);
	const text = messages
		.map((message) => {
			const record = message as { role?: string; content?: Array<{ type?: string; text?: string }> };
			return `${record.role ?? "message"}: ${(record.content ?? []).flatMap((part) => (part.type === "text" ? [part.text ?? ""] : [])).join("\n")}`;
		})
		.join("\n\n");
	await displayText(ctx, `${id} transcript`, text || "(no transcript)");
}

async function displayText(ctx: ExtensionCommandContext, title: string, text: string): Promise<void> {
	const lines = sanitizeTerminalText(text).split("\n");
	for (let offset = 0; offset < lines.length; offset += 24) {
		const page = lines.slice(offset, offset + 24);
		const action = await ctx.ui.select(title, [...page, offset + 24 < lines.length ? "More…" : BACK]);
		if (action !== "More…") return;
	}
}

async function takeOver(ctx: ExtensionCommandContext, sessionFile: string | undefined): Promise<boolean> {
	if (!sessionFile) throw new Error("This subagent has no session file.");
	const file = await validateChildSessionPath(sessionFile);
	if (
		await ctx.ui.confirm(
			"Take over subagent session?",
			"This leaves the parent session and closes every retained subagent.",
		)
	) {
		return !(await ctx.switchSession(file)).cancelled;
	}
	return false;
}

function dashboardAgentLabel(summary: AgentSummary): string {
	return [summary.agent_id, summary.status, summary.task_name || "(no task)"].map(sanitizeTerminalText).join(" · ");
}

function agentCounts(summaries: readonly AgentSummary[]): string {
	const waitingForInput = summaries.filter((summary) => summary.pending_question).length;
	const running = summaries.filter((summary) => isAgentActive(summary.status) && !summary.pending_question).length;
	const settled = summaries.length - running - waitingForInput;
	return [
		...(running === 0 ? [] : [`${running} running`]),
		...(waitingForInput === 0 ? [] : [`${waitingForInput} awaiting input`]),
		`${settled} settled`,
	].join(" · ");
}
