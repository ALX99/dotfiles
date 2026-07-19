import type { ReadonlyRunDetails } from "./run-state.ts";

export type AgentLifecycle =
	| { readonly phase: "created" }
	| { readonly phase: "starting" }
	| { readonly phase: "running" }
	| { readonly phase: "idle" }
	| { readonly phase: "failed"; readonly error: Error }
	| { readonly phase: "aborted" }
	| { readonly phase: "closing" }
	| { readonly phase: "closed" };

export type AgentStatus = Exclude<AgentLifecycle["phase"], "created" | "closing">;

export interface AgentSummary {
	readonly agent_id: string;
	readonly agent: string;
	readonly task_name: string;
	readonly profile: string;
	readonly model: string;
	readonly effective_thinking: string;
	readonly session_file?: string;
	readonly depth: number;
	readonly generation: number;
	readonly status: AgentStatus;
	readonly final_text?: string;
	readonly error?: string;
}

export interface AgentView {
	readonly summary: AgentSummary;
	readonly details: ReadonlyRunDetails;
}

export type WaitInterruptionKind = "timed_out" | "cancelled";

/** A wait ended without changing the subagent's underlying run. */
export class AgentWaitInterruptedError extends Error {
	readonly kind: WaitInterruptionKind;

	constructor(kind: WaitInterruptionKind, agentId: string, cause?: unknown) {
		super(
			kind === "timed_out" ? `Timed out waiting for agent ${agentId}.` : `Waiting for agent ${agentId} was aborted.`,
			{ cause },
		);
		this.name = "AgentWaitInterruptedError";
		this.kind = kind;
	}
}

const ALLOWED_TRANSITIONS: Readonly<Record<AgentLifecycle["phase"], readonly AgentLifecycle["phase"][]>> = {
	created: ["starting", "closing"],
	starting: ["running", "idle", "failed", "aborted", "closing"],
	running: ["idle", "failed", "aborted", "closing"],
	idle: ["starting", "failed", "closing"],
	failed: ["starting", "closing"],
	aborted: ["idle", "failed", "starting", "closing"],
	closing: ["closed"],
	closed: [],
};

export function transitionLifecycle(current: AgentLifecycle, next: AgentLifecycle): AgentLifecycle {
	if (current.phase === next.phase) return current;
	if (!ALLOWED_TRANSITIONS[current.phase].includes(next.phase)) {
		throw new Error(`Invalid agent lifecycle transition '${current.phase}' -> '${next.phase}'.`);
	}
	return next;
}

export function lifecycleStatus(lifecycle: AgentLifecycle): AgentStatus {
	switch (lifecycle.phase) {
		case "created":
		case "starting":
			return "starting";
		case "running":
			return "running";
		case "idle":
			return "idle";
		case "failed":
			return "failed";
		case "aborted":
			return "aborted";
		case "closing":
		case "closed":
			return "closed";
	}
}

export class CleanupAggregateError extends AggregateError {
	constructor(owner: string, errors: readonly unknown[]) {
		super(errors, `${owner} cleanup failed in ${errors.length} operation${errors.length === 1 ? "" : "s"}.`);
		this.name = "CleanupAggregateError";
	}
}
