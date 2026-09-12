import assert from "node:assert/strict";
import test from "node:test";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import fc from "fast-check";

import {
	buildStatusbarViewModel,
	calculateTokensPerSecond,
	formatTokenCount,
	renderContextPercentage,
	renderSessionCounts,
	renderTokenMix,
	renderTokensPerSecond,
	renderTotalTokens,
	sessionTotals,
	type SessionTotals,
} from "../statusbar.ts";

const plainTheme = {
	fg: (_color: string, text: string) => text,
	getColorMode: () => "truecolor",
} as Parameters<typeof renderSessionCounts>[1];

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
	assert.equal(renderTokensPerSecond(undefined, plainTheme), "tps:--");
	assert.equal(renderTokensPerSecond(38.4, plainTheme), "tps:38");
	assert.equal(renderTokensPerSecond(123.45, plainTheme), "tps:123");
});

test("supports multiple right-aligned statusbar parts", () => {
	const view = buildStatusbarViewModel({
		width: 40,
		leftParts: ["~/dotfiles", "model"],
		rightParts: ["tps:42.3", "50%"],
	});

	assert.equal(view.right, "tps:42.3  50%");
	assert.equal(view.line, "~/dotfiles · model         tps:42.3  50%");
});

interface UsageParts {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
}

function totals(overrides: Partial<SessionTotals> = {}): SessionTotals {
	return {
		turns: 0,
		compactions: 0,
		totalTokens: 0,
		readTokens: 0,
		writeTokens: 0,
		cachedTokens: 0,
		...overrides,
	};
}

function usageWithTotal(usage: UsageParts): UsageParts & { totalTokens: number } {
	return { ...usage, totalTokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite };
}

function assistantEntry(stopReason: string, usage: UsageParts): SessionEntry {
	return {
		type: "message",
		message: { role: "assistant", stopReason, usage: usageWithTotal(usage) },
	} as unknown as SessionEntry;
}

function usageEntry(type: "compaction" | "branch_summary", usage: UsageParts): SessionEntry {
	return { type, usage: usageWithTotal(usage) } as unknown as SessionEntry;
}

test("counts turns, compactions, and token usage across session entries", () => {
	const entries = [
		assistantEntry("stop", { input: 100, output: 200, cacheRead: 700, cacheWrite: 0 }),
		{ type: "message", message: { role: "user" } } as unknown as SessionEntry,
		assistantEntry("error", { input: 500, output: 500, cacheRead: 0, cacheWrite: 0 }),
		{ type: "model_change" } as unknown as SessionEntry,
		assistantEntry("aborted", { input: 50, output: 50, cacheRead: 150, cacheWrite: 0 }),
		usageEntry("compaction", { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }),
		usageEntry("branch_summary", { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }),
		{ type: "branch_summary", fromId: "x", summary: "s" } as unknown as SessionEntry,
	];

	assert.deepEqual(sessionTotals(entries), {
		turns: 2,
		compactions: 3,
		totalTokens: 1000 + 250 + 15 + 2,
		readTokens: 800 + 200 + 10 + 1,
		writeTokens: 200 + 50 + 5 + 1,
		cachedTokens: 700 + 150,
	});
});

test("formats token totals compactly", () => {
	assert.equal(formatTokenCount(0), "0");
	assert.equal(formatTokenCount(999), "999");
	assert.equal(formatTokenCount(1_234), "1.2K");
	assert.equal(formatTokenCount(12_345), "12K");
	assert.equal(formatTokenCount(123_456), "123K");
	assert.equal(formatTokenCount(999_499), "999K");
	assert.equal(formatTokenCount(999_500), "1M");
	assert.equal(formatTokenCount(1_234_567), "1.2M");
	assert.equal(formatTokenCount(-1), "--");
	assert.equal(formatTokenCount(Number.NaN), "--");
});

test("keeps every token count within the fixed token field", () => {
	fc.assert(
		fc.property(fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }), (tokens) => {
			assert.ok(formatTokenCount(tokens).length <= 4);
		}),
	);
});

