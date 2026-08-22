/** Persistent in-process Pi SDK subagents with stable, session-runtime IDs. */

import type { ExtensionAPI, ScopedModel } from "@earendil-works/pi-coding-agent";
import { createSubagentRuntime } from "./bootstrap.ts";
import { buildCapabilityHint, findScopedRankingError } from "./capability-hint.ts";
import { showAgentDashboard } from "./dashboard.ts";
import { isAgentActive, type AgentSummary } from "./agent-types.ts";
import { createFollowupAgentTool } from "./tools/followup-agent.ts";
import { createManagementTools } from "./tools/management-tools.ts";
import { createReadAgentResultTool } from "./tools/read-agent-result.ts";
import { createSpawnAgentTool } from "./tools/spawn-agent.ts";
import { createWaitAgentTool } from "./tools/wait-agent.ts";
import { missingSubagentTools, SubagentToolController, deactivateSubagentTools } from "./tool-activation.ts";

export { isCompletionSuperseded } from "./bootstrap.ts";
export { createSpawnAgentSchema, WaitAgentParamsSchema } from "./schemas.ts";

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
	const managementTools = createManagementTools({ registry: runtime.registry, admission: runtime.admission });

	pi.on("session_start", (_event, ctx) => {
		const rankingError = findScopedRankingError(runtime.profiles, ctx.scopedModels);
		if (rankingError) {
			// The runner catches handler throws and reports them; keep the failure
			// visible in the TUI and leave this session without subagent tools.
			deactivateSubagentTools(pi);
			ctx.ui.notify(rankingError, "error");
			throw new Error(rankingError);
		}
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
	pi.on("agent_settled", () => runtime.flushCompletions(pi));
	pi.on("before_agent_start", (event, ctx) => {
		if (!toolActivation.enabled || !ctx.model) return;
		if (!event.systemPromptOptions?.selectedTools?.includes("spawn_agent")) return;
		// An empty scope means every authenticated model is usable, mirroring resolveRun.
		const scopedModels = ctx.scopedModels;
		const hint = buildCapabilityHint({
			config: runtime.profiles,
			agents: runtime.agents,
			availableModels:
				scopedModels && scopedModels.length > 0
					? scopedModels
					: ctx.modelRegistry.getAvailable().map((model): ScopedModel => ({ model })),
			currentModel: ctx.model,
		});
		return hint ? { systemPrompt: `${event.systemPrompt}\n\n${hint}` } : undefined;
	});
	pi.on("session_shutdown", () => runtime.shutdown());
	registerSubagentsCommand(pi, toolActivation, runtime);
	pi.registerCommand("agents", {
		description: "Inspect and manage subagents owned by this session",
		handler: async (_args, ctx) => showAgentDashboard(ctx, runtime.registry),
	});

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
		}),
	);
	pi.registerTool(managementTools.answer_agent);
	pi.registerTool(managementTools.send_agent);
	pi.registerTool(
		createFollowupAgentTool(toolActivation, {
			registry: runtime.registry,
			ticks: runtime.ticks,
			claimUsage: (summary) => runtime.claimUsage(summary),
		}),
	);
	pi.registerTool(
		createWaitAgentTool(toolActivation, {
			registry: runtime.registry,
			consumeSettledCompletions: (summaries) => runtime.consumeSettledCompletions(summaries),
			claimUsage: (summary) => runtime.claimUsage(summary),
		}),
	);
	pi.registerTool(managementTools.list_agents);
	pi.registerTool(createReadAgentResultTool(runtime.registry));
	pi.registerTool(managementTools.interrupt_agent);
	pi.registerTool(managementTools.close_agent);
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
		const background = isAgentActive(summary.status);
		tools.activateForState(summary, background);
	}
}
