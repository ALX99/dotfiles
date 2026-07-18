import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { SubagentRuntime } from "../bootstrap.ts";
import { renderWaitCall } from "../render.ts";
import { uniqueAgentIds, WaitAgentParamsSchema } from "../schemas.ts";
import { jsonResult, waitDetails, type WaitDetails } from "../tool-results.ts";
import { renderWaitToolResult } from "../ui/result-renderers.ts";
import type { AgentSummary } from "../agent-types.ts";
import type { ReadonlyRunDetails } from "../run-state.ts";
import type { WaitAgentParams } from "../schemas.ts";

export const DEFAULT_WAIT_MS = 15 * 60 * 1_000;

interface WaitExecutionRuntime {
	readonly registry: {
		readonly wait: (id: string, timeoutMs?: number, signal?: AbortSignal) => Promise<ReadonlyRunDetails>;
		readonly summary: (id: string) => AgentSummary;
	};
	readonly consumeSettledCompletions: (summaries: readonly AgentSummary[]) => void;
}

export function createWaitAgentTool(
	runtime: SubagentRuntime,
	now: () => number = Date.now,
): ToolDefinition<typeof WaitAgentParamsSchema, WaitDetails> {
	return defineTool<typeof WaitAgentParamsSchema, WaitDetails>({
		name: "wait_agent",
		label: "Wait Agent",
		description:
			"Wait up to fifteen minutes for specified subagents to settle. Settled results are consumed, preventing redundant automatic follow-up turns.",
		parameters: WaitAgentParamsSchema,
		async execute(_id, params, signal) {
			return executeWaitAgent(params, runtime, signal, now);
		},
		renderCall(args, theme) {
			return renderWaitCall(uniqueAgentIds(args.agent_ids), DEFAULT_WAIT_MS, runtime.registry.list(), theme);
		},
		renderResult(result, options, theme) {
			return renderWaitToolResult(result, options, theme);
		},
	});
}

export async function executeWaitAgent(
	params: WaitAgentParams,
	runtime: WaitExecutionRuntime,
	signal: AbortSignal | undefined,
	now: () => number = Date.now,
) {
	const requested = uniqueAgentIds(params.agent_ids);
	// Resolve every ID before starting a potentially long wait. `wait()` is
	// asynchronous, so an unknown ID would otherwise be hidden by
	// Promise.allSettled until the valid agents have finished.
	for (const id of requested) runtime.registry.summary(id);
	const startTime = now();
	await Promise.allSettled(requested.map((id) => runtime.registry.wait(id, DEFAULT_WAIT_MS, signal)));
	const summaries = requested.map((id) => runtime.registry.summary(id));
	runtime.consumeSettledCompletions(summaries);
	return jsonResult(summaries, waitDetails(summaries, now() - startTime, DEFAULT_WAIT_MS));
}
