import * as fs from "node:fs";
import * as path from "node:path";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { Container } from "@earendil-works/pi-tui";
import { clipTextAtWord } from "../../_shared/terminal-text.ts";
import { formatAgentList, resolveAgent, type AgentConfig } from "../agents.ts";
import type { AgentRegistry } from "../agent-registry.ts";
import type { AgentQuestion, AgentSummary } from "../agent-types.ts";
import { ManagedAgent, type ManagedAgentOptions } from "../managed-agent.ts";
import { resolveRun, type ProfilesConfig } from "../profiles.ts";
import type { ReadonlyRunDetails, RunUsage } from "../run-state.ts";
import {
	createSpawnAgentSchema,
	preserveOptional,
	preserveRequired,
	type SpawnAgentSchemaOptions,
	trimOptional,
	trimRequired,
} from "../schemas.ts";
import { completedRunResult, formatPendingQuestion, toolError } from "../tool-results.ts";
import { renderCallHeader } from "../render.ts";
import { renderRunToolResult } from "../ui/result-renderers.ts";
import { requiresExactResultRead, type SubagentToolActivator } from "../tool-activation.ts";
import type { SpawnRpcProcess } from "../rpc-transport.ts";
import type { SpawnAdmissionController } from "../spawn-admission.ts";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export interface SpawnAgentDependencies {
	readonly agents: AgentConfig[];
	readonly profiles: ProfilesConfig;
	readonly agentDir: string;
	readonly admission: Pick<SpawnAdmissionController, "admit">;
	readonly registry: Pick<AgentRegistry, "add">;
	readonly ticks: Map<string, NodeJS.Timeout>;
	readonly onBackgroundComplete: (summary: AgentSummary) => void;
	readonly onQuestion: (summary: AgentSummary, question: AgentQuestion) => void;
	readonly claimUsage: (summary: AgentSummary) => Readonly<RunUsage> | undefined;
}

export interface SpawnAgentToolOptions {
	readonly spawnProcess?: SpawnRpcProcess;
	/** Test-only native-session validation seam. */
	readonly validateSessionIdentity?: ManagedAgentOptions["validateSessionIdentity"];
}

