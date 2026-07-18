import { CleanupAggregateError, type AgentLifecycle, type AgentSummary, type AgentView } from "./agent-types.ts";
import { ManagedAgent } from "./managed-agent.ts";
import type { ReadonlyRunDetails } from "./run-state.ts";

/** Closed agents retain dashboard and tool result metadata, but no process resources. */
export const DEFAULT_MAX_CLOSED_AGENT_HISTORY = 32;

export interface RegisteredAgent {
	readonly id: string;
	getLifecycle(): AgentLifecycle;
	summary(): AgentSummary;
	getDetails(): ReadonlyRunDetails;
	subscribe(listener: () => void): () => void;
	steer(message: string): Promise<void>;
	getMessages(): Promise<unknown[]>;
	loadFullOutput(): Promise<string>;
	followUp(message: string, taskName: string, background: boolean, signal?: AbortSignal): Promise<ReadonlyRunDetails>;
	wait(timeoutMs?: number, signal?: AbortSignal): Promise<ReadonlyRunDetails>;
	interrupt(): Promise<void>;
	close(): Promise<void>;
	isAvailable(): boolean;
}

class ClosedAgent implements RegisteredAgent {
	readonly id: string;
	private readonly archivedSummary: AgentSummary;
	private readonly archivedDetails: ReadonlyRunDetails;

	constructor(agent: ManagedAgent) {
		this.id = agent.id;
		this.archivedSummary = Object.freeze({ ...agent.summary(), status: "closed" });
		this.archivedDetails = freezeDetails({ ...agent.getDetails(), status: "closed" });
	}

	getLifecycle(): AgentLifecycle {
		return { phase: "closed", generation: this.archivedSummary.generation };
	}

	summary(): AgentSummary {
		return this.archivedSummary;
	}

	getDetails(): ReadonlyRunDetails {
		return this.archivedDetails;
	}

	subscribe(): () => void {
		return () => {};
	}

	async steer(): Promise<void> {
		throw new Error(`Agent ${this.id} is not running.`);
	}

	async getMessages(): Promise<unknown[]> {
		throw new Error(`Agent ${this.id} is not available.`);
	}

	async loadFullOutput(): Promise<string> {
		// ManagedAgent closes and deletes its output spool, so the dashboard uses finalText as its fallback.
		return "";
	}

	async followUp(): Promise<ReadonlyRunDetails> {
		throw new Error(`Agent ${this.id} process is dead; close it and spawn a replacement before following up.`);
	}

	async wait(): Promise<ReadonlyRunDetails> {
		return this.archivedDetails;
	}

	async interrupt(): Promise<void> {
		// Interrupting a closed ManagedAgent is intentionally a no-op.
	}

	async close(): Promise<void> {
		// Closing a closed ManagedAgent is intentionally a no-op.
	}

	isAvailable(): boolean {
		return false;
	}
}

export class AgentRegistry {
	private readonly agents = new Map<string, RegisteredAgent>();
	private readonly agentUnsubscribers = new Map<string, () => void>();
	private readonly closedAgentIds: string[] = [];
	private readonly listeners = new Set<() => void>();

	async add(agent: ManagedAgent): Promise<void> {
		const replaced = this.agents.get(agent.id);
		if (replaced === agent) return;
		if (replaced instanceof ManagedAgent) await this.close(agent.id);
		this.removeClosedAgentId(agent.id);
		this.agentUnsubscribers.get(agent.id)?.();
		this.agentUnsubscribers.delete(agent.id);
		this.agents.set(agent.id, agent);
		this.agentUnsubscribers.set(
			agent.id,
			agent.subscribe(() => this.handleAgentUpdate(agent)),
		);
		this.emit();
	}

	get(id: string): RegisteredAgent {
		const agent = this.agents.get(id);
		if (!agent) throw new Error(`Unknown agent_id '${id}'.`);
		return agent;
	}

	list(): AgentSummary[] {
		return [...this.agents.values()].map((agent) => agent.summary());
	}

	views(): AgentView[] {
		return [...this.agents.values()].map((agent) => ({ summary: agent.summary(), details: agent.getDetails() }));
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async close(id: string): Promise<void> {
		const agent = this.get(id);
		if (!(agent instanceof ManagedAgent)) return;
		try {
			await agent.close();
		} finally {
			if (agent.getLifecycle().phase === "closed") this.archive(agent);
		}
	}

	delete(id: string): void {
		this.agentUnsubscribers.get(id)?.();
		this.agentUnsubscribers.delete(id);
		this.agents.delete(id);
		this.removeClosedAgentId(id);
		this.emit();
	}

	async closeAll(): Promise<void> {
		const failures: unknown[] = [];
		try {
			const outcomes = await Promise.allSettled(
				[...this.agents.values()]
					.filter((agent): agent is ManagedAgent => agent instanceof ManagedAgent)
					.map((agent) => agent.close()),
			);
			for (const outcome of outcomes) if (outcome.status === "rejected") failures.push(outcome.reason);
		} finally {
			for (const unsubscribe of this.agentUnsubscribers.values()) unsubscribe();
			this.agentUnsubscribers.clear();
			this.agents.clear();
			this.closedAgentIds.length = 0;
			this.emit();
		}
		if (failures.length > 0) throw new CleanupAggregateError("Agent registry", failures);
	}

	private handleAgentUpdate(agent: ManagedAgent): void {
		if (agent.getLifecycle().phase === "closed") this.archive(agent);
		else this.emit();
	}

	private archive(agent: ManagedAgent): void {
		if (this.agents.get(agent.id) !== agent) return;
		this.agentUnsubscribers.get(agent.id)?.();
		this.agentUnsubscribers.delete(agent.id);
		this.agents.set(agent.id, new ClosedAgent(agent));
		this.removeClosedAgentId(agent.id);
		this.closedAgentIds.push(agent.id);
		while (this.closedAgentIds.length > DEFAULT_MAX_CLOSED_AGENT_HISTORY) {
			const evictedId = this.closedAgentIds.shift();
			if (evictedId !== undefined && this.agents.get(evictedId) instanceof ClosedAgent) {
				this.agents.delete(evictedId);
			}
		}
		this.emit();
	}

	private removeClosedAgentId(id: string): void {
		const index = this.closedAgentIds.indexOf(id);
		if (index >= 0) this.closedAgentIds.splice(index, 1);
	}

	private emit(): void {
		for (const listener of this.listeners) listener();
	}
}

function freezeDetails(details: ReadonlyRunDetails): ReadonlyRunDetails {
	return Object.freeze({
		...details,
		recentTools: Object.freeze(details.recentTools.map((tool) => Object.freeze({ ...tool }))),
		nestedRuns: Object.freeze(details.nestedRuns.map(freezeNestedRun)),
		usage: Object.freeze({ ...details.usage }),
	});
}

function freezeNestedRun(run: ReadonlyRunDetails["nestedRuns"][number]): ReadonlyRunDetails["nestedRuns"][number] {
	return Object.freeze({
		...run,
		recentTools: Object.freeze(run.recentTools.map((tool) => Object.freeze({ ...tool }))),
		nestedRuns: Object.freeze(run.nestedRuns.map(freezeNestedRun)),
	});
}
