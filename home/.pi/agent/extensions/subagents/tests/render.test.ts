import * as assert from "node:assert/strict";
import { test } from "node:test";

import { renderResultBlock } from "../render.ts";
import type { RunDetails } from "../process.ts";

const theme = {
	fg(_color: string, text: string): string {
		return text;
	},
	bold(text: string): string {
		return text;
	},
};

function details(): RunDetails {
	return {
		agent: "worker",
		taskName: "implement parser fix",
		depth: 1,
		exitCode: 0,
		finalText: "",
		stderr: "",
		aborted: false,
		startTime: 0,
		toolCount: 1,
		recentTools: [],
		lastMessage: "",
		nestedRuns: [
			{
				toolCallId: "child-a",
				agent: "scout",
				taskName: "locate parser",
				depth: 2,
				status: "running",
				toolCount: 1,
				recentTools: [{ name: "read", argsPreview: "src/parser.ts" }],
				lastMessage: "",
				nestedRuns: [],
			},
			{
				toolCallId: "child-b",
				agent: "scout",
				taskName: "locate tests",
				depth: 2,
				status: "running",
				toolCount: 1,
				recentTools: [{ name: "grep", argsPreview: "parser" }],
				lastMessage: "",
				nestedRuns: [{
					toolCallId: "grandchild",
					agent: "scout",
					taskName: "find fixture",
					depth: 3,
					status: "completed",
					toolCount: 1,
					recentTools: [{ name: "read", argsPreview: "testdata/fixture.json" }],
					lastMessage: "",
					nestedRuns: [],
				}],
			},
		],
		tokens: 0,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
	};
}

test("renderResultBlock shows concurrent nested subagents and their child", () => {
	const rendered = renderResultBlock(details(), { expanded: true, isPartial: true }, theme as never).render(120).join("\n");

	assert.match(rendered, /locate parser/);
	assert.match(rendered, /locate tests/);
	assert.match(rendered, /find fixture/);
	assert.match(rendered, /testdata\/fixture\.json/);
});
