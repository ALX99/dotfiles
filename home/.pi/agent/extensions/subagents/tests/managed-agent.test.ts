import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { SessionManager, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../agents.ts";
import { ManagedAgent } from "../managed-agent.ts";

const config: AgentConfig = {
	name: "scout",
	description: "test",
	tools: ["read"],
	systemPrompt: "test",
	filePath: "test",
};
const resolvedRun = {
	agent: "scout",
	profile: "fast",
	model: "test/model",
	modelInstance: {} as never,
	effectiveThinking: "low" as const,
	contextWindow: 1_000,
};

test("one native session owns foreground, background, steering, follow-up, and closure transitions", async (t) => {
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "managed-agent-test-"));
	t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
	const manager = SessionManager.create(agentDir, path.join(agentDir, "subagent-sessions"));
	const listeners = new Set<(event: any) => void>();
	const prompts: string[] = [];
	const steers: string[] = [];
	const fake = {
		sessionId: manager.getSessionId(),
		sessionFile: manager.getSessionFile(),
		sessionManager: manager,
		getContextUsage() {
			return { tokens: 3, contextWindow: 1_000, percent: 0.3 };
		},
		subscribe(listener: (event: any) => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		async prompt(message: string) {
			prompts.push(message);
			if (prompts.length === 2) {
				for (const listener of listeners) {
					listener({
						type: "tool_execution_start",
						toolCallId: "call-1",
						toolName: "read",
						args: { path: "src/index.ts" },
					});
				}
			}
			const assistant = {
				role: "assistant",
				content: [
					...(prompts.length === 2
						? [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/index.ts" } }]
						: []),
					{ type: "text", text: `done: ${message}` },
				],
				stopReason: "stop",
				usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0.1 } },
			};
			manager.appendMessage(assistant as never);
			for (const listener of listeners) listener({ type: "message_end", message: assistant });
			if (prompts.length === 3) await new Promise((resolve) => setTimeout(resolve, 10));
		},
		async steer(message: string) {
			steers.push(message);
		},
		async abort() {},
		dispose() {},
	};
	const completed: string[] = [];
	const agent = new ManagedAgent({
		id: "scout-1",
		agentDir,
		defaultCwd: agentDir,
		agent: config,
		resolvedRun,
		retain: true,
		sessionFactory: async () => fake as never,
		onBackgroundComplete: (summary) => completed.push(`${summary.agent_id}:${summary.generation}`),
	});
	t.after(() => agent.close());

	const first = await agent.start("inspect", undefined, "inspect", false);
	assert.equal(first.status, "idle");
	assert.equal(first.finalText, "done: Task: inspect");
	assert.equal(first.usage.output, 2);
	assert.deepEqual(first.contextUsage, { tokens: 3, contextWindow: 1_000, percent: 0.3 });

	const background = await agent.followUp("continue", "continue", true);
	assert.equal(background.status, "launched");
	const continued = await agent.wait();
	assert.equal(continued.toolCount, 1);
	assert.deepEqual(continued.recentTools, [{ name: "read", argsPreview: "src/index.ts" }]);
	assert.equal(continued.lastMessage, "done: continue");
	assert.ok(continued.lastActivityTime >= continued.startTime);
	assert.deepEqual(completed, ["scout-1:2"]);

	await agent.followUp("third", "third", true);
	await agent.steer("focus");
	await agent.wait();
	assert.deepEqual(steers, ["focus"]);
	assert.equal(agent.summary().generation, 3);
	assert.equal(prompts.length, 3);

	await agent.close();
	assert.equal(agent.phase, "closed");
});

