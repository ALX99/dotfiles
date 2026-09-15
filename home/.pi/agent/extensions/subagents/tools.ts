import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { Container } from "@earendil-works/pi-tui";
import { Deferred, Effect } from "effect";
import { Type } from "typebox";
import { runPromise } from "../_shared/effect-runtime.ts";
import { lstat } from "../_shared/fs.ts";
import { formatAgentList, resolveAgent, type AgentConfig } from "./agents.ts";
import type { AgentRegistry, LiveAgentTarget, ResolvedAgentTarget } from "./agent-registry.ts";
import {
	AgentWaitDeferredReason,
	AgentWaitInterruptedError,
	assertCurrentGeneration,
	futureGenerationError,
	isAgentActive,
	type AgentQuestion,
	type AgentSummary,
} from "./agent-types.ts";
import { ManagedAgent } from "./managed-agent.ts";
import { resolveRun, type ProfilesConfig } from "./profiles.ts";
import { RESULT_READ_DEFAULT_BYTES, type ResultPage } from "./result-store.ts";
import { sumRunUsage, toPiUsage, type ReadonlyRunDetails, type RunUsage } from "./run-state.ts";
import {
	AgentsStatusParamsSchema,
	AnswerAgentParamsSchema,
	CloseAgentParamsSchema,
	createSpawnAgentSchema,
	FollowupAgentParamsSchema,
	ReadAgentResultParamsSchema,
	SteerAgentParamsSchema,
	uniqueAgentTargets,
	WaitAgentsParamsSchema,
	preserveOptional,
	preserveRequired,
	type SpawnAgentSchemaOptions,
	type AnswerAgentParams,
	type AgentsStatusParams,
	type CloseAgentParams,
	type FollowupAgentParams,
	type ReadAgentResultParams,
	type SteerAgentParams,
	type WaitAgentsParams,
	trimRequired,
	trimOptional,
} from "./schemas.ts";
import {
	agentSummaryDetails,
	finishRunResult,
	jsonResult,
	textResult,
	toolError,
	waitDetails,
	type AgentSummaryDetails,
	type WaitDetails,
	type WaitOutcome,
	type WaitOutcomeStatus,
} from "./tool-results.ts";
import { renderCallHeader, renderManagementCall, renderWaitCall } from "./render.ts";
import { renderRunToolResult, renderSummaryToolResult, renderWaitToolResult } from "./ui/result-renderers.ts";
import type { SubagentToolActivator } from "./tool-activation.ts";
import type { SpawnAdmissionController } from "./spawn-admission.ts";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export interface SpawnAgentDependencies {
	readonly agents: AgentConfig[];
	readonly profiles: ProfilesConfig;
	readonly agentDir: string;
	readonly admission: Pick<SpawnAdmissionController, "admit">;
	readonly registry: Pick<AgentRegistry, "add" | "claimTaskName">;
	readonly ticks: Map<string, NodeJS.Timeout>;
	readonly onBackgroundComplete: (summary: AgentSummary) => void;
	readonly onQuestion: (summary: AgentSummary, question: AgentQuestion) => void;
	readonly claimUsage: (summary: AgentSummary) => Readonly<RunUsage> | undefined;
}

