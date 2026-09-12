import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { runPromise } from "../../_shared/effect-runtime.ts";
import type { AgentRegistry, ResolvedAgentTarget } from "../agent-registry.ts";
import { renderWaitCall } from "../render.ts";
import { renderWaitToolResult } from "../ui/result-renderers.ts";
import { uniqueAgentTargets, WaitAgentsParamsSchema } from "../schemas.ts";
import {
	jsonResult,
	waitDetails,
	type WaitDetails,
	type WaitOutcome,
	type WaitOutcomeStatus,
} from "../tool-results.ts";
import {
	AgentWaitDeferredReason,
	AgentWaitInterruptedError,
	futureGenerationError,
	isAgentActive,
	type AgentSummary,
} from "../agent-types.ts";
import type { RunUsage } from "../run-state.ts";
import { sumRunUsage, toPiUsage } from "../run-state.ts";
import type { WaitAgentsParams } from "../schemas.ts";
import type { SubagentToolActivator } from "../tool-activation.ts";

interface WaitExecutionRuntime {
	readonly registry: {
		readonly resolveGeneration: (target: string, generation?: number) => ResolvedAgentTarget;
		readonly wait: AgentRegistry["wait"];
		readonly summary: (id: string) => AgentSummary;
	};
}

interface WaitAgentsDependencies extends WaitExecutionRuntime {
	readonly registry: WaitExecutionRuntime["registry"] & {
		readonly list: () => AgentSummary[];
	};
	readonly claimUsage: (summary: AgentSummary) => Readonly<RunUsage> | undefined;
}

