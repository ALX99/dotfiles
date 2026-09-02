import {
	formatSkillsForPrompt,
	type BeforeAgentStartEvent,
	type ExtensionAPI,
	type ExtensionContext,
	type Skill,
} from "@earendil-works/pi-coding-agent";

import { inspectSkills, summarizeSkillTokens } from "./analysis.ts";
import { formatSkillsSummary, showSkillsPanel, showSkillsSelector, type SkillsPanelOptions } from "./ui.ts";

const SKILLS_STATE_ENTRY = "pi.skills.visibility";

interface PersistedSkillsState {
	version: 1;
	knownNames: string[];
	enabledNames: string[];
}

interface RuntimeState {
	/** Undefined means the current session has not resolved its skill inventory yet. */
	skills: Skill[] | undefined;
	enabledNames: Set<string>;
	/** Consumed by the first inventory sync, then discarded. */
	persistedState: PersistedSkillsState | undefined;
}

export default function skillsExtension(pi: ExtensionAPI): void {
	const state: RuntimeState = {
		skills: undefined,
		enabledNames: new Set(),
		persistedState: undefined,
	};

	pi.on("session_start", (_event, ctx) => restoreState(state, ctx));
	pi.on("session_tree", (_event, ctx) => restoreState(state, ctx));

	pi.on("before_agent_start", (event) => {
		const skills = event.systemPromptOptions.skills ?? state.skills ?? [];
		syncSkills(state, skills);
		const systemPrompt = rewriteSkillPrompt(event, state.enabledNames);
		return systemPrompt === undefined ? undefined : { systemPrompt };
	});

	pi.registerCommand("skills", {
		description: "Inspect and toggle model-visible Pi skills for this session",
		handler: async (_args, ctx) => {
			const options = ctx.getSystemPromptOptions();
			const skills = options.skills ?? state.skills ?? [];
			syncSkills(state, skills);
			const locked = isSessionLocked(ctx);

			const analyses = await inspectSkills(skills, pi.getActiveTools());
			const readActive = options.selectedTools?.includes("read") ?? true;
			let tokens = summarizeSkillTokens(analyses, state.enabledNames, readActive);
			const onToggle = (name: string, enabled: boolean): void => {
				if (isSessionLocked(ctx)) {
					ctx.ui.notify("Skill toggles are locked after the first user message.", "warning");
					return;
				}
				if (enabled) state.enabledNames.add(name);
				else state.enabledNames.delete(name);
				persistState(pi, state);
				tokens = summarizeSkillTokens(analyses, state.enabledNames, readActive);
			};
			const panelOptions: SkillsPanelOptions = {
				analyses,
				enabledNames: state.enabledNames,
				locked,
				readActive,
				getTokens: () => tokens,
				onToggle,
			};

			if (ctx.mode === "tui") {
				await showSkillsPanel(ctx, panelOptions);
				return;
			}
			if (ctx.hasUI) {
				await showSkillsSelector(ctx, panelOptions);
				return;
			}
			ctx.ui.notify(formatSkillsSummary(analyses, state.enabledNames, locked, readActive, tokens), "info");
		},
	});
}

/** Filter only the model-visible skills selected by this session. */
export function getEnabledModelSkills(skills: readonly Skill[], enabledNames: ReadonlySet<string>): Skill[] {
	return skills.filter((skill) => isModelInvocable(skill) && enabledNames.has(skill.name));
}

/** Replace only Pi's native discovery section; explicit /skill:name is unaffected. */
export function rewriteSkillPrompt(
	event: BeforeAgentStartEvent,
	enabledNames: ReadonlySet<string>,
): string | undefined {
	const selectedTools = event.systemPromptOptions.selectedTools;
	if (selectedTools !== undefined && !selectedTools.includes("read")) return undefined;

	const allSkills = event.systemPromptOptions.skills ?? [];
	const nativeSection = formatSkillsForPrompt(allSkills);
	if (nativeSection.length === 0) return undefined;
	const enabledSection = formatSkillsForPrompt(getEnabledModelSkills(allSkills, enabledNames));
	if (nativeSection === enabledSection) return undefined;

	// Pi appends this section to the assembled prompt. Use the last occurrence so
	// a custom prompt containing the same literal cannot capture the replacement.
	const sectionStart = event.systemPrompt.lastIndexOf(nativeSection);
	if (sectionStart === -1) return undefined;
	return `${event.systemPrompt.slice(0, sectionStart)}${enabledSection}${event.systemPrompt.slice(sectionStart + nativeSection.length)}`;
}

function restoreState(state: RuntimeState, ctx: ExtensionContext): void {
	state.skills = undefined;
	state.enabledNames = new Set();
	state.persistedState = undefined;

	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== SKILLS_STATE_ENTRY) continue;
		const persisted = parsePersistedState(entry.data);
		if (persisted !== undefined) state.persistedState = persisted;
	}
}

function syncSkills(state: RuntimeState, skills: readonly Skill[]): void {
	if (state.skills === undefined) {
		state.enabledNames = initialEnabledNames(skills, state.persistedState);
		state.persistedState = undefined;
	} else {
		state.enabledNames = reconcileEnabledNames(state.skills, state.enabledNames, skills);
	}
	state.skills = [...skills];
}

function initialEnabledNames(skills: readonly Skill[], persisted: PersistedSkillsState | undefined): Set<string> {
	if (persisted === undefined) return new Set(skills.filter(isModelInvocable).map(({ name }) => name));

	const knownNames = new Set(persisted.knownNames);
	const persistedEnabledNames = new Set(persisted.enabledNames);
	return new Set(
		skills
			.filter(isModelInvocable)
			.filter(({ name }) => !knownNames.has(name) || persistedEnabledNames.has(name))
			.map(({ name }) => name),
	);
}

function reconcileEnabledNames(
	previousSkills: readonly Skill[],
	previousEnabledNames: ReadonlySet<string>,
	nextSkills: readonly Skill[],
): Set<string> {
	const previousNames = new Set(previousSkills.map(({ name }) => name));
	return new Set(
		nextSkills
			.filter(isModelInvocable)
			.filter(({ name }) => !previousNames.has(name) || previousEnabledNames.has(name))
			.map(({ name }) => name),
	);
}

function persistState(pi: ExtensionAPI, state: RuntimeState): void {
	if (state.skills === undefined) return;
	const saved: PersistedSkillsState = {
		version: 1,
		knownNames: [...new Set(state.skills.map(({ name }) => name))].toSorted(),
		enabledNames: [...state.enabledNames].toSorted(),
	};
	pi.appendEntry(SKILLS_STATE_ENTRY, saved);
}

function parsePersistedState(data: unknown): PersistedSkillsState | undefined {
	if (!isRecord(data) || data.version !== 1) return undefined;
	const knownNames = asStringArray(data.knownNames);
	const enabledNames = asStringArray(data.enabledNames);
	if (knownNames === undefined || enabledNames === undefined) return undefined;
	return { version: 1, knownNames, enabledNames };
}

function asStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return undefined;
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isModelInvocable(skill: Skill): boolean {
	return !skill.disableModelInvocation;
}

function isSessionLocked(ctx: ExtensionContext): boolean {
	return ctx.sessionManager.getBranch().some(isUserMessageEntry);
}

function isUserMessageEntry(entry: { type: string; message?: { role?: string } }): boolean {
	return entry.type === "message" && entry.message?.role === "user";
}
