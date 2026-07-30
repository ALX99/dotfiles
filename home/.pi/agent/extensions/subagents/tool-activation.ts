import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentSummary } from "./agent-types.ts";

export const SUBAGENT_TOOL_NAMES = [
	"spawn_agent",
	"answer_agent",
	"send_agent",
	"followup_agent",
	"wait_agent",
	"list_agents",
	"read_agent_result",
	"interrupt_agent",
	"close_agent",
] as const;

const SPAWN_AGENT = "spawn_agent";
const BACKGROUND_LIVE_TOOLS = ["wait_agent", "list_agents", "interrupt_agent", "close_agent", "send_agent"];
const RETAINED_CHILD_TOOLS = ["followup_agent", "send_agent", "list_agents", "interrupt_agent", "close_agent"];
const ANSWER_TOOL = ["answer_agent"];
const READ_RESULT_TOOL = ["read_agent_result"];
const SUBAGENT_TOOL_SET = new Set<string>(SUBAGENT_TOOL_NAMES);
const EXACT_RESULT_NOTICE = "Use read_agent_result with agent_id and generation";

type ToolActivationAPI = Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">;

/** Start each session with the loader tool only, without disturbing other extensions. */
export function resetSubagentTools(pi: ToolActivationAPI): void {
	const next = [...new Set([...pi.getActiveTools().filter((name) => !SUBAGENT_TOOL_SET.has(name)), SPAWN_AGENT])];
	pi.setActiveTools(next);
}

/** Add tools only: this is Pi's signal for native deferred tool loading. */
export function activateSubagentTools(pi: ToolActivationAPI, names: readonly string[]): readonly string[] {
	const active = pi.getActiveTools();
	const added = [...new Set(names)].filter((name) => !active.includes(name));
	if (added.length) pi.setActiveTools([...active, ...added]);
	return added;
}

/** Activate controls made useful by a completed spawn or follow-up. */
export function activateForSubagentState(
	pi: ToolActivationAPI,
	summary: AgentSummary,
	background: boolean,
): readonly string[] {
	const names: string[] = [];
	const live = summary.status !== "closed";
	if (background && live) names.push(...BACKGROUND_LIVE_TOOLS);
	if (summary.retained && live) names.push(...RETAINED_CHILD_TOOLS);
	if (summary.pending_question) names.push(...ANSWER_TOOL, ...BACKGROUND_LIVE_TOOLS);
	if (requiresExactResultRead(summary)) names.push(...READ_RESULT_TOOL);
	return activateSubagentTools(pi, names);
}

/** A complete short result is already in the parent context; clipped/checkpoint results are not. */
export function requiresExactResultRead(summary: AgentSummary): boolean {
	return (
		summary.result !== undefined &&
		(!summary.result.complete || summary.final_text?.includes(EXACT_RESULT_NOTICE) === true)
	);
}
