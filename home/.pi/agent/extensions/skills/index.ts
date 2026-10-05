import type { ExtensionAPI, ExtensionContext, Skill } from "@earendil-works/pi-coding-agent";

import { runPromise } from "../_shared/effect-runtime.ts";
import { inspectSkills, summarizeSkillTokens } from "./analysis.ts";
import { formatSkillsSummary, showSkillsPanel, showSkillsSelector, type SkillsPanelOptions } from "./ui.ts";
import { enabledModelSkillNames, SKILLS_STATE_ENTRY, type PersistedSkillsState } from "./state.ts";

export default function skillsExtension(pi: ExtensionAPI): void {
	pi.registerCommand("skills", {
		description: "Inspect and toggle model-visible Pi skills for this session",
		handler: async (_args, ctx) => {
			const options = ctx.getSystemPromptOptions();
			const skills = options.skills ?? [];
			const enabledNames = new Set(enabledModelSkillNames(ctx.sessionManager.getBranch(), skills));
			const locked = isSessionLocked(ctx);

			const analyses = await runPromise(inspectSkills(skills, pi.getActiveTools()));
			const readActive = options.selectedTools?.includes("read") ?? true;
			const getTokens = () => summarizeSkillTokens(analyses, enabledNames, readActive);
			const onToggle = (name: string, enabled: boolean): void => {
				if (isSessionLocked(ctx)) {
					ctx.ui.notify("Skill toggles are locked after the first user message.", "warning");
					return;
				}
				if (enabled) enabledNames.add(name);
				else enabledNames.delete(name);
				persistState(pi, skills, enabledNames);
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

function persistState(pi: ExtensionAPI, skills: readonly Skill[], enabledNames: ReadonlySet<string>): void {
	const saved: PersistedSkillsState = {
		version: 1,
		knownNames: skills.map((skill) => skill.name).toSorted(),
		enabledNames: [...enabledNames].toSorted(),
	};
	pi.appendEntry(SKILLS_STATE_ENTRY, saved);
}

function isSessionLocked(ctx: ExtensionContext): boolean {
	return ctx.sessionManager.getBranch().some(isUserMessageEntry);
}

function isUserMessageEntry(entry: { type: string; message?: { role?: string } }): boolean {
	return entry.type === "message" && entry.message?.role === "user";
}
