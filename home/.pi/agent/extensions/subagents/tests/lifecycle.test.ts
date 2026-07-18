import * as assert from "node:assert/strict";
import { spawn, type SpawnOptionsWithoutStdio } from "node:child_process";
import * as fs from "node:fs";
import { test } from "node:test";
import type { AgentConfig } from "../agents.ts";
import { AgentRegistry, DEFAULT_MAX_CLOSED_AGENT_HISTORY } from "../agent-registry.ts";
import { transitionLifecycle } from "../agent-types.ts";
import { ManagedAgent } from "../managed-agent.ts";
import type { SpawnRpcProcess } from "../rpc-transport.ts";

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
	const registry = new AgentRegistry();
	await registry.add(managed);
	t.after(() => managed.close());
	const result = await managed.start("work", undefined, "work", false);
	assert.ok(result.outputFile);
	assert.equal(await managed.loadFullOutput(), "x".repeat(60_000));
	assert.equal(fs.existsSync(result.outputFile), true);
	await managed.close();
	assert.equal(fs.existsSync(result.outputFile), false);
	assert.equal(managed.getDetails().outputFile, undefined);
	assert.equal(registry.view(managed.id).details.outputFile, undefined);
});

test("follow-up drains queued settlement events before choosing its run", async (t) => {
	const script = String.raw`
let buffer = '';
let prompts = 0;
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  while (buffer.includes('\n')) {
    const i = buffer.indexOf('\n');
    const command = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1);
    const data = command.type === 'get_state' ? {sessionFile:'/tmp/follow-up.jsonl'} : undefined;
    process.stdout.write(JSON.stringify({type:'response', id:command.id, success:true, data}) + '\n');
    if (command.type === 'prompt' || command.type === 'follow_up') {
      prompts++;
      const text = prompts === 1 ? 'first' : 'second';
      process.stdout.write(JSON.stringify({type:'message_end', message:{role:'assistant', content:[{type:'text', text}]}}) + '\n');
      process.stdout.write('{"type":"agent_settled"}\n');
    }
  }
});
`;
	const managed = agent("follow-up-queued-settlement", script);
	t.after(() => managed.close());
	let releaseAppend: (() => void) | undefined;
	const appendReleased = new Promise<void>((resolve) => {
		releaseAppend = resolve;
	});
	let appendStarted: (() => void) | undefined;
	const appendPending = new Promise<void>((resolve) => {
		appendStarted = resolve;
	});

	const initial = managed.start("first", undefined, "first", true);
	const spool = (managed as unknown as { output: { append(text: string): Promise<unknown> } }).output;
	const append = spool.append.bind(spool);
	spool.append = async (text) => {
		appendStarted?.();
		await appendReleased;
		return append(text);
	};
	await initial;
	await appendPending;

	const followUp = managed.followUp("second", "second", false);
	releaseAppend?.();
	const result = await followUp;
	assert.equal(result.finalText, "second");
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
