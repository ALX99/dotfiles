import * as fs from "node:fs";
import * as path from "node:path";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { Container } from "@earendil-works/pi-tui";
import { formatAgentList, resolveAgent, type AgentConfig } from "../agents.ts";
import type { AgentRegistry } from "../agent-registry.ts";
import { isAgentActive, type AgentQuestion, type AgentSummary } from "../agent-types.ts";
import { ManagedAgent } from "../managed-agent.ts";
import { resolveRun, type ProfilesConfig } from "../profiles.ts";
import type { ReadonlyRunDetails, RunUsage } from "../run-state.ts";
import {
	createSpawnAgentSchema,
	preserveOptional,
	preserveRequired,
	type SpawnAgentSchemaOptions,
	trimOptional,
} from "../schemas.ts";
import { finishRunResult, toolError } from "../tool-results.ts";
import { renderCallHeader } from "../render.ts";
import { renderRunToolResult } from "../ui/result-renderers.ts";
import type { SubagentToolActivator } from "../tool-activation.ts";
import type { SpawnAdmissionController } from "../spawn-admission.ts";

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
	/**
	 * Which models the advertised profiles resolve to for the parent's current model. Travels as a
	 * guideline so it survives any extension that replaces the system prompt, and disappears with the
	 * tool if the host or a mode disables this one.
	 */
	readonly capabilityHint?: string;
}

export function createSpawnAgentTool(
	toolActivation: SubagentToolActivator,
	dependencies: SpawnAgentDependencies,
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
						description: profile.description,
					},
				]
			: [];
	});
	return defineTool<typeof schema, ReadonlyRunDetails>({
		name: "spawn_agent",
		label: "Spawn Agent",
		description:
			"Spawn an isolated one-shot subagent by default; retain:true only for later work needing its live context.",
		promptSnippet: "Spawn an isolated leaf subagent",
		promptGuidelines: spawnGuidelines(
			allowedAgents,
			allowedProfiles,
			dependencies.profiles.rootPolicy.maxConcurrentRootAgents,
			dependencies.capabilityHint,
		),
		parameters: schema,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const message = preserveRequired(params.message, "message");
			const defaultAgent = dependencies.agents[0];
			if (!defaultAgent) throw new Error("No subagent roles are configured.");
			const requestedAgent = trimOptional(params.agent) ?? defaultAgent.name;
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
			dependencies.admission.admit({
				agent: resolvedRun.agent,
				profile: resolvedRun.profile,
			});
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
		profiles,
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

export function spawnGuidelines(
	agents: readonly Pick<AgentConfig, "name" | "description">[] = [],
	profiles: readonly { readonly name: string; readonly description: string }[] = [],
	rootLimit?: number,
	capabilityHint?: string,
): string[] {
	// The renderer prefixes only a guideline's first line, so role and profile
	// entries are indented to stay nested under the sentence that introduces them.
	const roleMap =
		agents.length > 0
			? `Choose the narrowest matching role:\n${agents
					.map((agent) => `  - ${agent.name}: ${agent.description}`)
					.join("\n")}`
			: undefined;
	const profileMap =
		profiles.length > 0
			? `Choose the least expensive execution profile that can complete the work. Each profile's model and permitted thinking range resolve from your enabled scoped models:\n${profiles
					.map((profile) => `  - ${profile.name}: ${profile.description}`)
					.join("\n")}`
			: undefined;

	return [
		...(roleMap === undefined ? [] : [roleMap]),
		...(profileMap === undefined ? [] : [profileMap]),
		...(capabilityHint === undefined ? [] : [capabilityHint]),
		"Select fast only for bounded mechanical or well-scoped implementation with a known path and criterion. Do not select it for debugging or root-cause analysis, review, design, ambiguous investigation, security/correctness decisions, or final synthesis. Balanced is the default for work requiring judgment; worker/general use fast only when these criteria clearly fit.",
		...(rootLimit === undefined
			? []
			: [
					`Live-agent capacity is ${rootLimit} root children total. Profile/model/thinking ranges are preflighted before capacity is occupied.`,
				]),
		"Use subagents for independent work benefiting from parallelism, specialization, or isolation; handle simple, coupled, or single-file work directly. Once delegated, do not duplicate its assigned scope: do only non-overlapping work or wait. The current agent owns synthesis and proportionate final verification.",
		"Use foreground spawn_agent for one blocking task, or background:true for a parallel wave; use wait_agents as one barrier on explicit targets. Generations default to latest, so poll for progress with names, not bookkeeping. Do not build repeated automatic turns or a task scheduler.",
		"Address children by task_name (unique per session, stable across generations); agent_id works as an alias. Talk to children with flat verbs: followup_agent starts another task on a retained settled child, steer_agent guides a running generation at its next message boundary (generation required), answer_agent resolves a specific pending question (generation required). Never silently convert steering into followup or treat a generic message as a question answer.",
		"Inspect status and capacity with agents_status; release a child with close_agent (aborts a running generation and disposes in one step; persisted results remain readable). Use read_agent_result with target for exact cursor-paged output; generation defaults to latest.",
		"For dependent, retry, review/fix, or replacement work, hand off only the factual delta: decisions, findings, exact paths/symbols, constraints, and validation. Children do not inherit the transcript. Keep message self-contained; do not repeat it or paste the transcript in handoff. Omit handoff for independent work.",
		"For worker assignments, specify ownership, known concurrent edits, and required validation. Avoid concurrent writers unless ownership is explicitly disjoint.",
		"Use scouts only for bounded read-only discovery, never implementation, broad exploration, or final review verdicts.",
	];
}
