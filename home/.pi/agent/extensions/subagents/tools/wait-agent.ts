import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { SubagentRuntime } from "../bootstrap.ts";
import { renderWaitCall } from "../render.ts";
import { uniqueAgentIds, WaitAgentParamsSchema } from "../schemas.ts";
import {
	jsonResult,
	waitDetails,
	type WaitDetails,
	type WaitOutcome,
	type WaitOutcomeStatus,
} from "../tool-results.ts";
import { renderWaitToolResult } from "../ui/result-renderers.ts";
import { AgentWaitInterruptedError, type AgentSummary } from "../agent-types.ts";
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
	const waits = Promise.allSettled(requested.map((id) => runtime.registry.wait(id, DEFAULT_WAIT_MS, signal)));
	await waitForSettlementsOrAbort(waits, signal);
	const summaries = requested.map((id) => runtime.registry.summary(id));
	const outcomes = (await waits).map((outcome, index) => waitOutcome(requested[index]!, outcome));
	runtime.consumeSettledCompletions(summaries);
	const details = waitDetails(summaries, now() - startTime, DEFAULT_WAIT_MS, outcomes);
	return jsonResult({ summaries, outcomes }, details);
}

async function waitForSettlementsOrAbort(
	waits: Promise<readonly PromiseSettledResult<ReadonlyRunDetails>[]>,
	signal: AbortSignal | undefined,
): Promise<void> {
	if (!signal) {
		await waits;
		return;
	}
	signal.throwIfAborted();
	let rejectAbort: ((reason: unknown) => void) | undefined;
	const onAbort = () => rejectAbort?.(signal.reason);
	const aborted = new Promise<never>((_resolve, reject) => {
		rejectAbort = reject;
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		await Promise.race([waits, aborted]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

function waitOutcome(id: string, outcome: PromiseSettledResult<ReadonlyRunDetails>): WaitOutcome {
	if (outcome.status === "fulfilled") return { agent_id: id, status: "settled" };
	const interruption = outcome.reason instanceof AgentWaitInterruptedError ? outcome.reason : undefined;
	const status: WaitOutcomeStatus = interruption?.kind ?? "failed";
	return {
		agent_id: id,
		status,
		...(interruption === undefined ? { error: errorMessage(outcome.reason) } : {}),
	};
}

function errorMessage(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}