export function createSpawnAgentTool(
	toolActivation: SubagentToolActivator,
	dependencies: SpawnAgentDependencies,
): ToolDefinition<ReturnType<typeof createSpawnAgentSchema>, ReadonlyRunDetails> {
	const schemaOptions = spawnSchemaOptions(dependencies);
	const schema = createSpawnAgentSchema(schemaOptions);
	return defineTool<typeof schema, ReadonlyRunDetails>({
		name: "spawn_agent",
		label: "Spawn Agent",
		description: "Run a subagent on a self-contained task. One-shot by default; retain it to reuse its context later.",
		parameters: schema,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const message = preserveRequired(params.message, "message");
			const defaultAgent = dependencies.agents[0];
			if (!defaultAgent) throw new Error("No subagent roles are configured.");
			const requestedAgent = trimOptional(params.agent) ?? defaultAgent.name;
			const agentConfig = resolveAgent(dependencies.agents, requestedAgent);
			if (!agentConfig) {
				throw new Error(`Unknown agent '${requestedAgent}'. Available: ${formatAgentList(dependencies.agents)}.`);
			}
			const profile = trimOptional(params.profile);
			const cwd = trimOptional(params.cwd);
			const resolvedCwd = cwd === undefined ? undefined : path.resolve(ctx.cwd, cwd);
			// Resolution failures carry the user-facing reason in their message, so a
			// rejected spawn reads the same as any other tool error.
			const resolvedRun = await runPromise(
				resolveRun({
					config: dependencies.profiles,
					modelRegistry: ctx.modelRegistry,
					scopedModels: ctx.scopedModels,
					agent: agentConfig,
					...(profile === undefined ? {} : { profile }),
					...(params.thinking === undefined ? {} : { requestedThinking: params.thinking }),
				}),
			);
			if (resolvedCwd !== undefined) {
				const target = resolvedCwd;
				const status = await runPromise(
					Effect.gen(function* () {
						return yield* lstat(target);
					}),
				);
				if (!status.isDirectory) throw new Error(`cwd is not a directory: ${cwd}`);
			}
			// Keep this adjacent to registry.add below: the capacity check reads the registry
			// snapshot, so any suspension between the two would let concurrent spawns overfill it.
			dependencies.admission.admit();
			const background = params.background === true;
			const taskName = dependencies.registry.claimTaskName(trimOptional(params.task_name), message);
			let managed: ManagedAgent | undefined;
			let unsubscribe: (() => void) | undefined;
			const cleanupUpdate = () => {
				unsubscribe?.();
				unsubscribe = undefined;
			};
			try {
				managed = new ManagedAgent({
					agentDir: dependencies.agentDir,
					defaultCwd: ctx.cwd,
					...(resolvedCwd === undefined ? {} : { cwd: resolvedCwd }),
					agent: agentConfig,
					resolvedRun,
					retain: params.retain === true,
					onBackgroundComplete: (summary) => {
						cleanupUpdate();
						dependencies.onBackgroundComplete(summary);
					},
					onQuestion: (summary, question) => dependencies.onQuestion(summary, question),
				});
				await runPromise(dependencies.registry.add(managed));
				if (onUpdate) {
					unsubscribe = managed.subscribe((details) => {
						try {
							onUpdate({ content: [{ type: "text", text: "(running…)" }], details });
						} finally {
							if (
								details.status === "idle" ||
								details.status === "failed" ||
								details.status === "aborted" ||
								details.status === "closed"
							) {
								cleanupUpdate();
							}
						}
					});
				}
				const details = await managed.start(
					message,
					preserveOptional(params.handoff),
					taskName,
					background,
					background ? undefined : signal,
				);
				if (!background) cleanupUpdate();
				return finishRunResult({
					toolActivation,
					claimUsage: dependencies.claimUsage,
					summary: managed.summary(),
					details,
					background,
					includeRetention: true,
				});
			} catch (error) {
				cleanupUpdate();
				if (managed) {
					const summary = managed.summary();
					if (isAgentActive(summary.status)) {
						toolActivation.activateForState(summary);
					}
				}
				throw toolError(managed ? `Agent ${managed.id} failed` : "Agent startup failed", error);
			}
		},
		renderCall(args, theme, context) {
			const container =
				context.lastComponent instanceof Container
					? (context.lastComponent.clear(), context.lastComponent)
					: new Container();
			renderCallHeader(container, args, context.expanded, theme);
			return container;
		},
		renderResult(result, options, theme, context) {
			return renderRunToolResult(result, options, theme, dependencies.ticks, context.toolCallId, () =>
				context.invalidate(),
			);
		},
	});
}

function spawnSchemaOptions(dependencies: SpawnAgentDependencies): SpawnAgentSchemaOptions {
	const agents = dependencies.agents.map((agent) => agent.name);
	const profiles = [
		...new Set(agents.flatMap((agent) => dependencies.profiles.agentPolicies[agent]?.allowedProfiles ?? [])),
	];
	return {
		agents,
		agentDescriptions: Object.fromEntries(
			dependencies.agents.map((agent) => [
				agent.name,
				`${agent.description} Allowed profiles: ${dependencies.profiles.agentPolicies[agent.name]?.allowedProfiles.join(", ") ?? "none"}.`,
			]),
		),
		profiles,
		profileDescriptions: Object.fromEntries(
			profiles.map((name) => [name, dependencies.profiles.profiles[name]!.description] as const),
		),
		thinkingLevels: thinkingLevelsForProfiles(dependencies.profiles, profiles),
	};
}

