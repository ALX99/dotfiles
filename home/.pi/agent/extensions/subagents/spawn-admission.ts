import type { AgentRegistry } from "./agent-registry.ts";
import type { ProfilesConfig } from "./profiles.ts";

export interface SpawnAdmissionRequest {
	readonly agent: string;
	readonly profile: string;
}

export interface CapacitySnapshot {
	readonly root: { readonly live: number; readonly limit: number };
}

export class SpawnAdmissionController {
	private readonly config: ProfilesConfig;
	private readonly registry: AgentRegistry;

	constructor(config: ProfilesConfig, registry: AgentRegistry) {
		this.config = config;
		this.registry = registry;
	}

	capacity(): CapacitySnapshot {
		const live = this.registry.capacity();
		return Object.freeze({
			root: Object.freeze({
				live: live.length,
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
		if (capacity.root.live >= capacity.root.limit) {
			throw new Error(
				`Root-agent concurrency cap (${capacity.root.limit}) reached. Wait for one-shot agents to settle, follow up a retained live agent, or close a retained agent.`,
			);
		}
	}
}