test("a foreground question returns control and resumes after its answer", async (t) => {
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "managed-agent-question-test-"));
	t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
	const manager = SessionManager.create(agentDir, path.join(agentDir, "subagent-sessions"));
	const listeners = new Set<(event: any) => void>();
	let questionTool: ToolDefinition | undefined;
	const fake = {
		sessionId: manager.getSessionId(),
		sessionFile: manager.getSessionFile(),
		sessionManager: manager,
		messages: [],
		getContextUsage() {
			return { tokens: null, contextWindow: 1_000, percent: null };
		},
		subscribe(listener: (event: any) => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		async prompt() {
			const result = await questionTool!.execute(
				"question-call",
				{ question: "Which implementation?", alternatives: ["Simple", "Flexible"] },
				undefined,
				undefined,
				{} as never,
			);
			const answer = result.content[0]?.type === "text" ? result.content[0].text : "";
			const assistant = {
				role: "assistant",
				content: [{ type: "text", text: `answer:${answer}` }],
				stopReason: "stop",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
			};
			manager.appendMessage(assistant as never);
			for (const listener of listeners) listener({ type: "message_end", message: assistant });
		},
		async steer() {},
		async abort() {},
		dispose() {},
	};
	const questions: string[] = [];
	const completions: string[] = [];
	const agent = new ManagedAgent({
		id: "worker-1",
		agentDir,
		defaultCwd: agentDir,
		agent: { ...config, name: "worker", tools: ["ask_question"] },
		resolvedRun: { ...resolvedRun, agent: "worker" },
		retain: false,
		sessionFactory: async (customTools) => {
			questionTool = customTools[0];
			return fake as never;
		},
		onQuestion: (_summary, question) => questions.push(question.question_id),
		onBackgroundComplete: (summary) => completions.push(summary.final_text ?? ""),
	});
	t.after(() => agent.close());

	const waiting = await agent.start("choose", undefined, "choose", false);
	assert.equal(waiting.pendingQuestion?.question, "Which implementation?");
	assert.deepEqual(waiting.pendingQuestion?.options, ["Simple", "Flexible"]);
	assert.deepEqual(questions, [waiting.pendingQuestion?.question_id]);

	await agent.answerQuestion(waiting.pendingQuestion!.question_id, "Simple");
	const settled = await agent.wait(1_000);
	assert.equal(settled.finalText, "answer:Simple");
	assert.deepEqual(completions, ["answer:Simple"]);
	assert.equal(agent.phase, "closed");
});

test("closing a child waiting for input cancels the question and cannot regress from closed", async (t) => {
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "managed-agent-close-question-test-"));
	t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
	const manager = SessionManager.create(agentDir, path.join(agentDir, "subagent-sessions"));
	let questionTool: ToolDefinition | undefined;
	let prompt: Promise<void> | undefined;
	const fake = {
		sessionId: manager.getSessionId(),
		sessionFile: manager.getSessionFile(),
		sessionManager: manager,
		messages: [],
		getContextUsage() {
			return { tokens: null, contextWindow: 1_000, percent: null };
		},
		subscribe() {
			return () => {};
		},
		async prompt() {
			prompt = questionTool!
				.execute(
					"question-call",
					{ question: "Continue?", alternatives: ["Yes", "No"] },
					undefined,
					undefined,
					{} as never,
				)
				.then(() => {});
			await prompt;
		},
		async steer() {},
		async abort() {
			await prompt?.catch(() => {});
		},
		dispose() {},
	};
	const agent = new ManagedAgent({
		id: "worker-2",
		agentDir,
		defaultCwd: agentDir,
		agent: { ...config, name: "worker", tools: ["ask_question"] },
		resolvedRun: { ...resolvedRun, agent: "worker" },
		retain: true,
		sessionFactory: async (customTools) => {
			questionTool = customTools[0];
			return fake as never;
		},
	});

	const waiting = await agent.start("choose", undefined, "choose", false);
	assert.ok(waiting.pendingQuestion);
	await agent.close();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(agent.phase, "closed");
});

test("a terminal assistant error is a failed, incomplete generation", async (t) => {
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "managed-agent-failure-test-"));
	t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
	const manager = SessionManager.create(agentDir, path.join(agentDir, "subagent-sessions"));
	const listeners = new Set<(event: any) => void>();
	const assistant = {
		role: "assistant",
		content: [{ type: "text", text: "partial output" }],
		stopReason: "error",
		errorMessage: "provider unavailable",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
	};
	const fake = {
		sessionId: manager.getSessionId(),
		sessionFile: manager.getSessionFile(),
		sessionManager: manager,
		messages: [],
		getContextUsage() {
			return { tokens: null, contextWindow: 1_000, percent: null };
		},
		subscribe(listener: (event: any) => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		async prompt() {
			manager.appendMessage(assistant as never);
			for (const listener of listeners) listener({ type: "message_end", message: assistant });
		},
		async steer() {},
		async abort() {},
		dispose() {},
	};
	const agent = new ManagedAgent({
		id: "scout-failed",
		agentDir,
		defaultCwd: agentDir,
		agent: config,
		resolvedRun,
		retain: true,
		sessionFactory: async () => fake as never,
	});
	t.after(() => agent.close());

	const failed = await agent.start("inspect", undefined, "inspect", false);
	assert.equal(failed.status, "failed");
	assert.equal(failed.error, "provider unavailable");
	assert.equal(failed.finalText, "partial output");
	assert.equal(failed.result?.complete, false);
	assert.equal(agent.summary().status, "failed");
});
