import { defineTool, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import { clipTextAtWord } from "../../_shared/terminal-text.ts";
import { formatAgentList, resolveAgent, type AgentConfig } from "../agents.ts";
import type { SubagentRuntime } from "../bootstrap.ts";
import { executionCanDelegate } from "../spawn-admission.ts";
import { ManagedAgent } from "../managed-agent.ts";
import { resolveRun } from "../profiles.ts";
import type { ReadonlyRunDetails } from "../run-state.ts";
import { createSpawnAgentSchema, type SpawnAgentSchemaOptions, trimOptional, trimRequired } from "../schemas.ts";
import { textResult, toolError } from "../tool-results.ts";
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
	const allowedAgents = runtime.agents.filter((agent) => schemaOptions.agents.includes(agent.name));
	const allowedProfiles = schemaOptions.profiles.flatMap((name) => {
		const profile = runtime.profiles.profiles[name];
		return profile ? [{ name, description: profile.description }] : [];
	});
	return defineTool<typeof schema, ReadonlyRunDetails>({
		name: "spawn_agent",
		label: "Spawn Agent",
		description: "Spawn an admitted persistent subagent.",
		promptSnippet: "Spawn an isolated persistent subagent with its own context, model, and tools",
		promptGuidelines: spawnGuidelines(allowedAgents, allowedProfiles, runtime.executionContext === undefined),
		parameters: schema,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			if (runtime.executionContext && params.child_spawn_budget !== undefined) {
				throw new Error("Only the top-level process may supply child_spawn_budget; remove it from this nested spawn.");
			}
			const message = trimRequired(params.message, "message");
			const requestedAgent = trimRequired(params.agent, "agent");
			const agentConfig = resolveAgent(runtime.agents, requestedAgent).match(
				(value) => value,
				(error) => {
					throw new Error(`Unknown agent '${error.requested}'. Available: ${formatAgentList(error.available)}.`);
				},
			);
			const profile = trimOptional(params.profile);
			const resolvedRun = resolveRun({
				config: runtime.profiles,
				modelRegistry: ctx.modelRegistry,
				agent: agentConfig,
				...(profile === undefined ? {} : { profile }),
				...(params.thinking === undefined ? {} : { requestedThinking: params.thinking }),
			});
			const reservation = runtime.admission.reserve({
				agent: resolvedRun.agent,
				profile: resolvedRun.profile,
				...(params.child_spawn_budget === undefined ? {} : { childSpawnBudget: params.child_spawn_budget }),
			});
			const childContext = reservation.childContext;
			const background = params.background === true;
			const cwd = trimOptional(params.cwd);
			let managed: ManagedAgent | undefined;
			try {
				managed = new ManagedAgent({
					defaultCwd: ctx.cwd,
					...(cwd === undefined ? {} : { cwd }),
					agent: agentConfig,
					resolvedRun,
					childContext,
					subagentToolsEnabled: executionCanDelegate(runtime.profiles, childContext),
					...(options.spawnProcess === undefined ? {} : { spawnProcess: options.spawnProcess }),
					...(onUpdate
						? {
								onUpdate: (details) => {
									onUpdate({ content: [{ type: "text", text: "(running…)" }], details });
								},
							}
						: {}),
					onStartupComplete: () => reservation.commit(),
					onBackgroundComplete: (summary) => runtime.handleBackgroundComplete(pi, summary),
				});
				await runtime.registry.add(managed);
				const details = await managed.start(
					message,
					trimOptional(params.handoff),
					trimOptional(params.task_name) ?? clipTextAtWord(message, 60),
					background,
					background ? undefined : signal,
				);
				const summary = managed.summary();
				return textResult(background ? formatLaunch(summary) : formatCompletion(summary), details);
			} catch (error) {
				reservation.release();
				if (managed && !managed.isAvailable()) runtime.registry.delete(managed.id);
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
	const parent = runtime.executionContext;
	if (!parent) {
		const agents = runtime.agents.map((agent) => agent.name);
		const profiles = [
			...new Set(agents.flatMap((agent) => runtime.profiles.agentPolicies[agent]?.allowedProfiles ?? [])),
		];
		return {
			agents,
			profiles,
			maxSpawnBudgetPerChild: runtime.profiles.rootPolicy.maxSpawnBudgetPerChild,
		};
	}

	const delegation = runtime.profiles.agentPolicies[parent.agent]?.delegation;
	if (delegation?.mode !== "grant-required") {
		throw new Error(`Agent '${parent.agent}' has subagent tools but no delegation policy.`);
	}
	return {
		agents: delegation.allowedChildAgents,
		profiles: delegation.allowedChildProfiles,
	};
}

export function spawnGuidelines(
	agents: readonly Pick<AgentConfig, "name" | "description">[] = [],
	profiles: readonly { readonly name: string; readonly description: string }[] = [],
	isRootProcess = false,
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
		...(isRootProcess
			? [
					"Root concurrency limits count only live children owned by this top-level process, not every agent in the delegation tree. Nested child spawns use each parent's lifetime spawn budget; there is no tree-wide agent cap.",
				]
			: []),
		"Use subagents for independent work that benefits from parallelism, specialized expertise, or isolated context. Handle simple, tightly coupled, or single-file work directly. The current agent owns synthesis and final verification.",
		"For worker assignments, specify owned files, modules, or responsibility, note known concurrent edits, and name the required validation.",
		"Use scouts only for narrow read-only discovery; do not assign scouts implementation or final review verdicts.",
	];
}

function formatLaunch(summary: ReturnType<ManagedAgent["summary"]>): string {
	return `agent_id: ${summary.agent_id}\nstatus: ${summary.status}\ngeneration: ${summary.generation}\n\nCompletion will be delivered automatically. Use send_agent, followup_agent, wait_agent, interrupt_agent, or close_agent with this agent_id.`;
}

function formatCompletion(summary: ReturnType<ManagedAgent["summary"]>): string {
	return `agent_id: ${summary.agent_id}\nstatus: ${summary.status}\ngeneration: ${summary.generation}\n\n${summary.final_text || summary.error || "(no output)"}`;
}
