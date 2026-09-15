import type { AgentRegistry } from "./agent-registry.ts";
import { isAgentActive } from "./agent-types.ts";

export interface CapacitySnapshot {
	readonly root: {
		/** Children currently starting or running. */
		readonly live: number;
		/** Sessions occupying a slot, including idle retained children. */
		readonly occupied: number;
		readonly limit: number;
	};
}

export class SpawnAdmissionController {
	private readonly limit: number;
	private readonly registry: AgentRegistry;

	constructor(limit: number, registry: AgentRegistry) {
		this.limit = limit;
		this.registry = registry;
	}

	capacity(): CapacitySnapshot {
		const occupied = this.registry.capacity();
		return Object.freeze({
			root: Object.freeze({
				live: occupied.filter((summary) => isAgentActive(summary.status)).length,
				occupied: occupied.length,
				limit: this.limit,
			}),
		});
	}

	admit(): void {
		const capacity = this.capacity();
		if (capacity.root.occupied >= capacity.root.limit) {
			throw new Error(
				`Root-agent concurrency cap (${capacity.root.limit}) reached: ${capacity.root.occupied} admission slots are occupied (${capacity.root.live} currently running). Wait for one-shot agents to settle, use followup_agent on a retained settled agent, or close_agent to release a retained agent.`,
			);
		}
	}
}
