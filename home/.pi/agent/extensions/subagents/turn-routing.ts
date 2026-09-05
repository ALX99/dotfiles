import type { AgentPhase } from "./agent-types.ts";

/** Every message-bearing operation that can enter a managed child session. */
export type AgentTurnInput = StartTurnInput | FollowUpTurnInput | SteerTurnInput | AnswerTurnInput;

export interface StartTurnInput {
	readonly kind: "start";
	readonly message: string;
	readonly handoff: string | undefined;
	readonly taskName: string;
	readonly background: boolean;
	readonly signal: AbortSignal | undefined;
}

export interface FollowUpTurnInput {
	readonly kind: "follow_up";
	readonly message: string;
	readonly taskName: string;
	readonly background: boolean;
	readonly signal: AbortSignal | undefined;
}

export interface SteerTurnInput {
	readonly kind: "steer";
	readonly message: string;
}

export interface AnswerTurnInput {
	readonly kind: "answer";
	readonly questionId: string;
	readonly answer: string;
}

/** The small, synchronous state snapshot used to admit exactly one input path. */
export interface AgentTurnRoutingState {
	readonly agentId: string;
	readonly phase: AgentPhase;
	readonly retained: boolean;
	readonly hasSession: boolean;
	readonly pendingQuestionId: string | undefined;
}

export type AgentTurnRoute =
	| { readonly action: "open_and_launch"; readonly input: StartTurnInput }
	| { readonly action: "launch"; readonly input: FollowUpTurnInput }
	| { readonly action: "steer"; readonly input: SteerTurnInput }
	| { readonly action: "answer"; readonly input: AnswerTurnInput };

export type AgentTurnRejection =
	| "already_started"
	| "not_started"
	| "one_shot"
	| "closed"
	| "turn_active"
	| "not_running"
	| "question_pending"
	| "question_not_found";

/** A typed admission failure keeps callers from inferring state from prose. */
export class AgentTurnRoutingError extends Error {
	readonly code: AgentTurnRejection;

	constructor(code: AgentTurnRejection, message: string) {
		super(message);
		this.name = "AgentTurnRoutingError";
		this.code = code;
	}
}

/**
 * Decide whether an input starts a child generation, launches its next one,
 * steers the active generation, answers it, or is rejected. This stays pure so
 * admission is testable and every caller follows the same state-machine rules.
 */
export function routeAgentTurnInput(state: AgentTurnRoutingState, input: AgentTurnInput): AgentTurnRoute {
	switch (input.kind) {
		case "start":
			if (state.phase !== "created") throw reject(state, "already_started");
			return { action: "open_and_launch", input };
		case "follow_up":
			if (!state.retained) throw reject(state, "one_shot");
			if (state.phase === "closed" || state.phase === "closing") throw reject(state, "closed");
			if (state.pendingQuestionId) throw reject(state, "question_pending");
			if (state.phase === "starting" || state.phase === "running" || state.phase === "interrupting")
				throw reject(state, "turn_active");
			if (!state.hasSession) throw reject(state, "not_started");
			return { action: "launch", input };
		case "steer":
			if (!state.hasSession || (state.phase !== "starting" && state.phase !== "running")) {
				throw reject(state, "not_running");
			}
			if (state.pendingQuestionId) throw reject(state, "question_pending");
			return { action: "steer", input };
		case "answer":
			if (state.pendingQuestionId !== input.questionId) throw reject(state, "question_not_found", input.questionId);
			return { action: "answer", input };
		default:
			throw new Error("Unsupported agent turn input.");
	}
}

function reject(state: AgentTurnRoutingState, code: AgentTurnRejection, questionId?: string): AgentTurnRoutingError {
	const messages: Record<AgentTurnRejection, string> = {
		already_started: "Subagent already started.",
		not_started: `Agent ${state.agentId} has not started; use spawn_agent before a follow-up.`,
		one_shot: `Agent ${state.agentId} is one-shot. Spawn with retain:true before using followup_agent.`,
		closed: `Agent ${state.agentId} is closed.`,
		turn_active: `Agent ${state.agentId} is still running; use send_agent or wait_agent before a follow-up.`,
		not_running: `Agent ${state.agentId} is not running.`,
		question_pending: state.pendingQuestionId
			? `Agent ${state.agentId} is waiting for '${state.pendingQuestionId}'; use answer_agent.`
			: `Agent ${state.agentId} is waiting for input; use answer_agent.`,
		question_not_found: `Agent ${state.agentId} has no pending question '${questionId ?? ""}'.`,
	};
	return new AgentTurnRoutingError(code, messages[code]);
}
