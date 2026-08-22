import * as assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { ReadonlyRunDetails } from "../run-state.ts";
import { agentSummaryDetails, textResult, waitDetails } from "../tool-results.ts";
import { renderRunToolResult, renderSummaryToolResult, renderWaitToolResult } from "../ui/result-renderers.ts";

const summary = {
	agent_id: "agent-12345678",
	agent: "scout",
	task_name: "inspect parser",
	profile: "fast",
	model: "provider/model",
	effective_thinking: "low",
	generation: 1,
	retained: false,
	status: "idle" as const,
	started_at: 0,
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
};
const minimalTheme = {
	fg(_color: string, text: string): string {
		return text;
	},
	bold(text: string): string {
		return text;
	},
};
// The focused renderer fixture implements every Theme method these renderers call.
const theme = minimalTheme as Theme;
const options = { expanded: false, isPartial: false };

test("run-result ticks stay scoped to their streaming tool row", () => {
	const details = {
		agent: "scout",
		taskName: "inspect parser",
		profile: "fast",
		model: "provider/model",
		effectiveThinking: "low",
		finalText: "",
		startTime: 0,
		toolCount: 0,
		recentTools: [],
		lastMessage: "",
		lastActivityTime: 0,
		contextUsage: { tokens: null, contextWindow: 10_000, percent: null },
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
		resultId: "a".repeat(64),
		aborted: false,
	} satisfies ReadonlyRunDetails;
	const ticks = new Map<string, NodeJS.Timeout>();

	renderRunToolResult(textResult("", details), { ...options, isPartial: true }, theme, ticks, "run-1", () => {});
	assert.equal(ticks.has("run-1"), true);
	renderRunToolResult(textResult("", details), options, theme, ticks, "run-1", () => {});
	assert.equal(ticks.has("run-1"), false);
});

test("typed summary details flow from result constructors into renderers without adapters", () => {
	const result = textResult("raw fallback", agentSummaryDetails([summary]));
	const rendered = renderSummaryToolResult("list_agents", result, options, theme).render(120).join("\n");

	assert.match(rendered, /list_agents · 1 agent/);
	assert.match(rendered, /inspect parser/);
	assert.doesNotMatch(rendered, /raw fallback/);
});

test("typed wait details preserve timing and summary rendering", () => {
	const details = waitDetails([summary], 2_500);
	const result = textResult("raw fallback", details);
	const rendered = renderWaitToolResult(result, options, theme).render(120).join("\n");

	assert.match(rendered, /1\/1 settled · 2\.5s/);
	assert.match(rendered, /inspect parser/);
});

test("every fallback result renderer sanitizes terminal-control poison", () => {
	const poison = "\u001b]0;owned\u0007visible\u001b[31m red\u001b[0m\rnext\u2028last\u0000";
	const result = { content: [{ type: "text" as const, text: poison }] };
	const rendered = [
		renderRunToolResult(result, options, theme, new Map(), "run", () => {}),
		renderSummaryToolResult("list_agents", result, options, theme),
		renderWaitToolResult(result, options, theme),
	].map((component) => component.render(120).join("\n"));

	for (const output of rendered) {
		for (const control of ["\u001b", "\u0007", "\u0000", "\r", "\u2028"]) {
			assert.equal(output.includes(control), false);
		}
		assert.doesNotMatch(output, /owned/);
		assert.match(output, /visible red/);
		assert.match(
			output
				.split("\n")
				.map((line) => line.trimEnd())
				.join("\n"),
			/next\nlast/,
		);
	}
});
