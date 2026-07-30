import { getAgentDir, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { isRecord } from "../_shared/json.ts";
import { CleanupAggregateError, type AgentSummary, type AgentView } from "./agent-types.ts";
import { ManagedAgent, reserveManagedAgentIds } from "./managed-agent.ts";
import type { ReadonlyRunDetails } from "./run-state.ts";
import {
	paginateStoredResult,
	parseGenerationResultLocator,
	readChildTranscript,
	readLocatedAgentResult,
	readStoredAgentResult,
	type GenerationResultLocator,
	type ResultPage,
} from "./result-store.ts";

/** Closed agents retain dashboard and tool result metadata, but no process resources. */
export const DEFAULT_MAX_CLOSED_AGENT_HISTORY = 32;
export const SUBAGENT_SETTLEMENT_CUSTOM_TYPE = "subagent-settlement";

export type RegistryEntry =
	| { readonly kind: "live"; readonly agent: ManagedAgent }
	| { readonly kind: "archived"; readonly view: AgentView };

interface ResultLocator {
	readonly sessionFile: string;
	readonly generation: number;
	readonly resultId?: string;
	readonly native?: GenerationResultLocator;
}

export class AgentRegistry {
	private readonly entries = new Map<string, RegistryEntry>();
	private readonly resultLocators = new Map<string, Map<number, ResultLocator>>();
	private readonly agentUnsubscribers = new Map<string, () => void>();
	private readonly closedAgentIds: string[] = [];
	private readonly listeners = new Set<() => void>();
	private readonly agentDir: string;

	constructor(agentDir = getAgentDir()) {
		this.agentDir = agentDir;
	}

	async add(agent: ManagedAgent): Promise<void> {
		const replaced = this.entries.get(agent.id);
		if (replaced?.kind === "live" && replaced.agent === agent) return;
		if (replaced?.kind === "live") await this.close(agent.id);
		this.removeClosedAgentId(agent.id);
		this.agentUnsubscribers.get(agent.id)?.();
		this.agentUnsubscribers.delete(agent.id);
		this.resultLocators.delete(agent.id);
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
		if (!entry) {
			const locators = this.resultLocators.get(id);
			if (!locators) throw new Error(`Unknown agent_id '${id}'.`);
			const generation = options.generation ?? latestGeneration(locators);
			const locator = locators.get(generation);
			if (!locator) throw new Error(`Agent ${id} has no result locator for generation ${generation}.`);
			const result = locator.native
				? await readLocatedAgentResult(locator.native, this.agentDir)
				: await readStoredAgentResult(locator.sessionFile, generation, locator.resultId, this.agentDir);
			return paginateStoredResult(id, result, options);
		}
		if (entry.kind === "live") return entry.agent.readResult(options);
		const summary = entry.view.summary;
		const generation = options.generation ?? summary.generation;
		const locator = this.resultLocators.get(id)?.get(generation);
		if (locator) {
			const result = locator.native
				? await readLocatedAgentResult(locator.native, this.agentDir)
				: await readStoredAgentResult(locator.sessionFile, generation, locator.resultId, this.agentDir);
			return paginateStoredResult(id, result, options);
		}
		const sessionFile = summary.session_file;
		const resultId =
			generation === summary.generation ? (summary.result?.result_id ?? entry.view.details.resultId) : undefined;
		if (!sessionFile) throw new Error(`Agent '${id}' has no persisted session.`);
		const result = await readStoredAgentResult(sessionFile, generation, resultId, this.agentDir);
		return paginateStoredResult(id, result, options);
	}

	restoreResultLocators(entries: readonly SessionEntry[]): number {
		this.resultLocators.clear();
		for (const entry of entries) {
			for (const candidate of locatorCandidates(entry)) {
				this.storeResultLocator(candidate.agentId, candidate.locator);
			}
		}
		reserveManagedAgentIds(this.resultLocators.keys());
		return [...this.resultLocators.values()].reduce((count, generations) => count + generations.size, 0);
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
			this.resultLocators.clear();
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
		for (const locator of agent.getResultLocators().values()) {
			this.storeResultLocator(agent.id, {
				sessionFile: locator.sessionFile,
				generation: locator.generation,
				resultId: locator.resultId,
				native: locator,
			});
		}
		if (view.summary.session_file) {
			this.storeResultLocator(agent.id, {
				sessionFile: view.summary.session_file,
				generation: view.summary.generation,
				...(view.summary.result?.result_id === undefined ? {} : { resultId: view.summary.result.result_id }),
				...(view.summary.result_locator === undefined ? {} : { native: view.summary.result_locator }),
			});
		}
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

	private storeResultLocator(agentId: string, locator: ResultLocator): void {
		let generations = this.resultLocators.get(agentId);
		if (!generations) {
			generations = new Map();
			this.resultLocators.set(agentId, generations);
		}
		generations.set(locator.generation, locator);
	}

	private emit(): void {
		for (const listener of this.listeners) listener();
	}
}

const LOCATOR_TOOL_NAMES = new Set([
	"spawn_agent",
	"followup_agent",
	"wait_agent",
	"list_agents",
	"close_agent",
	"interrupt_agent",
]);

function locatorCandidates(entry: SessionEntry): Array<{ readonly agentId: string; readonly locator: ResultLocator }> {
	let details: unknown;
	if (entry.type === "custom" && entry.customType === SUBAGENT_SETTLEMENT_CUSTOM_TYPE) {
		details = entry.data;
	} else if (entry.type === "custom_message" && entry.customType === "subagent-completion") {
		details = entry.details;
	} else if (
		entry.type === "message" &&
		entry.message.role === "toolResult" &&
		LOCATOR_TOOL_NAMES.has(entry.message.toolName)
	) {
		details = entry.message.details;
	} else {
		return [];
	}
	return collectLocatorCandidates(details);
}

function collectLocatorCandidates(
	value: unknown,
): Array<{ readonly agentId: string; readonly locator: ResultLocator }> {
	if (Array.isArray(value)) return value.flatMap((item) => collectLocatorCandidates(item));
	if (!isRecord(value)) return [];
	const nested = Array.isArray(value.summaries)
		? value.summaries.flatMap((item) => collectLocatorCandidates(item))
		: [];
	const agentId = stringField(value, "agent_id", "agentId");
	const nativeValue = value.result_locator ?? value.resultLocator;
	if (nativeValue !== undefined) {
		const native = parseGenerationResultLocator(nativeValue);
		if (agentId === undefined || native === undefined) return nested;
		return [
			...nested,
			{
				agentId,
				locator: {
					sessionFile: native.sessionFile,
					generation: native.generation,
					resultId: native.resultId,
					native,
				},
			},
		];
	}
	const sessionFile = stringField(value, "session_file", "sessionFile");
	const generation = value.generation;
	if (
		agentId === undefined ||
		sessionFile === undefined ||
		typeof generation !== "number" ||
		!Number.isInteger(generation) ||
		generation < 1
	) {
		return nested;
	}
	const result = isRecord(value.result) ? value.result : undefined;
	const resultId = stringField(value, "resultId") ?? (result ? stringField(result, "result_id") : undefined);
	if (resultId !== undefined && !/^[0-9a-f]{64}$/.test(resultId)) return nested;
	return [
		...nested,
		{
			agentId,
			locator: {
				sessionFile,
				generation,
				...(resultId === undefined ? {} : { resultId }),
			},
		},
	];
}

function latestGeneration(locators: ReadonlyMap<number, ResultLocator>): number {
	const generations = [...locators.keys()];
	if (generations.length === 0) throw new Error("Stored agent has no result locators.");
	return Math.max(...generations);
}

function stringField(value: Readonly<Record<string, unknown>>, ...names: string[]): string | undefined {
	for (const name of names) {
		const field = value[name];
		if (typeof field === "string" && field.trim()) return field;
	}
	return undefined;
}
