/** Persistent RPC-backed subagents with stable, session-runtime IDs. */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { bootstrapSubagents, registerSubagentLifecycle } from "./bootstrap.ts";
import { showAgentDashboard } from "./dashboard/controller.ts";
import { createCloseAgentTool } from "./tools/close-agent.ts";
import { createFollowupAgentTool } from "./tools/followup-agent.ts";
import { createInterruptAgentTool } from "./tools/interrupt-agent.ts";
import { createListAgentsTool } from "./tools/list-agents.ts";
import { createSendAgentTool } from "./tools/send-agent.ts";
import { createSpawnAgentTool } from "./tools/spawn-agent.ts";
import { createWaitAgentTool } from "./tools/wait-agent.ts";

export { isCompletionSuperseded } from "./bootstrap.ts";
export { createSpawnAgentSchema, createWaitAgentSchema, WaitAgentParamsSchema } from "./schemas.ts";
export { DEFAULT_WAIT_MS } from "./tools/wait-agent.ts";

export default function registerSubagents(pi: ExtensionAPI): void {
	const runtime = bootstrapSubagents();
	if (!runtime) return;

	registerSubagentLifecycle(pi, runtime);
	pi.registerCommand("agents", {
		description: "Inspect and manage subagents owned by this session",
		handler: async (_args, ctx) => showAgentDashboard(ctx, runtime.registry),
	});

	pi.registerTool(createSpawnAgentTool(pi, runtime));
	pi.registerTool(createSendAgentTool(runtime));
	pi.registerTool(createFollowupAgentTool(runtime));
	pi.registerTool(createWaitAgentTool(runtime));
	pi.registerTool(createListAgentsTool(runtime));
	pi.registerTool(createInterruptAgentTool(runtime));
	pi.registerTool(createCloseAgentTool(runtime));
}
