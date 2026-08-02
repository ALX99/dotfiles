import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import type { AgentConfig } from "../agents.ts";
import { AgentRegistry, DEFAULT_MAX_CLOSED_AGENT_HISTORY } from "../agent-registry.ts";
import { transitionLifecycle, type AgentSummary } from "../agent-types.ts";
import { ManagedAgent as ProductionManagedAgent, type ManagedAgentOptions } from "../managed-agent.ts";
import type { ReadonlyRunDetails } from "../run-state.ts";
import { spawnRpcProcess, type SpawnRpcProcess } from "../rpc-transport.ts";

const testAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-lifecycle-test-"));
after(() => fs.rmSync(testAgentDir, { recursive: true, force: true }));

class ManagedAgent extends ProductionManagedAgent {
	constructor(options: Omit<ManagedAgentOptions, "agentDir">) {
		super({ ...options, agentDir: testAgentDir, validateSessionIdentity: async (identity) => identity });
	}
}

class CountingManagedAgent extends ManagedAgent {
	summaryCalls = 0;
	detailsCalls = 0;

	override summary(): AgentSummary {
		this.summaryCalls++;
		return super.summary();
	}

	override getDetails(): ReadonlyRunDetails {
		this.detailsCalls++;
		return super.getDetails();
	}
}

const config: AgentConfig = {
	name: "general",
	description: "test",
	systemPrompt: "",
	filePath: "general.md",
};
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

function fakeSpawner(script: string): SpawnRpcProcess {
	return (_command, _args, options) => spawnRpcProcess(process.execPath, ["-e", script], options);
}

function agent(id: string, script = "process.stdin.resume(); setInterval(() => {}, 100)"): ManagedAgent {
	return new ManagedAgent({
		id,
		defaultCwd: process.cwd(),
		agent: config,
		resolvedRun,
		childContext,
		retain: true,
		spawnProcess: fakeSpawner(script),
	});
}

async function waitForPhase(managed: ManagedAgent, phase: "running" | "failed"): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (managed.getLifecycle().phase === phase) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.fail(`Agent did not reach lifecycle phase '${phase}'.`);
}

test("allowed lifecycle transitions are explicit and impossible transitions throw", () => {
	let state = transitionLifecycle({ phase: "created" }, { phase: "starting" });
	state = transitionLifecycle(state, { phase: "running" });
	state = transitionLifecycle(state, { phase: "idle" });
	state = transitionLifecycle(state, { phase: "starting" });
	state = transitionLifecycle(state, { phase: "running" });
	state = transitionLifecycle(state, { phase: "aborted" });
	state = transitionLifecycle(state, { phase: "idle" });
	state = transitionLifecycle(state, { phase: "closing" });
	state = transitionLifecycle(state, { phase: "closed" });
	assert.equal(state.phase, "closed");
	assert.throws(() => transitionLifecycle({ phase: "closed" }, { phase: "starting" }), /invalid/i);
	assert.equal(
		transitionLifecycle({ phase: "starting" }, { phase: "failed", error: new Error("startup") }).phase,
		"failed",
	);
	assert.equal(
		transitionLifecycle({ phase: "running" }, { phase: "failed", error: new Error("exit") }).phase,
		"failed",
	);
	assert.equal(
		transitionLifecycle({ phase: "aborted" }, { phase: "failed", error: new Error("abort failed") }).phase,
		"failed",
	);
});

test("close while starting settles startup and reaches closed", async () => {
	const managed = agent("close-starting", "process.stdin.resume(); setInterval(() => {}, 100)");
	const starting = assert.rejects(managed.start("work", undefined, "work", false), /closed/);
	await new Promise((resolve) => setTimeout(resolve, 20));
	await managed.close();
	await starting;
	assert.equal(managed.getLifecycle().phase, "closed");
});

