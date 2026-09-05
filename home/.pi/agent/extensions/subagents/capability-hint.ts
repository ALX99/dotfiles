/** Advertise resolved profiles without assuming a universal model ranking. */
import type { ScopedModel } from "@earendil-works/pi-coding-agent";
import { splitModelId, type ProfilesConfig } from "./profiles.ts";

export interface CapabilityHintInput {
	readonly config: ProfilesConfig;
	readonly agents: readonly { readonly name: string }[];
	readonly availableModels: readonly ScopedModel[];
	readonly currentModel?: { readonly provider: string; readonly id: string };
}

export function buildCapabilityHint(input: CapabilityHintInput): string | undefined {
	const names = [
		...new Set(input.agents.flatMap((agent) => input.config.agentPolicies[agent.name]?.allowedProfiles ?? [])),
	];
	const lines = names.flatMap((name) => {
		const profile = input.config.profiles[name];
		if (!profile) return [];
		const candidate = profile.modelPriority.find(({ id }) => {
			const [provider, modelId] = splitModelId(id);
			return input.availableModels.some(({ model }) => model.provider === provider && model.id === modelId);
		});
		return candidate
			? [
					`${name} → ${candidate.id}: ${profile.description}. Thinking ${candidate.minThinking}–${candidate.maxThinking}, default ${candidate.defaultThinking}; explicit requests override scoped defaults within this range.`,
				]
			: [];
	});
	return lines.length
		? `Available subagent profiles:\n${lines.join("\n")}\nChoose a profile suited to the assignment. The parent owns integration and evidence-based verification; a model name alone does not establish correctness.`
		: undefined;
}
