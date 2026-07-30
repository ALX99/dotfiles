import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ManagedAgent } from "../managed-agent.ts";
import type { ProfilesConfig } from "../profiles.ts";
import { spawnRpcProcess, type SpawnRpcProcess } from "../rpc-transport.ts";
import { createFollowupAgentTool } from "../tools/followup-agent.ts";
import { createSpawnAgentTool } from "../tools/spawn-agent.ts";
import { createWaitAgentTool } from "../tools/wait-agent.ts";

const agentConfig = {
	name: "worker",
	description: "test",
	systemPrompt: "",
	filePath: "worker.md",
};

const profiles: ProfilesConfig = {
	rootPolicy: { maxConcurrentRootAgents: 4, maxConcurrentDeepAgents: 1 },
	profiles: {
		fast: {
			description: "test",
			countsTowardDeepAgentCap: false,
			modelPriority: [{ id: "provider/model", defaultThinking: "low", maxThinking: "low" }],
		},
	},
	agentPolicies: { worker: { defaultProfile: "fast", allowedProfiles: ["fast"] } },
};

const model: Model<Api> = {
	id: "model",
	name: "model",
	provider: "provider",
	api: "openai-responses",
	baseUrl: "https://example.test",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 16_000,
};

const rpcScript = String.raw`
let buffer = '';
let generation = 0;
let entries = [];
let leafId = null;
process.stdin.setEncoding('utf8');
function send(value) { process.stdout.write(JSON.stringify(value) + '\n'); }
process.stdin.on('data', chunk => {
  buffer += chunk;
  while (buffer.includes('\n')) {
    const index = buffer.indexOf('\n');
    const command = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
    const data = command.type === 'get_state' ? { sessionId: 'tool-usage', sessionFile: '/tmp/tool-usage.jsonl' }
      : command.type === 'get_entries' ? { entries: entries.slice(command.since ? entries.findIndex(entry => entry.id === command.since) + 1 : 0), leafId }
      : undefined;
    send({ type: 'response', id: command.id, success: true, data });
    if (command.type !== 'prompt') continue;
    const run = ++generation;
    send({ type: 'agent_start' });
    setTimeout(() => {
      const message = {
          role: 'assistant',
          content: [{ type: 'text', text: 'done:' + run }],
          stopReason: 'stop',
          usage: {
            input: run * 10,
            output: 5,
            reasoning: 3,
            cacheRead: 2,
            cacheWrite: 1,
            totalTokens: run * 10 + 8,
            cost: { total: run / 4 }
          }
        };
      const id = 'usage-' + run;
      entries.push({ type: 'message', id, parentId: leafId, timestamp: new Date().toISOString(), message }); leafId = id;
      send({ type: 'message_end', message });
      send({ type: 'agent_settled' });
    }, 25);
  }
});
`;

function spawnProcess(): SpawnRpcProcess {
	return (_command, _args, options) => spawnRpcProcess(process.execPath, ["-e", rpcScript], options);
}

function fixture(t: { after(callback: () => void | Promise<void>): void }) {
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-tool-usage-"));
	const agents = new Map<string, ManagedAgent>();
	t.after(async () => {
		await Promise.all([...agents.values()].map((agent) => agent.close()));
		await fs.promises.rm(agentDir, { recursive: true, force: true });
	});
	let activeTools = ["spawn_agent"];
	const accounted = new Set<string>();
	const pi = {
		getActiveTools: () => activeTools,
		setActiveTools: (tools: string[]) => {
			activeTools = tools;
		},
	};
	const runtime = {
		agents: [agentConfig],
		profiles,
		agentDir,
		registry: {
			add: async (agent: ManagedAgent) => {
				agents.set(agent.id, agent);
			},
			getLive: (id: string) => {
				const agent = agents.get(id);
				if (!agent) throw new Error(`Unknown agent '${id}'.`);
				return agent;
			},
			wait: (id: string, timeout?: number, signal?: AbortSignal) => {
				const agent = agents.get(id);
				if (!agent) throw new Error(`Unknown agent '${id}'.`);
				return agent.wait(timeout, signal);
			},
			summary: (id: string) => {
				const agent = agents.get(id);
				if (!agent) throw new Error(`Unknown agent '${id}'.`);
				return agent.summary();
			},
		},
		admission: { admit: () => ({ agent: "worker", profile: "fast" }) },
		handleBackgroundComplete: () => {},
		handleQuestion: () => {},
		consumeSettledCompletions: () => {},
		claimUsage: (summary: {
			agent_id: string;
			generation: number;
			status: string;
			usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; turns: number };
		}) => {
			if (summary.status === "starting" || summary.status === "running") return undefined;
			const key = `${summary.agent_id}:${summary.generation}`;
			if (accounted.has(key)) return undefined;
			accounted.add(key);
			return summary.usage;
		},
	};
	const context = {
		cwd: process.cwd(),
		modelRegistry: { getAvailable: () => [model] },
		scopedModels: [],
		sessionManager: { getSessionId: () => "parent-session" },
	};
	return { pi, runtime, context, activeTools: () => activeTools };
}

