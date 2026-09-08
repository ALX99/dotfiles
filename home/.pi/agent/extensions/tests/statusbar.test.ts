import assert from "node:assert/strict";
import test from "node:test";

import { buildStatusbarViewModel, calculateTokensPerSecond, renderTokensPerSecond } from "../statusbar.ts";

const plainTheme = { fg: (_color: string, text: string) => text } as Parameters<typeof renderTokensPerSecond>[2];

test("calculates output tokens per second from a positive duration", () => {
	assert.equal(calculateTokensPerSecond(120, 4000), 30);
});

test("does not report a rate for missing or invalid measurements", () => {
	for (const [outputTokens, durationMs] of [
		[0, 1000],
		[-1, 1000],
		[10, 0],
		[10, -1],
		[Number.NaN, 1000],
		[10, Number.POSITIVE_INFINITY],
	] as const) {
		assert.equal(calculateTokensPerSecond(outputTokens, durationMs), undefined);
	}
});

test("renders an unavailable and a measured TPS value", () => {
	assert.equal(renderTokensPerSecond(undefined, undefined, plainTheme), "tps:--");
	assert.equal(renderTokensPerSecond(42.345, 38.2, plainTheme), "tps:42.3 avg:38.2");
	assert.equal(renderTokensPerSecond(123.45, undefined, plainTheme), "tps:123");
});

test("supports multiple right-aligned statusbar parts", () => {
	const view = buildStatusbarViewModel({
		width: 40,
		leftParts: ["~/dotfiles", "model"],
		rightParts: ["tps:42.3", "50%"],
	});

	assert.equal(view.right, "tps:42.3 · 50%");
	assert.equal(view.line, "~/dotfiles · model        tps:42.3 · 50%");
});
