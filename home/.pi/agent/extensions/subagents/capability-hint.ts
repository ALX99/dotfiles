/** capabilityRanking interpretation: per-turn hint wording and startup contracts. */

import type { ScopedModel } from "@earendil-works/pi-coding-agent";
import { splitModelId, type ProfilesConfig } from "./profiles.ts";

export interface CapabilityHintInput {
	readonly config: ProfilesConfig;
	readonly agents: readonly { readonly name: string }[];
	readonly availableModels: readonly ScopedModel[];
	readonly currentModel?: { readonly provider: string; readonly id: string };
}

function unrankedModelIds(config: ProfilesConfig, modelIds: readonly string[]): string[] {
	const ranked = new Set(config.capabilityRanking);
	return [...new Set(modelIds)].filter((id) => !ranked.has(id));
}

/**
 * Startup contract for directional wording: every session-scoped model can
 * become the parent, so each must be ranked. An absent or empty scope means
 * "every authenticated model" and cannot be enforced against a hand-maintained
 * ranking, so it deliberately passes.
 */
export function findScopedRankingError(
	config: ProfilesConfig,
	scopedModels?: readonly ScopedModel[],
): string | undefined {
	if (!scopedModels || scopedModels.length === 0) return undefined;
	const missing = unrankedModelIds(
		config,
		scopedModels.map(({ model }) => `${model.provider}/${model.id}`),
	);
	if (missing.length === 0) return undefined;
	return `Subagent capabilityRanking must list every scoped model; missing: ${missing.join(", ")}. Rank them in extensions/subagents/profiles.json or narrow your scoped models.`;
}

/**
 * Build the per-turn system-prompt block naming which models the advertised
 * profiles resolve to right now and how they compare with the parent session's
 * model. The parent only sees profile names in spawn_agent guidelines, never
 * resolved model ids, so it cannot otherwise tell when a cheap profile
 * delegates to a weaker reasoner. Directional wording requires both sides to
 * be ranked (weakest-first in profiles.json); unranked or cross-provider
 * models degrade to neutral advice. Returns undefined when the parent model is
 * unknown or no advertised profile has an authenticated candidate.
 */
export function buildCapabilityHint(input: CapabilityHintInput): string | undefined {
	if (!input.currentModel) return undefined;
	const current = `${input.currentModel.provider}/${input.currentModel.id}`;
	const advertised = [
		...new Set(input.agents.flatMap((agent) => input.config.agentPolicies[agent.name]?.allowedProfiles ?? [])),
	];
	const resolved: { name: string; id: string }[] = [];
	for (const name of advertised) {
		const profile = input.config.profiles[name];
		if (!profile) continue;
		const candidate = profile.modelPriority.find(({ id }) => {
			const [provider, modelId] = splitModelId(id);
			return input.availableModels.some(({ model }) => model.provider === provider && model.id === modelId);
		});
		if (candidate) resolved.push({ name, id: candidate.id });
	}
	if (resolved.length === 0) return undefined;

	const ranking = input.config.capabilityRanking;
	const rank = (id: string): number | undefined => {
		const index = ranking?.indexOf(id);
		return index === undefined || index < 0 ? undefined : index;
	};
	const parentRank = rank(current);
	const describe = ({ name, id }: { name: string; id: string }): string => {
		const childRank = rank(id);
		if (parentRank !== undefined && childRank !== undefined && childRank !== parentRank) {
			return `${name} → ${id} (${childRank < parentRank ? "weaker" : "stronger"} than you)`;
		}
		return `${name} → ${id}`;
	};

	const mapping = resolved.map(describe).join(", ");
	const differing = resolved.filter((entry) => entry.id !== current);
	if (differing.length === 0) return `Live subagent models: ${mapping}. Children run your same model.`;

	// Any weaker differing child dominates; all-ranked-and-stronger reassures;
	// any unranked side stays neutral.
	let verdict: "weaker" | "stronger" | "neutral" = "stronger";
	for (const { id } of differing) {
		const child = rank(id);
		if (child === undefined || parentRank === undefined) {
			verdict = "neutral";
			break;
		}
		if (child < parentRank) verdict = "weaker";
	}
	const prefix = `Live subagent models: ${mapping}; you are running ${current}.`;
	switch (verdict) {
		case "weaker":
			return `${prefix} Use spawn_agent for well-scoped mechanical execution, and keep debugging, design decisions, and multi-step reasoning in your own context whenever the child's resolved model is weaker.`;
		case "stronger":
			return `${prefix} Children run models at least as capable as yours, so delegating demanding work via spawn_agent is safe; mind the added cost.`;
		case "neutral":
			return `${prefix} Match task difficulty to each child's resolved model before delegating reasoning-heavy work via spawn_agent.`;
	}
}
