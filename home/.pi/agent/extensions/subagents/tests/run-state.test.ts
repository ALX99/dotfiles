import { test, type TestContext } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import fc from "fast-check";
import { discoverAgents } from "../agents.ts";
import { parseAgentEvent } from "../event-schema.ts";
import { OutputSpool } from "../output-spool.ts";
import {
	MAX_ARGUMENT_PREVIEW_CHARACTERS,
	MAX_RETAINED_EVENT_TEXT_CHARACTERS,
	MAX_RETAINED_IDENTITY_CHARACTERS,
	argsPreview,
	foldAgentEvent,
	type MutableRunData,
	type ReadonlyNestedRunDetails,
} from "../run-state.ts";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function graphemeCount(value: string): number {
	return Array.from(segmenter.segment(value)).length;
}

function fresh(t: TestContext): {
	readonly details: MutableRunData;
	readonly ingest: (line: string) => Promise<void>;
} {
	const output = new OutputSpool();
	t.after(() => output.close());
	const details: MutableRunData = {
		agent: "test",
		taskName: "test",
		profile: "balanced",
		model: "provider/model",
		effectiveThinking: "medium",
		depth: 1,
		exitCode: 0,
		finalText: "",
		stderr: "",
		startTime: 0,
		toolCount: 0,
		recentTools: [],
		lastMessage: "",
		nestedRuns: [],
		tokens: 0,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
	};
	return {
		details,
		ingest: (line) => foldLine(line, details, output),
	};
}

async function foldLine(line: string, details: MutableRunData, output: OutputSpool): Promise<void> {
	if (!line.trim()) return;
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return;
	}
	const parsed = parseAgentEvent(value);
	if (parsed.kind === "event") await foldAgentEvent(parsed.event, details, output);
}

function msgEnd(message: unknown): string {
	return JSON.stringify({ type: "message_end", message });
}

const assistantWithUsage = (content: unknown, usage?: unknown): unknown => ({
	role: "assistant",
	content,
	...(usage ? { usage } : {}),
});

test("event folding ignores non-JSON and unrelated event types", async (t) => {
	const { details: d, ingest } = fresh(t);
	await ingest("not json");
	await ingest(JSON.stringify({ type: "turn_start" }));
	await ingest("");
	assert.equal(d.finalText, "");
	assert.equal(d.toolCount, 0);
});

test("event folding captures an assistant provider error even when the child exits zero", async (t) => {
	const { details: d, ingest } = fresh(t);
	await ingest(
		msgEnd({
			role: "assistant",
			content: [],
			stopReason: "error",
			errorMessage: "Codex error: unsupported model",
		}),
	);

	assert.equal(d.assistantError, "Codex error: unsupported model");
});

test("event folding clears a transient assistant error after a successful retry", async (t) => {
	const { details: d, ingest } = fresh(t);
	await ingest(
		msgEnd({
			role: "assistant",
			content: [],
			stopReason: "error",
			errorMessage: "temporary provider error",
		}),
	);
	await ingest(
		msgEnd({
			role: "assistant",
			content: [{ type: "text", text: "recovered" }],
			stopReason: "stop",
		}),
	);

	assert.equal(d.assistantError, undefined);
});

test("agent identity files do not select models", () => {
	const agents = discoverAgents(path.join(import.meta.dirname, "..", "agents"))._unsafeUnwrap();
	assert.ok(agents.some((agent) => agent.name === "general"));
	assert.equal("model" in agents[0]!, false);
});

