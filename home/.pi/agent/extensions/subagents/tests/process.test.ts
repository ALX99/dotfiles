import { test } from "node:test";
import * as assert from "node:assert/strict";
import type { Message } from "@earendil-works/pi-ai";
import { argsPreview, buildPiArgs, buildTaskPrompt, getFinalText, ingestLine, resolveEffectiveModel, type RunDetails } from "../process.ts";

function fresh(): RunDetails {
	return {
		agent: "test",
		taskName: "test",
		depth: 1,
		exitCode: 0,
		messages: [],
		stderr: "",
		aborted: false,
		startTime: 0,
		toolCount: 0,
		recentTools: [],
		lastMessage: "",
		nestedRuns: [],
		tokens: 0,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
	};
}

function msgEnd(message: unknown): string {
	return JSON.stringify({ type: "message_end", message });
}

const assistantWithUsage = (content: unknown, usage?: unknown): unknown => ({
	role: "assistant",
	content,
	...(usage ? { usage } : {}),
});

const msgs = (xs: unknown[]): Message[] => xs as unknown as Message[];

test("getFinalText returns empty for no assistant messages", () => {
	assert.equal(getFinalText([]), "");
	assert.equal(getFinalText(msgs([{ role: "user", content: [{ type: "text", text: "hi" }] }])), "");
});

test("getFinalText returns last assistant text block, trimming whitespace", () => {
	assert.equal(
		getFinalText(msgs([
			{ role: "assistant", content: [{ type: "text", text: "  first  " }] },
			{ role: "toolResult", content: [{ type: "text", text: "output" }] },
			{ role: "assistant", content: [{ type: "text", text: "  final answer  " }] },
		])),
		"final answer",
	);
});

test("getFinalText returns the last text part within the final assistant message", () => {
	assert.equal(
		getFinalText(msgs([
			{
				role: "assistant",
				content: [
					{ type: "text", text: "draft answer" },
					{ type: "toolCall", name: "read", arguments: { path: "README.md" } },
					{ type: "text", text: "  final answer after tool  " },
				],
			},
		])),
		"final answer after tool",
	);
});

test("getFinalText skips empty text parts", () => {
	assert.equal(
		getFinalText(msgs([{ role: "assistant", content: [{ type: "text", text: "   " }, { type: "text", text: "real" }] }])),
		"real",
	);
});

test("ingestLine ignores non-JSON and unrelated event types", () => {
	const d = fresh();
	ingestLine("not json", d);
	ingestLine(JSON.stringify({ type: "turn_start" }), d);
	ingestLine("", d);
	assert.deepEqual(d.messages, []);
	assert.equal(d.toolCount, 0);
});

test("ingestLine folds an assistant message_end into usage/tools/lastMessage", () => {
	const d = fresh();
	ingestLine(
		msgEnd(
			assistantWithUsage(
				[
					{ type: "text", text: "Let me check.\n```code\nx\n```\nDone now" },
					{ type: "toolCall", name: "read", arguments: { path: "/a/b.ts" } },
				],
				{ input: 10, output: 5, cacheRead: 2, cost: { total: 0.01 } },
			),
		),
		d,
	);
	assert.equal(d.messages.length, 1);
	assert.equal(d.toolCount, 1);
	assert.deepEqual(d.recentTools, [{ name: "read", argsPreview: "/a/b.ts" }]);
	assert.equal(d.usage.input, 10);
	assert.equal(d.usage.output, 5);
	assert.equal(d.usage.cacheRead, 2);
	assert.equal(d.usage.cost, 0.01);
	assert.equal(d.usage.turns, 1);
	assert.equal(d.tokens, 17);
	assert.equal(d.lastMessage, "Let me check.");
});

test("ingestLine: toolResult arrives via message_end (not tool_result_end)", () => {
	const d = fresh();
	ingestLine(msgEnd({ role: "toolResult", content: [{ type: "text", text: "result" }] }), d);
	assert.equal(d.messages.length, 1);
	assert.equal(d.toolCount, 0);
	assert.equal(d.lastMessage, "");
});

test("ingestLine ignores a tool_result_end event — pins the wire format", () => {
	const d = fresh();
	ingestLine(JSON.stringify({ type: "tool_result_end", message: { role: "toolResult", content: [] } }), d);
	assert.deepEqual(d.messages, []);
});

test("ingestLine: lastMessage skips blank lines and fence delimiters", () => {
	const d = fresh();
	ingestLine(
		msgEnd(assistantWithUsage([{ type: "text", text: "```ts\nconst x = 1;\n```\nReal prose" }])),
		d,
	);
	assert.equal(d.lastMessage, "const x = 1;");
});

test("recentTools is capped to a rolling window of the most recent calls", () => {
	const d = fresh();
	for (let i = 0; i < 60; i++) {
		ingestLine(
			msgEnd(assistantWithUsage([{ type: "toolCall", name: "bash", arguments: { command: `cmd ${i}` } }])),
			d,
		);
	}
	assert.equal(d.toolCount, 60);
	assert.ok(d.recentTools.length <= 50);
	assert.equal(d.recentTools[0].argsPreview, "cmd 10");
	assert.equal(d.recentTools.at(-1)?.argsPreview, "cmd 59");
});