test("foreground spawn and follow-up report each completed generation's nested usage", async (t) => {
	const { pi, runtime, context } = fixture(t);
	const spawn = createSpawnAgentTool(pi as never, runtime as never, {
		spawnProcess: spawnProcess(),
		validateSessionIdentity: async (identity) => identity,
	});
	const started = await spawn.execute(
		"spawn-1",
		{ agent: "worker", message: "first", retain: true },
		undefined,
		undefined,
		context as never,
	);
	assert.deepEqual(started.usage, {
		input: 10,
		output: 5,
		reasoning: 3,
		cacheRead: 2,
		cacheWrite: 1,
		totalTokens: 18,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25 },
	});

	const followup = createFollowupAgentTool(pi as never, runtime as never);
	const followed = await followup.execute(
		"followup-1",
		{ agent_id: started.details.agentId!, message: "second" },
		undefined,
		undefined,
		{} as never,
	);
	assert.deepEqual(followed.usage, {
		input: 20,
		output: 5,
		reasoning: 3,
		cacheRead: 2,
		cacheWrite: 1,
		totalTokens: 28,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 },
	});
});

test("background spawn and follow-up return no usage at launch", async (t) => {
	const { pi, runtime, context } = fixture(t);
	const spawn = createSpawnAgentTool(pi as never, runtime as never, {
		spawnProcess: spawnProcess(),
		validateSessionIdentity: async (identity) => identity,
	});
	const launched = await spawn.execute(
		"spawn-1",
		{ agent: "worker", message: "background", background: true },
		undefined,
		undefined,
		context as never,
	);
	assert.equal(launched.usage, undefined);
	assert.equal(Object.hasOwn(launched, "usage"), false);

	const retained = await spawn.execute(
		"spawn-2",
		{ agent: "worker", message: "retained", retain: true },
		undefined,
		undefined,
		context as never,
	);
	const followup = createFollowupAgentTool(pi as never, runtime as never);
	const followed = await followup.execute(
		"followup-1",
		{ agent_id: retained.details.agentId!, message: "background follow-up", background: true },
		undefined,
		undefined,
		{} as never,
	);
	assert.equal(followed.usage, undefined);
	assert.equal(Object.hasOwn(followed, "usage"), false);
});

test("cancelled foreground spawn activates controls for the child left running", async (t) => {
	const { pi, runtime, context, activeTools } = fixture(t);
	const spawn = createSpawnAgentTool(pi as never, runtime as never, {
		spawnProcess: spawnProcess(),
		validateSessionIdentity: async (identity) => identity,
	});
	const controller = new AbortController();
	controller.abort(new Error("cancelled by parent"));
	await assert.rejects(
		spawn.execute(
			"spawn-1",
			{ agent: "worker", message: "keep running" },
			controller.signal,
			undefined,
			context as never,
		),
		/was aborted/,
	);
	assert.deepEqual(activeTools(), [
		"spawn_agent",
		"wait_agent",
		"list_agents",
		"interrupt_agent",
		"close_agent",
		"send_agent",
	]);
});

test("the first background wait reports usage and repeated waits do not double count it", async (t) => {
	const { pi, runtime, context } = fixture(t);
	const spawn = createSpawnAgentTool(pi as never, runtime as never, {
		spawnProcess: spawnProcess(),
		validateSessionIdentity: async (identity) => identity,
	});
	const launched = await spawn.execute(
		"spawn-1",
		{ agent: "worker", message: "background", background: true },
		undefined,
		undefined,
		context as never,
	);
	const wait = createWaitAgentTool(pi as never, runtime as never);
	const first = await wait.execute(
		"wait-1",
		{ agent_ids: [launched.details.agentId!], timeout_ms: 1_000 },
		undefined,
		undefined,
		{} as never,
	);
	assert.equal(first.usage?.totalTokens, 18);
	assert.deepEqual(first.details.accountedGenerations, [
		{ agentId: launched.details.agentId, generation: launched.details.generation },
	]);
	const repeated = await wait.execute(
		"wait-2",
		{ agent_ids: [launched.details.agentId!], timeout_ms: 1_000 },
		undefined,
		undefined,
		{} as never,
	);
	assert.equal(repeated.usage, undefined);
	assert.equal(repeated.details.accountedGenerations, undefined);
});
