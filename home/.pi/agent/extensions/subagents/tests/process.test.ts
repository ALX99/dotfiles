import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { discoverAgents } from "../agents.ts";
import { argsPreview, ingestLine, type RunDetails } from "../process.ts";

function fresh(): RunDetails {
	return {
		agent: "test",
		taskName: "test",
		profile: "balanced",
		model: "provider/model",
		effectiveThinking: "medium",
		depth: 1,
		exitCode: 0,
		finalText: "",
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

test("ingestLine ignores non-JSON and unrelated event types", () => {
	const d = fresh();
	ingestLine("not json", d);
	ingestLine(JSON.stringify({ type: "turn_start" }), d);
	ingestLine("", d);
	assert.equal(d.finalText, "");
	assert.equal(d.toolCount, 0);
});

test("ingestLine captures an assistant provider error even when the child exits zero", () => {
	const d = fresh();
	ingestLine(
		msgEnd({
			role: "assistant",
			content: [],
			stopReason: "error",
			errorMessage: "Codex error: unsupported model",
		}),
		d,
	);

	assert.equal(d.assistantError, "Codex error: unsupported model");
});

test("ingestLine clears a transient assistant error after a successful retry", () => {
	const d = fresh();
	ingestLine(
		msgEnd({
			role: "assistant",
			content: [],
			stopReason: "error",
			errorMessage: "temporary provider error",
		}),
		d,
	);
	ingestLine(
		msgEnd({
			role: "assistant",
			content: [{ type: "text", text: "recovered" }],
			stopReason: "stop",
		}),
		d,
	);

	assert.equal(d.assistantError, undefined);
});

test("agent identity files do not select models", () => {
	const agents = discoverAgents(path.join(import.meta.dirname, "..", "agents"))._unsafeUnwrap();
	assert.ok(agents.some((agent) => agent.name === "general"));
	assert.equal("model" in agents[0]!, false);
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
	assert.equal(d.finalText, "Let me check.\n```code\nx\n```\nDone now");
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

test("ingestLine retains assistant text across messages in one generation", () => {
	const d = fresh();
	ingestLine(
		msgEnd(
			assistantWithUsage([
				{ type: "text", text: "First section." },
				{ type: "toolCall", name: "read", arguments: { path: "notes.md" } },
				{ type: "text", text: "Second section." },
			]),
		),
		d,
	);
	ingestLine(msgEnd(assistantWithUsage([{ type: "text", text: "Final conclusion." }])), d);

	assert.equal(d.finalText, "First section.\n\nSecond section.\n\nFinal conclusion.");
	assert.equal(d.toolCount, 1);
	assert.equal(d.lastMessage, "Final conclusion.");
});

test("ingestLine bounds large final text and preserves the full output in a private temp file", async () => {
	const d = fresh();
	const full = "x".repeat(60 * 1024);
	await ingestLine(msgEnd(assistantWithUsage([{ type: "text", text: full }])), d);

	assert.ok(Buffer.byteLength(d.finalText, "utf8") <= 50 * 1024);
	assert.match(d.finalText, /Output truncated/);
	assert.ok(d.outputFile);
	assert.equal(fs.statSync(d.outputFile).mode & 0o777, 0o600);
	assert.equal(fs.readFileSync(d.outputFile, "utf8"), full);

	const outputDir = path.dirname(d.outputFile);
	await ingestLine(msgEnd(assistantWithUsage([{ type: "text", text: "replacement" }])), d);
	assert.match(d.finalText, /Output truncated/);
	assert.ok(d.outputFile);
	assert.equal(path.dirname(d.outputFile), outputDir);
	assert.equal(fs.existsSync(outputDir), true);
	assert.match(fs.readFileSync(d.outputFile, "utf8"), /replacement$/);
	fs.rmSync(path.dirname(d.outputFile), { recursive: true, force: true });
});

test("ingestLine: toolResult arrives via message_end (not tool_result_end)", () => {
	const d = fresh();
	ingestLine(msgEnd({ role: "toolResult", content: [{ type: "text", text: "result" }] }), d);
	assert.equal(d.finalText, "");
	assert.equal(d.toolCount, 0);
	assert.equal(d.lastMessage, "");
});

test("ingestLine ignores a tool_result_end event — pins the wire format", () => {
	const d = fresh();
	ingestLine(JSON.stringify({ type: "tool_result_end", message: { role: "toolResult", content: [] } }), d);
	assert.equal(d.finalText, "");
});

test("ingestLine: lastMessage skips blank lines and fence delimiters", () => {
	const d = fresh();
	ingestLine(msgEnd(assistantWithUsage([{ type: "text", text: "```ts\nconst x = 1;\n```\nReal prose" }])), d);
	assert.equal(d.lastMessage, "const x = 1;");
});

test("recentTools is capped to a rolling window of the most recent calls", () => {
	const d = fresh();
	for (let i = 0; i < 60; i++) {
		ingestLine(msgEnd(assistantWithUsage([{ type: "toolCall", name: "bash", arguments: { command: `cmd ${i}` } }])), d);
	}
	assert.equal(d.toolCount, 60);
	assert.ok(d.recentTools.length <= 50);
	assert.equal(d.recentTools.at(0)?.argsPreview, "cmd 10");
	assert.equal(d.recentTools.at(-1)?.argsPreview, "cmd 59");
});

test("elapsed time, usage, tool count, and reported cost remain observational", () => {
	const d = fresh();
	d.startTime = Date.now() - 365 * 24 * 60 * 60 * 1_000;
	for (let index = 0; index < 100; index++) {
		ingestLine(
			msgEnd(
				assistantWithUsage([{ type: "toolCall", name: "read", arguments: { path: `file-${index}` } }], {
					input: 1_000_000,
					output: 1_000_000,
					cacheRead: 1_000_000,
					cacheWrite: 1_000_000,
					totalTokens: 4_000_000,
					cost: { total: 1_000_000 },
				}),
			),
			d,
		);
	}
	assert.equal(d.aborted, false);
	assert.equal(d.endTime, undefined);
	assert.equal(d.exitCode, 0);
	assert.equal(d.toolCount, 100);
	assert.equal(d.usage.turns, 100);
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

test("ingestLine forwards two nested spawn_agent snapshots recursively", () => {
	const d = fresh();
	for (const [id, agent, task] of [
		["child-a", "scout", "locate parser"],
		["child-b", "worker", "fix parser"],
	] as const) {
		ingestLine(
			JSON.stringify({
				type: "tool_execution_start",
				toolCallId: id,
				toolName: "spawn_agent",
				args: { agent, task_name: task },
			}),
			d,
		);
		ingestLine(
			JSON.stringify({
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
						nestedRuns:
							agent === "worker"
								? [
										{
											toolCallId: "grandchild",
											agent: "scout",
											taskName: "find tests",
											depth: 3,
											toolCount: 1,
											recentTools: [{ name: "grep", argsPreview: "parser" }],
											lastMessage: "",
											nestedRuns: [],
										},
									]
								: [],
					},
				},
			}),
			d,
		);
	}

	assert.equal(d.nestedRuns.length, 2);
	assert.deepEqual(
		d.nestedRuns.map((run) => run.agent),
		["scout", "worker"],
	);
	assert.equal(d.nestedRuns[1]?.nestedRuns[0]?.agent, "scout");
	assert.equal(d.nestedRuns[1]?.nestedRuns[0]?.recentTools[0]?.name, "grep");
});

test("ingestLine marks a completed nested spawn_agent", () => {
	const d = fresh();
	ingestLine(
		JSON.stringify({
			type: "tool_execution_start",
			toolCallId: "child",
			toolName: "spawn_agent",
			args: { agent: "scout", task_name: "find files" },
		}),
		d,
	);
	ingestLine(
		JSON.stringify({
			type: "tool_execution_end",
			toolCallId: "child",
			toolName: "spawn_agent",
			result: {
				details: {
					agent: "scout",
					taskName: "find files",
					depth: 2,
					endTime: 1,
					toolCount: 2,
					recentTools: [],
					lastMessage: "done",
					nestedRuns: [],
				},
			},
			isError: false,
		}),
		d,
	);

	assert.equal(d.nestedRuns[0]?.status, "completed");
	assert.equal(d.nestedRuns[0]?.lastMessage, "done");
});
