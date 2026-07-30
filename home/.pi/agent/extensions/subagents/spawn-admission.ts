import type { AgentRegistry } from "./agent-registry.ts";
import type { ProfilesConfig } from "./profiles.ts";
import type { ChildExecutionContext } from "./child-process.ts";

export interface SpawnAdmissionRequest {
	readonly agent: string;
	readonly profile: string;
}

export interface CapacitySnapshot {
	readonly root: { readonly live: number; readonly limit: number };
	readonly deep: { readonly live: number; readonly limit: number };
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
			deep: Object.freeze({
				live: live.filter((summary) => this.config.profiles[summary.profile]?.countsTowardDeepAgentCap === true).length,
				limit: this.config.rootPolicy.maxConcurrentDeepAgents,
			}),
		});
	}

	admit(request: SpawnAdmissionRequest): ChildExecutionContext {
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
		if (profile.countsTowardDeepAgentCap && capacity.deep.live >= capacity.deep.limit) {
			const existingDeep = this.registry
				.capacity()
				.filter((summary) => this.config.profiles[summary.profile]?.countsTowardDeepAgentCap);
			throw new Error(
				`Deep-agent concurrency cap (${capacity.deep.limit}) reached${existingDeep.length ? ` (${existingDeep.map((summary) => summary.agent_id).join(", ")})` : ""}. Wait for it to settle or close a retained deep agent.`,
			);
		}
		return Object.freeze({
			agent: request.agent,
			profile: request.profile,
		});
	}
}
