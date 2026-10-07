import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { ProfileSnapshot } from "./profile.ts";

type NamedCapability = { readonly name: string };

// Parent communication is part of the child invocation protocol, not a work capability.
const REQUIRED_AGENT_TOOLS = new Set(["ask_parent"]);
// These runtime tools discover or dispatch a profile's explicitly allowed deferred tools.
const LAZY_TOOL_RUNTIME = new Set(["codemode", "tool_search"]);

/** One resolved profile's tool and skill permissions. */
export interface ProfileCapabilityPolicy {
	readonly profile: string;
	/** Omitted means unrestricted; otherwise a frozen list of direct-child profile names. */
	readonly spawnProfiles: readonly string[] | undefined;
	allowsTool(name: string): boolean;
	allowsSkill(name: string): boolean;
	allowsSpawnProfile(name: string): boolean;
	filterToolNames(names: readonly string[]): string[];
	filterTools<T extends NamedCapability>(tools: readonly T[]): T[];
	filterSkills<T extends NamedCapability>(skills: readonly T[]): T[];
}

/** Omitted profile allowlists mean unrestricted; an empty list means deny all. */
export function createCapabilityPolicy(
	profile: Pick<ProfileSnapshot, "name" | "tools" | "skills" | "spawnProfiles">,
): ProfileCapabilityPolicy {
	const tools = profile.tools === undefined ? undefined : new Set(profile.tools);
	const skills = profile.skills === undefined ? undefined : new Set(profile.skills);
	const spawnProfiles = profile.spawnProfiles === undefined ? undefined : Object.freeze([...profile.spawnProfiles]);
	const allowedSpawnProfiles = spawnProfiles === undefined ? undefined : new Set(spawnProfiles);
	const allowsTool = (name: string) =>
		REQUIRED_AGENT_TOOLS.has(name) ||
		tools === undefined ||
		tools.has(name) ||
		(tools.size > 0 && LAZY_TOOL_RUNTIME.has(name));

	return Object.freeze({
		profile: profile.name,
		spawnProfiles,
		allowsTool,
		allowsSkill: (name: string) => skills === undefined || skills.has(name),
		allowsSpawnProfile: (name: string) => allowedSpawnProfiles === undefined || allowedSpawnProfiles.has(name),
		filterToolNames: (names: readonly string[]) => names.filter(allowsTool),
		filterTools: <T extends NamedCapability>(values: readonly T[]) => values.filter((tool) => allowsTool(tool.name)),
		filterSkills: <T extends NamedCapability>(values: readonly T[]) =>
			skills === undefined ? [...values] : values.filter((skill) => skills.has(skill.name)),
	});
}

/**
 * Enforce the snapshot at Pi's dispatch boundary. Pi runs this hook for direct, deferred, and
 * nested tool calls, so hiding a tool from the model is not the permission check.
 */
export function installToolExecutionPolicy(pi: Pick<ExtensionAPI, "on">, policy: ProfileCapabilityPolicy): () => void {
	return pi.on("tool_call", (event) => {
		if (policy.allowsTool(event.toolName)) return undefined;
		return {
			block: true,
			reason: `Profile "${policy.profile}" does not allow tool "${event.toolName}".`,
		};
	});
}
