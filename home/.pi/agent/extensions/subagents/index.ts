/** Persistent in-process Pi SDK subagents with stable, session-runtime IDs. */

import type { ExtensionAPI, ExtensionContext, ScopedModel } from "@earendil-works/pi-coding-agent";
import { createSubagentRuntime } from "./bootstrap.ts";
import { buildCapabilityHint } from "./capability-hint.ts";
import { showAgentDashboard } from "./dashboard.ts";
import type { AgentSummary } from "./agent-types.ts";
import { createAgentsStatusTool } from "./tools/agents-status.ts";
import { createAnswerAgentTool } from "./tools/answer-agent.ts";
import { createCloseAgentTool } from "./tools/close-agent.ts";
import { createFollowupAgentTool } from "./tools/followup-agent.ts";
import { createReadAgentResultTool } from "./tools/read-agent-result.ts";
import { createSpawnAgentTool } from "./tools/spawn-agent.ts";
import { createSteerAgentTool } from "./tools/steer-agent.ts";
import { createWaitAgentsTool } from "./tools/wait-agents.ts";
import { missingSubagentTools, SubagentToolController } from "./tool-activation.ts";

export { isCompletionSuperseded } from "./bootstrap.ts";
export { createSpawnAgentSchema, WaitAgentsParamsSchema } from "./schemas.ts";

type CommandAPI = Pick<ExtensionAPI, "registerCommand">;

interface SubagentCommandRuntime {
	readonly registry: {
		hasStoredResults(): boolean;
		list(): AgentSummary[];
	};
}

export default function registerSubagents(pi: ExtensionAPI): void {
	const toolActivation = new SubagentToolController(pi);
	const runtime = createSubagentRuntime(toolActivation);

	pi.on("agent_settled", () => runtime.flushCompletions(pi));

	/** Re-registering replaces the definition and rebuilds the prompt from the new guidelines. */
	const registerSpawnAgent = (capabilityHint?: string): void => {
		pi.registerTool(
			createSpawnAgentTool(toolActivation, {
				agents: runtime.agents,
				profiles: runtime.profiles,
				agentDir: runtime.agentDir,
				admission: runtime.admission,
				registry: runtime.registry,
				ticks: runtime.ticks,
				onBackgroundComplete: (summary) => runtime.handleBackgroundComplete(pi, summary),
				onQuestion: (summary, question) => runtime.handleQuestion(pi, summary, question),
				claimUsage: (summary) => runtime.claimUsage(summary),
				...(capabilityHint === undefined ? {} : { capabilityHint }),
			}),
		);
	};

	/**
	 * The hint names the models the advertised profiles resolve to, which the parent cannot otherwise
	 * see: spawn_agent's guidelines only ever name profiles. It travels as a guideline rather than an
	 * appended prompt block so that it composes with prompt-owning extensions instead of being
	 * overwritten by whichever one runs last, and so a disabled spawn_agent drops it automatically.
	 */
	const applyCapabilityHint = (
		ctx: ExtensionContext,
		model: { readonly provider: string; readonly id: string } | undefined,
	): void => {
		const hint =
			model === undefined
				? undefined
				: buildCapabilityHint({
						config: runtime.profiles,
						agents: runtime.agents,
						availableModels:
							ctx.scopedModels ?? ctx.modelRegistry.getAvailable().map((entry): ScopedModel => ({ model: entry })),
						currentModel: model,
					});
		registerSpawnAgent(hint);
	};

	// Registered without a hint first so the tool exists before the session reports its model.
	registerSpawnAgent();
	/**
	 * The hint names the models the advertised profiles resolve to, which the parent cannot otherwise
	 * see: spawn_agent's guidelines only ever name profiles. It is delivered as a guideline rather than
	 * appended to the prompt so that it composes with prompt-owning extensions instead of being
	 * overwritten by whichever one runs last, and so a disabled spawn_agent drops it automatically.
	 */
	pi.on("session_start", (event, ctx) => {
		applyCapabilityHint(ctx, ctx.model);
		runtime.startSession(ctx);
		toolActivation.reset();
		if (runtime.restoredResultCount > 0) toolActivation.activate(["read_agent_result"]);
		const missing = missingSubagentTools(pi);
		if (missing.length > 0) {
			ctx.ui.notify(
				`Subagent tools excluded by the host allowlist cannot be deferred: ${missing.join(", ")}. Admit every subagent tool at launch; this extension will keep management tools inactive until needed.`,
				"warning",
			);
		}
	});
	pi.on("model_select", (event, ctx) => applyCapabilityHint(ctx, event.model));
	pi.on("session_shutdown", () => runtime.shutdown());
	registerSubagentsCommand(pi, toolActivation, runtime);
	pi.registerCommand("agents", {
		description: "Inspect and manage subagents owned by this session",
		handler: async (_args, ctx) => showAgentDashboard(ctx, runtime.registry),
	});

	pi.registerTool(
		createFollowupAgentTool(toolActivation, {
			registry: runtime.registry,
			ticks: runtime.ticks,
			claimUsage: (summary) => runtime.claimUsage(summary),
		}),
	);
	pi.registerTool(
		createSteerAgentTool({
			registry: runtime.registry,
		}),
	);
	pi.registerTool(
		createAnswerAgentTool({
			registry: runtime.registry,
		}),
	);
	pi.registerTool(
		createWaitAgentsTool(toolActivation, {
			registry: runtime.registry,
			claimUsage: (summary) => runtime.claimUsage(summary),
		}),
	);
	pi.registerTool(createReadAgentResultTool(runtime.registry));
	pi.registerTool(
		createCloseAgentTool({
			registry: runtime.registry,
		}),
	);
	pi.registerTool(
		createAgentsStatusTool({
			registry: runtime.registry,
			admission: runtime.admission,
		}),
	);
}

export function registerSubagentsCommand(
	pi: CommandAPI,
	tools: SubagentToolController,
	runtime: SubagentCommandRuntime,
): void {
	pi.registerCommand("subagents", {
		description: "Toggle subagent tools (enabled by default)",
		handler: async (_args, ctx) => {
			const enabled = tools.toggle();
			if (enabled) restoreUsefulTools(tools, runtime);
			ctx.ui.notify(
				enabled
					? "Subagents enabled."
					: "Subagents disabled. Existing agents continue running and remain available in /agents.",
				"info",
			);
		},
	});
}

function restoreUsefulTools(tools: SubagentToolController, runtime: SubagentCommandRuntime): void {
	const summaries = runtime.registry.list();
	if (runtime.registry.hasStoredResults()) tools.activate(["read_agent_result"]);
	for (const summary of summaries) {
		tools.activateForState(summary);
	}
}
