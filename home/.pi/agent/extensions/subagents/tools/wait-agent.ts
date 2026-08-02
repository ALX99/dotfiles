import { defineTool, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
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
import {
	AgentWaitDeferredReason,
	AgentWaitInterruptedError,
	AgentWaitTimeoutReason,
	type AgentSummary,
} from "../agent-types.ts";
import type { ReadonlyRunDetails, RunUsage } from "../run-state.ts";
import { sumRunUsage, toPiUsage } from "../run-state.ts";
import type { WaitAgentParams } from "../schemas.ts";
import { activateForSubagentState } from "../tool-activation.ts";

export const DEFAULT_WAIT_MS = 15 * 60 * 1_000;

interface WaitExecutionRuntime {
	readonly registry: {
		readonly wait: (id: string, timeoutMs?: number, signal?: AbortSignal) => Promise<ReadonlyRunDetails>;
		readonly summary: (id: string) => AgentSummary;
	};
	readonly consumeSettledCompletions: (summaries: readonly AgentSummary[]) => void;
}

export function createWaitAgentTool(
	pi: ExtensionAPI,
	runtime: SubagentRuntime,
	now: () => number = Date.now,
): ToolDefinition<typeof WaitAgentParamsSchema, WaitDetails> {
	return defineTool<typeof WaitAgentParamsSchema, WaitDetails>({
		name: "wait_agent",
		label: "Wait Agent",
		description:
			"Wait as one multi-agent barrier for specified subagents to settle or request input. A matching queued completion is consumed exactly once.",
		parameters: WaitAgentParamsSchema,
		async execute(_id, params, signal) {
			const result = await executeWaitAgent(params, runtime, signal, now);
			const accountedGenerations: Array<{ agentId: string; generation: number }> = [];
			const usages: Readonly<RunUsage>[] = [];
			for (const summary of result.details.summaries) {
				activateForSubagentState(pi, summary, false);
				const usage = runtime.claimUsage(summary);
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
			return renderWaitCall(
				uniqueAgentIds(args.agent_ids),
				args.timeout_ms ?? DEFAULT_WAIT_MS,
				runtime.registry.list(),
				theme,
			);
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
	const timeoutMs = params.timeout_ms ?? DEFAULT_WAIT_MS;
	// Resolve every ID before starting a potentially long wait. `wait()` is
	// asynchronous, so an unknown ID would otherwise be hidden by
	// Promise.allSettled until the valid agents have finished.
	for (const id of requested) runtime.registry.summary(id);
	const startTime = now();
	const wave = new AbortController();
	const deadline = new AbortController();
	const deadlineTimer = setTimeout(() => deadline.abort(new AgentWaitTimeoutReason()), timeoutMs);
	const waitSignal = AbortSignal.any([wave.signal, deadline.signal, ...(signal ? [signal] : [])]);
	const waits = Promise.allSettled(
		requested.map(async (id) => {
			// The wave owns one absolute deadline. This prevents the timeout
			// from being restarted or measured independently for each child.
			const details = await runtime.registry.wait(id, timeoutMs, waitSignal);
			if (details.pendingQuestion && !wave.signal.aborted) {
				wave.abort(new AgentWaitDeferredReason());
			}
			return details;
		}),
	);
	try {
		await waitForSettlementsOrAbort(waits, signal);
		signal?.throwIfAborted();
		const summaries = requested.map((id) => runtime.registry.summary(id));
		const outcomes = (await waits).map((outcome, index) => waitOutcome(requested[index]!, outcome));
		runtime.consumeSettledCompletions(summaries);
		const details = waitDetails(summaries, Math.max(0, now() - startTime), timeoutMs, outcomes);
		return jsonResult({ summaries, outcomes }, details);
	} finally {
		clearTimeout(deadlineTimer);
	}
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
	if (outcome.status === "fulfilled") {
		return { agent_id: id, status: outcome.value.pendingQuestion ? "waiting_input" : "settled" };
	}
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