test("renders turn and compaction counts", () => {
	assert.deepEqual(renderSessionCounts(totals({ turns: 12, compactions: 3 }), plainTheme), ["turns:12", "comp:3"]);
	assert.deepEqual(renderSessionCounts(totals({ turns: 4 }), plainTheme), ["turns:4", "comp:0"]);
});

test("renders the compact total token count", () => {
	assert.equal(renderTotalTokens(totals({ totalTokens: 1_234_567 }), plainTheme), "tok:1.2M");
	assert.equal(renderTotalTokens(totals({ totalTokens: 950 }), plainTheme), "tok: 950");
});

test("renders the read and cache mix", () => {
	assert.deepEqual(
		renderTokenMix(totals({ readTokens: 45_440_000, writeTokens: 380_000, cachedTokens: 45_160_000 }), plainTheme),
		["read:99%", "cache:99%"],
	);
	assert.deepEqual(renderTokenMix(totals(), plainTheme), ["read:0%", "cache:0%"]);
	// The write share is the deducible remainder (100% - read%).
	assert.deepEqual(renderTokenMix(totals({ readTokens: 985, writeTokens: 15 }), plainTheme), ["read:99%", "cache:0%"]);
});

test("renders the context percentage at its natural width", () => {
	assert.equal(renderContextPercentage({ tokens: null, percent: null }, plainTheme), "--%");
	for (const [percent, width] of [
		[0, 2],
		[7, 2],
		[45, 3],
		[100, 4],
	] as const) {
		assert.equal(visibleWidth(renderContextPercentage({ tokens: 1, percent }, plainTheme)), width);
	}
});

test("keeps the token field a fixed width as values grow", () => {
	const tokenWidths = new Set(
		[0, 950, 12_345, 999_499, 999_500, 1_234_567, 999_999_999_999_999].map((totalTokens) =>
			visibleWidth(renderTotalTokens(totals({ totalTokens }), plainTheme)),
		),
	);
	assert.equal(tokenWidths.size, 1);
});

test("draws metric labels dim and values muted", () => {
	const calls: Array<[string, string]> = [];
	const theme = {
		fg: (color: string, text: string) => {
			calls.push([color, text]);
			return text;
		},
		getColorMode: () => "truecolor",
	} as Parameters<typeof renderSessionCounts>[1];

	assert.equal(
		`${renderTokensPerSecond(38.4, theme)} ${renderSessionCounts(totals({ turns: 12, compactions: 1 }), theme).join(" ")} ${renderTokenMix(totals({ readTokens: 99, writeTokens: 1, cachedTokens: 50 }), theme).join(" ")} ${renderTotalTokens(totals({ totalTokens: 1_234_567 }), theme)}`,
		"tps:38 turns:12 comp:1 read:99% cache:51% tok:1.2M",
	);
	assert.deepEqual(calls, [
		["dim", "tps:"],
		["muted", "38"],
		["dim", "turns:"],
		["muted", "12"],
		["dim", "comp:"],
		["muted", "1"],
		["dim", "read:"],
		["muted", "99%"],
		["dim", "cache:"],
		["muted", "51%"],
		["dim", "tok:"],
		["muted", "1.2M"],
	]);

	calls.length = 0;
	assert.equal(renderTokensPerSecond(undefined, theme), "tps:--");
	assert.deepEqual(calls, [
		["dim", "tps:"],
		["dim", "--"],
	]);
});

test("drops whole right-side metrics before cutting a value", () => {
	const view = buildStatusbarViewModel({
		width: 40,
		leftParts: ["~/dotfiles", "model"],
		rightParts: ["tps:38", "turns:12", "comp:5", "read:99%", "cache:99%", "tok:1.2M", "45%"],
	});

	assert.equal(view.right, "read:99%  cache:99%  tok:1.2M  45%");
	assert.equal(view.left, "model");
	assert.equal(view.line, `model ${view.right}`);
});
