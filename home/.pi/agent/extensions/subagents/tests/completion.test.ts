import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import type { AgentSummary } from "../agent-types.ts";
import {
	BACKGROUND_COMPLETION_DEBOUNCE_MS,
	DefaultSubagentRuntime,
	formatBackgroundCompletions,
	formatSubagentQuestion,
	isCompletionSuperseded,
} from "../bootstrap.ts";
import type { ProfilesConfig } from "../profiles.ts";

const testAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-completion-test-"));
after(() => fs.rmSync(testAgentDir, { recursive: true, force: true }));

function summary(generation: number, status: AgentSummary["status"] = "idle"): AgentSummary {
	return {
		agent_id: "agent-1",
		agent: "scout",
		task_name: "test",
		profile: "fast",
		model: "opencode-go/deepseek-v4-flash",
		effective_thinking: "low",
		generation,
		retained: false,
		status,
		started_at: 0,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
	};
}

test("new generations and explicitly closed retained agents supersede queued completions", () => {
	assert.equal(isCompletionSuperseded(summary(1), summary(2, "running")), true);
	assert.equal(isCompletionSuperseded(summary(1), { ...summary(1, "closed"), retained: true }), true);
	assert.equal(isCompletionSuperseded(summary(1), summary(1, "closed")), false);
	assert.equal(isCompletionSuperseded(summary(2), summary(2, "idle")), false);
	assert.equal(isCompletionSuperseded(summary(1), { ...summary(2), agent_id: "agent-2" }), false);
});

test("background completions serialize child output as safe XML", () => {
	const content = formatBackgroundCompletions([
		{
			...summary(1),
			task_name: `test '"<task>&`,
			final_text: "<follow this>&",
			ended_at: 20,
			duration_ms: 20,
			usage: { input: 10, output: 2, cacheRead: 30, cacheWrite: 1, cost: 0.25, turns: 3 },
		},
	]);
	assert.match(content, /<subagent_result agent_id="agent-1" task_name="test &apos;&quot;&lt;task&gt;&amp;"/);
	assert.match(content, /<output>&lt;follow this&gt;&amp;<\/output>/);
	assert.match(
		content,
		/<usage input="10" output="2" reasoning="0" cache_read="30" cache_write="1" turns="3" cost="0.25"/,
	);
	assert.match(content, /started_at="0" ended_at="20" duration_ms="20"/);
});

test("background completions keep previews bounded and direct exact reads", () => {
	const content = formatBackgroundCompletions([
		{
			...summary(1),
			final_text: "x".repeat(50 * 1024),
			result: {
				generation: 1,
				result_id: "a".repeat(64),
				pages: 9,
				complete: true,
				total_bytes: 50 * 1024,
				sha256: "b".repeat(64),
				source: "assistant",
			},
		},
	]);
	assert.ok(Buffer.byteLength(content, "utf8") < 3 * 1024);
	assert.match(content, /read_agent_result/);
	assert.match(content, /result_ref/);
});

test("subagent questions serialize their routing fields as safe XML", () => {
	const content = formatSubagentQuestion(
		{ ...summary(2), agent_id: `worker-"<&` },
		{
			question_id: `question-"<&`,
			question: "Choose <now> & later",
			options: ["A & B", "<custom>"],
		},
	);
	assert.match(content, /agent_id="worker-&quot;&lt;&amp;"/);
	assert.match(content, /question_id="question-&quot;&lt;&amp;"/);
	assert.match(content, /<question>Choose &lt;now&gt; &amp; later<\/question>/);
	assert.match(content, /<option>A &amp; B<\/option>/);
});

test("simultaneous idle background completions are delivered in one debounced follow-up", async (t) => {
	const runtime = new DefaultSubagentRuntime(
		[],
		{
			rootPolicy: {
				maxConcurrentRootAgents: 1,
				maxConcurrentDeepAgents: 1,
			},
			profiles: {},
			agentPolicies: {},
		} as ProfilesConfig,
		testAgentDir,
	);
	const notifications: string[] = [];
	await runtime.startSession({
		isIdle: () => true,
		sessionManager: { getBranch: () => [] },
		ui: {
			notify: (message: string) => notifications.push(message),
			setStatus: () => {},
			setWidget: () => {},
		},
	} as never);
	const messages: unknown[] = [];
	const settlements: unknown[] = [];
	const pi = {
		sendMessage: (message: unknown) => messages.push(message),
		appendEntry: (_type: string, data: unknown) => settlements.push(data),
		getActiveTools: () => [],
		setActiveTools: () => {},
	} as never;
	t.after(() => runtime.shutdown());

	runtime.handleBackgroundComplete(pi, summary(1));
	runtime.handleBackgroundComplete(pi, { ...summary(1), agent_id: "agent-2" });
	assert.equal(settlements.length, 2);
	assert.equal(messages.length, 0);
	await new Promise((resolve) => setTimeout(resolve, BACKGROUND_COMPLETION_DEBOUNCE_MS + 25));

	assert.equal(notifications.length, 2);
	assert.equal(messages.length, 1);
	assert.match(String((messages[0] as { content: string }).content), /<subagent_results>[\s\S]*agent-1[\s\S]*agent-2/);
});

