import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import type { AgentConfig } from "../agents.ts";
import { AgentRegistry } from "../agent-registry.ts";
import {
	childEnvironment,
	MAX_DIRECT_RPC_PROMPT_BYTES,
	ManagedAgent as ProductionManagedAgent,
	type ManagedAgentOptions,
} from "../managed-agent.ts";
import type { RpcEvent } from "../protocol.ts";
import { RpcTransport, spawnRpcProcess, type SpawnRpcProcess } from "../rpc-transport.ts";

const testAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-rpc-test-"));
after(() => fs.rmSync(testAgentDir, { recursive: true, force: true }));

class ManagedAgent extends ProductionManagedAgent {
	constructor(options: Omit<ManagedAgentOptions, "agentDir">) {
		super({ ...options, agentDir: testAgentDir, validateSessionIdentity: async (identity) => identity });
	}
}

const rpcScript = String.raw`
const fs = require('node:fs');
const path = require('node:path');
let buffer = '';
let entries = [];
let leafId = null;
let nextEntry = 1;
process.stdin.setEncoding('utf8');
function send(value) { process.stdout.write(JSON.stringify(value) + '\n'); }
function append(message) {
  const entry = { type: 'message', id: 'entry-' + nextEntry++, parentId: leafId, timestamp: new Date().toISOString(), message };
  entries.push(entry); leafId = entry.id;
}
function expand(value) { return value; }
function complete(text) {
  send({ type: 'agent_start' });
  const failed = text === 'done:assistant-error';
  const message = { role: 'assistant', content: failed ? [] : [{ type: 'text', text }], usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 }, totalTokens: 3 }, stopReason: failed ? 'error' : 'stop', errorMessage: failed ? 'provider exploded' : undefined };
  append(message);
  send({ type: 'message_end', message });
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
      : command.type === 'get_state' ? { sessionId: 'subagent-session', sessionFile: '/tmp/subagent-session.jsonl' }
      : command.type === 'get_entries' ? { entries: entries.slice(command.since ? entries.findIndex(entry => entry.id === command.since) + 1 : 0), leafId }
      : undefined;
    send({ type: 'response', id: command.id, command: command.type, success: true, data });
    if (command.type === 'prompt') complete('done:' + expand(command.message));
    if (command.type === 'follow_up') complete('follow:' + expand(command.message));
    if (command.type === 'abort') setTimeout(() => send({ type: 'agent_settled' }), 1);
  }
});
send({ type: 'unicode_event', text: 'left\u2028right' });
send({ type: 'extension_ui_request', id: 'ui-1', method: 'confirm', title: 'Question', message: 'Continue?' });
`;

const spawnedArgs: string[][] = [];
const spawnedContexts: unknown[] = [];
const spawnRpcFake: SpawnRpcProcess = (_command, args, options) => {
	spawnedArgs.push([...args]);
	spawnedContexts.push(JSON.parse(String(options.env?.PI_SUBAGENT_CONTEXT)));
	return spawnRpcProcess(process.execPath, ["-e", rpcScript], {
		...options,
		env: { ...options.env },
	});
};

const questionRpcScript = String.raw`
const fs = require('node:fs');
const path = require('node:path');
let buffer = '';
let entries = [];
let leafId = null;
process.stdin.setEncoding('utf8');
function send(value) { process.stdout.write(JSON.stringify(value) + '\n'); }
function expand(value) { return value; }
function finish(answer) {
  const message = { role: 'assistant', content: [{ type: 'text', text: 'answer:' + expand(answer) }], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } }, stopReason: 'stop' };
  const entry = { type: 'message', id: 'answer-entry', parentId: leafId, timestamp: new Date().toISOString(), message };
  entries.push(entry); leafId = entry.id;
  send({ type: 'message_end', message });
  send({ type: 'agent_settled' });
}
process.stdin.on('data', chunk => {
  buffer += chunk;
  while (buffer.includes('\n')) {
    const index = buffer.indexOf('\n');
    const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
    if (!line) continue;
    const command = JSON.parse(line);
    if (command.type === 'extension_ui_response') {
      if (command.id === 'question-1' && command.value === 'Something else') {
        send({ type: 'extension_ui_request', id: 'custom-1', method: 'input', title: 'Something else', placeholder: 'Type your answer...' });
      } else {
        finish(command.value ?? 'cancelled');
      }
      continue;
    }
    const data = command.type === 'get_state' ? { sessionId: 'subagent-question', sessionFile: '/tmp/subagent-question.jsonl' }
      : command.type === 'get_entries' ? { entries: entries.slice(command.since ? entries.findIndex(entry => entry.id === command.since) + 1 : 0), leafId }
      : undefined;
    send({ type: 'response', id: command.id, command: command.type, success: true, data });
    if (command.type === 'prompt') {
      send({ type: 'agent_start' });
      setTimeout(() => {
        send({
          type: 'extension_ui_request',
          id: 'question-1',
          method: 'select',
          title: 'Which implementation?',
          options: ['Simple', 'Flexible', 'Compare options', 'Something else']
        });
      }, 5);
    }
  }
});
`;