export function createWaitAgentsTool(
	toolActivation: SubagentToolActivator,
	dependencies: WaitAgentsDependencies,
	now: () => number = Date.now,
): ToolDefinition<typeof WaitAgentsParamsSchema, WaitDetails> {
	return defineTool<typeof WaitAgentsParamsSchema, WaitDetails>({
		name: "wait_agents",
		label: "Wait Agents",
		description:
			"Wait as one multi-agent barrier for explicit targets until each settles or requests input. Generations default to latest; already-settled generations return immediately. Waiting observes completion repeatably and never consumes it.",
		parameters: WaitAgentsParamsSchema,
		async execute(_id, params, signal) {
			const result = await executeWaitAgents(params, dependencies, signal, now);
			const accountedGenerations: Array<{ agentId: string; generation: number }> = [];
			const usages: Readonly<RunUsage>[] = [];
			for (const outcome of result.details.outcomes) {
				const summary = result.details.summaries.find(
					(candidate) => candidate.agent_id === outcome.agent_id && candidate.generation === outcome.generation,
				);
				if (summary) toolActivation.activateForState(summary);
				if (outcome.status !== "settled" || !summary) continue;
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
			return renderWaitCall(uniqueAgentTargets(args.targets), dependencies.registry.list(), theme);
		},
		renderResult(result, options, theme) {
			return renderWaitToolResult(result, options, theme);
		},
	});
}

export async function executeWaitAgents(
	params: WaitAgentsParams,
	runtime: WaitExecutionRuntime,
	signal: AbortSignal | undefined,
	now: () => number = Date.now,
) {
	const requested = uniqueAgentTargets(params.targets);
	const startTime = now();
	// Resolve first, then dedupe by canonical agent:generation key, so one
	// map plus one order list replaces parallel pending/plan bookkeeping.
	const entries = new Map<
		string,
		{
			agent_id: string;
			generation: number;
			summary?: AgentSummary;
			error?: string;
			outcome?: WaitOutcome;
		}
	>();
	const order: string[] = [];
	const pending: Array<{ key: string; agent_id: string; generation: number }> = [];
	let hasPendingQuestion = false;
	for (const target of requested) {
		let key: string;
		try {
			const resolved = runtime.registry.resolveGeneration(target.target, target.generation);
			key = `${resolved.agent_id}:${resolved.generation}`;
			if (!entries.has(key)) {
				order.push(key);
				entries.set(key, {
					agent_id: resolved.agent_id,
					generation: resolved.generation,
					summary: resolved.summary,
				});
			}
		} catch (error) {
			const address = target.target.trim();
			key = `unknown:${address}:${target.generation ?? 0}`;
			if (!entries.has(key)) {
				order.push(key);
				entries.set(key, {
					agent_id: address,
					generation: target.generation ?? 0,
					error: errorMessage(error),
				});
			}
		}
	}
	for (const key of order) {
		const entry = entries.get(key)!;
		if (!entry.summary) {
			entry.outcome = waitOutcome(entry.agent_id, entry.generation, "failed", entry.error);
			continue;
		}
		if (entry.generation > entry.summary.generation) {
			entry.outcome = {
				agent_id: entry.agent_id,
				generation: entry.generation,
				status: "failed",
				error: futureGenerationError(entry.summary, entry.generation).message,
			};
		} else if (entry.generation < entry.summary.generation) {
			entry.outcome = waitOutcome(entry.agent_id, entry.generation, "settled");
		} else if (entry.summary.pending_question) {
			entry.outcome = waitOutcome(entry.agent_id, entry.generation, "waiting_input");
			hasPendingQuestion = true;
		} else if (isAgentActive(entry.summary.status)) {
			pending.push({ key, agent_id: entry.agent_id, generation: entry.generation });
		} else {
			entry.outcome = waitOutcome(entry.agent_id, entry.generation, "settled");
		}
	}
	// A barrier is already satisfied once any target needs input. Do not begin
	// waits for other running children only to cancel them immediately.
	if (hasPendingQuestion) {
		for (const target of pending) {
			entries.get(target.key)!.outcome = waitOutcome(target.agent_id, target.generation, "cancelled");
		}
		return waitResult(entries, order, startTime, now);
	}

	const wave = new AbortController();
	const waitSignal = signal ? AbortSignal.any([wave.signal, signal]) : wave.signal;
	const waits = Promise.allSettled(
		pending.map(async (target) => {
			const details = await runPromise(runtime.registry.wait(target.agent_id, waitSignal));
			if (details.pendingQuestion && !wave.signal.aborted) {
				wave.abort(new AgentWaitDeferredReason());
			}
			return { target, details };
		}),
	);
	const settled = await waits;
	signal?.throwIfAborted();

	pending.forEach((target, index) => {
		const result = settled[index]!;
		if (result.status === "fulfilled") {
			const summary = runtime.registry.summary(target.agent_id);
			const entry = entries.get(target.key)!;
			entry.summary = summary;
			if (summary.generation !== target.generation) {
				entry.outcome = waitOutcome(target.agent_id, target.generation, "settled");
			} else if (result.value.details.pendingQuestion ?? summary.pending_question) {
				entry.outcome = waitOutcome(target.agent_id, target.generation, "waiting_input");
			} else {
				entry.outcome = waitOutcome(target.agent_id, target.generation, "settled");
			}
		} else {
			const summary = trySummary(runtime, target.agent_id);
			const entry = entries.get(target.key)!;
			if (summary) entry.summary = summary;
			const cancelled = result.reason instanceof AgentWaitInterruptedError;
			entry.outcome = waitOutcome(
				target.agent_id,
				target.generation,
				cancelled ? "cancelled" : "failed",
				cancelled ? undefined : errorMessage(result.reason),
			);
		}
	});
	return waitResult(entries, order, startTime, now);
}

function waitResult(
	entries: ReadonlyMap<string, { readonly summary?: AgentSummary; readonly outcome?: WaitOutcome }>,
	order: readonly string[],
	startTime: number,
	now: () => number,
) {
	const summaries: AgentSummary[] = [];
	const outcomes: WaitOutcome[] = [];
	for (const key of order) {
		const entry = entries.get(key)!;
		if (entry.summary) summaries.push(entry.summary);
		outcomes.push(entry.outcome!);
	}
	return jsonResult({ summaries, outcomes }, waitDetails(summaries, Math.max(0, now() - startTime), outcomes));
}

function waitOutcome(agent_id: string, generation: number, status: WaitOutcomeStatus, error?: string): WaitOutcome {
	return { agent_id, generation, status, ...(error === undefined ? {} : { error }) };
}

function trySummary(runtime: WaitExecutionRuntime, id: string): AgentSummary | undefined {
	try {
		return runtime.registry.summary(id);
	} catch {
		return undefined;
	}
}

function errorMessage(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}
