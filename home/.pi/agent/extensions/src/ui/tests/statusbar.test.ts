import assert from "node:assert/strict";
import test from "node:test";

import { visibleWidth } from "@earendil-works/pi-tui";
import fc from "fast-check";

import { createActiveProfileState } from "../../agents/active-profile.ts";
import type { AgentFooterRow } from "../../agents/inspection.ts";
import type { ProfileSnapshot } from "../../agents/profile.ts";
import type { SessionTotals } from "../../support/session-totals.ts";
import {
	buildStatusbarViewModel,
	calculateTokensPerSecond,
	formatTokenCount,
	renderContextPercentage,
	renderReadPercentage,
	renderSessionCounts,
	renderTokenMix,
	renderTokensPerSecond,
	renderTotalTokens,
	renderAgentFooterRow,
} from "../statusbar.ts";
import statusbar from "../statusbar.ts";

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
	assert.equal(renderReadPercentage(totals({ readTokens: 99, writeTokens: 1 }), plainTheme), "read:99%");
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

test("reserves the active root profile before optional footer metrics", () => {
	const profile = "profile:worker";
	const narrow = buildStatusbarViewModel({
		width: 14,
		leftParts: ["~/repo", "model", profile],
		priorityLeftPart: profile,
		rightParts: ["tps:42", "tok:1.2M", "45%"],
	});
	assert.equal(narrow.line, profile);

	const medium = buildStatusbarViewModel({
		width: 25,
		leftParts: ["~/repo", "model", profile],
		priorityLeftPart: profile,
		rightParts: ["tps:42", "tok:1.2M", "45%"],
	});
	assert.ok(medium.line.includes(profile));
	assert.ok(visibleWidth(medium.line) <= 25);
});

test("child rows sanitize dynamic text and retain identity and state before optional metrics", () => {
	const row: AgentFooterRow = {
		id: "worker-🔬\nagent",
		profile: "review\u001b[31m",
		status: "waiting_parent",
		model: "test/model\u001b[2J",
		totalTokens: 1_250,
		lastActivityAt: null,
		contextTokens: null,
		contextWindow: 128_000,
		contextPercent: null,
	};

	const wide = renderAgentFooterRow(row, 120, plainTheme);
	assert.match(wide, /worker-🔬 agent state:waiting_parent profile:review/u);
	assert.match(wide, /test\/model tok:/u);
	assert.match(wide, /ctx:--\/128K --%/u);
	assert.equal(wide.includes("\u001b"), false);
	assert.doesNotMatch(wide, /[\r\n]/u);
	assert.ok(visibleWidth(wide) <= 120);

	const narrow = renderAgentFooterRow(row, 40, plainTheme);
	assert.match(narrow, /worker-🔬 agent/u);
	assert.match(narrow, /state:waiting_parent/u);
	assert.ok(visibleWidth(narrow) <= 40);

	const contextFirst = renderAgentFooterRow(
		{
			id: "worker-agent-1",
			profile: "worker",
			status: "running",
			model: "provider/a-very-long-model-name",
			totalTokens: 1_250,
			lastActivityAt: null,
			contextTokens: null,
			contextWindow: 128_000,
			contextPercent: null,
		},
		61,
		plainTheme,
	);
	assert.match(contextFirst, /ctx:--\/128K --%/u);
	assert.doesNotMatch(contextFirst, /provider\/|tok:/u, "model and cumulative token fields drop before context");
	assert.ok(visibleWidth(contextFirst) <= 61);
});

