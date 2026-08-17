import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentSummary } from "./agent-types.ts";
import { isTruncatedResultPreview } from "./result-store.ts";

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
const RUNNING_AGENT_TOOLS = ["wait_agent", "list_agents", "interrupt_agent", "close_agent", "send_agent"];
const WAITING_INPUT_TOOLS = ["answer_agent", "wait_agent", "list_agents", "interrupt_agent", "close_agent"];
const RETAINED_SETTLED_TOOLS = ["followup_agent", "list_agents", "close_agent"];
const READ_RESULT_TOOL = ["read_agent_result"];
const SUBAGENT_TOOL_SET = new Set<string>(SUBAGENT_TOOL_NAMES);
type ToolActivationAPI = Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">;
type ToolRegistryAPI = Pick<ExtensionAPI, "getAllTools">;

export interface SubagentToolActivator {
	activate(names: readonly string[]): readonly string[];
	/** Expose only controls valid for the supplied lifecycle snapshot. */
	activateForState(summary: AgentSummary, background: boolean): readonly string[];
}

/** Own whether subagent tools may be exposed and gate every deferred activation. */
export class SubagentToolController implements SubagentToolActivator {
	private enabledState = true;
	private readonly pi: ToolActivationAPI;

	constructor(pi: ToolActivationAPI) {
		this.pi = pi;
	}

	get enabled(): boolean {
		return this.enabledState;
	}

	toggle(): boolean {
		this.enabledState = !this.enabledState;
		this.reset();
		return this.enabledState;
	}

	reset(): void {
		if (this.enabledState) resetSubagentTools(this.pi);
		else deactivateSubagentTools(this.pi);
	}

	activate(names: readonly string[]): readonly string[] {
		return this.enabledState ? activateSubagentTools(this.pi, names) : [];
	}

	activateForState(summary: AgentSummary, background: boolean): readonly string[] {
		return this.enabledState ? activateForSubagentState(this.pi, summary, background) : [];
	}
}

/** Deferred tools must survive the host's tool allowlist to be activated later. */
export function missingSubagentTools(pi: ToolRegistryAPI): readonly string[] {
	const available = new Set(pi.getAllTools().map((tool) => tool.name));
	return SUBAGENT_TOOL_NAMES.filter((name) => !available.has(name));
}

/** Start each session with the loader tool only, without disturbing other extensions. */
export function resetSubagentTools(pi: ToolActivationAPI): void {
	const active = pi.getActiveTools();
	const next = [...new Set([...active.filter((name) => !SUBAGENT_TOOL_SET.has(name)), SPAWN_AGENT])];
	if (!sameToolNames(active, next)) pi.setActiveTools(next);
}

/** Hide every subagent tool without disturbing tools owned by the host or other extensions. */
export function deactivateSubagentTools(pi: ToolActivationAPI): void {
	const active = pi.getActiveTools();
	const next = active.filter((name) => !SUBAGENT_TOOL_SET.has(name));
	if (next.length !== active.length) pi.setActiveTools(next);
}

/** Add tools only: this is Pi's signal for native deferred tool loading. */
export function activateSubagentTools(pi: ToolActivationAPI, names: readonly string[]): readonly string[] {
	const active = pi.getActiveTools();
	const added = [...new Set(names)].filter((name) => SUBAGENT_TOOL_SET.has(name) && !active.includes(name));
	if (added.length) pi.setActiveTools([...active, ...added]);
	return added;
}

/** Activate controls made useful by a completed spawn or follow-up. */
/** Lifecycle state is authoritative; the legacy background argument preserves existing callers. */
export function activateForSubagentState(
	pi: ToolActivationAPI,
	summary: AgentSummary,
	_background: boolean,
): readonly string[] {
	const names: string[] = [];
	if (summary.pending_question) names.push(...WAITING_INPUT_TOOLS);
	else if (summary.status === "starting" || summary.status === "running") names.push(...RUNNING_AGENT_TOOLS);
	else if (summary.retained && summary.status !== "closed") names.push(...RETAINED_SETTLED_TOOLS);
	if (requiresExactResultRead(summary)) names.push(...READ_RESULT_TOOL);
	return activateSubagentTools(pi, names);
}

/** The delivered terminal result is incomplete and must be reconstructed from storage. */
function sameToolNames(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((name, index) => name === right[index]);
}

export function requiresExactResultRead(summary: AgentSummary, maximumDisplayedBytes?: number): boolean {
	if (summary.result === undefined) return false;
	const text = summary.final_text ?? "";
	return (
		isTruncatedResultPreview(text) ||
		(maximumDisplayedBytes !== undefined && Buffer.byteLength(text, "utf8") > maximumDisplayedBytes)
	);
}
