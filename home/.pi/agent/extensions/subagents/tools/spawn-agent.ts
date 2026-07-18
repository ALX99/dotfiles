import { defineTool, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import { clipTextAtWord } from "../../_shared/terminal-text.ts";
import { formatAgentList, resolveAgent } from "../agents.ts";
import type { SubagentRuntime } from "../bootstrap.ts";
import { executionCanDelegate } from "../spawn-admission.ts";
import { ManagedAgent } from "../managed-agent.ts";
import { resolveRun } from "../profiles.ts";
import type { ReadonlyRunDetails } from "../run-state.ts";
import { createSpawnAgentSchema, trimOptional, trimRequired } from "../schemas.ts";
import { textResult, toolError } from "../tool-results.ts";
import { renderCallHeader } from "../render.ts";
import { renderRunToolResult } from "../ui/result-renderers.ts";

export function createSpawnAgentTool(
	pi: ExtensionAPI,
	runtime: SubagentRuntime,
): ToolDefinition<ReturnType<typeof createSpawnAgentSchema>, ReadonlyRunDetails> {
	const schema = createSpawnAgentSchema(runtime.profiles.rootPolicy.maxDelegationGrant);
	return defineTool<typeof schema, ReadonlyRunDetails>({
		name: "spawn_agent",
		label: "Spawn Agent",
		description:
			"Spawn an admitted persistent subagent. Root may explicitly grant a general agent up to two delegation credits; nested delegation is limited to fast scouts. Maximum depth is 2.",
		promptSnippet: "Spawn an isolated persistent subagent with its own context, model, and tools",
		promptGuidelines: spawnGuidelines(runtime.agentList),
		parameters: schema,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			if (runtime.executionContext && params.delegation_credits !== undefined) {
				throw new Error("Only the top-level process may supply delegation_credits; remove it from this nested spawn.");
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
			const childContext = runtime.admission.admit({
				agent: resolvedRun.agent,
				profile: resolvedRun.profile,
				...(params.delegation_credits === undefined ? {} : { delegationCredits: params.delegation_credits }),
			});
			const background = params.background === true;
			const cwd = trimOptional(params.cwd);
			const managed = new ManagedAgent({
				defaultCwd: ctx.cwd,
				...(cwd === undefined ? {} : { cwd }),
				agent: agentConfig,
				resolvedRun,
				childContext,
				subagentToolsEnabled: executionCanDelegate(runtime.profiles, childContext),
				...(onUpdate
					? {
							onUpdate: (details) => {
								onUpdate({ content: [{ type: "text", text: "(running…)" }], details });
							},
						}
					: {}),
				onBackgroundComplete: (summary) => runtime.handleBackgroundComplete(pi, summary),
			});
			await runtime.registry.add(managed);
			try {
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
				if (!managed.isAvailable()) runtime.registry.delete(managed.id);
				throw toolError(`Agent ${managed.id} failed`, error);
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

function spawnGuidelines(agentList: string): string[] {
	return [
		"The root agent must perform orchestration itself; expensive or specialized children are leaves, not replacement coordinators.",
		"Launch scouts directly for narrow, non-overlapping evidence gathering, then pass the collected evidence to a single deep reviewer for synthesis and judgment.",
		"Treat every deep reviewer as a leaf. Use followup_agent when an existing agent retains useful context, and do not replace an idle deep reviewer with a new one.",
		"Grant nested delegation only when a general coordinator genuinely needs up to two narrow fast reconnaissance tasks.",
		"Use spawn_agent to delegate a self-contained task to an isolated subagent.",
		`Available agents and execution policies:\n${agentList}`,
		"Normally choose only an agent. Use profile only as an explicit allowed override; never select an individual model.",
		"When using spawn_agent, provide a complete assignment: objective, scope, constraints, expected output, and verification.",
		"Use background=true only when independent work can continue; completion is delivered automatically.",
		"When the current response needs background results, call wait_agent once with all relevant IDs before answering; consumed results will not trigger redundant follow-up turns.",
		"For parallel reviews, give agents non-overlapping scopes and ask for the evidence and uncertainty the task requires; synthesize and deduplicate findings in the parent.",
		"Use followup_agent when continuing the same subject and the completed agent's retained context is useful, especially when a scout already has relevant repository knowledge. Spawn a new agent for an unrelated topic, independent implementation scope, or different role or execution policy.",
		"Use send_agent to steer running work, wait_agent to wait, and interrupt_agent or close_agent for lifecycle control.",
		"Subagents are non-interactive: they cannot open user dialogs and must report questions in text.",
	];
}

function formatLaunch(summary: ReturnType<ManagedAgent["summary"]>): string {
	return `agent_id: ${summary.agent_id}\nstatus: ${summary.status}\ngeneration: ${summary.generation}\n\nCompletion will be delivered automatically. Use send_agent, followup_agent, wait_agent, interrupt_agent, or close_agent with this agent_id.`;
}

function formatCompletion(summary: ReturnType<ManagedAgent["summary"]>): string {
	return `agent_id: ${summary.agent_id}\nstatus: ${summary.status}\ngeneration: ${summary.generation}\n\n${summary.final_text || summary.error || "(no output)"}`;
}
