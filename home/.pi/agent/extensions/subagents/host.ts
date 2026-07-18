/** Compatibility facade for the split subagent host core. */
export { AgentRegistry, DEFAULT_MAX_CLOSED_AGENT_HISTORY, type RegisteredAgent } from "./agent-registry.ts";
export {
	CleanupAggregateError,
	lifecycleStatus,
	transitionLifecycle,
	type AgentLifecycle,
	type AgentStatus,
	type AgentSummary,
	type AgentView,
} from "./agent-types.ts";
export { buildAgentSystemPrompt, childEnvironment, ManagedAgent, type ManagedAgentOptions } from "./managed-agent.ts";
export { executionCanDelegate, SpawnAdmissionController, type SpawnAdmissionRequest } from "./spawn-admission.ts";
