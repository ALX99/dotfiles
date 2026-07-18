import * as assert from "node:assert/strict";
import { spawn, type SpawnOptionsWithoutStdio } from "node:child_process";
import * as fs from "node:fs";
import { test } from "node:test";
import type { AgentConfig } from "../agents.ts";
import { AgentRegistry, DEFAULT_MAX_CLOSED_AGENT_HISTORY, ManagedAgent, transitionLifecycle } from "../host.ts";
import type { SpawnRpcProcess } from "../rpc.ts";

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
	treeId: "lifecycle-test",
	depth: 1,
	agent: "general",
	profile: "balanced",
	delegationCredits: 0,
} as const;

function fakeSpawner(script: string): SpawnRpcProcess {
	function spawnFake(_command: string, _args: readonly string[], options: SpawnOptionsWithoutStdio) {
		return spawn(process.execPath, ["-e", script], options);
	}
	// The fixture implements the stdio-pipe overload ManagedAgent uses.
	return spawnFake as unknown as SpawnRpcProcess;
}

function agent(id: string, script = "process.stdin.resume(); setInterval(() => {}, 100)"): ManagedAgent {
	return new ManagedAgent({
		id,
		defaultCwd: process.cwd(),
		agent: config,
		resolvedRun,
		childContext,
		subagentToolsEnabled: false,
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

test("allowed lifecycle transitions are explicit and stale/impossible transitions throw", () => {
	let state = transitionLifecycle({ phase: "created", generation: 0 }, { phase: "starting", generation: 1 });
	state = transitionLifecycle(state, { phase: "running", generation: 1 });
	state = transitionLifecycle(state, { phase: "idle", generation: 1 });
	state = transitionLifecycle(state, { phase: "starting", generation: 2 });
	state = transitionLifecycle(state, { phase: "running", generation: 2 });
	state = transitionLifecycle(state, { phase: "aborted", generation: 2 });
	state = transitionLifecycle(state, { phase: "idle", generation: 2 });
	state = transitionLifecycle(state, { phase: "closing", generation: 2 });
	state = transitionLifecycle(state, { phase: "closed", generation: 2 });
	assert.equal(state.phase, "closed");
	assert.throws(
		() => transitionLifecycle({ phase: "running", generation: 3 }, { phase: "idle", generation: 2 }),
		/stale/i,
	);
	assert.throws(
		() => transitionLifecycle({ phase: "closed", generation: 3 }, { phase: "starting", generation: 4 }),
		/invalid/i,
	);
	assert.equal(
		transitionLifecycle(
			{ phase: "starting", generation: 1 },
			{ phase: "failed", generation: 1, error: new Error("startup") },
		).phase,
		"failed",
	);
	assert.equal(
		transitionLifecycle(
			{ phase: "running", generation: 1 },
			{ phase: "failed", generation: 1, error: new Error("exit") },
		).phase,
		"failed",
	);
	assert.equal(
		transitionLifecycle(
			{ phase: "aborted", generation: 1 },
			{ phase: "failed", generation: 1, error: new Error("abort failed") },
		).phase,
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
    const data = command.type === 'get_state' ? {sessionFile:'/tmp/duplicate.jsonl'} : undefined;
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
		subagentToolsEnabled: false,
		spawnProcess: fakeSpawner(script),
		onBackgroundComplete: (summary) => completed.push(summary.agent_id),
	});
	t.after(() => managed.close());
	await managed.start("work", undefined, "work", true);
	await managed.wait(1_000);
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(completed, ["duplicate"]);
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
    const data = command.type === 'get_state' ? {sessionFile:'/tmp/dead.jsonl'} : undefined;
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
	await managed.start("work", undefined, "work", false);
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(managed.isAvailable(), false);
	assert.equal(managed.summary().status, "failed");
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
    const data = command.type === 'get_state' ? {sessionFile:'/tmp/abort-death.jsonl'} : undefined;
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
    const data = command.type === 'get_state' ? {sessionFile:'/tmp/abort-rpc.jsonl'} : undefined;
    process.stdout.write(JSON.stringify({type:'response', id:command.id, success:true, data}) + '\n');
    if (command.type === 'prompt') {
      promptCount++;
      process.stdout.write('{"type":"agent_start"}\n');
    }
    if ((command.type === 'prompt' && promptCount > 1) || command.type === 'follow_up') {
      process.stdout.write(JSON.stringify({type:'message_end', message:{role:'assistant', content:[{type:'text', text:'recovered'}]}}) + '\n');
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

test("agent close removes its owned output spool", async (t) => {
	const script = String.raw`
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  while (buffer.includes('\n')) {
    const i = buffer.indexOf('\n');
    const command = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1);
    const data = command.type === 'get_state' ? {sessionFile:'/tmp/output.jsonl'} : undefined;
    process.stdout.write(JSON.stringify({type:'response', id:command.id, success:true, data}) + '\n');
    if (command.type === 'prompt') {
      process.stdout.write(JSON.stringify({type:'message_end', message:{role:'assistant', content:[{type:'text', text:'x'.repeat(60000)}]}}) + '\n');
      process.stdout.write('{"type":"agent_settled"}\n');
    }
  }
});
`;
	const managed = agent("output-agent", script);
	t.after(() => managed.close());
	const result = await managed.start("work", undefined, "work", false);
	assert.ok(result.outputFile);
	assert.equal(await managed.loadFullOutput(), "x".repeat(60_000));
	assert.equal(fs.existsSync(result.outputFile), true);
	await managed.close();
	assert.equal(fs.existsSync(result.outputFile), false);
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
	assert.equal(registry.get("same"), second);
	await registry.closeAll();
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

test("registry retains only bounded immutable closed summaries and evicts the oldest closure", async () => {
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
	assert.throws(() => registry.get("closed-0"), /Unknown agent_id/);
	const retained = registry.get(`closed-${DEFAULT_MAX_CLOSED_AGENT_HISTORY}`);
	assert.equal(retained.summary().agent_id, `closed-${DEFAULT_MAX_CLOSED_AGENT_HISTORY}`);
	assert.equal(retained.summary().status, "closed");
	assert.equal(retained.getDetails().status, "closed");
	assert.equal(Object.isFrozen(retained.summary()), true);
	assert.equal(Object.isFrozen(retained.getDetails()), true);
	assert.notEqual(retained, closed[DEFAULT_MAX_CLOSED_AGENT_HISTORY]);
	await assert.doesNotReject(retained.close());
	await assert.rejects(retained.getMessages(), /not available/);
	assert.equal(await retained.loadFullOutput(), "");
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
