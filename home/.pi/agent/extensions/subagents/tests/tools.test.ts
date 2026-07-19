import * as assert from "node:assert/strict";
import { test } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../agents.ts";
import { AgentRegistry } from "../agent-registry.ts";
import { AgentWaitInterruptedError, type AgentSummary } from "../agent-types.ts";
import type { SubagentRuntime } from "../bootstrap.ts";
import type { ChildExecutionContext } from "../child-process.ts";
import type { ProfilesConfig } from "../profiles.ts";
import { spawnRpcProcess, type SpawnRpcProcess } from "../rpc-transport.ts";
import { initRunData, snapshotRunData, type ReadonlyRunDetails } from "../run-state.ts";
import { SpawnAdmissionController } from "../spawn-admission.ts";
import { createSpawnAgentTool, spawnGuidelines } from "../tools/spawn-agent.ts";
import { DEFAULT_WAIT_MS, executeWaitAgent } from "../tools/wait-agent.ts";

const spawnProfiles: ProfilesConfig = {
	rootPolicy: {
		maxConcurrentRootAgents: 1,
		maxConcurrentDeepAgents: 1,
		maxSpawnBudgetPerChild: 1,
	},
	profiles: {
		fast: {
			description: "Fast",
			delegationEnabled: true,
			countsTowardDeepAgentCap: false,
			modelPriority: [{ id: "provider/model", defaultThinking: "low", maxThinking: "low" }],
		},
	},
	agentPolicies: {
		scout: {
			defaultProfile: "fast",
			allowedProfiles: ["fast"],
			delegation: { mode: "leaf" },
		},
		worker: {
			defaultProfile: "fast",
			allowedProfiles: ["fast"],
			delegation: {
				mode: "grant-required",
				maxLifetimeChildSpawns: 1,
				allowedChildAgents: ["scout"],
				allowedChildProfiles: ["fast"],
			},
		},
	},
};

const spawnAgent: AgentConfig = {
	name: "scout",
	description: "Read-only discovery",
	systemPrompt: "",
	filePath: "scout.md",
};

function availableModel(): Model<Api> {
	return {
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
	} as Model<Api>;
}

function fakeSpawner(script: string): SpawnRpcProcess {
	return (_command, _args, options) => spawnRpcProcess(process.execPath, ["-e", script], options);
}

function sequenceSpawner(scripts: readonly string[]): SpawnRpcProcess {
	let index = 0;
	return (_command, _args, options) => {
		const script = scripts[index++];
		assert.ok(script, `unexpected child process ${index}`);
		return spawnRpcProcess(process.execPath, ["-e", script], options);
	};
}

function rpcScript(options: { output?: string; settleDelayMs?: number; invalidState?: boolean } = {}): string {
	const output = JSON.stringify(options.output ?? "done");
	const settleDelayMs = options.settleDelayMs ?? 0;
	return String.raw`
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  while (buffer.includes('\n')) {
    const i = buffer.indexOf('\n');
    const command = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1);
    const data = command.type === 'get_state' ? ${options.invalidState ? "{}" : "{sessionFile:'/tmp/spawn-tool.jsonl'}"} : undefined;
    process.stdout.write(JSON.stringify({type:'response', id:command.id, success:true, data}) + '\n');
    if (command.type === 'prompt') {
      process.stdout.write('{"type":"agent_start"}\n');
      setTimeout(() => {
        process.stdout.write(JSON.stringify({type:'message_end', message:{role:'assistant', content:[{type:'text', text:${output}}]}}) + '\n');
        process.stdout.write('{"type":"agent_settled"}\n');
      }, ${settleDelayMs});
    }
  }
});
`;
}

function spawnRuntime(executionContext?: ChildExecutionContext): {
	runtime: SubagentRuntime;
	registry: AgentRegistry;
	completions: Array<{ pi: ExtensionAPI; summary: AgentSummary }>;
} {
	const registry = new AgentRegistry();
	const completions: Array<{ pi: ExtensionAPI; summary: AgentSummary }> = [];
	const runtime: SubagentRuntime = {
		agents: [spawnAgent],
		profiles: spawnProfiles,
		executionContext,
		registry,
		admission: new SpawnAdmissionController(spawnProfiles, registry, "spawn-tools", executionContext),
		ticks: new Map(),
		shuttingDown: false,
		handleBackgroundComplete(pi, completed) {
			completions.push({ pi, summary: completed });
		},
		consumeSettledCompletions() {},
	};
	return { runtime, registry, completions };
}

function toolContext(): ExtensionContext {
	return {
		cwd: process.cwd(),
		modelRegistry: { getAvailable: () => [availableModel()] },
	} as ExtensionContext;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.fail("condition was not reached");
}

function summary(id: string): AgentSummary {
	return {
		agent_id: id,
		agent: "scout",
		task_name: "inspect",
		profile: "fast",
		model: "provider/model",
		effective_thinking: "low",
		depth: 1,
		generation: 1,
		status: "idle",
	};
}