const spawnQuestionRpcFake: SpawnRpcProcess = (_command, _args, options) =>
	spawnRpcProcess(process.execPath, ["-e", questionRpcScript], {
		...options,
		env: { ...options.env },
	});

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
	agent: "general",
	profile: "balanced",
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

test("ManagedAgent IDs include the agent name and remain sequential", () => {
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
		retain: true,
	});
	const second = new ManagedAgent({
		defaultCwd: process.cwd(),
		agent: config,
		resolvedRun,
		childContext,
		retain: true,
	});

	assert.match(first.id, /^general-\d+$/);
	assert.equal(second.id, `general-${Number(first.id.slice("general-".length)) + 1}`);
});

test("ManagedAgent passes an explicit scout allowlist and no shell capability", async (t) => {
	const agent = new ManagedAgent({
		defaultCwd: process.cwd(),
		agent: {
			name: "scout",
			description: "test",
			tools: ["read", "find", "grep", "ask_question"],
			systemPrompt: "",
			filePath: "scout.md",
		},
		resolvedRun: { ...resolvedRun, agent: "scout", profile: "fast", effectiveThinking: "low" },
		childContext: { ...childContext, agent: "scout", profile: "fast" },
		retain: true,
		spawnProcess: spawnRpcFake,
	});
	t.after(() => agent.close());

	spawnedArgs.length = 0;
	await agent.start("inspect", undefined, "inspect", false);
	const invocation = spawnedArgs[0] ?? [];
	assert.equal(invocation[invocation.indexOf("--tools") + 1], "read,find,grep,ask_question");
	assert.equal(invocation.includes("--exclude-tools"), false);
	assert.equal(invocation.includes("bash"), false);
});

test("ManagedAgent passes role-provided custom tool names to the child", async (t) => {
	for (const name of ["general", "worker", "scout"] as const) {
		const tools = ["read", "bash", "edit", "write", "grep", "find", "ls"];
		if (name !== "scout") tools.splice(4, 0, "apply_patch");
		const agent = new ManagedAgent({
			defaultCwd: process.cwd(),
			agent: {
				name,
				description: "test",
				tools,
				systemPrompt: "",
				filePath: `${name}.md`,
			},
			resolvedRun: { ...resolvedRun, agent: name },
			childContext: { ...childContext, agent: name },
			retain: true,
			spawnProcess: spawnRpcFake,
		});
		t.after(() => agent.close());

		spawnedArgs.length = 0;
		await agent.start("implement", undefined, "implement", false);
		const invocation = spawnedArgs[0] ?? [];
		assert.equal(invocation[invocation.indexOf("--tools") + 1], tools.join(","));
	}
});

test("children are leaves and receive only their role tools", async (t) => {
	const agent = new ManagedAgent({
		defaultCwd: process.cwd(),
		agent: {
			name: "general",
			description: "test",
			tools: ["read", "ask_question"],
			systemPrompt: "",
			filePath: "general.md",
		},
		resolvedRun,
		childContext,
		retain: true,
		spawnProcess: spawnRpcFake,
	});
	t.after(() => agent.close());

	spawnedArgs.length = 0;
	await agent.start("delegate", undefined, "delegate", false);
	const invocation = spawnedArgs[0] ?? [];
	const tools = (invocation[invocation.indexOf("--tools") + 1] ?? "").split(",");
	assert.equal(tools.includes("ask_question"), true);
	assert.equal(tools.includes("submit_agent_result"), false);
	assert.equal(tools.includes("answer_agent"), false);
	assert.equal(tools.includes("spawn_agent"), false);
});