test("ManagedAgent subscribers receive independent emitted run snapshots", async (t) => {
	const script = String.raw`
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  while (buffer.includes('\n')) {
    const index = buffer.indexOf('\n');
    const command = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
    const data = command.type === 'get_state' ? { sessionId: 'subscriber', sessionFile: '/tmp/subscriber.jsonl' }
      : command.type === 'get_entries' ? { entries: [], leafId: null } : undefined;
    process.stdout.write(JSON.stringify({ type: 'response', id: command.id, success: true, data }) + '\n');
    if (command.type === 'prompt') process.stdout.write('{"type":"agent_start"}\n{"type":"agent_settled"}\n');
  }
	});
`;
	const managed = agent("subscriber", script);
	t.after(() => managed.close());
	const snapshots: ReturnType<ManagedAgent["getDetails"]>[] = [];
	const unsubscribe = managed.subscribe((details) => snapshots.push(details));
	t.after(unsubscribe);

	const settled = await managed.start("work", undefined, "work", false);

	assert.ok(snapshots.some((details) => details.status === "starting"));
	assert.equal(snapshots.at(-1)?.status, "idle");
	assert.equal(settled.status, "idle");
	assert.notEqual(snapshots.at(-1), managed.getDetails());
	assert.notEqual(snapshots.at(-1)?.recentTools, managed.getDetails().recentTools);

	const followUp = await managed.followUp("next work", "next task", false);
	assert.equal(followUp.taskName, "next task");
	assert.equal(managed.summary().task_name, "next task");
	assert.equal(managed.getDetails().taskName, "next task");
	assert.equal(managed.summary().task_name, managed.getDetails().taskName);
});

test("duplicate settlement emits one background completion", async (t) => {
	const completed: string[] = [];
	const script = String.raw`
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  while (buffer.includes('\n')) {
    const i = buffer.indexOf('\n');
    const command = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1);
    const data = command.type === 'get_state' ? {sessionId:'duplicate', sessionFile:'/tmp/duplicate.jsonl'}
      : command.type === 'get_entries' ? {entries:[], leafId:null} : undefined;
    process.stdout.write(JSON.stringify({type:'response', id:command.id, success:true, data}) + '\n');
    if (command.type === 'prompt') {
      process.stdout.write('{"type":"agent_start"}\n{"type":"agent_settled"}\n{"type":"agent_settled"}\n');
    }
  }
});
`;
	const managed = new ManagedAgent({
		id: "duplicate",
		defaultCwd: process.cwd(),
		agent: config,
		resolvedRun,
		childContext,
		retain: true,
		spawnProcess: fakeSpawner(script),
		onBackgroundComplete: (summary) => completed.push(summary.agent_id),
	});
	t.after(() => managed.close());
	await managed.start("work", undefined, "work", true);
	await managed.wait(1_000);
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(completed, ["duplicate"]);
});

test("one-shot agents archive after foreground settlement and free capacity", async (t) => {
	const script = String.raw`
let buffer = '';
let entries = [];
let leafId = null;
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  while (buffer.includes('\n')) {
    const index = buffer.indexOf('\n');
    const command = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
    const data = command.type === 'get_state' ? { sessionId: 'one-shot', sessionFile: '/tmp/one-shot.jsonl' }
      : command.type === 'get_entries' ? { entries: entries.slice(command.since ? entries.findIndex(entry => entry.id === command.since) + 1 : 0), leafId } : undefined;
    process.stdout.write(JSON.stringify({ type: 'response', id: command.id, success: true, data }) + '\n');
    if (command.type === 'prompt') {
      process.stdout.write('{"type":"agent_start"}\n');
      const message = { role: 'assistant', content: [{ type: 'text', text: 'done' }], stopReason: 'stop' };
      entries.push({type:'message', id:'done', parentId:null, timestamp:new Date().toISOString(), message}); leafId = 'done';
      process.stdout.write(JSON.stringify({ type: 'message_end', message }) + '\n');
      process.stdout.write('{"type":"agent_settled"}\n');
    }
  }
});
`;
	const managed = new ManagedAgent({
		id: "one-shot",
		defaultCwd: process.cwd(),
		agent: config,
		resolvedRun,
		childContext,
		retain: false,
		spawnProcess: fakeSpawner(script),
	});
	const registry = new AgentRegistry();
	await registry.add(managed);
	t.after(() => registry.closeAll());
	const settled = await managed.start("work", undefined, "work", false);
	assert.equal(settled.status, "idle");
	assert.equal(registry.summary(managed.id).status, "closed");
	assert.equal(registry.capacity().length, 0);
	assert.throws(() => registry.getLive(managed.id), /closed/);
	await registry.close(managed.id);
	assert.equal(registry.summary(managed.id).result?.source, "assistant");
});

