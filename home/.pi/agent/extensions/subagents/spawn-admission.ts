import type { AgentRegistry } from "./agent-registry.ts";
import type { ProfilesConfig } from "./profiles.ts";
import { MAX_DELEGATION_DEPTH, type ChildExecutionContext } from "./child-process.ts";

export interface SpawnAdmissionRequest {
	readonly agent: string;
	readonly profile: string;
	readonly childSpawnBudget?: number;
}

export interface SpawnAdmissionReservation {
	readonly childContext: ChildExecutionContext;
	commit(): void;
	release(): void;
}

export class SpawnAdmissionController {
	private remainingCredits: number;
	private reservedOrCommittedChildSpawns = 0;
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
		this.remainingCredits = executionContext?.childSpawnBudget ?? 0;
	}

	canExposeSubagentTools(): boolean {
		return this.executionContext === undefined || executionCanDelegate(this.config, this.executionContext);
	}

	remainingDelegationCredits(): number {
		return this.remainingCredits;
	}

	reserve(request: SpawnAdmissionRequest): SpawnAdmissionReservation {
		const policy = this.config.agentPolicies[request.agent];
		const profile = this.config.profiles[request.profile];
		if (!policy) throw new Error(`No agent policy is configured for '${request.agent}'.`);
		if (!profile) throw new Error(`No profile policy is configured for '${request.profile}'.`);

		if (!this.executionContext) {
			const grant = request.childSpawnBudget ?? 0;
			assertGrant(grant, this.config.rootPolicy.maxSpawnBudgetPerChild);
			if (grant > 0 && policy.delegation.mode !== "grant-required") {
				throw new Error(
					`Agent '${request.agent}' is a leaf and cannot receive delegation credits. Omit child_spawn_budget.`,
				);
			}
			if (grant > 0 && !profile.delegationEnabled) {
				throw new Error(
					`Profile '${request.profile}' disables delegation and cannot receive delegation credits. Omit child_spawn_budget or choose a delegation-enabled profile.`,
				);
			}
			// A failed RPC process cannot be followed up or reused, so it must
			// not indefinitely consume a direct/deep concurrency slot.
			const nonClosed = this.registry.capacity();
			if (nonClosed.length >= this.config.rootPolicy.maxConcurrentRootAgents) {
				throw new Error(
					`Root-agent concurrency cap (${this.config.rootPolicy.maxConcurrentRootAgents}) reached. Use followup_agent with an existing agent, close an agent that is no longer needed, or perform the remaining work in the current session.`,
				);
			}
			if (profile.countsTowardDeepAgentCap) {
				const existingDeep = nonClosed.filter((agent) => this.config.profiles[agent.profile]?.countsTowardDeepAgentCap);
				if (existingDeep.length >= this.config.rootPolicy.maxConcurrentDeepAgents) {
					throw new Error(
						`Deep-agent concurrency cap (${this.config.rootPolicy.maxConcurrentDeepAgents}) reached. Reuse the existing deep agent (${existingDeep.map((agent) => agent.agent_id).join(", ")}) with followup_agent, or close it before spawning a replacement.`,
					);
				}
			}
			return createReservation(
				Object.freeze({
					treeId: this.treeId,
					depth: 1,
					agent: request.agent,
					profile: request.profile,
					childSpawnBudget: grant,
				}),
			);
		}

		if (request.childSpawnBudget !== undefined) {
			throw new Error("Nested agents cannot transfer or re-grant delegation credits; remove child_spawn_budget.");
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
		if (this.reservedOrCommittedChildSpawns >= parentPolicy.maxLifetimeChildSpawns) {
			throw new Error(
				`Nested lifetime child-spawn cap (${parentPolicy.maxLifetimeChildSpawns}) reached. Reuse an existing scout with followup_agent or perform the remaining reconnaissance here.`,
			);
		}
		if (this.remainingCredits <= 0) {
			throw new Error(
				"No delegation credits remain. Reuse an existing scout with followup_agent or perform the remaining reconnaissance here.",
			);
		}
		this.remainingCredits -= 1;
		this.reservedOrCommittedChildSpawns += 1;
		const childContext: ChildExecutionContext = Object.freeze({
			treeId: parent.treeId,
			depth: parent.depth + 1,
			agent: request.agent,
			profile: request.profile,
			childSpawnBudget: 0,
		});
		return createReservation(childContext, () => {
			this.remainingCredits += 1;
			this.reservedOrCommittedChildSpawns -= 1;
		});
	}
}

export function executionCanDelegate(config: ProfilesConfig, context: ChildExecutionContext): boolean {
	if (context.depth >= MAX_DELEGATION_DEPTH || context.childSpawnBudget <= 0) return false;
	const agentPolicy = config.agentPolicies[context.agent];
	const profile = config.profiles[context.profile];
	return agentPolicy?.delegation.mode === "grant-required" && profile?.delegationEnabled === true;
}

function createReservation(
	childContext: ChildExecutionContext,
	onRelease: () => void = () => {},
): SpawnAdmissionReservation {
	let state: "pending" | "committed" | "released" = "pending";
	return Object.freeze({
		childContext,
		commit() {
			if (state === "pending") state = "committed";
		},
		release() {
			if (state !== "pending") return;
			state = "released";
			onRelease();
		},
	});
}

function assertGrant(grant: number, maximum: number): void {
	if (!Number.isInteger(grant) || grant < 0 || grant > maximum) {
		throw new Error(`child_spawn_budget must be an integer from 0 to ${maximum}.`);
	}
}