test("child lifecycle states use distinct theme colors and activity ages stay concise", () => {
	const row: AgentFooterRow = {
		id: "worker-agent-1",
		profile: "worker",
		status: "running",
		model: "test/model",
		totalTokens: null,
		lastActivityAt: null,
		contextTokens: null,
		contextWindow: null,
		contextPercent: null,
	};
	const statusColors = new Map<string, string>();
	const theme = {
		fg(color: string, text: string) {
			if (text.startsWith("state:")) statusColors.set(text, color);
			return text;
		},
		getColorMode: () => "truecolor",
	} as typeof plainTheme;
	const now = Date.UTC(2026, 9, 6, 12, 0, 0);
	const statuses: readonly AgentFooterRow["status"][] = [
		"running",
		"waiting_parent",
		"settled",
		"interrupted",
		"cancelled",
		"error",
	];
	for (const status of statuses) {
		renderAgentFooterRow({ ...row, status }, 120, theme, now);
	}
	assert.deepEqual(
		statuses.map((status) => statusColors.get(`state:${status}`)),
		["accent", "warning", "success", "thinkingXhigh", "muted", "error"],
	);
	assert.equal(new Set(statusColors.values()).size, statuses.length);

	const activeRow = { ...row, lastActivityAt: now - 1_000 };
	assert.match(renderAgentFooterRow(activeRow, 120, plainTheme, now), /last:1s/u);
	assert.match(renderAgentFooterRow(activeRow, 120, plainTheme, now + 9_000), /last:10s/u);
	assert.match(renderAgentFooterRow(activeRow, 120, plainTheme, now + 59_000), /last:1m/u);
});

test("long child IDs retain lifecycle state and distinguishing suffixes at narrow widths", () => {
	const idPrefix = "long-running-specialist-research-worker-agent-";
	for (const status of ["running", "settled", "waiting_parent"] as const) {
		const first = renderAgentFooterRow(
			{
				id: `${idPrefix}1`,
				profile: "long-running-specialist-research-worker",
				status,
				model: "test/model",
				totalTokens: null,
				lastActivityAt: null,
				contextTokens: null,
				contextWindow: null,
				contextPercent: null,
			},
			48,
			plainTheme,
		);
		const second = renderAgentFooterRow(
			{
				id: `${idPrefix}2`,
				profile: "long-running-specialist-research-worker",
				status,
				model: "test/model",
				totalTokens: null,
				lastActivityAt: null,
				contextTokens: null,
				contextWindow: null,
				contextPercent: null,
			},
			48,
			plainTheme,
		);

		assert.match(first, new RegExp(`agent-1 state:${status}`, "u"));
		assert.match(second, new RegExp(`agent-2 state:${status}`, "u"));
		assert.notEqual(first, second, "same-profile sibling IDs remain distinguishable");
		assert.ok(first.startsWith("long-running"), "the ID retains a readable prefix");
		assert.ok(visibleWidth(first) <= 48);
		assert.ok(visibleWidth(second) <= 48);
	}

	const ansiTheme = {
		fg: (_color: string, text: string) => `\u001b[31m${text}\u001b[0m`,
		getColorMode: () => "truecolor",
	} as typeof plainTheme;
	const unicodeAndAnsi = renderAgentFooterRow(
		{
			id: "long-running-🔬-specialist-research-worker-agent-1",
			profile: "worker",
			status: "waiting_parent",
			model: "test/model",
			totalTokens: null,
			lastActivityAt: null,
			contextTokens: null,
			contextWindow: null,
			contextPercent: null,
		},
		48,
		ansiTheme,
	);
	assert.match(unicodeAndAnsi, /agent-1/u);
	assert.match(unicodeAndAnsi, /state:waiting_parent/u);
	assert.ok(visibleWidth(unicodeAndAnsi) <= 48);

	for (const width of [0, 1, 4]) {
		const tiny = renderAgentFooterRow(
			{
				id: `${idPrefix}1`,
				profile: "worker",
				status: "waiting_parent",
				model: "test/model",
				totalTokens: null,
				lastActivityAt: null,
				contextTokens: null,
				contextWindow: null,
				contextPercent: null,
			},
			width,
			plainTheme,
		);
		assert.ok(visibleWidth(tiny) <= width);
	}
});