test("a cancelled foreground wait promotes the eventual child completion", async (t) => {
	const script = String.raw`
let buffer = '';
let entries = [];
let leafId = null;
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  while (buffer.includes('\n')) {
    const index = buffer.indexOf('\n');
    const command = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
    const data = command.type === 'get_state' ? {sessionId:'cancelled-wait', sessionFile:'/tmp/cancelled-wait.jsonl'}
      : command.type === 'get_entries' ? {entries:entries.slice(command.since ? entries.findIndex(entry => entry.id === command.since) + 1 : 0), leafId} : undefined;
    process.stdout.write(JSON.stringify({type:'response', id:command.id, success:true, data}) + '\n');
    if (command.type === 'prompt') {
      process.stdout.write('{"type":"agent_start"}\n');
      setTimeout(() => {
        const message = {role:'assistant', content:[{type:'text', text:'finished'}], stopReason:'stop'};
        entries.push({type:'message', id:'finished', parentId:null, timestamp:new Date().toISOString(), message}); leafId = 'finished';
        process.stdout.write(JSON.stringify({type:'message_end', message}) + '\n');
        process.stdout.write('{"type":"agent_settled"}\n');
      }, 20);
    }
  }
});
`;
	const completed: string[] = [];
	const managed = new ManagedAgent({
		id: "cancelled-foreground",
		defaultCwd: process.cwd(),
		agent: config,
		resolvedRun,
		childContext,
		retain: true,
		spawnProcess: fakeSpawner(script),
		onBackgroundComplete: (summary) => completed.push(summary.final_text ?? ""),
	});
	t.after(() => managed.close());
	const abort = new AbortController();
	const foreground = managed.start("work", undefined, "work", false, abort.signal);
	await waitForPhase(managed, "running");
	abort.abort("caller stopped waiting");
	await assert.rejects(foreground, /cancelled/);
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.deepEqual(completed, ["finished"]);
});

test("a process death invalidates availability and follow-up rejects deterministically", async (t) => {
	const script = String.raw`
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  while (buffer.includes('\n')) {
    const i = buffer.indexOf('\n');
    const command = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1);
    const data = command.type === 'get_state' ? {sessionId:'dead', sessionFile:'/tmp/dead.jsonl'}
      : command.type === 'get_entries' ? {entries:[], leafId:null} : undefined;
    process.stdout.write(JSON.stringify({type:'response', id:command.id, success:true, data}) + '\n');
    if (command.type === 'prompt') {
      process.stdout.write('{"type":"agent_start"}\n{"type":"agent_settled"}\n');
      setTimeout(() => process.exit(9), 10);
    }
  }
});
`;
	const managed = agent("dead-agent", script);
	t.after(() => managed.close());
	const registry = new AgentRegistry();
	await registry.add(managed);
	await managed.start("work", undefined, "work", false);
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(managed.isAvailable(), false);
	assert.equal(managed.summary().status, "failed");
	assert.deepEqual(registry.capacity(), []);
	await assert.rejects(managed.followUp("again", "again", false), /process is dead/);
});

