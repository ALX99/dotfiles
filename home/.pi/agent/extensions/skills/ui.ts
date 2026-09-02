import { getSettingsListTheme, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { SettingsList, truncateToWidth, type Component, type SettingItem, type TUI } from "@earendil-works/pi-tui";

import { countDiagnostics, type SkillAnalysis, type SkillTokenSummary } from "./analysis.ts";
import { sanitizeTerminalText } from "../_shared/terminal-text.ts";

export interface SkillsPanelOptions {
	analyses: readonly SkillAnalysis[];
	enabledNames: ReadonlySet<string>;
	locked: boolean;
	readActive: boolean;
	getTokens: () => SkillTokenSummary;
	onToggle: (name: string, enabled: boolean) => void;
}

export function createSkillSettingsItems(
	analyses: readonly SkillAnalysis[],
	enabledNames: ReadonlySet<string>,
	locked: boolean,
): SettingItem[] {
	return analyses.map((analysis) => {
		const { skill } = analysis;
		const diagnosticMarker = getDiagnosticMarker(analysis);
		const item: SettingItem = {
			id: skill.name,
			label: `${sanitizeTerminalText(skill.name)}${diagnosticMarker}`,
			description: formatSkillDescription(analysis),
			currentValue: skill.disableModelInvocation ? "manual" : enabledNames.has(skill.name) ? "enabled" : "disabled",
		};
		if (!skill.disableModelInvocation && !locked) {
			item.values = ["enabled", "disabled"];
		}
		return item;
	});
}

export function formatSkillsSummary(
	analyses: readonly SkillAnalysis[],
	enabledNames: ReadonlySet<string>,
	locked: boolean,
	readActive: boolean,
	tokens: SkillTokenSummary,
): string {
	const modelInvocable = analyses.filter(({ skill }) => !skill.disableModelInvocation);
	const enabled = modelInvocable.filter(({ skill }) => enabledNames.has(skill.name));
	const diagnostics = countDiagnostics(analyses);
	const lines = [
		`/skills: ${enabled.length}/${modelInvocable.length} model-visible, ${analyses.length - modelInvocable.length} manual-only`,
		`Approx. tokens: descriptors ~${tokens.activeDescriptorTokens}; full bodies ~${tokens.allBodyTokens}; native loads ~${tokens.allNativeLoadTokens}`,
		`Session toggles: ${locked ? "locked after first user message" : "available until the first user message"}`,
	];
	if (!readActive) {
		lines.push("Warning: read is inactive, so Pi will not include skill descriptors in the model prompt.");
	}
	if (diagnostics.errors > 0 || diagnostics.warnings > 0) {
		lines.push(
			`Diagnostics: ${diagnostics.errors} error(s), ${diagnostics.warnings} warning(s); select a skill for details.`,
		);
	}
	return lines.join("\n");
}

export async function showSkillsPanel(ctx: ExtensionContext, options: SkillsPanelOptions): Promise<void> {
	await ctx.ui.custom((tui, theme, _keybindings, done) => {
		const items = createSkillSettingsItems(options.analyses, options.enabledNames, options.locked);
		const settingsList = new SettingsList(
			items,
			Math.min(Math.max(items.length, 1), 15),
			getSettingsListTheme(),
			(id, newValue) => options.onToggle(id, newValue === "enabled"),
			() => done(undefined),
			{ enableSearch: true },
		);
		return new SkillsPanel(tui, theme, settingsList, options);
	});
}

export async function showSkillsSelector(ctx: ExtensionContext, options: SkillsPanelOptions): Promise<void> {
	const doneLabel = "Done";
	const labels = options.analyses.map(({ skill }) => skill.name);
	while (true) {
		const choice = await ctx.ui.select(
			formatSkillsSummary(
				options.analyses,
				options.enabledNames,
				options.locked,
				options.readActive,
				options.getTokens(),
			),
			[...labels, doneLabel],
		);
		if (choice === undefined || choice === doneLabel) return;
		const analysis = options.analyses.find(({ skill }) => skill.name === choice);
		if (analysis === undefined || analysis.skill.disableModelInvocation) {
			ctx.ui.notify(`${choice} is manual-only; explicit /skill:${choice} remains available.`, "info");
			continue;
		}
		if (options.locked) {
			ctx.ui.notify("Skill toggles are locked after the first user message.", "warning");
			continue;
		}
		const enabled = !options.enabledNames.has(choice);
		options.onToggle(choice, enabled);
		ctx.ui.notify(`${choice}: ${enabled ? "enabled" : "disabled"}.`, "info");
	}
}

class SkillsPanel implements Component {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly settingsList: SettingsList;
	private readonly options: SkillsPanelOptions;

	constructor(tui: TUI, theme: Theme, settingsList: SettingsList, options: SkillsPanelOptions) {
		this.tui = tui;
		this.theme = theme;
		this.settingsList = settingsList;
		this.options = options;
	}

	render(width: number): string[] {
		const header = formatHeader(this.options, this.theme, width);
		return [...header, "", ...this.settingsList.render(width)];
	}

	handleInput(data: string): void {
		this.settingsList.handleInput(data);
		this.tui.requestRender();
	}

	invalidate(): void {
		this.settingsList.invalidate();
	}
}

function formatHeader(options: SkillsPanelOptions, theme: Theme, width: number): string[] {
	const modelInvocable = options.analyses.filter(({ skill }) => !skill.disableModelInvocation);
	const enabled = modelInvocable.filter(({ skill }) => options.enabledNames.has(skill.name));
	const diagnostics = countDiagnostics(options.analyses);
	const tokens = options.getTokens();
	const state = options.locked ? "locked after first user message" : "toggles open until first user message";
	const lines = [
		theme.fg("accent", theme.bold("Pi skill visibility")),
		theme.fg(
			"muted",
			`Model-visible ${enabled.length}/${modelInvocable.length} · descriptors ~${tokens.activeDescriptorTokens} · native loads ~${tokens.allNativeLoadTokens} tokens`,
		),
		theme.fg("dim", `Session: ${state} · explicit /skill:name remains native`),
	];
	if (!options.readActive) {
		lines.push(theme.fg("warning", "Warning: read is inactive; Pi will omit skill descriptors."));
	}
	if (diagnostics.errors > 0 || diagnostics.warnings > 0) {
		lines.push(theme.fg("warning", `Diagnostics: ${diagnostics.errors} errors · ${diagnostics.warnings} warnings`));
	}
	return lines.map((line) => truncateToWidth(line, width));
}

function formatSkillDescription(analysis: SkillAnalysis): string {
	const { skill, descriptorTokens, bodyTokens, nativeLoadTokens, diagnostics } = analysis;
	const lines = [
		sanitizeTerminalText(skill.description),
		`File: ${sanitizeTerminalText(skill.filePath)}`,
		`Approx. tokens: descriptor ~${descriptorTokens}; full body ~${bodyTokens}; /skill:name load ~${nativeLoadTokens}`,
	];
	for (const diagnostic of diagnostics) {
		lines.push(`${diagnostic.severity}: ${sanitizeTerminalText(diagnostic.message)}`);
	}
	if (skill.disableModelInvocation) {
		lines.push("Manual-only: explicit /skill:name remains available.");
	}
	return lines.join("\n");
}

function getDiagnosticMarker(analysis: SkillAnalysis): string {
	if (analysis.diagnostics.some(({ severity }) => severity === "error")) return " [error]";
	if (analysis.diagnostics.some(({ severity }) => severity === "warning")) return " [warn]";
	return "";
}
