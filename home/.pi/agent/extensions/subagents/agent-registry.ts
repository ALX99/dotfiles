import { getAgentDir, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { CleanupAggregateError, type AgentSummary, type AgentView } from "./agent-types.ts";
import { ManagedAgent, reserveManagedAgentIds } from "./managed-agent.ts";
import type { ReadonlyRunDetails } from "./run-state.ts";
import {
	ResultCatalog,
	readChildTranscript,
	type ResultLocator,
	type ResultPage,
	SUBAGENT_SETTLEMENT_CUSTOM_TYPE,
} from "./result-store.ts";

/** Closed agents retain dashboard and tool result metadata, but no process resources. */
export const DEFAULT_MAX_CLOSED_AGENT_HISTORY = 32;
export { SUBAGENT_SETTLEMENT_CUSTOM_TYPE };

export type RegistryEntry =
	| { readonly kind: "live"; readonly agent: ManagedAgent }
	| { readonly kind: "archived"; readonly view: AgentView };

export class AgentRegistry {
	private readonly entries = new Map<string, RegistryEntry>();
	private readonly resultCatalog: ResultCatalog;
	private readonly agentUnsubscribers = new Map<string, () => void>();
	private readonly closedAgentIds: string[] = [];
	private readonly listeners = new Set<() => void>();
	private readonly agentDir: string;

	constructor(agentDir = getAgentDir()) {
		this.agentDir = agentDir;
		this.resultCatalog = new ResultCatalog(agentDir);
	}

	async add(agent: ManagedAgent): Promise<void> {
		const replaced = this.entries.get(agent.id);
		if (replaced?.kind === "live" && replaced.agent === agent) return;
		if (replaced?.kind === "live") await this.close(agent.id);
		this.removeClosedAgentId(agent.id);
		this.agentUnsubscribers.get(agent.id)?.();
		this.agentUnsubscribers.delete(agent.id);
		this.resultCatalog.forget(agent.id);
		this.entries.set(agent.id, { kind: "live", agent });
		agent.attachResultSink((captured) => this.resultCatalog.recordGeneration(agent.id, captured));
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
		return entry.kind === "live" ? liveAgentView(entry.agent) : entry.view;
	}

	summary(id: string): AgentSummary {
		return this.view(id).summary;
	}

	async wait(id: string, timeoutMs?: number, signal?: AbortSignal): Promise<ReadonlyRunDetails> {
		const entry = this.requireEntry(id);
		return entry.kind === "live" ? entry.agent.wait(timeoutMs, signal) : entry.view.details;
	}

	async readTranscript(id: string): Promise<unknown[]> {
		const entry = this.requireEntry(id);
		if (entry.kind === "live") return entry.agent.getMessages();
		const sessionFile = entry.view.summary.session_file;
		if (!sessionFile) throw new Error(`Agent '${id}' has no persisted session.`);
		return readChildTranscript(sessionFile, this.agentDir);
	}

	async readResult(
		id: string,
		options: {
			readonly generation?: number;
			readonly cursor?: string;
			readonly offset?: number;
			readonly maxBytes?: number;
		} = {},
	): Promise<ResultPage> {
		const entry = this.entries.get(id);
		if (!entry) return this.resultCatalog.readResult(id, options);
		const view = entry.kind === "live" ? liveAgentView(entry.agent) : entry.view;
		const fallback = resultLocator(view);
		const generation = options.generation ?? view.summary.generation;
		if (entry.kind === "live" && generation !== undefined && entry.agent.hasPendingResult(generation)) {
			return entry.agent.readLiveResultPreview(options);
		}
		if (
			entry.kind === "live" &&
			generation !== undefined &&
			generation === view.summary.generation &&
			!this.resultCatalog.has(id, generation)
		) {
			return entry.agent.readSettledResult(options);
		}
		return this.resultCatalog.readResult(id, options, fallback);
	}

	restoreResultLocators(entries: readonly SessionEntry[]): number {
		const count = this.resultCatalog.restore(entries);
		reserveManagedAgentIds(this.resultCatalog.agentIds());
		return count;
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
			this.resultCatalog.clear();
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
		else {
			if (agent.getLifecycle().phase === "failed") {
				const fallback = resultLocator(liveAgentView(agent));
				if (fallback) this.resultCatalog.record(agent.id, fallback);
			}
			this.emit();
		}
	}

	private archive(agent: ManagedAgent): void {
		const current = this.entries.get(agent.id);
		if (current?.kind !== "live" || current.agent !== agent) return;
		this.agentUnsubscribers.get(agent.id)?.();
		this.agentUnsubscribers.delete(agent.id);
		const liveView = liveAgentView(agent);
		const view: AgentView = {
			summary: { ...liveView.summary, status: "closed" },
			details: { ...liveView.details, status: "closed", aborted: false },
		};
		const fallback = resultLocator(view);
		if (fallback) this.resultCatalog.record(agent.id, fallback);
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

function liveAgentView(agent: ManagedAgent): AgentView {
	return { summary: agent.summary(), details: agent.getDetails() };
}

function resultLocator(view: AgentView): ResultLocator | undefined {
	const sessionFile = view.summary.session_file;
	if (!sessionFile) return undefined;
	return {
		sessionFile,
		generation: view.summary.generation,
		...(view.summary.result?.result_id === undefined
			? { resultId: view.details.resultId }
			: { resultId: view.summary.result.result_id }),
		...(view.summary.result_locator === undefined ? {} : { native: view.summary.result_locator }),
	};
}
