import assert from "node:assert/strict";
import test from "node:test";

import { createSyntheticSourceInfo, type Skill } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

import type { SkillAnalysis, SkillDiagnostic } from "../analysis.ts";
import { createSkillDisplayItems, createSkillSettingsItems, fitSkillDescription } from "../ui.ts";

function makeSkill(name: string, disableModelInvocation = false): Skill {
	return {
		name,
		description: `${name} description`,
		filePath: `/tmp/${name}/SKILL.md`,
		baseDir: `/tmp/${name}`,
		sourceInfo: createSyntheticSourceInfo(`/tmp/${name}/SKILL.md`, { source: "test" }),
		disableModelInvocation,
	};
}

function makeAnalysis(
	name: string,
	descriptorTokens: number,
	disableModelInvocation = false,
	diagnostics: SkillDiagnostic[] = [],
): SkillAnalysis {
	return {
		skill: makeSkill(name, disableModelInvocation),
		body: `${name} body`,
		descriptorTokens,
		bodyTokens: descriptorTokens + 1,
		nativeLoadTokens: descriptorTokens + 2,
		diagnostics,
	};
}

test("skill rows show descriptor token cost and sort by visibility status", () => {
	const analyses = [
		makeAnalysis("manual", 12, true),
		makeAnalysis("beta", 7),
		makeAnalysis("alpha", 5, false, [{ severity: "error", message: "broken", path: "/tmp/alpha/SKILL.md" }]),
		makeAnalysis("warn", 8, false, [{ severity: "warning", message: "review", path: "/tmp/warn/SKILL.md" }]),
	];
	const enabledNames = new Set(["beta", "alpha"]);

	const items = createSkillSettingsItems(analyses, enabledNames, false);

	assert.deepEqual(
		items.map(({ id, label, currentValue }) => ({ id, label, currentValue })),
		[
			{ id: "alpha", label: "alpha (~5 tokens) [error]", currentValue: "enabled" },
			{ id: "beta", label: "beta (~7 tokens)", currentValue: "enabled" },
			{ id: "warn", label: "warn (~8 tokens) [warn]", currentValue: "disabled" },
			{ id: "manual", label: "manual (~12 tokens)", currentValue: "manual" },
		],
	);
	assert.deepEqual(
		items.filter(({ values }) => values !== undefined).map(({ id }) => id),
		["alpha", "beta", "warn"],
	);
	assert.deepEqual(
		analyses.map(({ skill }) => skill.name),
		["manual", "beta", "alpha", "warn"],
	);
});

test("TUI rows and selector choices share display labels and ordering", () => {
	const analyses = [makeAnalysis("manual", 4, true), makeAnalysis("disabled", 3), makeAnalysis("enabled", 2)];
	const enabledNames = new Set(["enabled"]);

	const displayItems = createSkillDisplayItems(analyses, enabledNames);
	const settingsItems = createSkillSettingsItems(analyses, enabledNames, true);

	assert.deepEqual(
		settingsItems.map(({ id, label, currentValue }) => ({ id, label, status: currentValue })),
		displayItems.map(({ analysis, label, status }) => ({ id: analysis.skill.name, label, status })),
	);
	assert.ok(settingsItems.every(({ values }) => values === undefined));
});

test("skill descriptions stay at a stable visual height when they wrap", () => {
	const width = 24;
	const maxLines = 3;
	const longDescription = "A skill description that wraps across several visual lines.\nFile: /tmp/skill/SKILL.md";
	const fitted = fitSkillDescription(longDescription, width, maxLines);

	assert.deepEqual(fitted.split("\n"), ["A skill description", "that wraps across", "several visual…"]);
	assert.ok(fitted.split("\n").every((line) => visibleWidth(line) <= width - 4));
	assert.deepEqual(fitSkillDescription("short", width, maxLines).split("\n"), ["short", "", ""]);
});
