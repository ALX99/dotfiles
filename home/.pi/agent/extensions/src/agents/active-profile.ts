import type { ProfileCapabilityPolicy } from "./policy.ts";
import { createCapabilityPolicy } from "./policy.ts";
import type { ProfileSnapshot } from "./profile.ts";
import type { ToolSelection } from "../integration/tool-selection.ts";

/** Current-session profile state shared by prompt, permission, and command adapters. */
export interface ProfilePromptState {
	getProfile(): Pick<ProfileSnapshot, "name" | "prompt"> | undefined;
	getPolicy(): ProfileCapabilityPolicy | undefined;
}

export interface ActiveProfileState extends ProfilePromptState {
	getProfile(): ProfileSnapshot | undefined;
	setProfile(profile?: ProfileSnapshot): void;
	subscribe(listener: () => void): () => void;
}

export function createActiveProfileState(toolSelection: ToolSelection): ActiveProfileState {
	let profile: ProfileSnapshot | undefined;
	let policy: ProfileCapabilityPolicy | undefined;
	const listeners = new Set<() => void>();

	return {
		getProfile: () => profile,
		getPolicy: () => policy,
		setProfile(nextProfile) {
			const nextPolicy = nextProfile === undefined ? undefined : createCapabilityPolicy(nextProfile);
			toolSelection.setCapabilityPolicy(nextPolicy);
			profile = nextProfile;
			policy = nextPolicy;
			for (const listener of Array.from(listeners)) {
				try {
					listener();
				} catch (cause) {
					console.error(
						`Active profile change listener failed: ${cause instanceof Error ? cause.message : String(cause)}`,
					);
				}
			}
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}
