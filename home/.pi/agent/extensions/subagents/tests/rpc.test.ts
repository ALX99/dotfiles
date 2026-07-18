import * as assert from "node:assert/strict";
import { spawn, type SpawnOptionsWithoutStdio } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { AgentConfig } from "../agents.ts";
import { AgentRegistry, ManagedAgent } from "../host.ts";
import { RpcTransport, type RpcEvent, type SpawnRpcProcess } from "../rpc.ts";

const rpcScript = String.raw`
let buffer = '';
process.stdin.setEncoding('utf8');
function send(value) { process.stdout.write(JSON.stringify(value) + '\n'); }
function complete(text) {
  send({ type: 'agent_start' });
  const failed = text === 'done:assistant-error';
  send({ type: 'message_end', message: { role: 'assistant', content: failed ? [] : [{ type: 'text', text }], usage: { input: 2, output: 1, totalTokens: 3 }, stopReason: failed ? 'error' : 'stop', errorMessage: failed ? 'provider exploded' : undefined } });
  if (!text.endsWith('slow')) setTimeout(() => send({ type: 'agent_settled' }), 5);
}
process.stdin.on('data', chunk => {
  buffer += chunk;
  while (buffer.includes('\n')) {
    const index = buffer.indexOf('\n');
    const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
    if (!line) continue;
    const command = JSON.parse(line);
    if (command.type === 'extension_ui_response') { send({ type: 'ui_cancelled', value: command.cancelled }); continue; }
    if (command.type === 'never') { setTimeout(() => process.exit(9), 5); continue; }
    const data = command.type === 'get_messages'
      ? { messages: [{ role: 'assistant', content: [{ type: 'text', text: 'transcript' }] }] }
      : command.type === 'get_state' ? { sessionFile: '/tmp/subagent-session.jsonl' } : undefined;
    send({ type: 'response', id: command.id, command: command.type, success: true, data });
    if (command.type === 'prompt') complete('done:' + command.message);
    if (command.type === 'follow_up') complete('follow:' + command.message);
    if (command.type === 'abort') setTimeout(() => send({ type: 'agent_settled' }), 1);
  }
});
send({ type: 'unicode_event', text: 'left\u2028right' });
send({ type: 'extension_ui_request', id: 'ui-1', method: 'confirm', title: 'Question', message: 'Continue?' });
`;

const spawnedArgs: string[][] = [];
const spawnedContexts: unknown[] = [];
function spawnFake(_command: string, args: readonly string[], options: SpawnOptionsWithoutStdio) {
	spawnedArgs.push([...args]);
	spawnedContexts.push(JSON.parse(String(options.env?.PI_SUBAGENT_CONTEXT)));
	return spawn(process.execPath, ["-e", rpcScript], options);
}
// ManagedAgent always calls the stdio-pipe overload implemented by spawnFake;
// the full Node spawn overload set is intentionally unnecessary in this fixture.
const spawnRpcFake = spawnFake as unknown as SpawnRpcProcess;

const testEnv: Record<string, string> = Object.fromEntries(
	Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
);

const resolvedRun = {
	agent: "general",
	profile: "balanced",
	model: "opencode-go/glm-5.2",
	effectiveThinking: "medium" as const,
	contextWindow: 128_000,
};

const childContext = {
	treeId: "test-tree",
	depth: 1,
	agent: "general",
	profile: "balanced",
	delegationCredits: 0,
} as const;

function transport(events: RpcEvent[], onExit: (error: Error | undefined) => void = () => {}): RpcTransport {
	return new RpcTransport({
		command: process.execPath,
		args: ["-e", rpcScript],
		cwd: process.cwd(),
		env: testEnv,
		onEvent: (event) => events.push(event),
		onExit,
	});
}

test("RpcTransport correlates responses, preserves Unicode separators, and cancels child UI", async () => {
	const events: RpcEvent[] = [];
	const client = transport(events);
	await client.start();
	await client.request({ type: "prompt", message: "one" });
	await new Promise((resolve) => setTimeout(resolve, 20));

	assert.equal(events.find((event) => event.type === "unicode_event")?.text, "left\u2028right");
	assert.equal(
		events.some((event) => event.type === "ui_cancelled" && event.value === true),
		true,
	);
	assert.equal(
		events.some((event) => event.type === "agent_settled"),
		true,
	);
	await client.close();
});

test("RpcTransport rejects pending commands when the child exits", async () => {
	const client = transport([]);
	await client.start();
	await assert.rejects(client.request({ type: "never" }), /exited/);
});

