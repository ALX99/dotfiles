import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { ApplicationEffects } from "../application.ts";
import type { ProfileCapabilityPolicy } from "./policy.ts";
import type { AgentChildCommunication, AgentWorkflows } from "./workflows.ts";
import {
	registerAgentTools,
	type AgentToolHandlers,
	type AnswerAgentParams,
	type AskParentParams,
	type CancelAgentParams,
	type InspectAgentParams,
	type ListAgentsParams,
	type SendAgentParams,
	type SpawnAgentParams,
	type WaitAgentParams,
} from "./tools.ts";

/** Bind model-facing tools to the active session workflows. Only child runtimes receive ask_parent. */
export function registerAgentWorkflowTools(
	pi: ExtensionAPI,
	getWorkflows: () => AgentWorkflows | undefined,
	applicationEffects: ApplicationEffects,
	parentCommunication?: AgentChildCommunication,
	capabilityPolicy?: ProfileCapabilityPolicy,
): void {
	const workflows = (): AgentWorkflows => {
		const active = getWorkflows();
		if (active === undefined) throw new Error("Agent workflows are not ready for this Pi session.");
		return active;
	};
	const handlers: AgentToolHandlers = {
		spawn: (_toolCallId, params: SpawnAgentParams, signal, _ctx) =>
			runWithSignal(applicationEffects, workflows().spawnAgent(params), signal).then(asAgentToolResult),
		wait: (_toolCallId, params: WaitAgentParams, signal, _ctx) =>
			runWithSignal(applicationEffects, workflows().waitAgent(params.agents), signal).then((events) =>
				asAgentToolResult({ events }),
			),
		send: (_toolCallId, params: SendAgentParams, signal, _ctx) => {
			const effect = workflows().sendAgent(params.agent, params.message, params.mode, params.wait);
			const run = params.wait ? runWithSignal(applicationEffects, effect, signal) : applicationEffects.run(effect);
			return run.then(asAgentToolResult);
		},
		answer: (_toolCallId, params: AnswerAgentParams, _ctx) =>
			applicationEffects
				.run(workflows().answerAgent(params.agent, params.answer))
				.then((request) => asAgentToolResult({ agent: params.agent, status: "resumed", request: request.message })),
		cancel: (_toolCallId, params: CancelAgentParams, _ctx) =>
			applicationEffects.run(workflows().cancelAgent(params.agent)).then(asAgentToolResult),
		list: (_toolCallId, _params: ListAgentsParams, _ctx) =>
			applicationEffects.run(workflows().listAgents()).then(asAgentToolResult),
		inspect: (_toolCallId, params: InspectAgentParams, _ctx) =>
			applicationEffects.run(workflows().inspectAgent(params.agent)).then(asAgentToolResult),
		...(parentCommunication === undefined
			? {}
			: {
					askParent: (_toolCallId, params: AskParentParams, signal, _ctx) =>
						runWithSignal(
							applicationEffects,
							parentCommunication.askParent(params.message, params.options),
							signal,
						).then((answer) => asAgentToolResult({ answer })),
				}),
	};

	registerAgentTools(pi, handlers, capabilityPolicy?.spawnProfiles);
}

function runWithSignal<A, E>(
	applicationEffects: ApplicationEffects,
	effect: import("effect").Effect.Effect<A, E>,
	signal: AbortSignal | undefined,
): Promise<A> {
	return signal === undefined ? applicationEffects.run(effect) : applicationEffects.run(effect, { signal });
}

function asAgentToolResult(value: unknown): AgentToolResult<unknown> {
	return {
		content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
		details: value,
	};
}
