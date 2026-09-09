import type { ReadonlyRunDetails, RunUsage } from "./run-state.ts";
import type { AgentResultReference, GenerationResultLocator } from "./result-store.ts";
export type AgentPhase =
	| "created"
	| "starting"
	| "running"
	| "interrupting"
	| "idle"
	| "failed"
	| "aborted"
	| "closing"
	| "closed";

export type AgentStatus = Exclude<AgentPhase, "created" | "closing" | "interrupting">;

const LIFECYCLE_STATUS = {
	created: "starting",
	starting: "starting",
	running: "running",
	interrupting: "running",
	idle: "idle",
	failed: "failed",
	aborted: "aborted",
	closing: "closed",
	closed: "closed",
} as const satisfies Record<AgentPhase, AgentStatus>;

export function isAgentActive(status: AgentStatus): boolean {
	return status === "starting" || status === "running";
}

/** Reject a request naming a generation that is no longer current. */
export function assertCurrentGeneration(summary: AgentSummary, generation: number): void {
	if (summary.generation !== generation) {
		throw new Error(
			`Agent '${summary.task_name}' is at generation ${summary.generation} (status: ${summary.status}); target generation ${generation} is stale and was not affected.`,
		);
	}
}

/** Reject a request naming a generation that does not exist yet. */
export function futureGenerationError(summary: AgentSummary, generation: number): Error {
	return new Error(
		`Agent '${summary.task_name}' is at generation ${summary.generation}; target generation ${generation} does not exist yet.`,
	);
}

export interface AgentQuestion {
	readonly question_id: string;
	readonly question: string;
	readonly options: readonly string[];
}

export interface AgentSummary {
	readonly agent_id: string;
	readonly agent: string;
	readonly task_name: string;
	readonly profile: string;
	readonly model: string;
	readonly effective_thinking: string;
	readonly session_id?: string;
	readonly session_file?: string;
	readonly generation: number;
	readonly retained: boolean;
	readonly status: AgentStatus;
	/** Terminal execution outcome preserved when status becomes closed. */
	readonly outcome?: "succeeded" | "failed" | "aborted";
	readonly started_at: number;
	readonly ended_at?: number;
	readonly duration_ms?: number;
	readonly usage: Readonly<RunUsage>;
	readonly final_text?: string;
	readonly result?: AgentResultReference;
	readonly result_locator?: GenerationResultLocator;
	readonly error?: string;
	readonly pending_question?: AgentQuestion;
}

export interface AgentView {
	readonly summary: AgentSummary;
	readonly details: ReadonlyRunDetails;
}

/** Internal reason used to release every wait in a wave when one child needs input. */
export class AgentWaitDeferredReason extends Error {
	constructor() {
		super("Another agent in this wait wave needs input.");
		this.name = "AgentWaitDeferredReason";
	}
}

/** A wait ended because the parent stopped waiting; the child's run continues unaffected. */
export class AgentWaitInterruptedError extends Error {
	constructor(agentId: string, cause?: unknown) {
		super(`Waiting for agent ${agentId} was aborted.`, { cause });
		this.name = "AgentWaitInterruptedError";
	}
}

export function lifecycleStatus(lifecycle: { readonly phase: AgentPhase }): AgentStatus {
	return LIFECYCLE_STATUS[lifecycle.phase];
}

export class CleanupAggregateError extends AggregateError {
	constructor(owner: string, errors: readonly unknown[]) {
		super(errors, `${owner} cleanup failed in ${errors.length} operation${errors.length === 1 ? "" : "s"}.`);
		this.name = "CleanupAggregateError";
	}
}
