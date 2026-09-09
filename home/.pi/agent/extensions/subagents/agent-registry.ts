import { getAgentDir, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { clipTextAtWord } from "../_shared/terminal-text.ts";
import { assertCurrentGeneration, CleanupAggregateError, type AgentSummary, type AgentView } from "./agent-types.ts";
import { ManagedAgent, reserveManagedAgentIds } from "./managed-agent.ts";
import type { ReadonlyRunDetails } from "./run-state.ts";
import {
	ResultCatalog,
	readChildTranscript,
	type ResultPage,
	SUBAGENT_SETTLEMENT_CUSTOM_TYPE,
} from "./result-store.ts";

/** Closed agents retain dashboard and tool result metadata, but no live session resources. */
export const DEFAULT_MAX_CLOSED_AGENT_HISTORY = 32;
export { SUBAGENT_SETTLEMENT_CUSTOM_TYPE };

export type RegistryEntry =
	| { readonly kind: "live"; readonly agent: ManagedAgent }
	| { readonly kind: "archived"; readonly view: AgentView };

export interface ResolvedAgentTarget {
	readonly agent_id: string;
	readonly summary: AgentSummary;
	readonly generation: number;
}

export interface LiveAgentTarget extends ResolvedAgentTarget {
	readonly agent: ManagedAgent;
}

export class AgentRegistry {
	private readonly entries = new Map<string, RegistryEntry>();
	private readonly resultCatalog: ResultCatalog;
	private readonly agentUnsubscribers = new Map<string, () => void>();
	private readonly listeners = new Set<() => void>();
	private readonly agentDir: string;

	constructor(agentDir = getAgentDir()) {
		this.agentDir = agentDir;
		this.resultCatalog = new ResultCatalog(agentDir);
	}

	async add(agent: ManagedAgent): Promise<void> {
		const existing = this.entries.get(agent.id);
		if (existing?.kind === "live" && existing.agent === agent) return;
		if (existing) throw new Error(`Agent '${agent.id}' is already registered.`);
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
		return entry.kind === "live" ? entry.agent.view() : entry.view;
	}

	summary(id: string): AgentSummary {
		const entry = this.requireEntry(id);
		return entry.kind === "live" ? entry.agent.summary() : entry.view.summary;
	}

	async wait(id: string, signal?: AbortSignal): Promise<ReadonlyRunDetails> {
		const entry = this.requireEntry(id);
		return entry.kind === "live" ? entry.agent.wait(signal) : entry.view.details;
	}

	/**
	 * Resolve a human address to its stable agent.
	 * An exact agent_id wins, otherwise a task_name unique across live and
	 * archived agents. Names are claimed at spawn and never change, so either
	 * form stays valid.
	 */
	resolveTarget(target: string): { agent_id: string; summary: AgentSummary } {
		const address = target.trim();
		if (!address) throw new Error("target must not be blank.");
		if (this.entries.has(address)) return { agent_id: address, summary: this.summary(address) };
		const named = [...this.entries.keys()].filter((id) => this.summary(id).task_name === address);
		if (named.length > 1)
			throw new Error(`Agent address '${address}' matches ${named.length} agents; use agent_id instead.`);
		const match = named[0];
		if (match === undefined) throw new Error(`Unknown agent '${address}'.${this.knownAddressesHint()}`);
		return { agent_id: match, summary: this.summary(match) };
	}

	/** Resolve a target to its effective generation; omitted means latest. */
	resolveGeneration(target: string, generation?: number): ResolvedAgentTarget {
		const resolved = this.resolveTarget(target);
		return { ...resolved, generation: generation ?? resolved.summary.generation };
	}

	/**
	 * Resolve a target to its live session. An explicit generation must be
	 * current; a missing one defaults to the latest.
	 */
	liveTarget(target: string, generation?: number): LiveAgentTarget {
		const resolved = this.resolveGeneration(target, generation);
		if (generation !== undefined) assertCurrentGeneration(resolved.summary, generation);
		return { ...resolved, agent: this.getLive(resolved.agent_id) };
	}

	/**
	 * Read persisted result text by human address. An explicit generation may
	 * name an evicted or restored agent_id unknown to the live registry; a
	 * missing generation defaults to the latest known one.
	 */
	async readResultByAddress(
		target: string,
		options: {
			readonly generation?: number;
			readonly cursor?: string;
			readonly offset?: number;
			readonly maxBytes?: number;
		} = {},
	): Promise<ResultPage> {
		const address = target.trim();
		if (!address) throw new Error("target must not be blank.");
		try {
			if (options.generation === undefined) {
				const resolved = this.resolveGeneration(address);
				return this.readResult(resolved.agent_id, { ...options, generation: resolved.generation });
			}
			const resolved = this.resolveTarget(address);
			return this.readResult(resolved.agent_id, options);
		} catch {
			// Unknown among known agents: it may still be an evicted or restored
			// agent_id with persisted results, which ResultCatalog serves and
			// defaults to its latest generation.
			return this.readResult(address, options);
		}
	}

	/**
	 * Claim the immutable human address for a new agent: a provided task_name
	 * must be free, otherwise one is derived from the message and uniquified.
	 */
	claimTaskName(proposed: string | undefined, message: string): string {
		const trimmed = proposed?.trim();
		if (trimmed) {
			const holder = this.addressHolder(trimmed);
			if (holder !== undefined)
				throw new Error(
					`task_name '${trimmed}' is already used by agent '${holder}'. Pick another task_name or omit it to derive one.`,
				);
			return trimmed;
		}
		const base = clipTextAtWord(message, 60) || "task";
		let candidate = base;
		for (let suffix = 2; this.addressHolder(candidate) !== undefined; suffix += 1) {
			candidate = `${base}-${suffix}`;
		}
		return candidate;
	}

	private addressHolder(address: string): string | undefined {
		if (this.entries.has(address)) return address;
		return [...this.entries.keys()].find((id) => this.summary(id).task_name === address);
	}

	private knownAddressesHint(): string {
		const names = [...this.entries.keys()].map((id) => this.summary(id).task_name);
		if (names.length === 0) return " No agents are known in this session.";
		const shown = names.slice(0, 8).join(", ");
		return ` Known agents: ${shown}${names.length > 8 ? ", …" : ""}.`;
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
		const view = entry.kind === "live" ? entry.agent.view() : entry.view;
		const generation = options.generation ?? view.summary.generation;
		if (entry.kind === "live" && entry.agent.hasPendingResult(generation)) {
			throw new Error(
				`Agent '${id}' generation ${generation} is still running; use wait_agents to wait for settlement before reading its exact result.`,
			);
		}
		return this.resultCatalog.readResult(id, { ...options, generation });
	}

	restoreResultLocators(entries: readonly SessionEntry[]): number {
		const count = this.resultCatalog.restore(entries);
		reserveManagedAgentIds(this.resultCatalog.agentIds());
		return count;
	}

	hasStoredResults(): boolean {
		return this.resultCatalog.size > 0;
	}

	list(): AgentSummary[] {
		return [...this.entries.keys()].map((id) => this.summary(id));
	}

	/** Agents with live (or still-starting) sessions that consume spawn capacity. */
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
			if (entry.agent.phase === "closed") this.archive(entry.agent);
		}
	}

	async closeAll(): Promise<void> {
		const outcomes = await Promise.allSettled(
			[...this.entries.values()]
				.filter((entry): entry is Extract<RegistryEntry, { kind: "live" }> => entry.kind === "live")
				.map((entry) => this.close(entry.agent.id)),
		);
		const failures = outcomes.flatMap((outcome) => (outcome.status === "rejected" ? [outcome.reason] : []));
		// A failed cleanup still has an owner and must remain retryable.
		if (failures.length > 0) throw new CleanupAggregateError("Agent registry", failures);
		for (const unsubscribe of this.agentUnsubscribers.values()) unsubscribe();
		this.agentUnsubscribers.clear();
		this.entries.clear();
		this.resultCatalog.clear();
		this.emit();
	}

	private requireEntry(id: string): RegistryEntry {
		const entry = this.entries.get(id);
		if (!entry) throw new Error(`Unknown agent_id '${id}'.`);
		return entry;
	}

	private handleAgentUpdate(agent: ManagedAgent): void {
		const locator = agent.summary().result_locator;
		if (locator) this.resultCatalog.record(agent.id, locator);
		if (agent.phase === "closed") this.archive(agent);
		else this.emit();
	}

	private archive(agent: ManagedAgent): void {
		const current = this.entries.get(agent.id);
		if (current?.kind !== "live" || current.agent !== agent) return;
		this.agentUnsubscribers.get(agent.id)?.();
		this.agentUnsubscribers.delete(agent.id);
		const liveView = agent.view();
		const view: AgentView = {
			summary: { ...liveView.summary, status: "closed", outcome: terminalOutcome(liveView) },
			details: { ...liveView.details, status: "closed" },
		};
		// Map insertion order is the archive order; no second eviction queue.
		this.entries.delete(agent.id);
		this.entries.set(agent.id, { kind: "archived", view });
		const archived = [...this.entries].filter(([, entry]) => entry.kind === "archived");
		for (const [id] of archived.slice(0, Math.max(0, archived.length - DEFAULT_MAX_CLOSED_AGENT_HISTORY))) {
			this.entries.delete(id);
		}
		this.emit();
	}

	private emit(): void {
		for (const listener of this.listeners) listener();
	}
}

/** The terminal execution outcome preserved when an agent is archived as closed. */
function terminalOutcome(view: AgentView): "succeeded" | "failed" | "aborted" {
	if (view.details.aborted) return "aborted";
	if (view.details.error ?? view.summary.error) return "failed";
	return "succeeded";
}