test("scouts inherit provider configuration but not SSH or GPG agent sockets", () => {
	const source = {
		OPENAI_API_KEY: "provider-credential",
		SSH_AUTH_SOCK: "/tmp/ssh.sock",
		SSH_AGENT_PID: "123",
		GPG_AGENT_INFO: "/tmp/gpg.sock:123:1",
		TERM: "xterm-256color",
	};
	const scout = childEnvironment({ ...childContext, agent: "scout" }, source);
	const general = childEnvironment(childContext, source);

	assert.equal(scout.OPENAI_API_KEY, "provider-credential");
	assert.equal(scout.TERM, "xterm-256color");
	assert.equal(scout.SSH_AUTH_SOCK, undefined);
	assert.equal(scout.SSH_AGENT_PID, undefined);
	assert.equal(scout.GPG_AGENT_INFO, undefined);
	assert.equal(general.SSH_AUTH_SOCK, "/tmp/ssh.sock");
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
		retain: true,
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
	assert.equal(invocation.includes("--exclude-tools"), false);
	assert.equal(invocation.includes("--tools"), false);
	assert.equal(invocation.includes("--no-tools"), true);
	assert.deepEqual(spawnedContexts, [{ ...childContext, agentId: id }]);
	assert.equal(first.sessionFile, "/tmp/subagent-session.jsonl");
	assert.equal(first.finalText, "done:Task: first");
	assert.equal(agent.summary().agent_id, id);
	assert.equal(agent.summary().generation, 1);
	assert.equal(agent.summary().retained, true);
	assert.equal(agent.summary().status, "idle");
	assert.equal(agent.summary().final_text, "done:Task: first");
	assert.equal(agent.summary().result?.source, "assistant");
	assert.deepEqual(agent.summary().result_locator?.start, { appendCursor: null, leafId: null });

	const second = await agent.followUp("second", "second task", false);
	assert.equal(agent.id, id);
	assert.equal(spawnedArgs.length, 1, "follow-ups must reuse the same configured child process");
	assert.equal(second.finalText, "done:second");
	assert.equal(agent.summary().generation, 2);
	assert.equal(agent.summary().result_locator?.start.appendCursor, "entry-1");
	await assert.rejects(agent.getMessages(), /managed subagent session directory|Child session/);

	const launched = await agent.followUp("third", "third task", true);
	assert.equal(launched.status, "launched");
	await agent.wait(1_000);
	assert.deepEqual(completions, ["done:third"]);

	await agent.followUp("slow", "slow task", true);
	await agent.interrupt();
	const interrupted = await agent.wait(1_000);
	assert.equal(interrupted.status, "aborted");
	assert.equal(interrupted.aborted, true);
	assert.equal(interrupted.generation, 4);
	assert.deepEqual(completions, ["done:third"], "interrupted background runs must not report completion");
	const afterAbort = await agent.followUp("after abort", "recovery task", false);
	assert.equal(afterAbort.finalText, "done:after abort");
	assert.equal(agent.summary().generation, 5);

	await assert.rejects(agent.followUp("assistant-error", "failing task", false), /provider exploded/);
	assert.equal(agent.summary().agent_id, id);
	assert.equal(agent.summary().generation, 6);
	assert.equal(agent.summary().status, "failed");
	assert.match(agent.summary().error ?? "", /^provider exploded/);
	assert.equal(agent.summary().failure?.kind, "provider_failure");

	await agent.followUp("slow", "close task", true);
	await agent.close();
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(completions, ["done:third"], "closed background runs must not report failure completion");
	assert.equal(agent.summary().status, "closed");
});