export function thinkingLevelsForProfiles(
	config: Pick<ProfilesConfig, "profiles">,
	profiles: readonly string[],
): readonly ModelThinkingLevel[] {
	if (profiles.length === 0) throw new Error("No profiles are available for thinking-level advertisement.");
	// The schema cannot know which authenticated candidate will win at runtime,
	// so offer only levels every configured fallback accepts.
	const minimumRank = Math.max(
		...profiles.flatMap((name) => {
			const profile = config.profiles[name];
			if (!profile) throw new Error(`Profile '${name}' is not configured.`);
			return profile.modelPriority.map((candidate) => THINKING_LEVELS.indexOf(candidate.defaultThinking));
		}),
	);
	const maximumRank = Math.min(
		...profiles.map((name) => {
			const profile = config.profiles[name];
			if (!profile) throw new Error(`Profile '${name}' is not configured.`);
			return Math.min(...profile.modelPriority.map((candidate) => THINKING_LEVELS.indexOf(candidate.maxThinking)));
		}),
	);
	if (minimumRank < 0 || maximumRank < 0) throw new Error("Configured profile has an unknown thinking-level range.");
	if (minimumRank > maximumRank)
		throw new Error("Configured profiles have no common thinking level for advertisement.");
	return THINKING_LEVELS.slice(minimumRank, maximumRank + 1);
}

const DEFAULT_CLOSED_AGENT_LIMIT = 10;

interface AgentsStatusDependencies {
	readonly registry: {
		readonly list: () => AgentSummary[];
	};
	readonly admission: Pick<SpawnAdmissionController, "capacity">;
}

export function createAgentsStatusTool(
	dependencies: AgentsStatusDependencies,
): ToolDefinition<typeof AgentsStatusParamsSchema, AgentSummaryDetails> {
	return defineTool<typeof AgentsStatusParamsSchema, AgentSummaryDetails>({
		name: "agents_status",
		label: "Agents Status",
		description: "Inspect subagent status and available capacity.",
		parameters: AgentsStatusParamsSchema,
		async execute(_id, params: AgentsStatusParams) {
			const limit = params.closed_limit ?? DEFAULT_CLOSED_AGENT_LIMIT;
			const summaries = dependencies.registry.list();
			const live = summaries.filter((summary) => summary.status !== "closed");
			const closed = limit === 0 ? [] : summaries.filter((summary) => summary.status === "closed").slice(-limit);
			const capacity = dependencies.admission.capacity();
			return jsonResult(
				{ capacity, agents: [...live, ...closed] },
				agentSummaryDetails([...live, ...closed], capacity),
			);
		},
		renderCall(_args, theme, context) {
			return renderManagementCall(
				"agents_status",
				undefined,
				undefined,
				context.expanded,
				dependencies.registry.list(),
				theme,
			);
		},
		renderResult(result, options, theme) {
			return renderSummaryToolResult("agents_status", result, options, theme);
		},
	});
}

interface AnswerAgentDependencies {
	readonly registry: {
		readonly liveTarget: (target: string, generation?: number) => LiveAgentTarget;
		readonly list: () => AgentSummary[];
	};
}

export function createAnswerAgentTool(
	dependencies: AnswerAgentDependencies,
): ToolDefinition<typeof AnswerAgentParamsSchema, AgentSummaryDetails> {
	return defineTool<typeof AnswerAgentParamsSchema, AgentSummaryDetails>({
		name: "answer_agent",
		label: "Answer Agent",
		description: "Answer a pending question from a subagent.",
		parameters: AnswerAgentParamsSchema,
		async execute(_id, params: AnswerAgentParams) {
			const questionId = trimRequired(params.question_id, "question_id");
			const answer = preserveRequired(params.answer, "answer");
			const resolved = dependencies.registry.liveTarget(params.target, params.generation);
			await resolved.agent.answerQuestion(questionId, answer);
			const next = resolved.agent.summary();
			return textResult(
				`Answer delivered to '${next.task_name}'. Further questions or completion will be delivered automatically.`,
				agentSummaryDetails([next]),
			);
		},
		renderCall(args, theme, context) {
			return renderManagementCall(
				"answer_agent",
				args.target,
				args.answer,
				context.expanded,
				dependencies.registry.list(),
				theme,
				"blocking",
			);
		},
		renderResult(result, options, theme) {
			return renderSummaryToolResult("answer_agent", result, options, theme);
		},
	});
}

