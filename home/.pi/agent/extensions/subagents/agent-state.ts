import type { AgentQuestion } from "./agent-types.ts";
import type { MutableRunData, ReadonlyRunDetails } from "./run-state.ts";

export type AgentPhase = "created" | "starting" | "running" | "idle" | "failed" | "aborted" | "closing" | "closed";

export interface QuestionSignal {
	readonly promise: Promise<AgentQuestion>;
	readonly resolve: (question: AgentQuestion) => void;
	settled: boolean;
}

export type QuestionInteraction =
	| { readonly kind: "waiting"; readonly signal: QuestionSignal }
	| { readonly kind: "pending"; readonly question: AgentQuestion; readonly signal: QuestionSignal }
	| { readonly kind: "custom-answer"; readonly answer: string; readonly signal: QuestionSignal };

export interface RunCompletion {
	readonly generation: number;
	readonly promise: Promise<ReadonlyRunDetails>;
	readonly resolve: (details: ReadonlyRunDetails) => void;
	readonly reject: (error: Error) => void;
	settled: boolean;
}

interface StateBase {
	readonly generation: number;
	readonly run: MutableRunData;
}

type ActivePhase = "starting" | "running" | "aborted";

export type ActiveAgentState<P extends ActivePhase = ActivePhase> = StateBase & {
	readonly phase: P;
	readonly completion: RunCompletion;
	readonly question: QuestionInteraction;
};

type IdleAgentState = StateBase & { readonly phase: "idle"; readonly completion: RunCompletion };
type FailedAgentState = StateBase & {
	readonly phase: "failed";
	readonly completion: RunCompletion;
	readonly error: Error;
	readonly recovery?: Promise<void>;
};
type ClosingAgentState = StateBase & { readonly phase: "closing"; readonly completion?: RunCompletion };

export type AgentState =
	| (StateBase & { readonly phase: "created"; readonly generation: 0 })
	| ActiveAgentState<"starting">
	| ActiveAgentState<"running">
	| ActiveAgentState<"aborted">
	| IdleAgentState
	| FailedAgentState
	| ClosingAgentState
	| (StateBase & { readonly phase: "closed"; readonly completion?: RunCompletion });

export function isActiveState(state: AgentState): state is ActiveAgentState {
	return state.phase === "starting" || state.phase === "running" || state.phase === "aborted";
}

export function beginAgentRun(run: MutableRunData, completion: RunCompletion): ActiveAgentState<"starting"> {
	return {
		phase: "starting",
		generation: completion.generation,
		run,
		completion,
		question: { kind: "waiting", signal: newQuestionSignal() },
	};
}

export function markAgentRunning(state: ActiveAgentState<"starting">): ActiveAgentState<"running"> {
	return { ...state, phase: "running" };
}

export function markAgentAborted(
	state: ActiveAgentState<"starting"> | ActiveAgentState<"running">,
): ActiveAgentState<"aborted"> {
	return {
		...state,
		phase: "aborted",
		question: { kind: "waiting", signal: newQuestionSignal() },
	};
}

export function updateAgentQuestion(state: ActiveAgentState, question: QuestionInteraction): ActiveAgentState {
	return { ...state, question };
}

export function markAgentIdle(state: ActiveAgentState<"starting"> | ActiveAgentState<"running">): IdleAgentState {
	return {
		phase: "idle",
		generation: state.generation,
		run: state.run,
		completion: state.completion,
	};
}

export function markAgentFailed(
	state: ActiveAgentState | IdleAgentState,
	error: Error,
	recovery?: Promise<void>,
): FailedAgentState {
	return {
		phase: "failed",
		generation: state.generation,
		run: state.run,
		completion: state.completion,
		error,
		...(recovery === undefined ? {} : { recovery }),
	};
}

export function markAgentClosing(state: Exclude<AgentState, { readonly phase: "closed" }>): ClosingAgentState {
	return {
		phase: "closing",
		generation: state.generation,
		run: state.run,
		...("completion" in state ? { completion: state.completion } : {}),
	};
}

export function markAgentClosed(state: AgentState): AgentState {
	if (state.phase !== "closing") throw new Error(`Invalid agent lifecycle transition '${state.phase}' -> 'closed'.`);
	return {
		phase: "closed",
		generation: state.generation,
		run: state.run,
		...("completion" in state ? { completion: state.completion } : {}),
	};
}

export function newQuestionSignal(): QuestionSignal {
	const { promise, resolve } = Promise.withResolvers<AgentQuestion>();
	return { promise, resolve, settled: false };
}
