import type { ReadonlyRunDetails } from "./run-state.ts";

export type AgentLifecycle =
	| { readonly phase: "created"; readonly generation: 0 }
	| { readonly phase: "starting"; readonly generation: number }
	| { readonly phase: "running"; readonly generation: number }
	| { readonly phase: "idle"; readonly generation: number }
	| { readonly phase: "failed"; readonly generation: number; readonly error: Error }
	| { readonly phase: "aborted"; readonly generation: number }
	| { readonly phase: "closing"; readonly generation: number }
	| { readonly phase: "closed"; readonly generation: number };

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
	if (current.phase === next.phase && current.generation === next.generation) return current;
	if (!ALLOWED_TRANSITIONS[current.phase].includes(next.phase)) {
		throw new Error(`Invalid agent lifecycle transition '${current.phase}' -> '${next.phase}'.`);
	}
	if (
		next.phase !== "closed" &&
		next.phase !== "closing" &&
		next.phase !== "created" &&
		next.generation < current.generation
	) {
		throw new Error(`Stale agent generation ${next.generation}; current generation is ${current.generation}.`);
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
