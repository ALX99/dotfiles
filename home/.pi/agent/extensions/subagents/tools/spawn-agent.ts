import * as fs from "node:fs";
import * as path from "node:path";
import { defineTool, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import { clipTextAtWord } from "../../_shared/terminal-text.ts";
import { formatAgentList, resolveAgent, type AgentConfig } from "../agents.ts";
import type { SubagentRuntime } from "../bootstrap.ts";
import { ManagedAgent } from "../managed-agent.ts";
import { resolveRuns } from "../profiles.ts";
import type { ReadonlyRunDetails } from "../run-state.ts";
import {
	createSpawnAgentSchema,
	prepareSpawnArguments,
	preserveOptional,
	preserveRequired,
	type SpawnAgentSchemaOptions,
	trimOptional,
	trimRequired,
} from "../schemas.ts";
import { formatPendingQuestion, textResult, toolError } from "../tool-results.ts";
import { renderCallHeader } from "../render.ts";
import { renderRunToolResult } from "../ui/result-renderers.ts";
import type { SpawnRpcProcess } from "../rpc-transport.ts";

export interface SpawnAgentToolOptions {
	readonly spawnProcess?: SpawnRpcProcess;
}

export function createSpawnAgentTool(
	pi: ExtensionAPI,
	runtime: SubagentRuntime,
	options: SpawnAgentToolOptions = {},
): ToolDefinition<ReturnType<typeof createSpawnAgentSchema>, ReadonlyRunDetails> {
	const schemaOptions = spawnSchemaOptions(runtime);
	const schema = createSpawnAgentSchema(schemaOptions);
	const allowedAgents = runtime.agents
		.filter((agent) => schemaOptions.agents.includes(agent.name))
		.map((agent) => ({
			...agent,
			description: `${agent.description} Allowed profiles: ${runtime.profiles.agentPolicies[agent.name]?.allowedProfiles.join(", ") ?? "none"}.`,
		}));
	const allowedProfiles = schemaOptions.profiles.flatMap((name) => {
		const profile = runtime.profiles.profiles[name];
		return profile
			? [
					{
						name,
						description: `${profile.description}. The effective model and thinking cap are resolved from the currently enabled scoped models.`,
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
			runtime.profiles.rootPolicy.maxConcurrentRootAgents,
			runtime.profiles.rootPolicy.maxConcurrentDeepAgents,
		),
		parameters: schema,
		prepareArguments: prepareSpawnArguments,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const message = preserveRequired(params.message, "message");
			const requestedAgent = trimRequired(params.agent, "agent");
			const agentConfig = resolveAgent(runtime.agents, requestedAgent).match(
				(value) => value,
				(error) => {
					throw new Error(`Unknown agent '${error.requested}'. Available: ${formatAgentList(error.available)}.`);
				},
			);
			const profile = trimOptional(params.profile);
			const cwd = trimOptional(params.cwd);
			const resolvedCwd = cwd === undefined ? undefined : path.resolve(ctx.cwd, cwd);
			const resolvedRuns = resolveRuns({
				config: runtime.profiles,
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
			const [resolvedRun, ...fallbackRuns] = resolvedRuns;
			const childContext = {
				...runtime.admission.admit({
					agent: resolvedRun.agent,
					profile: resolvedRun.profile,
				}),
				parentSessionId: ctx.sessionManager.getSessionId(),
			};
			const background = params.background === true;
			let managed: ManagedAgent | undefined;
			try {
				managed = new ManagedAgent({
					agentDir: runtime.agentDir,
					defaultCwd: ctx.cwd,
					...(resolvedCwd === undefined ? {} : { cwd: resolvedCwd }),
					agent: agentConfig,
					resolvedRun,
					fallbackRuns,
					childContext,
					retain: params.retain === true,
					...(options.spawnProcess === undefined ? {} : { spawnProcess: options.spawnProcess }),
					...(onUpdate
						? {
								onUpdate: (details) => {
									onUpdate({ content: [{ type: "text", text: "(running…)" }], details });
								},
							}
						: {}),
					onBackgroundComplete: (summary) => runtime.handleBackgroundComplete(pi, summary),
					onQuestion: (summary, question) => runtime.handleQuestion(pi, summary, question),
				});
				await runtime.registry.add(managed);
				const details = await managed.start(
					message,
					preserveOptional(params.handoff),
					trimOptional(params.task_name) ?? clipTextAtWord(message, 60),
					background,
					background ? undefined : signal,
				);
				const summary = managed.summary();
				return textResult(
					background ? formatLaunch(summary) : (formatPendingQuestion(summary) ?? formatCompletion(summary)),
					details,
				);
			} catch (error) {
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
			return renderRunToolResult(result, options, theme, runtime.ticks, context.toolCallId, () => context.invalidate());
		},
	});
}

function spawnSchemaOptions(runtime: SubagentRuntime): SpawnAgentSchemaOptions {
	const agents = runtime.agents.map((agent) => agent.name);
	const profiles = [
		...new Set(agents.flatMap((agent) => runtime.profiles.agentPolicies[agent]?.allowedProfiles ?? [])),
	];
	return {
		agents,
		profiles,
	};
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
					`Live-process capacity is ${rootLimit} root children total and ${deepLimit} deep-profile child. list_agents reports current usage. Profile/model/thinking are preflighted before capacity is occupied.`,
				]),
		"For one blocking delegated task, prefer foreground spawn_agent. For background parallel work, launch one concurrent wave, then call wait_agent once with that wave's IDs and a suitable timeout; do not build repeated automatic turns or a task scheduler.",
		"Use subagents for independent work that benefits from parallelism, specialized expertise, or isolated context. Handle simple, tightly coupled, or single-file work directly. Once work is delegated, do not duplicate its assigned scope: while the subagent runs, address only non-overlapping needs or wait for its result. The current agent owns synthesis and proportionate, risk-based final verification.",
		"When prior investigation or decisions matter, use handoff for only non-derivable facts, decisions, exact excerpts, constraints, and relevant paths. Do not paste the parent transcript or repeat the assignment.",
		"For worker assignments, specify owned files, modules, or responsibility, note known concurrent edits, and name required validation. Avoid concurrent writers unless ownership is explicitly disjoint.",
		"Use scouts only for bounded, narrow read-only discovery; do not assign scouts implementation, broad exploration, or final review verdicts.",
	];
}

function formatLaunch(summary: ReturnType<ManagedAgent["summary"]>): string {
	return `agent_id: ${summary.agent_id}\nstatus: ${summary.status}\ngeneration: ${summary.generation}\nretained: ${summary.retained}\n\nCompletion will be delivered automatically. One-shot agents archive after settlement; use read_agent_result to page the exact result.`;
}

function formatCompletion(summary: ReturnType<ManagedAgent["summary"]>): string {
	return `agent_id: ${summary.agent_id}\nstatus: ${summary.status}\ngeneration: ${summary.generation}\nretained: ${summary.retained}\n\n${summary.final_text || summary.error || "(no output)"}\n\nUse read_agent_result for exact cursor-paged reconstruction.`;
}
