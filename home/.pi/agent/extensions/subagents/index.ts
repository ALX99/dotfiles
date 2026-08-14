/** Persistent RPC-backed subagents with stable, session-runtime IDs. */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { bootstrapSubagents, registerSubagentLifecycle } from "./bootstrap.ts";
import { parseChildExecutionContext } from "./child-process.ts";
import { showAgentDashboard } from "./dashboard.ts";
import type { AgentSummary } from "./agent-types.ts";
import { createAnswerAgentTool } from "./tools/answer-agent.ts";
import { createCloseAgentTool } from "./tools/close-agent.ts";
import { createFollowupAgentTool } from "./tools/followup-agent.ts";
import { createInterruptAgentTool } from "./tools/interrupt-agent.ts";
import { createListAgentsTool } from "./tools/list-agents.ts";
import { createReadAgentResultTool } from "./tools/read-agent-result.ts";
import { createSendAgentTool } from "./tools/send-agent.ts";
import { createSpawnAgentTool } from "./tools/spawn-agent.ts";
import { createWaitAgentTool } from "./tools/wait-agent.ts";
import { missingSubagentTools, SubagentToolController } from "./tool-activation.ts";

export { isCompletionSuperseded } from "./bootstrap.ts";
export { createSpawnAgentSchema, WaitAgentParamsSchema } from "./schemas.ts";
export { DEFAULT_WAIT_MS } from "./tools/wait-agent.ts";

type CommandAPI = Pick<ExtensionAPI, "registerCommand">;

interface SubagentCommandRuntime {
	readonly registry: {
		hasStoredResults(): boolean;
		list(): AgentSummary[];
	};
}

export default function registerSubagents(pi: ExtensionAPI): void {
	const childContext = parseChildExecutionContext();
	if (childContext) return;
	const toolActivation = new SubagentToolController(pi);
	const runtime = bootstrapSubagents(toolActivation);

	registerSubagentLifecycle(pi, runtime);
	pi.on("session_start", (_event, ctx) => {
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
	pi.registerTool(createAnswerAgentTool({ registry: runtime.registry }));
	pi.registerTool(createSendAgentTool({ registry: runtime.registry }));
	pi.registerTool(
		createFollowupAgentTool(toolActivation, {
			registry: {
				getLive: (id) => runtime.registry.getLive(id),
				list: () => runtime.registry.list(),
			},
			ticks: runtime.ticks,
			claimUsage: (summary) => runtime.claimUsage(summary),
		}),
	);
	pi.registerTool(
		createWaitAgentTool(toolActivation, {
			registry: {
				wait: (id, timeoutMs, signal) => runtime.registry.wait(id, timeoutMs, signal),
				summary: (id) => runtime.registry.summary(id),
				list: () => runtime.registry.list(),
			},
			consumeSettledCompletions: (summaries) => runtime.consumeSettledCompletions(summaries),
			claimUsage: (summary) => runtime.claimUsage(summary),
		}),
	);
	pi.registerTool(createListAgentsTool({ registry: runtime.registry, admission: runtime.admission }));
	pi.registerTool(createReadAgentResultTool(runtime.registry));
	pi.registerTool(createInterruptAgentTool({ registry: runtime.registry }));
	pi.registerTool(createCloseAgentTool({ registry: runtime.registry }));
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
		const background = summary.status === "starting" || summary.status === "running";
		tools.activateForState(summary, background);
	}
}
