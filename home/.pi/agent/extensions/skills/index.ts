import {
	formatSkillsForPrompt,
	type BeforeAgentStartEvent,
	type ExtensionAPI,
	type ExtensionContext,
	type Skill,
} from "@earendil-works/pi-coding-agent";

import { isRecord } from "../_shared/json.ts";
import { inspectSkills, summarizeSkillTokens } from "./analysis.ts";
import { formatSkillsSummary, showSkillsPanel, showSkillsSelector, type SkillsPanelOptions } from "./ui.ts";

const SKILLS_STATE_ENTRY = "pi.skills.visibility";

interface PersistedSkillsState {
	version: 1;
	knownNames: string[];
	enabledNames: string[];
}

interface RuntimeState {
	/** Last inventory, used only when Pi does not provide one. */
	skills: Skill[];
	/** One selection per known name; missing names are enabled by default. */
	selection: Map<string, boolean>;
}

export default function skillsExtension(pi: ExtensionAPI): void {
	const state: RuntimeState = {
		skills: [],
		selection: new Map(),
	};

	pi.on("session_start", (_event, ctx) => restoreState(state, ctx));
	pi.on("session_tree", (_event, ctx) => restoreState(state, ctx));

	pi.on("before_agent_start", (event) => {
		const skills = event.systemPromptOptions.skills ?? state.skills;
		const enabledNames = syncSkills(state, skills);
		const systemPrompt = rewriteSkillPrompt(event, enabledNames);
		return systemPrompt === undefined ? undefined : { systemPrompt };
	});

	pi.registerCommand("skills", {
		description: "Inspect and toggle model-visible Pi skills for this session",
		handler: async (_args, ctx) => {
			const options = ctx.getSystemPromptOptions();
			const skills = options.skills ?? state.skills;
			const enabledNames = syncSkills(state, skills);
			const locked = isSessionLocked(ctx);

			const analyses = await inspectSkills(skills, pi.getActiveTools());
			const readActive = options.selectedTools?.includes("read") ?? true;
			const getTokens = () => summarizeSkillTokens(analyses, enabledNames, readActive);
			const onToggle = (name: string, enabled: boolean): void => {
				if (isSessionLocked(ctx)) {
					ctx.ui.notify("Skill toggles are locked after the first user message.", "warning");
					return;
				}
				if (enabled) enabledNames.add(name);
				else enabledNames.delete(name);
				state.selection.set(name, enabled);
				persistState(pi, state);
			};
			const panelOptions: SkillsPanelOptions = {
				analyses,
				enabledNames,
				locked,
				readActive,
				getTokens,
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
			ctx.ui.notify(formatSkillsSummary(analyses, enabledNames, locked, readActive, getTokens()), "info");
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
	state.skills = [];
	state.selection.clear();

	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== SKILLS_STATE_ENTRY) continue;
		const persisted = parsePersistedState(entry.data);
		if (persisted === undefined) continue;
		const enabledNames = new Set(persisted.enabledNames);
		state.selection = new Map(persisted.knownNames.map((name) => [name, enabledNames.has(name)]));
	}
}

/** Reconcile restored and live selections through the same inventory boundary. */
function syncSkills(state: RuntimeState, skills: readonly Skill[]): Set<string> {
	state.selection = new Map(
		skills.map((skill) => [skill.name, isModelInvocable(skill) && (state.selection.get(skill.name) ?? true)]),
	);
	state.skills = [...skills];
	return new Set([...state.selection].filter(([, enabled]) => enabled).map(([name]) => name));
}

function persistState(pi: ExtensionAPI, state: RuntimeState): void {
	const saved: PersistedSkillsState = {
		version: 1,
		knownNames: [...state.selection.keys()].toSorted(),
		enabledNames: [...state.selection]
			.filter(([, enabled]) => enabled)
			.map(([name]) => name)
			.toSorted(),
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

function isModelInvocable(skill: Skill): boolean {
	return !skill.disableModelInvocation;
}

function isSessionLocked(ctx: ExtensionContext): boolean {
	return ctx.sessionManager.getBranch().some(isUserMessageEntry);
}

function isUserMessageEntry(entry: { type: string; message?: { role?: string } }): boolean {
	return entry.type === "message" && entry.message?.role === "user";
}