interface CloseAgentDependencies {
	readonly registry: {
		readonly resolveGeneration: (target: string, generation?: number) => ResolvedAgentTarget;
		readonly summary: (id: string) => AgentSummary;
		readonly list: () => AgentSummary[];
		readonly close: AgentRegistry["close"];
	};
}

export function createCloseAgentTool(
	dependencies: CloseAgentDependencies,
): ToolDefinition<typeof CloseAgentParamsSchema, AgentSummaryDetails> {
	return defineTool<typeof CloseAgentParamsSchema, AgentSummaryDetails>({
		name: "close_agent",
		label: "Close Agent",
		description: "Close a subagent, aborting it first if still running. Stored results remain available.",
		parameters: CloseAgentParamsSchema,
		async execute(_id, params: CloseAgentParams) {
			const resolved = dependencies.registry.resolveGeneration(params.target, params.generation);
			if (params.generation !== undefined) assertCurrentGeneration(resolved.summary, params.generation);
			await runPromise(dependencies.registry.close(resolved.agent_id));
			const closed = dependencies.registry.summary(resolved.agent_id);
			return jsonResult(closed, agentSummaryDetails([closed]));
		},
		renderCall(args, theme, context) {
			return renderManagementCall(
				"close_agent",
				args.target,
				undefined,
				context.expanded,
				dependencies.registry.list(),
				theme,
			);
		},
		renderResult(result, options, theme) {
			return renderSummaryToolResult("close_agent", result, options, theme);
		},
	});
}

interface FollowupAgentDependencies {
	readonly registry: {
		readonly liveTarget: (target: string) => LiveAgentTarget;
		readonly list: () => AgentSummary[];
	};
	readonly ticks: Map<string, NodeJS.Timeout>;
	readonly claimUsage: (summary: AgentSummary) => Readonly<RunUsage> | undefined;
}

export function createFollowupAgentTool(
	toolActivation: SubagentToolActivator,
	dependencies: FollowupAgentDependencies,
): ToolDefinition<typeof FollowupAgentParamsSchema, ReadonlyRunDetails> {
	return defineTool<typeof FollowupAgentParamsSchema, ReadonlyRunDetails>({
		name: "followup_agent",
		label: "Followup Agent",
		description: "Run another task on a retained, settled subagent.",
		parameters: FollowupAgentParamsSchema,
		async execute(_id, params: FollowupAgentParams, signal, onUpdate) {
			const message = preserveRequired(params.message, "message");
			const background = params.background === true;
			const agent = dependencies.registry.liveTarget(params.target).agent;
			const unsubscribe = onUpdate
				? agent.subscribe((details) => {
						onUpdate({ content: [{ type: "text", text: "(running…)" }], details });
					})
				: undefined;
			let details: ReadonlyRunDetails;
			try {
				details = await agent.followUp(message, background, background ? undefined : signal);
			} finally {
				unsubscribe?.();
			}
			return finishRunResult({
				toolActivation,
				claimUsage: dependencies.claimUsage,
				summary: agent.summary(),
				details,
				background,
			});
		},
		renderCall(args, theme, context) {
			return renderManagementCall(
				"followup_agent",
				args.target,
				args.message,
				context.expanded,
				dependencies.registry.list(),
				theme,
				args.background === true ? "async" : "blocking",
			);
		},
		renderResult(result, options, theme, context) {
			return renderRunToolResult(result, options, theme, dependencies.ticks, context.toolCallId, () =>
				context.invalidate(),
			);
		},
	});
}

export type ReadAgentResultDependencies = Pick<AgentRegistry, "readResultByAddress" | "list">;

export function createReadAgentResultTool(
	dependencies: ReadAgentResultDependencies,
): ToolDefinition<typeof ReadAgentResultParamsSchema, ResultPage> {
	return defineTool({
		name: "read_agent_result",
		label: "Read Agent Result",
		description: "Read persisted output from a subagent generation.",
		parameters: ReadAgentResultParamsSchema,
		async execute(_id, params: ReadAgentResultParams) {
			const page = await runPromise(
				dependencies.readResultByAddress(params.target, {
					...(params.generation === undefined ? {} : { generation: params.generation }),
					...(params.cursor === undefined ? {} : { cursor: params.cursor }),
					...(params.offset === undefined ? {} : { offset: params.offset }),
					maxBytes: params.max_bytes ?? RESULT_READ_DEFAULT_BYTES,
				}),
			);
			return textResult(JSON.stringify(page), page);
		},
		renderCall(args, theme, context) {
			return renderManagementCall(
				"read_agent_result",
				args.target,
				undefined,
				context.expanded,
				dependencies.list(),
				theme,
			);
		},
	});
}

