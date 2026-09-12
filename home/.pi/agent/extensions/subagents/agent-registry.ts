import { getAgentDir, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { Cause, Effect, Exit, Result, Schema } from "effect";
import { toError } from "../_shared/errors.ts";
import { clipTextAtWord } from "../_shared/terminal-text.ts";
import { assertCurrentGeneration, CleanupAggregateError, type AgentSummary, type AgentView } from "./agent-types.ts";
import { ManagedAgent, reserveManagedAgentIds } from "./managed-agent.ts";
import type { ReadonlyRunDetails } from "./run-state.ts";
import {
	ResultCatalog,
	readChildTranscript,
	type ResultPage,
	type ResultReadError,
	SUBAGENT_SETTLEMENT_CUSTOM_TYPE,
} from "./result-store.ts";

/** Why an address did not resolve to a usable agent. */
export const AgentLookupReason = Schema.Literals([
	"unknown_agent",
	"closed_agent",
	"ambiguous_address",
	"blank_address",
	"already_registered",
	"taken_task_name",
	"missing_session",
	"stale_generation",
	"pending_generation",
]);
export type AgentLookupReason = Schema.Schema.Type<typeof AgentLookupReason>;

/**
 * A rejected agent lookup or registration. Synchronous readers throw it and
 * effectful paths return it, so one message describes each rejection.
 */
export class AgentLookupError extends Schema.TaggedError<AgentLookupError>()("AgentLookupError", {
	reason: AgentLookupReason,
	message: Schema.String,
}) {}

function lookupError(reason: AgentLookupReason, message: string): AgentLookupError {
	return new AgentLookupError({ reason, message });
}

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

	add(agent: ManagedAgent): Effect.Effect<void, AgentLookupError> {
		return Effect.gen({ self: this }, function* () {
			const existing = this.entries.get(agent.id);
			if (existing?.kind === "live" && existing.agent === agent) return undefined;
			if (existing) return yield* lookupError("already_registered", `Agent '${agent.id}' is already registered.`);
			this.entries.set(agent.id, { kind: "live", agent });
			this.agentUnsubscribers.set(
				agent.id,
				agent.subscribe(() => this.handleAgentUpdate(agent)),
			);
			this.emit();
			return undefined;
		});
	}

	getLive(id: string): ManagedAgent {
		const entry = this.requireEntry(id);
		if (entry.kind === "archived") throw lookupError("closed_agent", `Agent '${id}' is closed.`);
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

	wait(id: string, signal?: AbortSignal): Effect.Effect<ReadonlyRunDetails, AgentLookupError | Error> {
		return Effect.gen({ self: this }, function* () {
			const entry = yield* Effect.fromResult(this.lookup(id));
			if (entry.kind === "archived") return entry.view.details;
			return yield* Effect.tryPromise({
				try: () => entry.agent.wait(signal),
				catch: (error) => toError(error),
			});
		});
	}

	/**
	 * Resolve a human address to its stable agent.
	 * An exact agent_id wins, otherwise a task_name unique across live and
	 * archived agents. Names are claimed at spawn and never change, so either
	 * form stays valid.
	 */
	resolveTarget(target: string): { agent_id: string; summary: AgentSummary } {
		return Result.getOrThrow(this.resolveAddress(target));
	}

	/** Resolve a target to its effective generation; omitted means latest. */
	resolveGeneration(target: string, generation?: number): ResolvedAgentTarget {
		return Result.getOrThrow(this.resolveGenerationForEffect(target, generation));
	}

	/** Address resolution is shared by the throwing and effectful callers. */
	private resolveAddress(target: string): Result.Result<{ agent_id: string; summary: AgentSummary }, AgentLookupError> {
		const address = target.trim();
		if (!address) return Result.fail(lookupError("blank_address", "target must not be blank."));
		if (this.entries.has(address)) return Result.succeed({ agent_id: address, summary: this.summary(address) });
		const named = [...this.entries.keys()].filter((id) => this.summary(id).task_name === address);
		if (named.length > 1) {
			return Result.fail(
				lookupError(
					"ambiguous_address",
					`Agent address '${address}' matches ${named.length} agents; use agent_id instead.`,
				),
			);
		}
		const match = named[0];
		if (match === undefined) {
			return Result.fail(lookupError("unknown_agent", `Unknown agent '${address}'.${this.knownAddressesHint()}`));
		}
		return Result.succeed({ agent_id: match, summary: this.summary(match) });
	}

	private resolveGenerationForEffect(
		target: string,
		generation?: number,
	): Result.Result<ResolvedAgentTarget, AgentLookupError> {
		return this.resolveAddress(target).pipe(
			Result.map((resolved) => ({ ...resolved, generation: generation ?? resolved.summary.generation })),
		);
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
	readResultByAddress(
		target: string,
		options: {
			readonly generation?: number;
			readonly cursor?: string;
			readonly offset?: number;
			readonly maxBytes?: number;
		} = {},
	): Effect.Effect<ResultPage, AgentLookupError | ResultReadError> {
		return Effect.gen({ self: this }, function* () {
			const address = target.trim();
			if (!address) return yield* lookupError("blank_address", "target must not be blank.");
			const resolved =
				options.generation === undefined ? this.resolveGenerationForEffect(address) : this.resolveAddress(address);
			// An address unknown to the live registry may still name an evicted or
			// restored agent_id with persisted results, which the catalog serves and
			// defaults to that agent's latest generation. Failures after resolution
			// belong to the read itself and must not fall back.
			if (Result.isFailure(resolved)) return yield* this.readResult(address, options);
			const generation =
				options.generation === undefined && "generation" in resolved.success
					? { generation: resolved.success.generation }
					: {};
			return yield* this.readResult(resolved.success.agent_id, { ...options, ...generation });
		});
	}

	/**
	 * Claim the immutable human address for a new agent: a provided task_name
	 * must be free, otherwise one is derived from the message and uniquified.
	 */
	claimTaskName(proposed: string | undefined, message: string): string {
		const trimmed = proposed?.trim();
		if (trimmed) {
			const holder = this.addressHolder(trimmed);
			if (holder !== undefined) {
				throw lookupError(
					"taken_task_name",
					`task_name '${trimmed}' is already used by agent '${holder}'. Pick another task_name or omit it to derive one.`,
				);
			}
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

	readTranscript(id: string): Effect.Effect<unknown[], AgentLookupError | ResultReadError | Error> {
		return Effect.gen({ self: this }, function* () {
			const entry = yield* Effect.fromResult(this.lookup(id));
			if (entry.kind === "live") {
				return yield* Effect.tryPromise({ try: () => entry.agent.getMessages(), catch: (error) => toError(error) });
			}
			const sessionFile = entry.view.summary.session_file;
			if (!sessionFile) return yield* lookupError("missing_session", `Agent '${id}' has no persisted session.`);
			return yield* readChildTranscript(sessionFile, this.agentDir);
		});
	}

	readResult(
		id: string,
		options: {
			readonly generation?: number;
			readonly cursor?: string;
			readonly offset?: number;
			readonly maxBytes?: number;
		} = {},
	): Effect.Effect<ResultPage, AgentLookupError | ResultReadError> {
		return Effect.gen({ self: this }, function* () {
			const entry = this.entries.get(id);
			if (!entry) return yield* this.resultCatalog.readResult(id, options);
			const view = entry.kind === "live" ? entry.agent.view() : entry.view;
			const generation = options.generation ?? view.summary.generation;
			if (entry.kind === "live" && entry.agent.hasPendingResult(generation)) {
				return yield* lookupError(
					"pending_generation",
					`Agent '${id}' generation ${generation} is still running; use wait_agents to wait for settlement before reading its exact result.`,
				);
			}
			return yield* this.resultCatalog.readResult(id, { ...options, generation });
		});
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

	close(id: string): Effect.Effect<void, AgentLookupError | Error> {
		return Effect.gen({ self: this }, function* () {
			const entry = yield* Effect.fromResult(this.lookup(id));
			if (entry.kind === "archived") return;
			yield* Effect.tryPromise({
				try: () => entry.agent.close(),
				catch: (error) => toError(error),
			}).pipe(
				// A failed cleanup still has an owner and must remain retryable,
				// so the agent is archived only once its session really closed.
				Effect.ensuring(Effect.sync(() => (entry.agent.phase === "closed" ? this.archive(entry.agent) : undefined))),
			);
		});
	}

	/**
	 * Close every live agent, collecting each outcome so one failure cannot skip
	 * the others. Failures are reported together and stay retryable.
	 */
	closeAll(): Effect.Effect<void, CleanupAggregateError | Error> {
		return Effect.gen({ self: this }, function* () {
			const live = [...this.entries.values()].filter(
				(entry): entry is Extract<RegistryEntry, { kind: "live" }> => entry.kind === "live",
			);
			const exits = yield* Effect.forEach(live, (entry) => this.close(entry.agent.id).pipe(Effect.exit), {
				concurrency: "unbounded",
			});
			const failures = exits.flatMap((exit) => (Exit.isFailure(exit) ? [Cause.squash(exit.cause)] : []));
			if (failures.length > 0) return yield* Effect.fail(new CleanupAggregateError("Agent registry", failures));
			for (const unsubscribe of this.agentUnsubscribers.values()) unsubscribe();
			this.agentUnsubscribers.clear();
			this.entries.clear();
			this.resultCatalog.clear();
			this.emit();
			return undefined;
		});
	}

	private lookup(id: string): Result.Result<RegistryEntry, AgentLookupError> {
		const entry = this.entries.get(id);
		return entry === undefined
			? Result.fail(lookupError("unknown_agent", `Unknown agent_id '${id}'.`))
			: Result.succeed(entry);
	}

	private requireEntry(id: string): RegistryEntry {
		return Result.getOrThrow(this.lookup(id));
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