test("spawn_agent exposes concise delegation guidance without coupling to exact prose", () => {
	const guidelines = spawnGuidelines(
		[spawnAgent],
		[{ name: "fast", description: spawnProfiles.profiles.fast!.description }],
		true,
	);
	assert.ok(guidelines.length >= 2);
	assert.ok(guidelines.some((guideline) => /independent work|parallelism/.test(guideline)));
	assert.ok(guidelines.some((guideline) => /scouts?.*read-only/i.test(guideline)));
	assert.ok(guidelines.some((guideline) => /fast: Fast/.test(guideline)));
	assert.ok(guidelines.some((guideline) => /not every agent.*tree|no tree-wide agent cap/i.test(guideline)));
	assert.ok(guidelines.every((guideline) => guideline.length < 500));
});

test("spawn_agent completes a foreground transaction and leaves the reusable agent registry-owned", async (t) => {
	const pi = {} as ExtensionAPI;
	const { runtime, registry } = spawnRuntime();
	t.after(() => registry.closeAll());
	const tool = createSpawnAgentTool(pi, runtime, { spawnProcess: fakeSpawner(rpcScript({ output: "foreground" })) });

	const result = await tool.execute(
		"foreground-call",
		{ agent: "scout", message: "inspect", background: false },
		undefined,
		undefined,
		toolContext(),
	);

	assert.equal(result.details?.finalText, "foreground");
	assert.equal(result.details?.status, "idle");
	const [registered] = registry.list();
	assert.ok(registered);
	assert.equal(registered.agent_id, result.details?.agentId);
	assert.equal(registered.status, "idle");
});

test("spawn_agent startup failure cleans its registry entry and releases root admission capacity", async (t) => {
	const pi = {} as ExtensionAPI;
	const { runtime, registry } = spawnRuntime();
	t.after(() => registry.closeAll());
	const tool = createSpawnAgentTool(pi, runtime, {
		spawnProcess: sequenceSpawner([rpcScript({ invalidState: true }), rpcScript({ output: "replacement" })]),
	});

	await assert.rejects(
		tool.execute("failed-call", { agent: "scout", message: "fail startup" }, undefined, undefined, toolContext()),
		/invalid session state/,
	);
	assert.deepEqual(registry.list(), []);

	const replacement = await tool.execute(
		"replacement-call",
		{ agent: "scout", message: "try again" },
		undefined,
		undefined,
		toolContext(),
	);
	assert.equal(replacement.details?.finalText, "replacement");
	assert.equal(registry.list().length, 1, "the failed transaction must not consume the direct-agent slot");
});

test("spawn_agent startup failure refunds nested admission without leaving a registry ghost", async (t) => {
	const pi = {} as ExtensionAPI;
	const parent: ChildExecutionContext = {
		treeId: "nested-spawn-tools",
		depth: 1,
		agent: "worker",
		profile: "fast",
		childSpawnBudget: 1,
	};
	const { runtime, registry } = spawnRuntime(parent);
	t.after(() => registry.closeAll());
	const tool = createSpawnAgentTool(pi, runtime, {
		spawnProcess: sequenceSpawner([rpcScript({ invalidState: true }), rpcScript({ output: "replacement" })]),
	});

	await assert.rejects(
		tool.execute(
			"failed-nested-call",
			{ agent: "scout", message: "fail startup" },
			undefined,
			undefined,
			toolContext(),
		),
		/invalid session state/,
	);
	assert.deepEqual(registry.list(), []);
	assert.equal(runtime.admission.remainingDelegationCredits(), 1);

	const replacement = await tool.execute(
		"retry-nested-call",
		{ agent: "scout", message: "retry" },
		undefined,
		undefined,
		toolContext(),
	);
	assert.equal(replacement.details?.finalText, "replacement");
	assert.equal(runtime.admission.remainingDelegationCredits(), 0);
	const [registered] = registry.list();
	assert.ok(registered);
	await registry.close(registered.agent_id);
	assert.equal(runtime.admission.remainingDelegationCredits(), 0, "closing a started child must not refund its credit");
});

test("spawn_agent routes cancellation only to foreground waiting and preserves the live agent", async (t) => {
	const pi = {} as ExtensionAPI;
	const { runtime, registry } = spawnRuntime();
	t.after(() => registry.closeAll());
	const tool = createSpawnAgentTool(pi, runtime, {
		spawnProcess: fakeSpawner(rpcScript({ output: "eventual", settleDelayMs: 100 })),
	});
	const cancellation = new AbortController();
	cancellation.abort(new Error("cancel tool call"));

	await assert.rejects(
		tool.execute(
			"cancelled-call",
			{ agent: "scout", message: "keep running", background: false },
			cancellation.signal,
			undefined,
			toolContext(),
		),
		/Waiting for agent .* was aborted/,
	);
	const [registered] = registry.list();
	assert.ok(registered);
	assert.match(registered.status, /starting|running|idle/);
	await registry.wait(registered.agent_id, 1_000);
	assert.equal(registry.summary(registered.agent_id).status, "idle");
});

