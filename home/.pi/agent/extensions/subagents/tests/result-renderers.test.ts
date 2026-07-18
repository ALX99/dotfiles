import * as assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { agentSummaryDetails, textResult, waitDetails } from "../tool-results.ts";
import { renderRunToolResult, renderSummaryToolResult, renderWaitToolResult } from "../ui/result-renderers.ts";

const summary = {
	agent_id: "agent-12345678",
	agent: "scout",
	task_name: "inspect parser",
	profile: "fast",
	model: "provider/model",
	effective_thinking: "low",
	depth: 1,
	generation: 1,
	status: "idle" as const,
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

test("typed summary details flow from result constructors into renderers without adapters", () => {
	const result = textResult("raw fallback", agentSummaryDetails([summary]));
	const rendered = renderSummaryToolResult("list_agents", result, options, theme).render(120).join("\n");

	assert.match(rendered, /list_agents · 1 agent/);
	assert.match(rendered, /inspect parser/);
	assert.doesNotMatch(rendered, /raw fallback/);
});

test("typed wait details preserve timing and summary rendering", () => {
	const details = waitDetails([summary], 2_500, 10_000);
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
