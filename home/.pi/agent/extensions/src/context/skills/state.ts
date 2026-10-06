import type { SessionEntry, Skill } from "@earendil-works/pi-coding-agent";
import { Result, Schema } from "effect";

export const SKILLS_STATE_ENTRY = "pi.skills.visibility";

const PersistedSkillsState = Schema.Struct({
	version: Schema.Literal(1),
	knownNames: Schema.Array(Schema.String),
	enabledNames: Schema.Array(Schema.String),
});

export type PersistedSkillsState = Schema.Schema.Type<typeof PersistedSkillsState>;

/** The branch's latest valid selection; unrecorded names remain enabled by default. */
export function readSelection(entries: readonly SessionEntry[]): Map<string, boolean> | undefined {
	let selection: Map<string, boolean> | undefined;
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== SKILLS_STATE_ENTRY) continue;
		const decoded = Schema.decodeUnknownResult(PersistedSkillsState)(entry.data);
		if (Result.isFailure(decoded)) continue;
		const enabled = new Set(decoded.success.enabledNames);
		selection = new Map(decoded.success.knownNames.map((name) => [name, enabled.has(name)]));
	}
	return selection;
}

/** Selection data for the prompt renderer, independent of extension registration and UI. */
export function enabledModelSkillNames(
	entries: readonly SessionEntry[],
	skills: readonly Skill[],
): ReadonlySet<string> {
	const selection = readSelection(entries);
	return new Set(
		skills
			.filter((skill) => !skill.disableModelInvocation && (selection?.get(skill.name) ?? true))
			.map((skill) => skill.name),
	);
}