test("event folding captures assistant usage, tools, and lastMessage", async (t) => {
	const { details: d, ingest } = fresh(t);
	await ingest(
		msgEnd(
			assistantWithUsage(
				[
					{ type: "text", text: "Let me check.\n```code\nx\n```\nDone now" },
					{ type: "toolCall", name: "read", arguments: { path: "/a/b.ts" } },
				],
				{ input: 10, output: 5, cacheRead: 2, cost: { total: 0.01 } },
			),
		),
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

test("event folding retains assistant text across messages in one generation", async (t) => {
	const { details: d, ingest } = fresh(t);
	await ingest(
		msgEnd(
			assistantWithUsage([
				{ type: "text", text: "First section." },
				{ type: "toolCall", name: "read", arguments: { path: "notes.md" } },
				{ type: "text", text: "Second section." },
			]),
		),
	);
	await ingest(msgEnd(assistantWithUsage([{ type: "text", text: "Final conclusion." }])));

	assert.equal(d.finalText, "First section.\n\nSecond section.\n\nFinal conclusion.");
	assert.equal(d.toolCount, 1);
	assert.equal(d.lastMessage, "Final conclusion.");
});

test("event folding bounds large final text and preserves the full output in a private temp file", async (t) => {
	const { details: d, ingest } = fresh(t);
	const full = "x".repeat(60 * 1024);
	await ingest(msgEnd(assistantWithUsage([{ type: "text", text: full }])));

	assert.ok(Buffer.byteLength(d.finalText, "utf8") <= 50 * 1024);
	assert.match(d.finalText, /Output truncated/);
	assert.ok(d.outputFile);
	assert.equal(fs.statSync(d.outputFile).mode & 0o777, 0o600);
	assert.equal(fs.readFileSync(d.outputFile, "utf8"), full);

	const outputDir = path.dirname(d.outputFile);
	await ingest(msgEnd(assistantWithUsage([{ type: "text", text: "replacement" }])));
	assert.match(d.finalText, /Output truncated/);
	assert.ok(d.outputFile);
	assert.equal(path.dirname(d.outputFile), outputDir);
	assert.equal(fs.existsSync(outputDir), true);
	assert.match(fs.readFileSync(d.outputFile, "utf8"), /replacement$/);
});

test("toolResult arrives via message_end but is not assistant output", async (t) => {
	const { details: d, ingest } = fresh(t);
	await ingest(msgEnd({ role: "toolResult", content: [{ type: "text", text: "result" }] }));
	assert.equal(d.finalText, "");
	assert.equal(d.toolCount, 0);
	assert.equal(d.lastMessage, "");
});

test("event folding ignores tool_result_end — pins the wire format", async (t) => {
	const { details: d, ingest } = fresh(t);
	await ingest(JSON.stringify({ type: "tool_result_end", message: { role: "toolResult", content: [] } }));
	assert.equal(d.finalText, "");
});

test("lastMessage skips blank lines and fence delimiters", async (t) => {
	const { details: d, ingest } = fresh(t);
	await ingest(msgEnd(assistantWithUsage([{ type: "text", text: "```ts\nconst x = 1;\n```\nReal prose" }])));
	assert.equal(d.lastMessage, "const x = 1;");
});

test("recentTools is capped to a rolling window of the most recent calls", async (t) => {
	const { details: d, ingest } = fresh(t);
	for (let i = 0; i < 60; i++) {
		await ingest(msgEnd(assistantWithUsage([{ type: "toolCall", name: "bash", arguments: { command: `cmd ${i}` } }])));
	}
	assert.equal(d.toolCount, 60);
	assert.ok(d.recentTools.length <= 50);
	assert.equal(d.recentTools.at(0)?.argsPreview, "cmd 10");
	assert.equal(d.recentTools.at(-1)?.argsPreview, "cmd 59");
});

test("elapsed time, usage, tool count, and reported cost remain observational", async (t) => {
	const { details: d, ingest } = fresh(t);
	d.startTime = Date.now() - 365 * 24 * 60 * 60 * 1_000;
	for (let index = 0; index < 100; index++) {
		await ingest(
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
		);
	}
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

test("event folding forwards two nested spawn_agent snapshots recursively", async (t) => {
	const { details: d, ingest } = fresh(t);
	for (const [id, agent, task] of [
		["child-a", "scout", "locate parser"],
		["child-b", "worker", "fix parser"],
	] as const) {
		await ingest(
			JSON.stringify({
				type: "tool_execution_start",
				toolCallId: id,
				toolName: "spawn_agent",
				args: { agent, task_name: task },
			}),
		);
		await ingest(
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

test("event folding marks a completed nested spawn_agent", async (t) => {
	const { details: d, ingest } = fresh(t);
	await ingest(
		JSON.stringify({
			type: "tool_execution_start",
			toolCallId: "child",
			toolName: "spawn_agent",
			args: { agent: "scout", task_name: "find files" },
		}),
	);
	await ingest(
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
	);

	assert.equal(d.nestedRuns[0]?.status, "completed");
	assert.equal(d.nestedRuns[0]?.lastMessage, "done");
});

test("retained event snapshots stay bounded for arbitrary tool arguments and nested results", async (t) => {
	const { details } = fresh(t);
	const output = new OutputSpool();
	t.after(() => output.close());

	await fc.assert(
		fc.asyncProperty(
			fc.dictionary(fc.string({ maxLength: 20 }), fc.jsonValue(), { maxKeys: 30 }),
			fc.string({ maxLength: 2_000 }),
			fc.array(
				fc.record({
					name: fc.string({ maxLength: 2_000 }),
					argsPreview: fc.string({ maxLength: 2_000 }),
				}),
				{ maxLength: 20 },
			),
			async (args, retained, tools) => {
				assert.ok(graphemeCount(argsPreview(args)) <= MAX_ARGUMENT_PREVIEW_CHARACTERS);
				const nested = (depth: number): Record<string, unknown> => ({
					toolCallId: retained,
					agent: retained,
					taskName: retained,
					lastMessage: retained,
					recentTools: tools,
					nestedRuns: depth === 0 ? [] : [nested(depth - 1)],
				});
				details.nestedRuns = [];
				await foldAgentEvent(
					{ type: "tool_execution_start", toolCallId: retained, toolName: "spawn_agent", args },
					details,
					output,
				);
				await foldAgentEvent(
					{
						type: "tool_execution_end",
						toolCallId: retained,
						toolName: "spawn_agent",
						result: { details: nested(6) },
						isError: false,
					},
					details,
					output,
				);

				const assertNestedBounds = (run: ReadonlyNestedRunDetails, depth: number): void => {
					assert.ok(depth <= 4);
					assert.ok(graphemeCount(run.taskName) <= MAX_RETAINED_EVENT_TEXT_CHARACTERS);
					assert.ok(graphemeCount(run.lastMessage) <= MAX_RETAINED_EVENT_TEXT_CHARACTERS);
					assert.ok(run.recentTools.length <= 8);
					for (const tool of run.recentTools) {
						assert.ok(graphemeCount(tool.argsPreview) <= MAX_ARGUMENT_PREVIEW_CHARACTERS);
					}
					assert.ok(run.nestedRuns.length <= 8);
					for (const child of run.nestedRuns) assertNestedBounds(child, depth + 1);
				};
				for (const run of details.nestedRuns) assertNestedBounds(run, 1);
			},
		),
	);
});

test("assistant errors, messages, and tool names are bounded before snapshots retain them", async (t) => {
	const { details } = fresh(t);
	const output = new OutputSpool();
	t.after(() => output.close());
	const huge = "界".repeat(MAX_RETAINED_EVENT_TEXT_CHARACTERS * 4);
	await foldAgentEvent(
		{
			type: "message_end",
			message: {
				role: "assistant",
				stopReason: "error",
				errorMessage: huge,
				content: [
					{ type: "text", text: huge },
					{ type: "toolCall", name: huge, arguments: { command: huge } },
				],
			},
		},
		details,
		output,
	);
	assert.ok(graphemeCount(details.assistantError ?? "") <= MAX_RETAINED_EVENT_TEXT_CHARACTERS);
	assert.ok(graphemeCount(details.lastMessage) <= MAX_RETAINED_EVENT_TEXT_CHARACTERS);
	assert.ok(graphemeCount(details.recentTools[0]?.name ?? "") <= MAX_RETAINED_IDENTITY_CHARACTERS);
	assert.ok(graphemeCount(details.recentTools[0]?.argsPreview ?? "") <= MAX_ARGUMENT_PREVIEW_CHARACTERS);
});
