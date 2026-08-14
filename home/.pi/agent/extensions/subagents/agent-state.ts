import type { AgentQuestion } from "./agent-types.ts";
import type { MutableRunData, ReadonlyRunDetails } from "./run-state.ts";

/**
 * A generation has one terminal lifecycle. Process ownership belongs to the
 * enclosing child session, so it is deliberately not represented here.
 */
export type GenerationPhase = "starting" | "running" | "idle" | "failed" | "aborted";

/** Lifecycle visible from the stable agent facade. */
export type AgentPhase = "created" | GenerationPhase | "closing" | "closed";

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

interface GenerationStateBase {
	readonly generation: number;
	readonly run: MutableRunData;
}

type ActiveGenerationPhase = "starting" | "running" | "aborted";

export type ActiveGenerationState<P extends ActiveGenerationPhase = ActiveGenerationPhase> = GenerationStateBase & {
	readonly phase: P;
	readonly completion: RunCompletion;
	readonly question: QuestionInteraction;
};

export type IdleGenerationState = GenerationStateBase & { readonly phase: "idle"; readonly completion: RunCompletion };
export type FailedGenerationState = GenerationStateBase & {
	readonly phase: "failed";
	readonly completion: RunCompletion;
	readonly error: Error;
	readonly recovery?: Promise<void>;
};

export type GenerationState =
	| ActiveGenerationState<"starting">
	| ActiveGenerationState<"running">
	| ActiveGenerationState<"aborted">
	| IdleGenerationState
	| FailedGenerationState;

export function isActiveGeneration(state: GenerationState): state is ActiveGenerationState {
	return state.phase === "starting" || state.phase === "running" || state.phase === "aborted";
}

export function beginGeneration(run: MutableRunData, completion: RunCompletion): ActiveGenerationState<"starting"> {
	return {
		phase: "starting",
		generation: completion.generation,
		run,
		completion,
		question: { kind: "waiting", signal: newQuestionSignal() },
	};
}

export function markGenerationRunning(state: ActiveGenerationState<"starting">): ActiveGenerationState<"running"> {
	return { ...state, phase: "running" };
}

export function markGenerationAborted(
	state: ActiveGenerationState<"starting"> | ActiveGenerationState<"running">,
): ActiveGenerationState<"aborted"> {
	return {
		...state,
		phase: "aborted",
		question: { kind: "waiting", signal: newQuestionSignal() },
	};
}

export function updateGenerationQuestion(
	state: ActiveGenerationState,
	question: QuestionInteraction,
): ActiveGenerationState {
	return { ...state, question };
}

export function markGenerationIdle(
	state: ActiveGenerationState<"starting"> | ActiveGenerationState<"running">,
): IdleGenerationState {
	return {
		phase: "idle",
		generation: state.generation,
		run: state.run,
		completion: state.completion,
	};
}

export function markGenerationFailed(
	state: ActiveGenerationState | IdleGenerationState,
	error: Error,
	recovery?: Promise<void>,
): FailedGenerationState {
	return {
		phase: "failed",
		generation: state.generation,
		run: state.run,
		completion: state.completion,
		error,
		...(recovery === undefined ? {} : { recovery }),
	};
}

export function newQuestionSignal(): QuestionSignal {
	const { promise, resolve } = Promise.withResolvers<AgentQuestion>();
	return { promise, resolve, settled: false };
}
