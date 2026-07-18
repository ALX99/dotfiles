import type { AgentRegistry } from "./agent-registry.ts";
import type { ProfilesConfig } from "./profiles.ts";
import type { ChildExecutionContext } from "./process.ts";

export interface SpawnAdmissionRequest {
	readonly agent: string;
	readonly profile: string;
	readonly delegationCredits?: number;
}

export class SpawnAdmissionController {
	private remainingCredits: number;
	private createdChildren = 0;
	private readonly config: ProfilesConfig;
	private readonly registry: AgentRegistry;
	private readonly treeId: string;
	private readonly executionContext: ChildExecutionContext | undefined;

	constructor(
		config: ProfilesConfig,
		registry: AgentRegistry,
		treeId: string,
		executionContext?: ChildExecutionContext,
	) {
		this.config = config;
		this.registry = registry;
		this.treeId = treeId;
		this.executionContext = executionContext;
		this.remainingCredits = executionContext?.delegationCredits ?? 0;
	}

	canExposeSubagentTools(): boolean {
		return this.executionContext === undefined || executionCanDelegate(this.config, this.executionContext);
	}

	remainingDelegationCredits(): number {
		return this.remainingCredits;
	}

	admit(request: SpawnAdmissionRequest): ChildExecutionContext {
		const policy = this.config.agentPolicies[request.agent];
		const profile = this.config.profiles[request.profile];
		if (!policy) throw new Error(`No agent policy is configured for '${request.agent}'.`);
		if (!profile) throw new Error(`No profile policy is configured for '${request.profile}'.`);

		if (!this.executionContext) {
			const grant = request.delegationCredits ?? 0;
			assertGrant(grant, this.config.rootPolicy.maxDelegationGrant);
			if (grant > 0 && policy.delegation.mode !== "grant-required") {
				throw new Error(
					`Agent '${request.agent}' is a leaf and cannot receive delegation credits. Omit delegation_credits.`,
				);
			}
			if (grant > 0 && !profile.delegationEnabled) {
				throw new Error(
					`Profile '${request.profile}' disables delegation and cannot receive delegation credits. Omit delegation_credits or choose a delegation-enabled profile.`,
				);
			}
			const nonClosed = this.registry.list().filter((agent) => agent.status !== "closed");
			if (nonClosed.length >= this.config.rootPolicy.maxDirectAgents) {
				throw new Error(
					`Direct-agent cap (${this.config.rootPolicy.maxDirectAgents}) reached. Use followup_agent with an existing agent, close an agent that is no longer needed, or perform the remaining work in the current session.`,
				);
			}
			if (profile.countsTowardDeepAgentCap) {
				const existingDeep = nonClosed.filter((agent) => this.config.profiles[agent.profile]?.countsTowardDeepAgentCap);
				if (existingDeep.length >= this.config.rootPolicy.maxDeepAgents) {
					throw new Error(
						`Deep-agent cap (${this.config.rootPolicy.maxDeepAgents}) reached. Use followup_agent with the existing deep agent (${existingDeep.map((agent) => agent.agent_id).join(", ")}) instead of creating another one.`,
					);
				}
			}
			return Object.freeze({
				treeId: this.treeId,
				depth: 1,
				agent: request.agent,
				profile: request.profile,
				delegationCredits: grant,
			});
		}

		if (request.delegationCredits !== undefined) {
			throw new Error("Nested agents cannot transfer or re-grant delegation credits; remove delegation_credits.");
		}
		const parent = this.executionContext;
		if (!executionCanDelegate(this.config, parent)) {
			throw new Error("This execution is a leaf and cannot spawn subagents. Perform the work in the current process.");
		}
		const configuredParent = this.config.agentPolicies[parent.agent];
		if (!configuredParent) throw new Error(`No agent policy is configured for parent '${parent.agent}'.`);
		const parentPolicy = configuredParent.delegation;
		if (parentPolicy.mode !== "grant-required") {
			throw new Error("This execution's agent policy does not permit nested delegation.");
		}
		if (!parentPolicy.allowedChildAgents.includes(request.agent)) {
			throw new Error(`Nested delegation may spawn only: ${parentPolicy.allowedChildAgents.join(", ")}.`);
		}
		if (!parentPolicy.allowedChildProfiles.includes(request.profile)) {
			throw new Error(`Nested delegation may use only profiles: ${parentPolicy.allowedChildProfiles.join(", ")}.`);
		}
		if (this.createdChildren >= parentPolicy.maxDirectChildren) {
			throw new Error(
				`Nested direct-agent cap (${parentPolicy.maxDirectChildren}) reached. Reuse an existing scout with followup_agent or perform the remaining reconnaissance here.`,
			);
		}
		if (this.remainingCredits <= 0) {
			throw new Error(
				"No delegation credits remain. Reuse an existing scout with followup_agent or perform the remaining reconnaissance here.",
			);
		}
		this.remainingCredits -= 1;
		this.createdChildren += 1;
		return Object.freeze({
			treeId: parent.treeId,
			depth: parent.depth + 1,
			agent: request.agent,
			profile: request.profile,
			delegationCredits: 0,
		});
	}
}

export function executionCanDelegate(config: ProfilesConfig, context: ChildExecutionContext): boolean {
	if (context.depth >= 2 || context.delegationCredits <= 0) return false;
	const agentPolicy = config.agentPolicies[context.agent];
	const profile = config.profiles[context.profile];
	return agentPolicy?.delegation.mode === "grant-required" && profile?.delegationEnabled === true;
}

function assertGrant(grant: number, maximum: number): void {
	if (!Number.isInteger(grant) || grant < 0 || grant > maximum) {
		throw new Error(`delegation_credits must be an integer from 0 to ${maximum}.`);
	}
}
