import { getSettingsListTheme, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import {
	SettingsList,
	truncateToWidth,
	type Component,
	type SettingItem,
	type TUI,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

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

type SkillDisplayStatus = "enabled" | "disabled" | "manual";

const MAX_SKILL_DESCRIPTION_LINES = 6;

export interface SkillDisplayItem {
	analysis: SkillAnalysis;
	label: string;
	status: SkillDisplayStatus;
}

export function createSkillDisplayItems(
	analyses: readonly SkillAnalysis[],
	enabledNames: ReadonlySet<string>,
): SkillDisplayItem[] {
	return analyses
		.toSorted((left, right) => compareSkillDisplayOrder(left, right, enabledNames))
		.map((analysis) => ({
			analysis,
			label: formatSkillLabel(analysis),
			status: getSkillDisplayStatus(analysis, enabledNames),
		}));
}

export function createSkillSettingsItems(
	analyses: readonly SkillAnalysis[],
	enabledNames: ReadonlySet<string>,
	locked: boolean,
): SettingItem[] {
	return createSkillDisplayItems(analyses, enabledNames).map(({ analysis, label, status }) => {
		const { skill } = analysis;
		const item: SettingItem = {
			id: skill.name,
			label,
			description: formatSkillDescription(analysis),
			currentValue: status,
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
		return new SkillsPanel(tui, theme, settingsList, items, options);
	});
}

export async function showSkillsSelector(ctx: ExtensionContext, options: SkillsPanelOptions): Promise<void> {
	const doneLabel = "Done";
	while (true) {
		const items = createSkillDisplayItems(options.analyses, options.enabledNames);
		const choice = await ctx.ui.select(
			formatSkillsSummary(
				options.analyses,
				options.enabledNames,
				options.locked,
				options.readActive,
				options.getTokens(),
			),
			[...items.map(({ label }) => label), doneLabel],
		);
		if (choice === undefined || choice === doneLabel) return;
		const item = items.find(({ label }) => label === choice);
		if (item === undefined) return;
		const { skill } = item.analysis;
		if (skill.disableModelInvocation) {
			ctx.ui.notify(`${skill.name} is manual-only; explicit /skill:${skill.name} remains available.`, "info");
			continue;
		}
		if (options.locked) {
			ctx.ui.notify("Skill toggles are locked after the first user message.", "warning");
			continue;
		}
		const enabled = !options.enabledNames.has(skill.name);
		options.onToggle(skill.name, enabled);
		ctx.ui.notify(`${skill.name}: ${enabled ? "enabled" : "disabled"}.`, "info");
	}
}

class SkillsPanel implements Component {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly settingsList: SettingsList;
	private readonly items: SettingItem[];
	private readonly descriptions: ReadonlyMap<string, string | undefined>;
	private readonly options: SkillsPanelOptions;

	constructor(tui: TUI, theme: Theme, settingsList: SettingsList, items: SettingItem[], options: SkillsPanelOptions) {
		this.tui = tui;
		this.theme = theme;
		this.settingsList = settingsList;
		this.items = items;
		this.descriptions = new Map(items.map(({ id, description }) => [id, description]));
		this.options = options;
	}

	render(width: number): string[] {
		const header = formatHeader(this.options, this.theme, width);
		stabilizeSkillDescriptions(
			this.items,
			this.descriptions,
			width,
			getSkillDescriptionLineLimit(this.tui.terminal.rows, header.length, this.items.length),
		);
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

export function fitSkillDescription(description: string, width: number, maxLines: number): string {
	const contentWidth = Math.max(1, width - 4);
	const lineLimit = Math.max(1, Math.floor(maxLines));
	const wrapped = wrapTextWithAnsi(description, contentWidth);
	const lines = wrapped.slice(0, lineLimit);
	if (wrapped.length > lineLimit) {
		const lastLine = lines[lineLimit - 1] ?? "";
		lines[lineLimit - 1] = `${truncateToWidth(lastLine, Math.max(0, contentWidth - 1), "")}…`;
	}
	while (lines.length < lineLimit) lines.push("");
	return lines.join("\n");
}

function formatSkillLabel(analysis: SkillAnalysis): string {
	const diagnosticMarker = getDiagnosticMarker(analysis);
	return `${sanitizeTerminalText(analysis.skill.name)} (~${analysis.descriptorTokens} tokens)${diagnosticMarker}`;
}

function getSkillDisplayStatus(analysis: SkillAnalysis, enabledNames: ReadonlySet<string>): SkillDisplayStatus {
	if (analysis.skill.disableModelInvocation) return "manual";
	return enabledNames.has(analysis.skill.name) ? "enabled" : "disabled";
}

function compareSkillDisplayOrder(
	left: SkillAnalysis,
	right: SkillAnalysis,
	enabledNames: ReadonlySet<string>,
): number {
	const statusOrder = {
		enabled: 0,
		disabled: 1,
		manual: 2,
	} as const;
	const statusDifference =
		statusOrder[getSkillDisplayStatus(left, enabledNames)] - statusOrder[getSkillDisplayStatus(right, enabledNames)];
	if (statusDifference !== 0) return statusDifference;
	if (left.skill.name < right.skill.name) return -1;
	if (left.skill.name > right.skill.name) return 1;
	return 0;
}

function getDiagnosticMarker(analysis: SkillAnalysis): string {
	if (analysis.diagnostics.some(({ severity }) => severity === "error")) return " [error]";
	if (analysis.diagnostics.some(({ severity }) => severity === "warning")) return " [warn]";
	return "";
}

function stabilizeSkillDescriptions(
	items: SettingItem[],
	descriptions: ReadonlyMap<string, string | undefined>,
	width: number,
	maxLines: number,
): void {
	for (const item of items) {
		const description = descriptions.get(item.id);
		if (description !== undefined) item.description = fitSkillDescription(description, width, maxLines);
	}
}

function getSkillDescriptionLineLimit(terminalRows: number, headerLines: number, itemCount: number): number {
	const visibleRows = Math.min(Math.max(itemCount, 1), 15);
	const scrollIndicator = itemCount > visibleRows ? 1 : 0;
	const settingsListFixedLines = 1 + 1 + visibleRows + scrollIndicator + 1 + 1 + 1;
	const availableLines = terminalRows - headerLines - 1 - settingsListFixedLines - 2;
	return Math.max(1, Math.min(MAX_SKILL_DESCRIPTION_LINES, availableLines));
}
