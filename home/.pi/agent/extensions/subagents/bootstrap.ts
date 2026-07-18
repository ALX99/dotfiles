import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { discoverAgents, type AgentConfig } from "./agents.ts";
import { AgentRegistry } from "./agent-registry.ts";
import { CleanupAggregateError, type AgentSummary } from "./agent-types.ts";
import { parseChildExecutionContext, type ChildExecutionContext } from "./process.ts";
import { loadProfiles, type ProfilesConfig } from "./profiles.ts";
import { SpawnAdmissionController } from "./spawn-admission.ts";
import { bindRegistryUi, notifyCompletion, type RegistryUiBinding } from "./ui/widget.ts";

export interface SubagentRuntime {
	readonly agents: AgentConfig[];
	readonly profiles: ProfilesConfig;
	readonly executionContext: ChildExecutionContext | undefined;
	readonly registry: AgentRegistry;
	readonly admission: SpawnAdmissionController;
	readonly ticks: Map<string, NodeJS.Timeout>;
	readonly agentList: string;
	readonly shuttingDown: boolean;
	handleBackgroundComplete(pi: ExtensionAPI, summary: AgentSummary): void;
	consumeSettledCompletions(summaries: readonly AgentSummary[]): void;
}

class DefaultSubagentRuntime implements SubagentRuntime {
	readonly agents: AgentConfig[];
	readonly profiles: ProfilesConfig;
	readonly executionContext: ChildExecutionContext | undefined;
	readonly registry = new AgentRegistry();
	readonly ticks = new Map<string, NodeJS.Timeout>();
	readonly admission: SpawnAdmissionController;
	readonly agentList: string;
	shuttingDown = false;
	private readonly pendingCompletions = new Map<string, AgentSummary>();
	private activeContext: ExtensionContext | undefined;
	private uiBinding: RegistryUiBinding | undefined;

	constructor(agents: AgentConfig[], profiles: ProfilesConfig, executionContext: ChildExecutionContext | undefined) {
		this.agents = agents;
		this.profiles = profiles;
		this.executionContext = executionContext;
		this.admission = new SpawnAdmissionController(
			profiles,
			this.registry,
			executionContext?.treeId ?? randomUUID(),
			executionContext,
		);
		this.agentList = formatAgentPolicyList(agents, profiles);
	}

	startSession(ctx: ExtensionContext): void {
		this.activeContext = ctx;
		this.uiBinding?.close();
		this.uiBinding = bindRegistryUi(ctx, this.registry, () => {
			discardSupersededCompletions(this.pendingCompletions, this.registry.list());
		});
		this.uiBinding.refresh();
	}

	flushCompletions(pi: ExtensionAPI): void {
		const completions = [...this.pendingCompletions.values()];
		this.pendingCompletions.clear();
		if (completions.length) sendCompletions(pi, completions);
	}

	handleBackgroundComplete(pi: ExtensionAPI, summary: AgentSummary): void {
		if (this.shuttingDown || (summary.status !== "idle" && summary.status !== "failed")) return;
		notifyCompletion(this.activeContext, summary);
		if (this.activeContext?.isIdle()) sendCompletions(pi, [summary]);
		else this.pendingCompletions.set(summary.agent_id, summary);
	}

	consumeSettledCompletions(summaries: readonly AgentSummary[]): void {
		for (const summary of summaries) {
			if (summary.status !== "idle" && summary.status !== "failed") continue;
			const pending = this.pendingCompletions.get(summary.agent_id);
			if (pending?.generation === summary.generation) this.pendingCompletions.delete(summary.agent_id);
		}
	}

	async shutdown(): Promise<void> {
		this.shuttingDown = true;
		this.pendingCompletions.clear();
		const failures: unknown[] = [];
		try {
			this.uiBinding?.close();
		} catch (error) {
			failures.push(error);
		} finally {
			this.uiBinding = undefined;
			this.activeContext = undefined;
		}
		for (const tick of this.ticks.values()) clearInterval(tick);
		this.ticks.clear();
		try {
			await this.registry.closeAll();
		} catch (error) {
			failures.push(error);
		}
		if (failures.length) throw new CleanupAggregateError("Subagent extension", failures);
	}
}

