/** Persistent RPC-backed subagents with stable, session-runtime IDs. */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { bootstrapSubagents, registerSubagentLifecycle } from "./bootstrap.ts";
import { registerChildExecutionRuntime } from "./child-runtime.ts";
import { parseChildExecutionContext } from "./child-process.ts";
import { showAgentDashboard } from "./dashboard.ts";
import { createAnswerAgentTool } from "./tools/answer-agent.ts";
import { createCloseAgentTool } from "./tools/close-agent.ts";
import { createFollowupAgentTool } from "./tools/followup-agent.ts";
import { createInterruptAgentTool } from "./tools/interrupt-agent.ts";
import { createListAgentsTool } from "./tools/list-agents.ts";
import { createReadAgentResultTool } from "./tools/read-agent-result.ts";
import { createSendAgentTool } from "./tools/send-agent.ts";
import { createSpawnAgentTool } from "./tools/spawn-agent.ts";
import { createWaitAgentTool } from "./tools/wait-agent.ts";
import { resetSubagentTools } from "./tool-activation.ts";

export { isCompletionSuperseded } from "./bootstrap.ts";
export { createSpawnAgentSchema, createWaitAgentSchema, WaitAgentParamsSchema } from "./schemas.ts";
export { DEFAULT_WAIT_MS } from "./tools/wait-agent.ts";

export default function registerSubagents(pi: ExtensionAPI): void {
	const childContext = parseChildExecutionContext();
	if (childContext) {
		registerChildExecutionRuntime(pi, childContext);
		return;
	}
	const runtime = bootstrapSubagents();

	registerSubagentLifecycle(pi, runtime);
	pi.on("session_start", () => resetSubagentTools(pi));
	pi.registerCommand("agents", {
		description: "Inspect and manage subagents owned by this session",
		handler: async (_args, ctx) => showAgentDashboard(ctx, runtime.registry),
	});

	pi.registerTool(createSpawnAgentTool(pi, runtime));
	pi.registerTool(createAnswerAgentTool(runtime));
	pi.registerTool(createSendAgentTool(runtime));
	pi.registerTool(createFollowupAgentTool(pi, runtime));
	pi.registerTool(createWaitAgentTool(pi, runtime));
	pi.registerTool(createListAgentsTool(runtime));
	pi.registerTool(createReadAgentResultTool(runtime));
	pi.registerTool(createInterruptAgentTool(runtime));
	pi.registerTool(createCloseAgentTool(runtime));
}