test("a same-model profile change requests a footer render and updates the bound profile", () => {
	const activeProfile = createActiveProfileState({ setCapabilityPolicy: () => {} } as Parameters<
		typeof createActiveProfileState
	>[0]);
	const profile: ProfileSnapshot = {
		name: "worker",
		model: { provider: "test", id: "same-model" },
		prompt: "Work carefully.",
		sourcePath: "/profiles/worker.md",
	};

	let footer: { readonly render: (width: number) => string[] } | undefined;
	let renderRequests = 0;
	const ctx = {
		cwd: "/repo",
		model: { id: "same-model" },
		mode: "print",
		getContextUsage: () => undefined,
		sessionManager: { getEntries: () => [] },
		ui: {
			setFooter(factory: (tui: unknown, theme: typeof plainTheme) => typeof footer) {
				footer = factory({ requestRender: () => (renderRequests += 1) }, plainTheme);
			},
			setWorkingVisible: () => {},
		},
	} as unknown as Parameters<ReturnType<typeof statusbar>["events"]["sessionStart"]>[1];
	const pi = { getThinkingLevel: () => undefined } as unknown as Parameters<typeof statusbar>[0];
	const activity = statusbar(pi, {} as Parameters<typeof statusbar>[1], activeProfile);
	activity.events.sessionStart({} as Parameters<typeof activity.events.sessionStart>[0], ctx);

	assert.doesNotMatch(footer?.render(80).join("\n") ?? "", /profile:worker/u);
	const requestsBeforeSwitch = renderRequests;
	activeProfile.setProfile(profile);
	assert.ok(
		renderRequests > requestsBeforeSwitch,
		"setProfile notifies the statusbar even without a model_select event",
	);
	assert.match(footer?.render(80).join("\n") ?? "", /profile:worker/u);

	activeProfile.setProfile({ ...profile, name: "reviewer" });
	assert.match(footer?.render(80).join("\n") ?? "", /profile:reviewer/u);

	activity.setAgentRows([
		{
			id: "worker-agent-1",
			profile: "worker",
			status: "running",
			model: "test/model",
			totalTokens: 20,
			lastActivityAt: null,
			contextTokens: 10,
			contextWindow: 100,
			contextPercent: 10,
		},
		{
			id: "reviewer-agent-1",
			profile: "reviewer",
			status: "waiting_parent",
			model: "test/model",
			totalTokens: 30,
			lastActivityAt: null,
			contextTokens: null,
			contextWindow: 100,
			contextPercent: null,
		},
	]);
	const lines = footer?.render(80) ?? [];
	assert.equal(lines.length, 3, "the root row is followed by exactly one row per direct child");
	assert.ok(lines[1]?.includes("worker-agent-1"));
	assert.ok(lines[2]?.includes("reviewer-agent-1"));
	assert.ok(lines.every((line) => !line.includes("\n") && visibleWidth(line) <= 80));
});

test("visible child rows request one shared age refresh and stop it when rows disappear", (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	let footer: { readonly render: (width: number) => string[] } | undefined;
	let renderRequests = 0;
	const ctx = {
		cwd: "/repo",
		model: { id: "test-model" },
		mode: "tui",
		getContextUsage: () => undefined,
		sessionManager: { getEntries: () => [] },
		ui: {
			setFooter(factory: (tui: unknown, theme: typeof plainTheme) => typeof footer) {
				footer = factory({ requestRender: () => (renderRequests += 1) }, plainTheme);
			},
			setWorkingVisible: () => {},
		},
	} as unknown as Parameters<ReturnType<typeof statusbar>["events"]["sessionStart"]>[1];
	const pi = { getThinkingLevel: () => undefined } as unknown as Parameters<typeof statusbar>[0];
	const editor = { install: () => {} } as unknown as Parameters<typeof statusbar>[1];
	const activity = statusbar(pi, editor);
	activity.events.sessionStart({} as Parameters<typeof activity.events.sessionStart>[0], ctx);

	const beforeRows = renderRequests;
	t.mock.timers.tick(1_000);
	assert.equal(renderRequests, beforeRows, "the empty footer does not start a refresh timer");

	const row: AgentFooterRow = {
		id: "worker-agent-1",
		profile: "worker",
		status: "running",
		model: "test/model",
		totalTokens: null,
		lastActivityAt: Date.now(),
		contextTokens: null,
		contextWindow: null,
		contextPercent: null,
	};
	activity.setAgentRows([row, { ...row, id: "reviewer-agent-1" }]);
	const beforeTick = renderRequests;
	t.mock.timers.tick(1_000);
	assert.equal(renderRequests, beforeTick + 1);
	activity.setAgentRows([]);
	const afterRowsDisappear = renderRequests;
	t.mock.timers.tick(2_000);
	assert.equal(renderRequests, afterRowsDisappear, "the shared timer stops when no child rows remain");
	activity.events.sessionShutdown({} as Parameters<typeof activity.events.sessionShutdown>[0], ctx);
});