test("RpcTransport handles child stdin EPIPE without an unhandled stream error", async (t) => {
	const script = "process.stdin.destroy(); setTimeout(() => {}, 200)";
	const client = new RpcTransport({
		command: process.execPath,
		args: ["-e", script],
		cwd: process.cwd(),
		env: testEnv,
		onEvent: () => {},
		onExit: () => {},
	});
	t.after(() => client.close());
	await client.start();
	await new Promise((resolve) => setTimeout(resolve, 50));
	await assert.rejects(
		client.request({ type: "prompt", message: "x".repeat(512 * 1024) }),
		/stdin failed|EPIPE|not available/,
	);
	await client.close();
});

test("ManagedAgent assigns readable sequential IDs", () => {
	const config: AgentConfig = {
		name: "general",
		description: "test",
		systemPrompt: "",
		filePath: "general.md",
	};
	const first = new ManagedAgent({
		defaultCwd: process.cwd(),
		agent: config,
		resolvedRun,
		childContext,
		subagentToolsEnabled: false,
	});
	const second = new ManagedAgent({
		defaultCwd: process.cwd(),
		agent: config,
		resolvedRun,
		childContext,
		subagentToolsEnabled: false,
	});

	assert.match(first.id, /^agent-\d+$/);
	assert.equal(second.id, `agent-${Number(first.id.slice("agent-".length)) + 1}`);
});

test("ManagedAgent retains its ID and increments generation across follow-ups", async (t) => {
	const config: AgentConfig = {
		name: "general",
		description: "test",
		systemPrompt: "",
		filePath: "general.md",
	};
	const completions: string[] = [];
	const agent = new ManagedAgent({
		defaultCwd: process.cwd(),
		agent: config,
		resolvedRun,
		childContext,
		subagentToolsEnabled: false,
		spawnProcess: spawnRpcFake,
		onBackgroundComplete: (summary) => completions.push(summary.final_text ?? ""),
	});
	t.after(() => agent.close());

	spawnedArgs.length = 0;
	spawnedContexts.length = 0;
	const first = await agent.start("first", undefined, "first task", false);
	const id = agent.id;
	const invocation = spawnedArgs[0] ?? [];
	assert.equal(invocation.filter((arg) => arg === "--model").length, 1);
	assert.equal(invocation.filter((arg) => arg === "--thinking").length, 1);
	assert.equal(invocation.filter((arg) => arg === "--session-dir").length, 1);
	assert.equal(invocation.includes("--no-session"), false);
	assert.deepEqual(invocation.slice(invocation.indexOf("--model"), invocation.indexOf("--model") + 4), [
		"--model",
		resolvedRun.model,
		"--thinking",
		resolvedRun.effectiveThinking,
	]);
	assert.match(invocation[invocation.indexOf("--session-dir") + 1] ?? "", /subagent-sessions$/);
	const excludedTools = invocation[invocation.indexOf("--exclude-tools") + 1] ?? "";
	for (const tool of [
		"spawn_agent",
		"send_agent",
		"followup_agent",
		"wait_agent",
		"list_agents",
		"interrupt_agent",
		"close_agent",
	]) {
		assert.match(excludedTools, new RegExp(`(?:^|,)${tool}(?:,|$)`));
	}
	assert.deepEqual(spawnedContexts, [childContext]);
	assert.equal(first.sessionFile, "/tmp/subagent-session.jsonl");
	assert.equal(first.finalText, "done:Task: first");
	assert.deepEqual(agent.summary(), {
		agent_id: id,
		agent: "general",
		task_name: "first task",
		profile: "balanced",
		model: "opencode-go/glm-5.2",
		effective_thinking: "medium",
		session_file: "/tmp/subagent-session.jsonl",
		depth: 1,
		generation: 1,
		status: "idle",
		final_text: "done:Task: first",
	});

	const second = await agent.followUp("second", "second task", false);
	assert.equal(agent.id, id);
	assert.equal(spawnedArgs.length, 1, "follow-ups must reuse the same configured child process");
	assert.equal(second.finalText, "done:second");
	assert.equal(agent.summary().generation, 2);
	assert.deepEqual(await agent.getMessages(), [{ role: "assistant", content: [{ type: "text", text: "transcript" }] }]);

	const launched = await agent.followUp("third", "third task", true);
	assert.equal(launched.status, "launched");
	await agent.wait(1_000);
	assert.deepEqual(completions, ["done:third"]);

	await agent.followUp("slow", "slow task", true);
	await agent.interrupt();
	await agent.wait(1_000);
	assert.deepEqual(completions, ["done:third"], "interrupted background runs must not report completion");
	const afterAbort = await agent.followUp("after abort", "recovery task", false);
	assert.equal(afterAbort.finalText, "done:after abort");
	assert.equal(agent.summary().generation, 5);

	await assert.rejects(agent.followUp("assistant-error", "failing task", false), /provider exploded/);
	assert.deepEqual(agent.summary(), {
		agent_id: id,
		agent: "general",
		task_name: "failing task",
		profile: "balanced",
		model: "opencode-go/glm-5.2",
		effective_thinking: "medium",
		session_file: "/tmp/subagent-session.jsonl",
		depth: 1,
		generation: 6,
		status: "failed",
		error: "provider exploded",
	});

	await agent.followUp("slow", "close task", true);
	await agent.close();
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(completions, ["done:third"], "closed background runs must not report failure completion");
	assert.equal(agent.summary().status, "closed");
});

