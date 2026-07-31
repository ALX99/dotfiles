import * as assert from "node:assert/strict";
import { test } from "node:test";

import {
	buildFooterViewModel,
	contextGradientColor,
	renderContextBar,
	renderContextBorder,
	shortenCwd,
} from "../footer.ts";

const theme = {
	fg(_color: string, text: string): string {
		return text;
	},
	getColorMode(): "truecolor" {
		return "truecolor";
	},
};
// renderContextBar uses only fg(); the focused fixture omits unrelated Theme methods.
const renderTheme = theme as never;

const ansiEscapeSequence = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g");

function stripAnsi(text: string): string {
	return text.replace(ansiEscapeSequence, "");
}

test("renderContextBar renders only the percentage above the context window", () => {
	assert.doesNotThrow(() => {
		renderContextBar({ tokens: 210, contextWindow: 100, percent: 210 }, renderTheme);
	});

	assert.equal(stripAnsi(renderContextBar({ tokens: 210, contextWindow: 100, percent: 210 }, renderTheme)), "210%");
});

test("renderContextBar renders negative percentages", () => {
	assert.equal(stripAnsi(renderContextBar({ tokens: 0, contextWindow: 100, percent: -5 }, renderTheme)), "-5%");
});

test("contextGradientColor interpolates through green, yellow, orange, and red", () => {
	assert.deepEqual(contextGradientColor(0), [86, 211, 100]);
	assert.deepEqual(contextGradientColor(55), [227, 179, 65]);
	assert.deepEqual(contextGradientColor(78), [240, 136, 62]);
	assert.deepEqual(contextGradientColor(100), [248, 81, 73]);
	assert.notDeepEqual(contextGradientColor(60), contextGradientColor(70));
});

test("renderContextBorder fills smoothly across the available width", () => {
	assert.equal(stripAnsi(renderContextBorder(90, 10, renderTheme)), "━━━━━━━━━─");
});

test("renderContextBorder stays muted until context usage is available", () => {
	assert.equal(stripAnsi(renderContextBorder(null, 10, renderTheme)), "──────────");
});

test("shortenCwd only substitutes an actual home-directory boundary", () => {
	assert.equal(shortenCwd("/Users/alex/project", "/Users/alex"), "~/project");
	assert.equal(shortenCwd("/Users/alex", "/Users/alex"), "~");
	assert.equal(shortenCwd("/Users/alexander/project", "/Users/alex"), "/Users/alexander/project");
});

test("narrow footer keeps the context percentage and active model", () => {
	const view = buildFooterViewModel({
		width: 18,
		leftParts: ["~/project", "git:main", "model"],
		contextBar: "99%",
	});

	assert.equal(view.left, "model");
	assert.equal(view.right, "99%");
	assert.equal(view.line, "model          99%");
});

test("wide footer shows only the context percentage on the right", () => {
	const view = buildFooterViewModel({
		width: 100,
		leftParts: ["~/project", "git:main", "model/max"],
		contextBar: "55%",
	});

	assert.equal(view.left, "~/project · git:main · model/max");
	assert.equal(view.right, "55%");
});

test("narrow footers prioritize the active model over location details", () => {
	const view = buildFooterViewModel({
		width: 25,
		leftParts: ["~/very/long/project", "git:feature", "model/max"],
		contextBar: "55%",
	});

	assert.equal(view.left, "model/max");
});
