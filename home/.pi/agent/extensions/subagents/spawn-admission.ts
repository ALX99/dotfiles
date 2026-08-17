import type { AgentRegistry } from "./agent-registry.ts";
import { isAgentActive } from "./agent-types.ts";
import type { ProfilesConfig } from "./profiles.ts";

export interface SpawnAdmissionRequest {
	readonly agent: string;
	readonly profile: string;
}

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
	private readonly config: ProfilesConfig;
	private readonly registry: AgentRegistry;

	constructor(config: ProfilesConfig, registry: AgentRegistry) {
		this.config = config;
		this.registry = registry;
	}

	capacity(): CapacitySnapshot {
		const occupied = this.registry.capacity();
		return Object.freeze({
			root: Object.freeze({
				live: occupied.filter((summary) => isAgentActive(summary.status)).length,
				occupied: occupied.length,
				limit: this.config.rootPolicy.maxConcurrentRootAgents,
			}),
		});
	}

	admit(request: SpawnAdmissionRequest): void {
		const policy = this.config.agentPolicies[request.agent];
		const profile = this.config.profiles[request.profile];
		if (!policy) throw new Error(`No agent policy is configured for '${request.agent}'.`);
		if (!profile) throw new Error(`No profile policy is configured for '${request.profile}'.`);
		if (!policy.allowedProfiles.includes(request.profile)) {
			throw new Error(
				`Profile '${request.profile}' is not allowed for agent '${request.agent}'. Allowed: ${policy.allowedProfiles.join(", ")}.`,
			);
		}

		const capacity = this.capacity();
		if (capacity.root.occupied >= capacity.root.limit) {
			throw new Error(
				`Root-agent concurrency cap (${capacity.root.limit}) reached: ${capacity.root.occupied} admission slots are occupied (${capacity.root.live} currently running). Wait for one-shot agents to settle, follow up a retained settled agent, or close a retained agent.`,
			);
		}
	}
}