test("consuming completions removes only the matching settled generation", async (t) => {
	const runtime = new DefaultSubagentRuntime(
		[],
		{
			rootPolicy: {
				maxConcurrentRootAgents: 1,
				maxConcurrentDeepAgents: 1,
			},
			profiles: {},
			agentPolicies: {},
		} as ProfilesConfig,
		testAgentDir,
	);
	t.after(() => runtime.shutdown());
	await runtime.startSession({
		isIdle: () => false,
		sessionManager: { getBranch: () => [] },
		ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
	} as never);
	const messages: unknown[] = [];
	const pi = {
		sendMessage: (message: unknown) => messages.push(message),
		appendEntry: () => {},
		getActiveTools: () => [],
		setActiveTools: () => {},
	} as never;

	runtime.handleBackgroundComplete(pi, summary(1));
	runtime.consumeSettledCompletions([summary(2)]);
	runtime.flushCompletions(pi, true);
	assert.equal(messages.length, 1, "a newer generation must not consume an older completion");

	runtime.handleBackgroundComplete(pi, summary(3));
	runtime.consumeSettledCompletions([summary(3)]);
	runtime.flushCompletions(pi, true);
	assert.equal(messages.length, 1, "the matching generation must be consumed");
});

test("background questions steer the parent immediately", async (t) => {
	const runtime = new DefaultSubagentRuntime(
		[],
		{
			rootPolicy: {
				maxConcurrentRootAgents: 1,
				maxConcurrentDeepAgents: 1,
			},
			profiles: {},
			agentPolicies: {},
		} as ProfilesConfig,
		testAgentDir,
	);
	const messages: Array<{
		message: { customType: string; content: string };
		options: { deliverAs: string; triggerTurn: boolean };
	}> = [];
	let activeTools = ["spawn_agent"];
	const pi = {
		sendMessage: (
			message: { customType: string; content: string },
			options: { deliverAs: string; triggerTurn: boolean },
		) => messages.push({ message, options }),
		getActiveTools: () => activeTools,
		setActiveTools: (next: string[]) => {
			activeTools = next;
		},
	} as never;
	t.after(() => runtime.shutdown());

	runtime.handleQuestion(pi, summary(1, "running"), {
		question_id: "question-1",
		question: "Choose",
		options: ["A", "B"],
	});

	assert.equal(messages.length, 1);
	assert.equal(messages[0]?.message.customType, "subagent-question");
	assert.match(messages[0]?.message.content ?? "", /question-1[\s\S]*Choose/);
	assert.match(messages[0]?.message.content ?? "", /answer_agent/);
	assert.deepEqual(messages[0]?.options, { deliverAs: "steer", triggerTurn: true });
	assert.deepEqual(activeTools, [
		"spawn_agent",
		"answer_agent",
		"wait_agent",
		"list_agents",
		"interrupt_agent",
		"close_agent",
		"send_agent",
	]);
});

test("usage claims restore from persisted wait results across session reload", async (t) => {
	const runtime = new DefaultSubagentRuntime(
		[],
		{
			rootPolicy: { maxConcurrentRootAgents: 1, maxConcurrentDeepAgents: 1 },
			profiles: {},
			agentPolicies: {},
		} as ProfilesConfig,
		testAgentDir,
	);
	t.after(() => runtime.shutdown());
	await runtime.startSession({
		sessionManager: {
			getBranch: () => [
				{
					type: "message",
					message: {
						role: "toolResult",
						toolName: "wait_agent",
						details: {
							accountedGenerations: [{ agentId: "agent-1", generation: 1 }],
						},
					},
				},
			],
		},
		ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
	} as never);
	assert.equal(runtime.claimUsage(summary(1)), undefined);
	assert.deepEqual(runtime.claimUsage(summary(2)), summary(2).usage);
});