test("wait timeout stops only the waiter and leaves the child running", async (t) => {
	const config: AgentConfig = {
		name: "worker",
		description: "test",
		systemPrompt: "",
		filePath: "worker.md",
	};
	const agent = new ManagedAgent({
		defaultCwd: process.cwd(),
		agent: config,
		resolvedRun: { ...resolvedRun, agent: "worker" },
		childContext: { ...childContext, agent: "worker" },
		subagentToolsEnabled: false,
		spawnProcess: spawnRpcFake,
	});
	t.after(() => agent.close());

	await agent.start("slow", undefined, "slow", true);
	await assert.rejects(agent.wait(10), /Timed out waiting/);
	assert.equal(agent.summary().status, "running");
	const waiter = new AbortController();
	const waiting = agent.wait(undefined, waiter.signal);
	waiter.abort();
	await assert.rejects(waiting, /Waiting for agent .* was aborted/);
	assert.equal(agent.summary().status, "running");
	await agent.interrupt();
	await agent.wait(1_000);
});

test("cancelling a foreground waiter does not automatically interrupt its child", async (t) => {
	const config: AgentConfig = {
		name: "general",
		description: "test",
		systemPrompt: "",
		filePath: "general.md",
	};
	const agent = new ManagedAgent({
		defaultCwd: process.cwd(),
		agent: config,
		resolvedRun,
		childContext,
		subagentToolsEnabled: false,
		spawnProcess: spawnRpcFake,
	});
	t.after(() => agent.close());
	const waiter = new AbortController();
	const running = agent.start("slow", undefined, "slow", false, waiter.signal);
	setTimeout(() => waiter.abort(), 10);
	await assert.rejects(running, /Waiting for agent .* was aborted/);
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(agent.summary().status, "running");
	await agent.interrupt();
	await agent.wait(1_000);
});

test("AgentRegistry publishes lifecycle changes and immutable views", async (t) => {
	const config: AgentConfig = {
		name: "scout",
		description: "test",
		systemPrompt: "",
		filePath: "scout.md",
	};
	const agent = new ManagedAgent({
		defaultCwd: process.cwd(),
		agent: config,
		resolvedRun: { ...resolvedRun, agent: "scout", profile: "fast", effectiveThinking: "low" },
		childContext: { ...childContext, agent: "scout", profile: "fast" },
		subagentToolsEnabled: false,
		spawnProcess: spawnRpcFake,
	});
	const registry = new AgentRegistry();
	let updates = 0;
	const unsubscribe = registry.subscribe(() => updates++);
	t.after(async () => {
		unsubscribe();
		await registry.closeAll();
	});

	registry.add(agent);
	await agent.start("inspect", undefined, "inspect registry", false);
	const view = registry.views()[0];
	assert.equal(view?.summary.status, "idle");
	assert.equal(view?.details.contextWindow, 128_000);
	assert.ok(updates >= 3);

	assert.ok(view);
	const exposedTools: unknown = view.details.recentTools;
	assert.ok(Array.isArray(exposedTools));
	exposedTools.push({ name: "fake", argsPreview: "mutation" });
	assert.equal(
		registry.views()[0]?.details.recentTools.some((tool) => tool.name === "fake"),
		false,
	);
});

test("ManagedAgent cleans temporary prompts after startup failure", async () => {
	const before = new Set((await fs.promises.readdir(os.tmpdir())).filter((name) => name.startsWith("subagent-")));
	const config: AgentConfig = {
		name: "cleanup-test",
		description: "test",
		systemPrompt: "temporary prompt",
		filePath: "cleanup-test.md",
	};
	const agent = new ManagedAgent({
		defaultCwd: path.join(os.tmpdir(), `missing-subagent-cwd-${Date.now()}`),
		agent: config,
		resolvedRun: { ...resolvedRun, agent: config.name },
		childContext: { ...childContext, agent: config.name },
		subagentToolsEnabled: false,
	});

	await assert.rejects(agent.start("fail", undefined, "failed startup", false), /Could not start|ENOENT/);
	assert.equal(agent.isAvailable(), false);
	const after = (await fs.promises.readdir(os.tmpdir())).filter(
		(name) => name.startsWith("subagent-") && !before.has(name),
	);
	assert.deepEqual(after, []);
});