interface SteerAgentDependencies {
	readonly registry: {
		readonly liveTarget: (target: string, generation?: number) => LiveAgentTarget;
		readonly list: () => AgentSummary[];
	};
}

export function createSteerAgentTool(
	dependencies: SteerAgentDependencies,
): ToolDefinition<typeof SteerAgentParamsSchema, AgentSummaryDetails> {
	return defineTool<typeof SteerAgentParamsSchema, AgentSummaryDetails>({
		name: "steer_agent",
		label: "Steer Agent",
		description: "Send guidance to a running subagent generation.",
		parameters: SteerAgentParamsSchema,
		async execute(_id, params: SteerAgentParams) {
			const message = preserveRequired(params.message, "message");
			const resolved = dependencies.registry.liveTarget(params.target, params.generation);
			const summary = resolved.summary;
			if (!isAgentActive(summary.status))
				throw new Error(`Agent '${summary.task_name}' is not running (status: ${summary.status}).`);
			if (summary.pending_question)
				throw new Error(
					`Agent '${summary.task_name}' is waiting for '${summary.pending_question.question_id}'; use answer_agent.`,
				);
			await resolved.agent.steer(message);
			const next = resolved.agent.summary();
			return textResult(
				`Steering message accepted by '${next.task_name}' generation ${next.generation}.`,
				agentSummaryDetails([next]),
			);
		},
		renderCall(args, theme, context) {
			return renderManagementCall(
				"steer_agent",
				args.target,
				args.message,
				context.expanded,
				dependencies.registry.list(),
				theme,
				"blocking",
			);
		},
		renderResult(result, options, theme) {
			return renderSummaryToolResult("steer_agent", result, options, theme);
		},
	});
}

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
		description: "Wait for selected subagents to settle or request input.",
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

export interface ChildAskQuestionDependencies<Generation> {
	readonly getGeneration: () => Generation | undefined;
	readonly isGenerationSettled: (generation: Generation) => boolean;
	readonly hasPendingQuestion: (generation: Generation) => boolean;
	readonly setQuestion: (
		generation: Generation,
		question: AgentQuestion,
		answer: Deferred.Deferred<string, Error>,
	) => void;
	readonly signalArrival: (generation: Generation) => void;
	readonly emit: () => void;
	readonly summary: () => AgentSummary;
	readonly onQuestion?: (summary: AgentSummary, question: AgentQuestion) => void;
	readonly awaitAnswer: (
		generation: Generation,
		question: AgentQuestion,
		answer: Deferred.Deferred<string, Error>,
		signal: AbortSignal | undefined,
	) => Promise<string>;
}

export function createChildAskQuestionTool<Generation>(
	dependencies: ChildAskQuestionDependencies<Generation>,
): ToolDefinition {
	return defineTool({
		name: "ask_question",
		label: "Ask Question",
		description: "Ask the parent a multiple-choice question and wait for its answer.",
		executionMode: "sequential",
		parameters: Type.Object(
			{
				question: Type.String({ minLength: 1 }),
				alternatives: Type.Array(Type.String({ minLength: 1 }), { minItems: 2, maxItems: 5 }),
			},
			{ additionalProperties: false },
		),
		execute: async (_id, params, signal) => {
			signal?.throwIfAborted();
			const generation = dependencies.getGeneration();
			if (generation === undefined || dependencies.isGenerationSettled(generation)) {
				throw new Error("No active subagent generation.");
			}
			if (dependencies.hasPendingQuestion(generation)) {
				throw new Error("The subagent already has a pending question.");
			}
			const question: AgentQuestion = {
				question_id: randomBytes(16).toString("hex"),
				question: params.question,
				options: [...params.alternatives],
			};
			const answer = Deferred.makeUnsafe<string, Error>();
			dependencies.setQuestion(generation, question, answer);
			dependencies.signalArrival(generation);
			dependencies.emit();
			dependencies.onQuestion?.(dependencies.summary(), question);
			const text = await dependencies.awaitAnswer(generation, question, answer, signal);
			return { content: [{ type: "text", text }], details: { answer: text } };
		},
	});
}
