import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { ProfileCapabilityPolicy } from "../agents/policy.ts";
import { APPLY_PATCH_TOOL_NAME } from "../tools/apply-patch/types.ts";
import { RECALL_TOOL_NAME } from "../openai/search/recall.ts";
import { TASK_TOOL_NAMES } from "../tasks/tools.ts";

const OWNED_TOOLS = {
	applyPatch: [APPLY_PATCH_TOOL_NAME],
	tasks: TASK_TOOL_NAMES,
	searchRecall: [RECALL_TOOL_NAME],
} as const;

const OWNED_TOOL_ENTRIES = [
	["applyPatch", OWNED_TOOLS.applyPatch],
	["tasks", OWNED_TOOLS.tasks],
	["searchRecall", OWNED_TOOLS.searchRecall],
] as const;

type Owner = keyof typeof OWNED_TOOLS;

export interface ToolSelection {
	getActiveTools(): string[];
	/** Remove currently active tools that this session's profile does not permit. */
	applyCapabilityPolicy(): void;
	setApplyPatchActive(enabled: boolean): void;
	setTaskTools(names: readonly string[]): void;
	setSearchRecallActive(enabled: boolean): void;
}

/**
 * The one writer for personal feature tool activation. It changes only the tools owned here,
 * always starts from Pi's live selection, and reads back that selection after Pi applies its
 * registry and CLI constraints.
 */
export function createToolSelection(
	pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">,
	policy?: ProfileCapabilityPolicy,
): ToolSelection {
	const ownerByTool = new Map<string, Owner>();
	for (const [owner, names] of OWNED_TOOL_ENTRIES) {
		for (const name of names) {
			if (ownerByTool.has(name)) throw new Error(`Tool ${name} has more than one personal selection owner.`);
			ownerByTool.set(name, owner);
		}
	}
	const managedNames = new Set(ownerByTool.keys());
	const desiredByOwner = new Map<Owner, ReadonlySet<string>>();

	function set(owner: Owner, names: readonly string[]): void {
		const owned = new Set<string>(OWNED_TOOLS[owner]);
		for (const name of names) {
			if (!owned.has(name)) throw new Error(`${owner} cannot activate tool ${name}.`);
		}
		desiredByOwner.set(owner, new Set(names));

		const active = pi.getActiveTools();
		const wanted = new Set<string>();
		for (const [feature, featureTools] of OWNED_TOOL_ENTRIES) {
			const desired = desiredByOwner.get(feature);
			for (const name of featureTools) {
				if (desired?.has(name) ?? active.includes(name)) wanted.add(name);
			}
		}

		const next = active.filter((name) => !managedNames.has(name) || wanted.has(name));
		for (const name of managedNames) {
			if (wanted.has(name) && !next.includes(name)) next.push(name);
		}
		applyNames(next);
	}

	function applyNames(names: readonly string[]): void {
		const next = policy?.filterToolNames(names) ?? [...names];
		const active = pi.getActiveTools();
		if (active.length !== next.length || active.some((name, index) => name !== next[index])) pi.setActiveTools(next);
	}

	return {
		getActiveTools: () => policy?.filterToolNames(pi.getActiveTools()) ?? pi.getActiveTools(),
		applyCapabilityPolicy: () => applyNames(pi.getActiveTools()),
		setApplyPatchActive: (enabled) => set("applyPatch", enabled ? OWNED_TOOLS.applyPatch : []),
		setTaskTools: (names) => set("tasks", names),
		setSearchRecallActive: (enabled) => set("searchRecall", enabled ? OWNED_TOOLS.searchRecall : []),
	};
}