test("process death during abort fails and settles the active run without a follow-up hang", async () => {
	const script = String.raw`
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  while (buffer.includes('\n')) {
    const i = buffer.indexOf('\n');
    const command = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1);
    const data = command.type === 'get_state' ? {sessionId:'abort-death', sessionFile:'/tmp/abort-death.jsonl'}
      : command.type === 'get_entries' ? {entries:[], leafId:null} : undefined;
    if (command.type !== 'abort') {
      process.stdout.write(JSON.stringify({type:'response', id:command.id, success:true, data}) + '\n');
    }
    if (command.type === 'prompt') process.stdout.write('{"type":"agent_start"}\n');
    if (command.type === 'abort') process.exit(23);
  }
});
`;
	const managed = agent("abort-death", script);
	const completion = managed.start("work", undefined, "work", false);
	await waitForPhase(managed, "running");
	await assert.rejects(managed.interrupt(), /exited/);
	await assert.rejects(completion, /exited/);
	assert.equal(managed.summary().status, "failed");
	assert.equal(managed.isAvailable(), false);
	await assert.rejects(managed.followUp("again", "again", false), /process is dead/);
	await managed.close();
});

test("abort RPC failure fails and settles the run, then permits a deterministic follow-up", async (t) => {
	const script = String.raw`
let buffer = '';
let promptCount = 0;
let entries = [];
let leafId = null;
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  while (buffer.includes('\n')) {
    const i = buffer.indexOf('\n');
    const command = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1);
    if (command.type === 'abort') {
      process.stdout.write(JSON.stringify({type:'response', id:command.id, success:false, error:'abort exploded'}) + '\n');
      continue;
    }
    const data = command.type === 'get_state' ? {sessionId:'abort-rpc', sessionFile:'/tmp/abort-rpc.jsonl'}
      : command.type === 'get_entries' ? {entries:entries.slice(command.since ? entries.findIndex(entry => entry.id === command.since) + 1 : 0), leafId} : undefined;
    process.stdout.write(JSON.stringify({type:'response', id:command.id, success:true, data}) + '\n');
    if (command.type === 'prompt') {
      promptCount++;
      process.stdout.write('{"type":"agent_start"}\n');
    }
    if ((command.type === 'prompt' && promptCount > 1) || command.type === 'follow_up') {
      const message = {role:'assistant', content:[{type:'text', text:'recovered'}], stopReason:'stop'};
      const id = 'recovered-' + promptCount;
      entries.push({type:'message', id, parentId:leafId, timestamp:new Date().toISOString(), message}); leafId = id;
      process.stdout.write(JSON.stringify({type:'message_end', message}) + '\n');
      process.stdout.write('{"type":"agent_settled"}\n');
    }
  }
});
`;
	const managed = agent("abort-rpc", script);
	t.after(() => managed.close());
	const completion = managed.start("work", undefined, "work", false);
	await waitForPhase(managed, "running");
	await assert.rejects(managed.interrupt(), /abort exploded/);
	await assert.rejects(completion, /abort exploded/);
	assert.equal(managed.summary().status, "failed");
	const recovered = await managed.followUp("again", "again", false);
	assert.equal(recovered.finalText, "recovered");
	assert.equal(managed.summary().status, "idle");
});

test("a delayed settlement from the previous turn cannot settle a newer generation", async (t) => {
	const script = String.raw`
let buffer = '';
let prompts = 0;
let entries = [];
let leafId = null;
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  while (buffer.includes('\n')) {
    const i = buffer.indexOf('\n');
    const command = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1);
    const data = command.type === 'get_state' ? {sessionId:'stale-settlement', sessionFile:'/tmp/stale-settlement.jsonl'}
      : command.type === 'get_entries' ? {entries:entries.slice(command.since ? entries.findIndex(entry => entry.id === command.since) + 1 : 0), leafId} : undefined;
    process.stdout.write(JSON.stringify({type:'response', id:command.id, success:true, data}) + '\n');
    if (command.type !== 'prompt' && command.type !== 'follow_up') continue;
    prompts++;
    if (prompts === 2) process.stdout.write('{"type":"agent_settled"}\n');
    process.stdout.write('{"type":"agent_start"}\n');
    const message = {role:'assistant', content:[{type:'text', text:prompts === 1 ? 'first' : 'second'}], stopReason:'stop'};
    const id = 'stale-' + prompts;
    entries.push({type:'message', id, parentId:leafId, timestamp:new Date().toISOString(), message}); leafId = id;
    process.stdout.write(JSON.stringify({type:'message_end', message}) + '\n');
    process.stdout.write('{"type":"agent_settled"}\n');
  }
});
`;
	const managed = agent("stale-settlement", script);
	t.after(() => managed.close());

	const first = await managed.start("first", undefined, "first", false);
	assert.equal(first.finalText, "first");
	const second = await managed.followUp("second", "second", false);
	assert.equal(second.generation, 2);
	assert.equal(second.finalText, "second");
});