test("spawn_agent background success ignores tool cancellation and wires automatic completion", async (t) => {
	const pi = {} as ExtensionAPI;
	const { runtime, registry, completions } = spawnRuntime();
	t.after(() => registry.closeAll());
	const tool = createSpawnAgentTool(pi, runtime, {
		spawnProcess: fakeSpawner(rpcScript({ output: "background", settleDelayMs: 20 })),
	});
	const cancellation = new AbortController();
	cancellation.abort(new Error("cancelled parent tool"));

	const result = await tool.execute(
		"background-call",
		{ agent: "scout", message: "inspect later", background: true },
		cancellation.signal,
		undefined,
		toolContext(),
	);
	assert.equal(result.details?.status, "launched");
	assert.equal(completions.length, 0);

	await waitUntil(() => completions.length === 1);
	const completion = completions[0];
	assert.ok(completion);
	assert.equal(completion.pi, pi);
	assert.equal(completion.summary.agent_id, result.details?.agentId);
	assert.equal(completion.summary.status, "idle");
	assert.equal(completion.summary.final_text, "background");
});

test("wait_agent trims and deduplicates IDs before lookup, waiting, and completion consumption", async () => {
	const lookups: string[] = [];
	const waits: Array<{ id: string; timeout: number | undefined }> = [];
	let consumed: readonly AgentSummary[] = [];
	const details = snapshotRunData(
		initRunData({
			agent: { name: "scout", description: "Scout", systemPrompt: "Scout", filePath: "scout.md" },
			taskName: "inspect",
			profile: "fast",
			model: "provider/model",
			effectiveThinking: "low",
			parentDepth: 0,
		}),
		{ status: "idle" },
	);
	const runtime = {
		registry: {
			async wait(id: string, timeout: number | undefined) {
				lookups.push(id);
				waits.push({ id, timeout });
				return details;
			},
			summary,
		},
		consumeSettledCompletions(summaries: readonly AgentSummary[]) {
			consumed = summaries;
		},
	};
	const times = [100, 145];
	const result = await executeWaitAgent(
		{ agent_ids: [" agent-1 ", "agent-1", "agent-2"] },
		runtime,
		undefined,
		() => times.shift() ?? 145,
	);

	assert.deepEqual(lookups, ["agent-1", "agent-2"]);
	assert.deepEqual(waits, [
		{ id: "agent-1", timeout: DEFAULT_WAIT_MS },
		{ id: "agent-2", timeout: DEFAULT_WAIT_MS },
	]);
	assert.deepEqual(
		consumed.map((item) => item.agent_id),
		["agent-1", "agent-2"],
	);
	assert.equal(result.details?.elapsedMs, 45);
});

test("wait_agent rejects unknown IDs before waiting on valid agents", async () => {
	const waits: string[] = [];
	const runtime = {
		registry: {
			async wait(id: string) {
				waits.push(id);
				return snapshotRunData(
					initRunData({
						agent: { name: "scout", description: "Scout", systemPrompt: "Scout", filePath: "scout.md" },
						taskName: "inspect",
						profile: "fast",
						model: "provider/model",
						effectiveThinking: "low",
						parentDepth: 0,
					}),
				);
			},
			summary(id: string) {
				if (id === "typo-agent") throw new Error(`Unknown agent_id '${id}'.`);
				return summary(id);
			},
		},
		consumeSettledCompletions() {},
	};

	await assert.rejects(
		executeWaitAgent({ agent_ids: ["real-agent", "typo-agent"] }, runtime, undefined),
		/Unknown agent_id 'typo-agent'/,
	);
	assert.deepEqual(waits, []);
});

test("wait_agent reports timeout and cancellation without interrupting other agents", async () => {
	const runtime = {
		registry: {
			wait(id: string) {
				return Promise.reject(new AgentWaitInterruptedError(id === "slow" ? "timed_out" : "cancelled", id));
			},
			summary,
		},
		consumeSettledCompletions() {},
	};

	const result = await executeWaitAgent({ agent_ids: ["slow", "cancelled"] }, runtime, undefined);

	assert.deepEqual(result.details?.outcomes, [
		{ agent_id: "slow", status: "timed_out" },
		{ agent_id: "cancelled", status: "cancelled" },
	]);
	assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /"timed_out"/);
});

test("wait_agent propagates external cancellation immediately", async () => {
	const cancellation = new AbortController();
	const reason = new Error("parent cancelled wait");
	const runtime = {
		registry: {
			wait() {
				return new Promise<ReadonlyRunDetails>(() => {});
			},
			summary,
		},
		consumeSettledCompletions() {},
	};
	const waiting = executeWaitAgent({ agent_ids: ["agent-1"] }, runtime, cancellation.signal);
	cancellation.abort(reason);
	await assert.rejects(waiting, reason);
});
