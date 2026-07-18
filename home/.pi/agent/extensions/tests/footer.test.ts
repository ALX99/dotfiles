import * as assert from "node:assert/strict";
import { test } from "node:test";

import { branchRevision, buildFooterViewModel, renderContextBar, shortenCwd, THINKING_COLOR } from "../footer.ts";

const theme = {
	fg(_color: string, text: string): string {
		return text;
	},
};
// renderContextBar uses only fg(); the focused fixture omits unrelated Theme methods.
const renderTheme = theme as never;

test("renderContextBar clamps percentages above 100 to the bar width", () => {
	assert.doesNotThrow(() => {
		renderContextBar({ tokens: 210, contextWindow: 100, percent: 210 }, renderTheme);
	});

	assert.equal(renderContextBar({ tokens: 210, contextWindow: 100, percent: 210 }, renderTheme), "[██████████]210%");
});

test("renderContextBar clamps negative percentages to the empty bar", () => {
	assert.equal(renderContextBar({ tokens: 0, contextWindow: 100, percent: -5 }, renderTheme), "[░░░░░░░░░░]-5%");
});

test("shortenCwd only substitutes an actual home-directory boundary", () => {
	assert.equal(shortenCwd("/Users/alex/project", "/Users/alex"), "~/project");
	assert.equal(shortenCwd("/Users/alex", "/Users/alex"), "~");
	assert.equal(shortenCwd("/Users/alexander/project", "/Users/alex"), "/Users/alexander/project");
});

test("thinking colors cover every supported level, including off and max", () => {
	assert.deepEqual(THINKING_COLOR, {
		off: "muted",
		minimal: "thinkingMinimal",
		low: "thinkingLow",
		medium: "thinkingMedium",
		high: "thinkingHigh",
		xhigh: "thinkingXhigh",
		max: "thinkingXhigh",
	});
});

test("branch revision changes when switching to a same-length branch", () => {
	assert.notEqual(branchRevision([{ id: "root" }, { id: "left" }]), branchRevision([{ id: "root" }, { id: "right" }]));
});

test("narrow footer keeps context pressure before token, age, and extension status", () => {
	const view = buildFooterViewModel({
		width: 18,
		leftParts: ["~/project", "(main)", "model"],
		contextBar: "[██████████]99%",
		tokens: "↑12k/↓3k/CH80%",
		sessionLength: "2h",
		statuses: ["extension warning"],
	});

	assert.equal(view.left, "");
	assert.equal(view.right, "[██████████]99%");
	assert.equal(view.line, "[██████████]99%");
});

test("wide footer retains token and secondary right-side information", () => {
	const view = buildFooterViewModel({
		width: 100,
		leftParts: ["~/project", "(main)"],
		contextBar: "[██████████]55%",
		tokens: "↑12k/↓3k/CH80%",
		sessionLength: "2h",
		statuses: ["extension ready"],
	});

	assert.match(view.right, /↑12k/);
	assert.match(view.right, /55%/);
	assert.match(view.right, /2h/);
	assert.match(view.right, /extension ready/);
});