test("registry replacement closes the replaced agent", async () => {
	const registry = new AgentRegistry();
	const first = agent("same");
	const second = agent("same");
	let firstClosed = 0;
	first.close = async () => {
		firstClosed++;
	};
	await registry.add(first);
	await registry.add(second);
	assert.equal(firstClosed, 1);
	assert.equal(registry.getLive("same"), second);
	await registry.closeAll();
});

test("registry reads live results from one coherent view projection", async () => {
	const managed = new CountingManagedAgent({
		id: "projection",
		defaultCwd: process.cwd(),
		agent: config,
		resolvedRun,
		childContext,
		retain: true,
		spawnProcess: fakeSpawner("process.stdin.resume(); setInterval(() => {}, 100)"),
	});
	const registry = new AgentRegistry();
	await registry.add(managed);
	try {
		const summary = registry.summary(managed.id);
		assert.equal(summary.agent_id, managed.id);
		assert.equal(managed.detailsCalls, 0);
		assert.deepEqual(registry.list(), [summary]);
		assert.equal(managed.detailsCalls, 0);
		assert.equal(managed.summaryCalls, 2);
		await registry.readResult(managed.id);
		assert.equal(managed.summaryCalls, 3);
		assert.equal(managed.detailsCalls, 1);
	} finally {
		await registry.closeAll();
	}
});

test("registry closeAll cleans every entry and reports partial failures", async () => {
	const registry = new AgentRegistry();
	const failing = agent("failing");
	const successful = agent("successful");
	let successfulClosed = false;
	failing.close = async () => {
		throw new Error("injected close failure");
	};
	successful.close = async () => {
		successfulClosed = true;
	};
	await registry.add(failing);
	await registry.add(successful);
	await assert.rejects(registry.closeAll(), /cleanup failed/);
	assert.equal(successfulClosed, true);
	assert.deepEqual(registry.list(), []);
});

test("registry retains bounded archived data without exposing fake live-agent methods", async () => {
	const registry = new AgentRegistry();
	const closed: ManagedAgent[] = [];
	for (let index = 0; index <= DEFAULT_MAX_CLOSED_AGENT_HISTORY; index++) {
		const managed = agent(`closed-${index}`);
		closed.push(managed);
		await registry.add(managed);
		await registry.close(managed.id);
		assert.equal(managed.getLifecycle().phase, "closed");
	}

	assert.equal(registry.list().length, DEFAULT_MAX_CLOSED_AGENT_HISTORY);
	assert.throws(() => registry.view("closed-0"), /Unknown agent_id/);
	const retained = registry.view(`closed-${DEFAULT_MAX_CLOSED_AGENT_HISTORY}`);
	assert.equal(retained.summary.agent_id, `closed-${DEFAULT_MAX_CLOSED_AGENT_HISTORY}`);
	assert.equal(retained.summary.status, "closed");
	assert.equal(retained.details.status, "closed");
	assert.notEqual(retained, closed[DEFAULT_MAX_CLOSED_AGENT_HISTORY]);
	assert.throws(() => registry.getLive(retained.summary.agent_id), /closed/);
	await assert.doesNotReject(registry.close(retained.summary.agent_id));
	assert.deepEqual(await registry.wait(retained.summary.agent_id), retained.details);
	await registry.closeAll();
	assert.deepEqual(registry.list(), []);
});

test("registry closeAll closes live agents while discarding archived summaries", async () => {
	const registry = new AgentRegistry();
	const archived = agent("archived");
	const live = agent("live");
	await registry.add(archived);
	await registry.close("archived");
	await registry.add(live);
	await registry.closeAll();
	assert.equal(live.getLifecycle().phase, "closed");
	assert.deepEqual(registry.list(), []);
});