test("argsPreview picks known keys", () => {
	assert.equal(argsPreview({ path: "/x" }), "/x");
	assert.equal(argsPreview({ command: "ls -la" }), "ls -la");
	assert.equal(argsPreview({ query: "hi there" }), "hi there");
});

test("argsPreview falls back to compact JSON for unknown shapes", () => {
	assert.equal(argsPreview({ foo: "bar", n: 1 }), '{"foo":"bar","n":1}');
	assert.equal(argsPreview(undefined), "");
	assert.equal(argsPreview("str"), "");
	assert.equal(argsPreview(null), "");
});

test("buildTaskPrompt adds a bounded parent handoff only when supplied", () => {
	assert.equal(buildTaskPrompt("check this"), "Task: check this");
	assert.equal(
		buildTaskPrompt("check this", "  src/config.ts:10-20 contains the failing parser.  "),
		"Task: check this\n\nParent handoff (trusted context; verify if needed):\nsrc/config.ts:10-20 contains the failing parser.",
	);
});

test("ingestLine forwards two nested spawn_agent snapshots recursively", () => {
	const d = fresh();
	for (const [id, agent, task] of [["child-a", "scout", "locate parser"], ["child-b", "worker", "fix parser"]] as const) {
		ingestLine(JSON.stringify({
			type: "tool_execution_start",
			toolCallId: id,
			toolName: "spawn_agent",
			args: { agent_type: agent, task_name: task },
		}), d);
		ingestLine(JSON.stringify({
			type: "tool_execution_update",
			toolCallId: id,
			toolName: "spawn_agent",
			args: {},
			partialResult: {
				details: {
					agent,
					taskName: task,
					depth: 2,
					toolCount: 1,
					recentTools: [{ name: "read", argsPreview: `src/${agent}.ts` }],
					lastMessage: "reading target",
					nestedRuns: agent === "worker" ? [{
						toolCallId: "grandchild",
						agent: "scout",
						taskName: "find tests",
						depth: 3,
						toolCount: 1,
						recentTools: [{ name: "grep", argsPreview: "parser" }],
						lastMessage: "",
						nestedRuns: [],
					}] : [],
				},
			},
		}), d);
	}

	assert.equal(d.nestedRuns.length, 2);
	assert.deepEqual(d.nestedRuns.map((run) => run.agent), ["scout", "worker"]);
	assert.equal(d.nestedRuns[1]?.nestedRuns[0]?.agent, "scout");
	assert.equal(d.nestedRuns[1]?.nestedRuns[0]?.recentTools[0]?.name, "grep");
});

test("ingestLine marks a completed nested spawn_agent", () => {
	const d = fresh();
	ingestLine(JSON.stringify({
		type: "tool_execution_start",
		toolCallId: "child",
		toolName: "spawn_agent",
		args: { agent_type: "scout", task_name: "find files" },
	}), d);
	ingestLine(JSON.stringify({
		type: "tool_execution_end",
		toolCallId: "child",
		toolName: "spawn_agent",
		result: { details: { agent: "scout", taskName: "find files", depth: 2, endTime: 1, toolCount: 2, recentTools: [], lastMessage: "done", nestedRuns: [] } },
		isError: false,
	}), d);

	assert.equal(d.nestedRuns[0]?.status, "completed");
	assert.equal(d.nestedRuns[0]?.lastMessage, "done");
});

test("buildPiArgs maps reasoning effort override to Pi's thinking flag", () => {
	const args = buildPiArgs({
		model: "openai/gpt-5.5",
		reasoningEffortOverride: "high",
		tools: ["read", "grep"],
		message: "check this",
	});

	assert.deepEqual(args, [
		"--mode", "json",
		"--print",
		"--no-session",
		"--model", "openai/gpt-5.5",
		"--thinking", "high",
		"--tools", "read,grep",
		"Task: check this",
	]);
	assert.equal(args.includes("--reasoning-effort"), false);
});

test("buildPiArgs translates Codex reasoning effort none to Pi thinking off", () => {
	assert.deepEqual(
		buildPiArgs({ reasoningEffortOverride: "none", message: "quiet" }),
		["--mode", "json", "--print", "--no-session", "--thinking", "off", "Task: quiet"],
	);
});

test("resolveEffectiveModel prefers an explicit agent model", () => {
	assert.equal(
		resolveEffectiveModel("openai/gpt-5.5", { provider: "openmodel", id: "deepseek-v4-flash" }),
		"openai/gpt-5.5",
	);
});

test("resolveEffectiveModel inherits the current session model when agent model is omitted", () => {
	assert.equal(
		resolveEffectiveModel(undefined, { provider: "openmodel", id: "deepseek-v4-flash" }),
		"openmodel/deepseek-v4-flash",
	);
});

test("resolveEffectiveModel leaves model unset when neither source is available", () => {
	assert.equal(resolveEffectiveModel(undefined, undefined), undefined);
});