test("queued follow-up prompts stay in one logical generation", async (t) => {
	const script = String.raw`
let buffer = '';
let prompts = 0;
let entries = [];
let leafId = null;
function send(value) { process.stdout.write(JSON.stringify(value) + '\n'); }
function append(text) {
  const message = {role:'assistant', content:[{type:'text', text}], stopReason:'stop'};
  const id = 'queued-' + prompts;
  entries.push({type:'message', id, parentId:leafId, timestamp:new Date().toISOString(), message}); leafId = id;
  send({type:'message_end', message});
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  while (buffer.includes('\n')) {
    const index = buffer.indexOf('\n');
    const command = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
    const data = command.type === 'get_state' ? {sessionId:'queued', sessionFile:'/tmp/queued.jsonl'}
      : command.type === 'get_entries' ? {entries:entries.slice(command.since ? entries.findIndex(entry => entry.id === command.since) + 1 : 0), leafId}
      : undefined;
    send({type:'response', id:command.id, success:true, data});
    if (command.type !== 'prompt') continue;
    prompts++;
    if (prompts === 1) {
      send({type:'agent_start'});
      append('first turn');
    } else {
      append('queued:' + command.message);
      send({type:'agent_settled'});
    }
  }
});
`;
	const managed = new ManagedAgent({
		defaultCwd: process.cwd(),
		agent: { name: "general", description: "test", systemPrompt: "", filePath: "general.md" },
		resolvedRun,
		childContext,
		retain: true,
		spawnProcess: (_command, _args, options) => spawnRpcProcess(process.execPath, ["-e", script], options),
	});
	t.after(() => managed.close());

	await managed.start("first", undefined, "first", true);
	for (let attempt = 0; managed.summary().status !== "running" && attempt < 100; attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	const queued = await managed.followUp("second", "second", true);
	assert.equal(queued.generation, 1);
	const settled = await managed.wait(1_000);
	assert.equal(settled.generation, 1);
	assert.equal(settled.finalText, "queued:second");
	assert.equal(managed.summary().result_locator?.start.appendCursor, null);
});

test("direct RPC context accepts bounded large Unicode text without an artifact marker", async (t) => {
	const directConfig: AgentConfig = {
		name: "general",
		description: "test",
		systemPrompt: "",
		filePath: "general.md",
	};
	const agent = new ManagedAgent({
		id: "unicode-direct",
		defaultCwd: process.cwd(),
		agent: directConfig,
		resolvedRun,
		childContext,
		retain: false,
		spawnProcess: spawnRpcFake,
	});
	t.after(() => agent.close());
	const message = "🙂界".repeat(60_000);
	assert.ok(Buffer.byteLength(message, "utf8") < MAX_DIRECT_RPC_PROMPT_BYTES);
	const settled = await agent.start(message, undefined, "unicode", false);
	assert.equal(settled.status, "idle");
	const expected = `done:Task: ${message}`;
	assert.equal(settled.finalText, expected);
	assert.equal(settled.result?.total_bytes, Buffer.byteLength(expected, "utf8"));
	const oversized = new ManagedAgent({
		id: "unicode-too-large",
		defaultCwd: process.cwd(),
		agent: directConfig,
		resolvedRun,
		childContext,
		retain: false,
		spawnProcess: spawnRpcFake,
	});
	t.after(() => oversized.close());
	await assert.rejects(
		oversized.start("x".repeat(MAX_DIRECT_RPC_PROMPT_BYTES + 1), undefined, "too large", false),
		/direct prompt limit/,
	);
});

test("steer and queued follow-up retain one generation checkpoint range", async (t) => {
	const script = String.raw`
let buffer = '', leafId = null, count = 0, entries = [];
process.stdin.setEncoding('utf8');
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
process.stdin.on('data', chunk => {
  buffer += chunk;
  while (buffer.includes('\n')) {
    const index = buffer.indexOf('\n'), command = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
    const data = command.type === 'get_state' ? { sessionId: 'same-generation', sessionFile: '/tmp/same-generation.jsonl' }
      : command.type === 'get_entries' ? { entries: entries.slice(command.since ? entries.findIndex(entry => entry.id === command.since) + 1 : 0), leafId }
      : undefined;
    send({ type: 'response', id: command.id, success: true, data });
    if (command.type !== 'prompt') continue;
    count++;
    if (count === 1) send({ type: 'agent_start' });
    if (count !== 3) continue;
    const message = { role: 'assistant', content: [{ type: 'text', text: 'settled once' }], stopReason: 'stop',
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } } };
    const entry = { type: 'message', id: 'same-result', parentId: leafId, timestamp: new Date().toISOString(), message };
    entries.push(entry); leafId = entry.id;
    send({ type: 'message_end', message }); send({ type: 'agent_settled' });
  }
});`;
	const agent = new ManagedAgent({
		id: "same-generation",
		defaultCwd: process.cwd(),
		agent: { name: "general", description: "test", systemPrompt: "", filePath: "general.md" },
		resolvedRun,
		childContext,
		retain: true,
		spawnProcess: (_command, _args, options) =>
			spawnRpcProcess(process.execPath, ["-e", script], { ...options, env: { ...options.env } }),
	});
	t.after(() => agent.close());
	await agent.start("initial", undefined, "initial", true);
	await agent.steer("steer");
	const settled = await agent.followUp("queued", "queued", false);
	assert.equal(settled.generation, 1);
	assert.deepEqual(agent.summary().result_locator?.start, { appendCursor: null, leafId: null });
});

test("ManagedAgent retries a settled assistant error with the next model candidate", async (t) => {
	const fallbackScript = String.raw`
let buffer = '';
const model = process.env.TEST_MODEL;
let entries = [];
let leafId = null;
process.stdin.setEncoding('utf8');
function send(value) { process.stdout.write(JSON.stringify(value) + '\n'); }
process.stdin.on('data', chunk => {
  buffer += chunk;
  while (buffer.includes('\n')) {
    const index = buffer.indexOf('\n');
    const command = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
    const data = command.type === 'get_state' ? { sessionId: 'subagent-fallback', sessionFile: '/tmp/subagent-fallback.jsonl' }
      : command.type === 'get_entries' ? { entries: entries.slice(command.since ? entries.findIndex(entry => entry.id === command.since) + 1 : 0), leafId }
      : undefined;
    send({ type: 'response', id: command.id, command: command.type, success: true, data });
    if (command.type !== 'prompt') continue;
    send({ type: 'agent_start' });
    if (model === 'provider/primary') {
      const message = { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'primary failed' };
      entries.push({ type: 'message', id: 'primary-entry', parentId: null, timestamp: new Date().toISOString(), message }); leafId = 'primary-entry';
      send({ type: 'message_end', message });
    } else {
      const message = { role: 'assistant', content: [{ type: 'text', text: 'fallback succeeded' }], stopReason: 'stop' };
      entries.push({ type: 'message', id: 'fallback-entry', parentId: null, timestamp: new Date().toISOString(), message }); leafId = 'fallback-entry';
      send({ type: 'message_end', message });
    }
    send({ type: 'agent_settled' });
  }
});
`;
	let spawnCount = 0;
	const fallbackArgs: string[][] = [];
	const completions: string[] = [];
	const managed = new ManagedAgent({
		defaultCwd: process.cwd(),
		agent: {
			name: "general",
			description: "test",
			systemPrompt: "",
			filePath: "general.md",
		},
		resolvedRun: {
			...resolvedRun,
			model: "provider/primary",
		},
		fallbackRuns: [
			{
				...resolvedRun,
				model: "provider/fallback",
				effectiveThinking: "high",
				contextWindow: 64_000,
			},
		],
		childContext,
		retain: true,
		spawnProcess: (_command, args, options) => {
			spawnCount++;
			fallbackArgs.push([...args]);
			const modelIndex = args.indexOf("--model");
			const selectedModel = args[modelIndex + 1];
			assert.ok(selectedModel);
			return spawnRpcProcess(process.execPath, ["-e", fallbackScript], {
				...options,
				env: { ...options.env, TEST_MODEL: selectedModel },
			});
		},
		onBackgroundComplete: (summary) => completions.push(summary.final_text ?? summary.error ?? ""),
	});
	t.after(() => managed.close());

	const launched = await managed.start("work", undefined, "fallback task", true);
	assert.equal(launched.status, "launched");
	const result = await managed.wait(1_000);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(result.finalText, "fallback succeeded");
	assert.equal(result.model, "provider/fallback");
	assert.equal(result.effectiveThinking, "high");
	assert.equal(result.contextWindow, 64_000);
	assert.equal(result.generation, 1);
	assert.equal(spawnCount, 2);
	assert.equal(fallbackArgs[1]?.includes("--session"), true, "model fallback should resume the persistent session");
	assert.deepEqual(completions, ["fallback succeeded"]);
	assert.equal(managed.summary().agent_id, managed.id);
	assert.equal(managed.summary().model, "provider/fallback");
	assert.equal(managed.summary().effective_thinking, "high");
	assert.equal(managed.summary().generation, 1);
	assert.equal(managed.summary().status, "idle");
	assert.equal(managed.summary().final_text, "fallback succeeded");
	assert.equal(managed.summary().result?.source, "assistant");
});

test("account quota fallback skips models on the exhausted provider", async (t) => {
	const script = String.raw`
let buffer = '';
const model = process.env.TEST_MODEL;
let entries = [];
let leafId = null;
process.stdin.setEncoding('utf8');
function send(value) { process.stdout.write(JSON.stringify(value) + '\n'); }
process.stdin.on('data', chunk => {
  buffer += chunk;
  while (buffer.includes('\n')) {
    const index = buffer.indexOf('\n');
    const command = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
    const data = command.type === 'get_state' ? { sessionId: 'quota-fallback', sessionFile: '/tmp/quota-fallback.jsonl' }
      : command.type === 'get_entries' ? { entries: entries.slice(command.since ? entries.findIndex(entry => entry.id === command.since) + 1 : 0), leafId }
      : undefined;
    send({ type: 'response', id: command.id, success: true, data });
    if (command.type !== 'prompt') continue;
    send({ type: 'agent_start' });
    if (model.startsWith('same-provider/')) {
      const message = { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'account quota exhausted' };
      entries.push({ type: 'message', id: 'quota-primary', parentId: null, timestamp: new Date().toISOString(), message }); leafId = 'quota-primary';
      send({ type: 'message_end', message });
    } else {
      const message = { role: 'assistant', content: [{ type: 'text', text: 'other provider succeeded' }], stopReason: 'stop' };
      entries.push({ type: 'message', id: 'quota-recovery', parentId: null, timestamp: new Date().toISOString(), message }); leafId = 'quota-recovery';
      send({ type: 'message_end', message });
    }
    send({ type: 'agent_settled' });
  }
});
`;
	const spawnedModels: string[] = [];
	const managed = new ManagedAgent({
		defaultCwd: process.cwd(),
		agent: { name: "general", description: "test", systemPrompt: "", filePath: "general.md" },
		resolvedRun: { ...resolvedRun, model: "same-provider/primary" },
		fallbackRuns: [
			{ ...resolvedRun, model: "same-provider/secondary" },
			{ ...resolvedRun, model: "other-provider/recovery" },
		],
		childContext,
		retain: true,
		spawnProcess: (_command, args, options) => {
			const model = args[args.indexOf("--model") + 1]!;
			spawnedModels.push(model);
			return spawnRpcProcess(process.execPath, ["-e", script], {
				...options,
				env: { ...options.env, TEST_MODEL: model },
			});
		},
	});
	t.after(() => managed.close());
	const result = await managed.start("work", undefined, "quota", false);
	assert.equal(result.finalText, "other provider succeeded");
	assert.deepEqual(spawnedModels, ["same-provider/primary", "other-provider/recovery"]);
});

test("mutating workers report recoverable failure instead of replaying on fallback", async (t) => {
	const script = String.raw`
let buffer = '';
let entries = [];
let leafId = null;
process.stdin.setEncoding('utf8');
function send(value) { process.stdout.write(JSON.stringify(value) + '\n'); }
process.stdin.on('data', chunk => {
  buffer += chunk;
  while (buffer.includes('\n')) {
    const index = buffer.indexOf('\n');
    const command = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
    const data = command.type === 'get_state' ? { sessionId: 'mutating-worker', sessionFile: '/tmp/mutating-worker.jsonl' }
      : command.type === 'get_entries' ? { entries: entries.slice(command.since ? entries.findIndex(entry => entry.id === command.since) + 1 : 0), leafId }
      : undefined;
    send({ type: 'response', id: command.id, success: true, data });
    if (command.type !== 'prompt') continue;
    send({ type: 'agent_start' });
    send({ type: 'tool_execution_end', toolCallId: 'edit-1', toolName: 'edit', result: {}, isError: false });
    entries.push({ type: 'message', id: 'edit-result', parentId: null, timestamp: new Date().toISOString(), message: { role: 'toolResult', toolCallId: 'edit-1', toolName: 'edit', content: [], isError: false, timestamp: 0 } }); leafId = 'edit-result';
    const message = { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'provider failed after edit' };
    entries.push({ type: 'message', id: 'mutation-error', parentId: leafId, timestamp: new Date().toISOString(), message }); leafId = 'mutation-error';
    send({ type: 'message_end', message });
    send({ type: 'agent_settled' });
  }
});
`;
	let spawnCount = 0;
	const managed = new ManagedAgent({
		defaultCwd: process.cwd(),
		agent: { name: "worker", description: "test", systemPrompt: "", filePath: "worker.md" },
		resolvedRun: { ...resolvedRun, agent: "worker", model: "provider/primary" },
		fallbackRuns: [{ ...resolvedRun, agent: "worker", model: "other/recovery" }],
		childContext: { agent: "worker", profile: "balanced" },
		retain: true,
		spawnProcess: (_command, _args, options) => {
			spawnCount++;
			return spawnRpcProcess(process.execPath, ["-e", script], options);
		},
	});
	t.after(() => managed.close());
	await assert.rejects(
		managed.start("mutate", undefined, "mutate", false),
		/Automatic model fallback was not attempted/,
	);
	assert.equal(spawnCount, 1);
	assert.deepEqual(managed.summary().failure, { kind: "mutation_replay_blocked", recoverable: true });
	assert.equal(managed.summary().session_file, "/tmp/mutating-worker.jsonl");
	assert.ok(managed.summary().result);
});

test("interrupting a model fallback handover aborts without releasing capacity", async (t) => {
	const script = String.raw`
let buffer = '';
let entries = [];
let leafId = null;
process.stdin.setEncoding('utf8');
function send(value) { process.stdout.write(JSON.stringify(value) + '\n'); }
process.stdin.on('data', chunk => {
  buffer += chunk;
  while (buffer.includes('\n')) {
    const index = buffer.indexOf('\n');
    const command = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
    const data = command.type === 'get_state' ? { sessionId: 'subagent-interrupted-fallback', sessionFile: '/tmp/subagent-interrupted-fallback.jsonl' }
      : command.type === 'get_entries' ? { entries: entries.slice(command.since ? entries.findIndex(entry => entry.id === command.since) + 1 : 0), leafId }
      : undefined;
    send({ type: 'response', id: command.id, command: command.type, success: true, data });
    if (command.type === 'prompt') {
      send({ type: 'agent_start' });
      const message = { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'primary failed' };
      entries.push({ type: 'message', id: 'interrupted-primary', parentId: null, timestamp: new Date().toISOString(), message }); leafId = 'interrupted-primary';
      send({ type: 'message_end', message });
      setTimeout(() => send({ type: 'agent_settled' }), 10);
    }
  }
});
`;
	let spawnCount = 0;
	const managed = new ManagedAgent({
		defaultCwd: process.cwd(),
		agent: {
			name: "general",
			description: "test",
			systemPrompt: "",
			filePath: "general.md",
		},
		resolvedRun: { ...resolvedRun, model: "provider/primary" },
		fallbackRuns: [{ ...resolvedRun, model: "provider/fallback" }],
		childContext,
		retain: true,
		spawnProcess: (_command, _args, options) => {
			spawnCount++;
			return spawnRpcProcess(process.execPath, ["-e", script], options);
		},
	});
	let releaseClose: (() => void) | undefined;
	const closeGate = new Promise<void>((resolve) => {
		releaseClose = resolve;
	});
	t.after(async () => {
		releaseClose?.();
		await managed.close();
	});

	await managed.start("work", undefined, "interrupt fallback", true);
	const internal = managed as unknown as {
		transport: { close(): Promise<void> } | undefined;
		replacingTransport: boolean;
	};
	const transport = internal.transport;
	assert.ok(transport);
	const close = transport.close.bind(transport);
	const { promise: closeStarted, resolve: markCloseStarted } = Promise.withResolvers<void>();
	transport.close = async () => {
		markCloseStarted();
		await closeGate;
		await close();
	};

	await closeStarted;
	assert.equal(internal.replacingTransport, true);
	assert.equal(managed.occupiesCapacity(), true);
	await managed.interrupt();
	assert.equal((await managed.wait(1_000)).status, "aborted");
	releaseClose?.();
	for (let attempt = 0; internal.replacingTransport && attempt < 100; attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.equal(internal.replacingTransport, false);
	assert.equal(spawnCount, 1);
	assert.equal(managed.summary().status, "aborted");
});

test("a foreground child question returns to its parent and resumes after a listed answer", async (t) => {
	const questions: string[] = [];
	const completions: string[] = [];
	const agent = new ManagedAgent({
		defaultCwd: process.cwd(),
		agent: {
			name: "general",
			description: "test",
			tools: ["ask_question"],
			systemPrompt: "",
			filePath: "general.md",
		},
		resolvedRun,
		childContext,
		retain: false,
		spawnProcess: spawnQuestionRpcFake,
		onQuestion: (_summary, question) => questions.push(question.question_id),
		onBackgroundComplete: (completed) => completions.push(completed.final_text ?? ""),
	});
	t.after(() => agent.close());

	const waiting = await agent.start("choose", undefined, "choose", false);
	assert.equal(waiting.pendingQuestion?.question_id, "question-1");
	assert.deepEqual(waiting.pendingQuestion?.options, ["Simple", "Flexible", "Compare options", "Something else"]);
	assert.deepEqual(questions, [], "a foreground tool result carries the question without a duplicate callback");
	assert.equal(agent.summary().pending_question?.question, "Which implementation?");

	await agent.answerQuestion("question-1", "Simple");
	assert.equal(agent.summary().pending_question, undefined);
	const settled = await agent.wait(1_000);
	assert.equal(settled.finalText, "answer:Simple");
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(completions, ["answer:Simple"], "a question-interrupted foreground run is promoted");
	assert.equal(agent.summary().status, "closed");
});

test("a background child question notifies its parent and forwards a custom answer through RPC input", async (t) => {
	const questions: Array<{ id: string; summaryQuestionId: string | undefined }> = [];
	const agent = new ManagedAgent({
		defaultCwd: process.cwd(),
		agent: {
			name: "worker",
			description: "test",
			tools: ["ask_question"],
			systemPrompt: "",
			filePath: "worker.md",
		},
		resolvedRun: { ...resolvedRun, agent: "worker" },
		childContext: { ...childContext, agent: "worker" },
		retain: false,
		spawnProcess: spawnQuestionRpcFake,
		onQuestion: (summary, question) =>
			questions.push({ id: question.question_id, summaryQuestionId: summary.pending_question?.question_id }),
	});
	t.after(() => agent.close());

	const launched = await agent.start("choose", undefined, "choose", true);
	assert.equal(launched.status, "launched");
	for (let attempt = 0; questions.length === 0 && attempt < 100; attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.deepEqual(questions, [{ id: "question-1", summaryQuestionId: "question-1" }]);
	await assert.rejects(agent.answerQuestion("stale-question", "Flexible"), /no pending question/);

	await agent.answerQuestion("question-1", "A custom approach");
	const settled = await agent.wait(1_000);
	assert.equal(settled.finalText, "answer:A custom approach");
	await new Promise((resolve) => setImmediate(resolve));
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
		retain: true,
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
		retain: true,
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
		retain: true,
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
		retain: true,
	});

	await assert.rejects(agent.start("fail", undefined, "failed startup", false), /Could not start|ENOENT/);
	assert.equal(agent.isAvailable(), false);
	const after = (await fs.promises.readdir(os.tmpdir())).filter(
		(name) => name.startsWith("subagent-") && !before.has(name),
	);
	assert.deepEqual(after, []);
});
