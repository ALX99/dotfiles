import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../agents.ts";
import { ChildSession } from "../child-session.ts";
import { spawnRpcProcess, type SpawnRpcProcess } from "../rpc-transport.ts";

const resultId = "a".repeat(64);
const agent: AgentConfig = {
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
const childContext = { agent: "general", profile: "balanced" } as const;
const rpcScript = String.raw`
let buffer = '';
const entryResponses = JSON.parse(process.env.TEST_ENTRY_RESPONSES);
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  while (buffer.includes('\n')) {
    const index = buffer.indexOf('\n');
    const command = JSON.parse(buffer.slice(0, index));
    buffer = buffer.slice(index + 1);
    if (command.type === 'get_entries') {
      const response = entryResponses.shift();
      if ('error' in response) {
        process.stdout.write(JSON.stringify({ type: 'response', id: command.id, success: false, error: response.error }) + '\n');
        continue;
      }
      process.stdout.write(JSON.stringify({ type: 'response', id: command.id, success: true, data: response }) + '\n');
      continue;
    }
    const data = command.type === 'get_state'
      ? { sessionId: 'session', sessionFile: process.env.TEST_SESSION_FILE }
      : undefined;
    process.stdout.write(JSON.stringify({ type: 'response', id: command.id, success: true, data }) + '\n');
  }
});
`;

function childSession(
	agentDir: string,
	entryResponses: readonly object[],
	sessionFile = "/tmp/session.jsonl",
): ChildSession {
	const spawnProcess: SpawnRpcProcess = (_command, _args, options) =>
		spawnRpcProcess(process.execPath, ["-e", rpcScript], {
			...options,
			env: {
				...options.env,
				TEST_ENTRY_RESPONSES: JSON.stringify(entryResponses),
				TEST_SESSION_FILE: sessionFile,
			},
		});
	return new ChildSession({
		agentId: "worker",
		agentDir,
		defaultCwd: process.cwd(),
		agent,
		resolvedRun,
		childContext,
		spawnProcess,
		validateSessionIdentity: async (identity) => identity,
		onEvent: () => {},
	});
}

function message(id: string, parentId: string | null): Record<string, unknown> {
	return {
		id,
		parentId,
		timestamp: new Date().toISOString(),
		type: "message",
		message: { role: "assistant", content: [{ type: "text", text: id }], stopReason: "stop" },
	};
}

function appendAssistant(manager: SessionManager, text: string): void {
	manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text }],
		api: "test",
		provider: "test",
		model: "test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	});
}

test("ChildSession captures initial and retained-generation deltas", async (t) => {
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "child-session-test-"));
	t.after(() => fs.rm(agentDir, { recursive: true, force: true }));
	const session = childSession(agentDir, [
		{ entries: [], leafId: null },
		{ entries: [message("one", null)], leafId: "one" },
		{ entries: [], leafId: "one" },
		{ entries: [message("two", "one")], leafId: "two" },
	]);
	t.after(() => session.close());

	await session.open();
	await session.prepareGeneration();
	assert.equal((await session.captureSettlement(1, resultId)).result.text, "one");
	await session.prepareGeneration();
	assert.equal((await session.captureSettlement(2, resultId)).result.text, "two");
});

test("ChildSession retries an invalid final leaf without advancing its checkpoint", async (t) => {
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "child-session-test-"));
	t.after(() => fs.rm(agentDir, { recursive: true, force: true }));
	const session = childSession(agentDir, [
		{ entries: [], leafId: null },
		{ entries: [message("one", null)], leafId: "missing" },
		{ entries: [message("one", null)], leafId: "one" },
	]);
	t.after(() => session.close());

	await session.open();
	await session.prepareGeneration();
	await assert.rejects(session.captureSettlement(1, resultId), /outside its append range/);
	assert.equal((await session.captureSettlement(1, resultId)).result.text, "one");
});

test("ChildSession recovers a failed generation from validated session storage after transport loss", async (t) => {
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "child-session-test-"));
	t.after(() => fs.rm(agentDir, { recursive: true, force: true }));
	const manager = SessionManager.create(process.cwd(), path.join(agentDir, "subagent-sessions"));
	const sessionFile = manager.getSessionFile();
	assert.ok(sessionFile);
	const session = childSession(agentDir, [{ entries: [], leafId: null }], sessionFile);

	await session.open();
	await session.prepareGeneration();
	appendAssistant(manager, "recovered");
	await session.close();

	assert.equal((await session.captureFailedGeneration(1, resultId))?.result.text, "recovered");
});

test("ChildSession rejects live entry-read failures instead of recovering from disk", async (t) => {
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "child-session-test-"));
	t.after(() => fs.rm(agentDir, { recursive: true, force: true }));
	const manager = SessionManager.create(process.cwd(), path.join(agentDir, "subagent-sessions"));
	const sessionFile = manager.getSessionFile();
	assert.ok(sessionFile);
	const session = childSession(agentDir, [{ entries: [], leafId: null }, { error: "entry read failure" }], sessionFile);
	t.after(() => session.close());

	await session.open();
	await session.prepareGeneration();
	appendAssistant(manager, "disk fallback");

	await assert.rejects(session.captureFailedGeneration(1, resultId), /entry read failure/);
});
