import { CleanupAggregateError, type AgentSummary, type AgentView } from "./agent-types.ts";
import { ManagedAgent } from "./managed-agent.ts";
import type { ReadonlyRunDetails } from "./run-state.ts";

/** Closed agents retain dashboard and tool result metadata, but no process resources. */
export const DEFAULT_MAX_CLOSED_AGENT_HISTORY = 32;

export type RegistryEntry =
	| { readonly kind: "live"; readonly agent: ManagedAgent }
	| { readonly kind: "archived"; readonly view: AgentView };

export class AgentRegistry {
	private readonly entries = new Map<string, RegistryEntry>();
	private readonly agentUnsubscribers = new Map<string, () => void>();
	private readonly closedAgentIds: string[] = [];
	private readonly listeners = new Set<() => void>();

	async add(agent: ManagedAgent): Promise<void> {
		const replaced = this.entries.get(agent.id);
		if (replaced?.kind === "live" && replaced.agent === agent) return;
		if (replaced?.kind === "live") await this.close(agent.id);
		this.removeClosedAgentId(agent.id);
		this.agentUnsubscribers.get(agent.id)?.();
		this.agentUnsubscribers.delete(agent.id);
		this.entries.set(agent.id, { kind: "live", agent });
		this.agentUnsubscribers.set(
			agent.id,
			agent.subscribe(() => this.handleAgentUpdate(agent)),
		);
		this.emit();
	}

	getLive(id: string): ManagedAgent {
		const entry = this.requireEntry(id);
		if (entry.kind === "archived") throw new Error(`Agent '${id}' is closed.`);
		return entry.agent;
	}

	view(id: string): AgentView {
		const entry = this.requireEntry(id);
		return entry.kind === "live" ? { summary: entry.agent.summary(), details: entry.agent.getDetails() } : entry.view;
	}

	summary(id: string): AgentSummary {
		return this.view(id).summary;
	}

	async wait(id: string, timeoutMs?: number, signal?: AbortSignal): Promise<ReadonlyRunDetails> {
		const entry = this.requireEntry(id);
		return entry.kind === "live" ? entry.agent.wait(timeoutMs, signal) : entry.view.details;
	}

	list(): AgentSummary[] {
		return [...this.entries.keys()].map((id) => this.summary(id));
	}

	/** Agents with live (or still-starting) processes that consume spawn capacity. */
	capacity(): AgentSummary[] {
		return [...this.entries.values()]
			.filter(
				(entry): entry is Extract<RegistryEntry, { kind: "live" }> =>
					entry.kind === "live" && entry.agent.occupiesCapacity(),
			)
			.map((entry) => entry.agent.summary());
	}

	views(): AgentView[] {
		return [...this.entries.keys()].map((id) => this.view(id));
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async close(id: string): Promise<void> {
		const entry = this.requireEntry(id);
		if (entry.kind === "archived") return;
		try {
			await entry.agent.close();
		} finally {
			if (entry.agent.getLifecycle().phase === "closed") this.archive(entry.agent);
		}
	}

	delete(id: string): void {
		this.agentUnsubscribers.get(id)?.();
		this.agentUnsubscribers.delete(id);
		this.entries.delete(id);
		this.removeClosedAgentId(id);
		this.emit();
	}

	async closeAll(): Promise<void> {
		const failures: unknown[] = [];
		try {
			const outcomes = await Promise.allSettled(
				[...this.entries.values()]
					.filter((entry): entry is Extract<RegistryEntry, { kind: "live" }> => entry.kind === "live")
					.map((entry) => entry.agent.close()),
			);
			for (const outcome of outcomes) if (outcome.status === "rejected") failures.push(outcome.reason);
		} finally {
			for (const unsubscribe of this.agentUnsubscribers.values()) unsubscribe();
			this.agentUnsubscribers.clear();
			this.entries.clear();
			this.closedAgentIds.length = 0;
			this.emit();
		}
		if (failures.length > 0) throw new CleanupAggregateError("Agent registry", failures);
	}

	private requireEntry(id: string): RegistryEntry {
		const entry = this.entries.get(id);
		if (!entry) throw new Error(`Unknown agent_id '${id}'.`);
		return entry;
	}

	private handleAgentUpdate(agent: ManagedAgent): void {
		if (agent.getLifecycle().phase === "closed") this.archive(agent);
		else this.emit();
	}

	private archive(agent: ManagedAgent): void {
		const current = this.entries.get(agent.id);
		if (current?.kind !== "live" || current.agent !== agent) return;
		this.agentUnsubscribers.get(agent.id)?.();
		this.agentUnsubscribers.delete(agent.id);
		const view: AgentView = {
			summary: { ...agent.summary(), status: "closed" },
			details: { ...agent.getDetails(), status: "closed", aborted: false },
		};
		this.entries.set(agent.id, { kind: "archived", view });
		this.removeClosedAgentId(agent.id);
		this.closedAgentIds.push(agent.id);
		while (this.closedAgentIds.length > DEFAULT_MAX_CLOSED_AGENT_HISTORY) {
			const evictedId = this.closedAgentIds.shift();
			if (evictedId !== undefined && this.entries.get(evictedId)?.kind === "archived") {
				this.entries.delete(evictedId);
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