export function createSpawnAgentTool(
	toolActivation: SubagentToolActivator,
	dependencies: SpawnAgentDependencies,
	options: SpawnAgentToolOptions = {},
): ToolDefinition<ReturnType<typeof createSpawnAgentSchema>, ReadonlyRunDetails> {
	const schemaOptions = spawnSchemaOptions(dependencies);
	const schema = createSpawnAgentSchema(schemaOptions);
	const allowedAgents = dependencies.agents
		.filter((agent) => schemaOptions.agents.includes(agent.name))
		.map((agent) => ({
			...agent,
			description: `${agent.description} Allowed profiles: ${dependencies.profiles.agentPolicies[agent.name]?.allowedProfiles.join(", ") ?? "none"}.`,
		}));
	const allowedProfiles = schemaOptions.profiles.flatMap((name) => {
		const profile = dependencies.profiles.profiles[name];
		return profile
			? [
					{
						name,
						description: `${profile.description}. The effective model and permitted thinking range are resolved from the currently enabled scoped models.`,
					},
				]
			: [];
	});
	return defineTool<typeof schema, ReadonlyRunDetails>({
		name: "spawn_agent",
		label: "Spawn Agent",
		description:
			"Spawn an isolated one-shot subagent by default. Set retain:true only when later follow-up work needs the same live context.",
		promptSnippet: "Spawn an isolated leaf subagent with its own context, model, and tools",
		promptGuidelines: spawnGuidelines(
			allowedAgents,
			allowedProfiles,
			dependencies.profiles.rootPolicy.maxConcurrentRootAgents,
			dependencies.profiles.rootPolicy.maxConcurrentDeepAgents,
		),
		parameters: schema,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const message = preserveRequired(params.message, "message");
			const requestedAgent = trimRequired(params.agent, "agent");
			const agentConfig = resolveAgent(dependencies.agents, requestedAgent).match(
				(value) => value,
				(error) => {
					throw new Error(`Unknown agent '${error.requested}'. Available: ${formatAgentList(error.available)}.`);
				},
			);
			const profile = trimOptional(params.profile);
			const cwd = trimOptional(params.cwd);
			const resolvedCwd = cwd === undefined ? undefined : path.resolve(ctx.cwd, cwd);
			const resolvedRun = resolveRun({
				config: dependencies.profiles,
				modelRegistry: ctx.modelRegistry,
				scopedModels: ctx.scopedModels,
				agent: agentConfig,
				...(profile === undefined ? {} : { profile }),
				...(params.thinking === undefined ? {} : { requestedThinking: params.thinking }),
			});
			if (resolvedCwd !== undefined) {
				const stats = await fs.promises.stat(resolvedCwd);
				if (!stats.isDirectory()) throw new Error(`cwd is not a directory: ${cwd}`);
			}
			const childContext = {
				...dependencies.admission.admit({
					agent: resolvedRun.agent,
					profile: resolvedRun.profile,
				}),
				parentSessionId: ctx.sessionManager.getSessionId(),
			};
			const background = params.background === true;
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
					childContext,
					retain: params.retain === true,
					...(options.spawnProcess === undefined ? {} : { spawnProcess: options.spawnProcess }),
					...(options.validateSessionIdentity === undefined
						? {}
						: { validateSessionIdentity: options.validateSessionIdentity }),
					onBackgroundComplete: (summary) => {
						cleanupUpdate();
						dependencies.onBackgroundComplete(summary);
					},
					onQuestion: (summary, question) => dependencies.onQuestion(summary, question),
				});
				await dependencies.registry.add(managed);
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
					trimOptional(params.task_name) ?? clipTextAtWord(message, 60),
					background,
					background ? undefined : signal,
				);
				if (!background) cleanupUpdate();
				const summary = managed.summary();
				toolActivation.activateForState(summary, background);
				return completedRunResult(
					background ? formatLaunch(summary) : (formatPendingQuestion(summary) ?? formatCompletion(summary)),
					details,
					background ? undefined : dependencies.claimUsage(summary),
				);
			} catch (error) {
				cleanupUpdate();
				if (managed) {
					const summary = managed.summary();
					if (summary.status === "starting" || summary.status === "running") {
						toolActivation.activateForState(summary, true);
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
		profiles,
		thinkingLevels: thinkingLevelsForProfiles(dependencies.profiles, profiles),
	};
}

export function thinkingLevelsForProfiles(
	config: ProfilesConfig,
	profiles: readonly string[],
): readonly ModelThinkingLevel[] {
	if (profiles.length === 0) throw new Error("No profiles are available for thinking-level advertisement.");
	const minimumRank = Math.min(
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

export function spawnGuidelines(
	agents: readonly Pick<AgentConfig, "name" | "description">[] = [],
	profiles: readonly { readonly name: string; readonly description: string }[] = [],
	rootLimit?: number,
	deepLimit?: number,
): string[] {
	const roleMap =
		agents.length > 0
			? `Choose the narrowest matching role:\n${agents
					.map((agent) => `- ${agent.name}: ${agent.description}`)
					.join("\n")}`
			: undefined;
	const profileMap =
		profiles.length > 0
			? `Choose the least expensive execution profile that can complete the work:\n${profiles
					.map((profile) => `- ${profile.name}: ${profile.description}`)
					.join("\n")}`
			: undefined;

	return [
		...(roleMap === undefined ? [] : [roleMap]),
		...(profileMap === undefined ? [] : [profileMap]),
		...(rootLimit === undefined || deepLimit === undefined
			? []
			: [
					`Live-process capacity is ${rootLimit} root children total and ${deepLimit} deep-profile child. Profile/model/thinking ranges are preflighted before capacity is occupied.`,
				]),
		"For one blocking delegated task, prefer foreground spawn_agent. For background parallel work, launch one concurrent wave, then use the management controls made available by that launch as one barrier with that wave's IDs and a suitable timeout; do not build repeated automatic turns or a task scheduler.",
		"Use subagents for independent work that benefits from parallelism, specialized expertise, or isolated context. Handle simple, tightly coupled, or single-file work directly. Once work is delegated, do not duplicate its assigned scope: while the subagent runs, address only non-overlapping needs or wait for its result. The current agent owns synthesis and proportionate, risk-based final verification.",
		"When a new child task depends on prior work—especially a retry, review/fix cycle, or replacement for an earlier child—put the compact factual delta in handoff: decisions, findings, exact paths or symbols, constraints, and validation failures or results. The child has its own context and does not inherit the parent transcript. Keep the assignment self-contained in message, do not repeat it in handoff, and never paste the parent transcript; omit handoff for independent work.",
		"For worker assignments, specify owned files, modules, or responsibility, note known concurrent edits, and name required validation. Avoid concurrent writers unless ownership is explicitly disjoint.",
		"Use scouts only for bounded, narrow read-only discovery; do not assign scouts implementation, broad exploration, or final review verdicts.",
	];
}

function formatLaunch(summary: ReturnType<ManagedAgent["summary"]>): string {
	return `agent_id: ${summary.agent_id}\nstatus: ${summary.status}\ngeneration: ${summary.generation}\nretained: ${summary.retained}\n\nCompletion will be delivered automatically. One-shot agents archive after settlement.`;
}

function formatCompletion(summary: ReturnType<ManagedAgent["summary"]>): string {
	const exactResultGuidance = requiresExactResultRead(summary)
		? "\n\nUse read_agent_result for exact cursor-paged reconstruction."
		: "";
	return `agent_id: ${summary.agent_id}\nstatus: ${summary.status}\ngeneration: ${summary.generation}\nretained: ${summary.retained}\n\n${summary.final_text || summary.error || "(no output)"}${exactResultGuidance}`;
}