export function bootstrapSubagents(): DefaultSubagentRuntime | undefined {
	const discovered = discoverAgents();
	let agents: AgentConfig[];
	let agentErrors: string[] = [];
	if (discovered.isOk()) {
		agents = discovered.value;
	} else if (discovered.error.kind === "configuration") {
		agents = discovered.error.agents;
		agentErrors = discovered.error.errors;
	} else {
		throw new Error(discoveryErrorMessage(discovered.error));
	}
	const profileResult = loadProfiles(agents);
	if (profileResult.isErr()) throw new Error([...agentErrors, ...profileResult.error.errors].join("\n"));
	if (agentErrors.length) throw new Error(agentErrors.join("\n"));
	const runtime = new DefaultSubagentRuntime(agents, profileResult.value, parseChildExecutionContext());
	return runtime.admission.canExposeSubagentTools() ? runtime : undefined;
}

export function registerSubagentLifecycle(pi: ExtensionAPI, runtime: DefaultSubagentRuntime): void {
	pi.on("session_start", (_event, ctx) => runtime.startSession(ctx));
	pi.on("agent_end", () => runtime.flushCompletions(pi));
	pi.on("session_shutdown", () => runtime.shutdown());
}

function formatAgentPolicyList(agents: readonly AgentConfig[], profiles: ProfilesConfig): string {
	return agents
		.map((agent) => {
			const policy = profiles.agentPolicies[agent.name];
			if (!policy) throw new Error(`No execution policy is configured for agent '${agent.name}'.`);
			const allowed = policy.allowedProfiles.map((name) => `\`${name}\``).join(", ");
			return `- **${agent.name}** — ${agent.description} Default profile: \`${policy.defaultProfile}\`; allowed: ${allowed}.`;
		})
		.join("\n");
}

function sendCompletions(pi: ExtensionAPI, summaries: readonly AgentSummary[]): void {
	const completions = summaries.map((summary) => {
		const output = escapeXml(summary.final_text || summary.error || "(no output)");
		return `<subagent_completion agent_id="${summary.agent_id}" generation="${summary.generation}" status="${summary.status}">\n${output}\n</subagent_completion>`;
	});
	pi.sendMessage(
		{
			customType: "subagent-completion",
			content:
				completions.length === 1
					? (completions[0] ?? "")
					: `<subagent_completions>\n${completions.join("\n")}\n</subagent_completions>`,
			display: true,
			details: summaries.length === 1 && summaries[0] ? summaries[0] : summaries,
		},
		{ deliverAs: "followUp", triggerTurn: true },
	);
}

function escapeXml(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function discardSupersededCompletions(
	pending: Map<string, AgentSummary>,
	currentSummaries: readonly AgentSummary[],
): void {
	for (const current of currentSummaries) {
		const queued = pending.get(current.agent_id);
		if (queued && isCompletionSuperseded(queued, current)) pending.delete(current.agent_id);
	}
}

export function isCompletionSuperseded(queued: AgentSummary, current: AgentSummary): boolean {
	return (
		queued.agent_id === current.agent_id && (current.generation > queued.generation || current.status === "closed")
	);
}

function discoveryErrorMessage(error: {
	readonly kind: string;
	readonly dir: string;
	readonly cause?: NodeJS.ErrnoException;
	readonly errors?: readonly string[];
}): string {
	if (error.kind === "read_dir")
		return `Could not read agents dir ${error.dir}: ${error.cause?.message ?? error.cause?.code ?? "unknown error"}.`;
	if (error.kind === "configuration") return error.errors?.join("\n") || `Invalid agent configuration in ${error.dir}.`;
	return `No agent files found in ${error.dir}.`;
}
