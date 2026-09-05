import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { renderWaitCall } from "../render.ts";
import { uniqueAgentIds, WaitAgentParamsSchema } from "../schemas.ts";
import { jsonResult, waitDetails, type WaitDetails, type WaitOutcome } from "../tool-results.ts";
import { renderWaitToolResult } from "../ui/result-renderers.ts";
import {
	AgentWaitDeferredReason,
	AgentWaitInterruptedError,
	isAgentActive,
	type AgentSummary,
} from "../agent-types.ts";
import type { ReadonlyRunDetails, RunUsage } from "../run-state.ts";
import { sumRunUsage, toPiUsage } from "../run-state.ts";
import type { WaitAgentParams } from "../schemas.ts";
import type { SubagentToolActivator } from "../tool-activation.ts";

interface WaitExecutionRuntime {
	readonly registry: {
		readonly wait: (id: string, signal?: AbortSignal) => Promise<ReadonlyRunDetails>;
		readonly summary: (id: string) => AgentSummary;
	};
	readonly consumeSettledCompletions: (summaries: readonly AgentSummary[]) => void;
}

interface WaitAgentDependencies extends WaitExecutionRuntime {
	readonly registry: WaitExecutionRuntime["registry"] & {
		readonly list: () => AgentSummary[];
	};
	readonly claimUsage: (summary: AgentSummary) => Readonly<RunUsage> | undefined;
}

export function createWaitAgentTool(
	toolActivation: SubagentToolActivator,
	dependencies: WaitAgentDependencies,
	now: () => number = Date.now,
): ToolDefinition<typeof WaitAgentParamsSchema, WaitDetails> {
	return defineTool<typeof WaitAgentParamsSchema, WaitDetails>({
		name: "wait_agent",
		label: "Wait Agent",
		description:
			"Wait until any specified subagent settles or requests input. Other children keep running. Use the returned remaining_agent_ids for the next wait; answer pending questions first.",
		parameters: WaitAgentParamsSchema,
		async execute(_id, params, signal) {
			const result = await executeWaitAgent(params, dependencies, signal, now);
			const accountedGenerations: Array<{ agentId: string; generation: number }> = [];
			const usages: Readonly<RunUsage>[] = [];
			for (const summary of result.details.summaries) {
				toolActivation.activateForState(summary, false);
				const usage = dependencies.claimUsage(summary);
				if (!usage) continue;
				usages.push(usage);
				accountedGenerations.push({ agentId: summary.agent_id, generation: summary.generation });
			}
			if (usages.length === 0) return result;
			return {
				...result,
				details: { ...result.details, accountedGenerations },
				usage: toPiUsage(sumRunUsage(usages)),
			};
		},
		renderCall(args, theme) {
			return renderWaitCall(uniqueAgentIds(args.agent_ids), dependencies.registry.list(), theme);
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
	const wave = new AbortController();
	const waitSignal = signal ? AbortSignal.any([wave.signal, signal]) : wave.signal;
	const waits = Promise.allSettled(
		requested
			.map(async (id) => {
				const details = await runtime.registry.wait(id, waitSignal);
				if (!wave.signal.aborted) {
					wave.abort(new AgentWaitDeferredReason());
				}
				return details;
			})
			.map((wait) =>
				wait.catch((error) => {
					if (!wave.signal.aborted) wave.abort(new AgentWaitDeferredReason());
					throw error;
				}),
			),
	);
	// Children reject promptly through the shared signal, so caller cancellation
	// surfaces here as a throw while wave release surfaces as cancelled outcomes.
	const settled = await waits;
	signal?.throwIfAborted();
	const summaries = requested.map((id) => runtime.registry.summary(id));
	const outcomes = settled.map((outcome, index) => waitOutcome(requested[index]!, outcome));
	runtime.consumeSettledCompletions(summaries);
	const remaining = summaries.filter((summary) => isAgentActive(summary.status)).map((summary) => summary.agent_id);
	return jsonResult(
		{
			remaining_agent_ids: remaining,
			guidance: remaining.length
				? "Other agents still need attention. Answer pending questions, continue non-overlapping work, or wait_agent with remaining_agent_ids. Collect required results before finishing."
				: "All requested agents have settled.",
			summaries,
			outcomes,
		},
		waitDetails(summaries, Math.max(0, now() - startTime), outcomes),
	);
}

function waitOutcome(id: string, outcome: PromiseSettledResult<ReadonlyRunDetails>): WaitOutcome {
	if (outcome.status === "fulfilled") {
		return { agent_id: id, status: outcome.value.pendingQuestion ? "waiting_input" : "settled" };
	}
	const cancelled = outcome.reason instanceof AgentWaitInterruptedError;
	return {
		agent_id: id,
		status: cancelled ? "running" : "failed",
		...(cancelled ? {} : { error: errorMessage(outcome.reason) }),
	};
}

function errorMessage(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}
