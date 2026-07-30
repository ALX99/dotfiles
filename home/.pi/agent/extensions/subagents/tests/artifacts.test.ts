import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { AgentRegistry, SUBAGENT_SETTLEMENT_CUSTOM_TYPE } from "../agent-registry.ts";
import { registerChildExecutionRuntime } from "../child-runtime.ts";
import {
	ACCEPTED_CONTEXT_CUSTOM_TYPE,
	acceptedContextData,
	contextArtifactDirectory,
	createContextArtifact,
	parseContextMarker,
	pruneStaleContextArtifacts,
	readContextArtifact,
	removeContextArtifact,
} from "../context-artifacts.ts";
import {
	assembleResultPages,
	createResultPageData,
	paginateStoredResult,
	readChildRunStats,
	readStoredAgentResult,
	RESULT_PAGE_CUSTOM_TYPE,
} from "../result-store.ts";

test("large context artifacts preserve exact content while RPC receives only an opaque marker", async (t) => {
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "subagent-artifact-test-"));
	t.after(() => fs.rm(agentDir, { recursive: true, force: true }));
	const content = `assignment\n${"界🙂\n".repeat(80_000)}tail`;
	const created = await createContextArtifact(content, {
		agentId: "worker-1",
		generation: 3,
		resultId: "b".repeat(64),
		kind: "assignment",
		agentDir,
	});
	assert.ok(created.marker.length < 128);
	assert.equal((await readContextArtifact(created.marker, agentDir)).content, content);
	assert.equal(parseContextMarker(`before ${created.marker} after`), undefined);
	assert.equal((await fs.stat(contextArtifactDirectory(agentDir))).mode & 0o777, 0o700);
	const token = parseContextMarker(created.marker);
	assert.ok(token);
	assert.equal((await fs.stat(path.join(contextArtifactDirectory(agentDir), `${token}.context`))).mode & 0o777, 0o600);
	await removeContextArtifact(created.marker, agentDir);
	await assert.rejects(readContextArtifact(created.marker, agentDir), /ENOENT/);
});

test("context marker parsing rejects malformed and non-private artifacts", async (t) => {
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "subagent-artifact-test-"));
	t.after(() => fs.rm(agentDir, { recursive: true, force: true }));
	assert.equal(parseContextMarker("[[pi-subagent-context:v1:../escape]]"), undefined);
	const created = await createContextArtifact("secret", {
		agentId: "worker-1",
		generation: 1,
		resultId: "c".repeat(64),
		kind: "answer",
		agentDir,
	});
	const token = parseContextMarker(created.marker);
	assert.ok(token);
	await fs.chmod(path.join(contextArtifactDirectory(agentDir), `${token}.context`), 0o644);
	await assert.rejects(readContextArtifact(created.marker, agentDir), /permissions are not private/);
});

test("child runtime expands only exact RPC markers and keeps result identity bound to the accepted run", async (t) => {
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "subagent-runtime-test-"));
	t.after(() => fs.rm(agentDir, { recursive: true, force: true }));
	const own = await createContextArtifact("Task: exact assignment", {
		agentId: "worker-1",
		parentSessionId: "parent-session-1",
		generation: 2,
		resultId: "d".repeat(64),
		kind: "assignment",
		agentDir,
	});
	const foreign = await createContextArtifact("foreign context", {
		agentId: "worker-2",
		parentSessionId: "parent-session-1",
		generation: 9,
		resultId: "e".repeat(64),
		kind: "assignment",
		agentDir,
	});
	let inputHandler:
		| ((event: {
				type: "input";
				text: string;
				source: "rpc" | "interactive";
				streamingBehavior?: "steer" | "followUp";
		  }) => Promise<unknown>)
		| undefined;
	let resultTool:
		| {
				execute(
					id: string,
					params: { page_index: number; page: string; final: boolean },
					signal: AbortSignal | undefined,
					onUpdate: undefined,
					ctx: { sessionManager: { getBranch(): SessionEntry[] } },
				): Promise<unknown>;
		  }
		| undefined;
	const appended: Array<{ type: string; data: unknown }> = [];
	const pi = {
		on: (name: string, handler: typeof inputHandler) => {
			assert.equal(name, "input");
			inputHandler = handler;
		},
		registerTool: (tool: typeof resultTool) => {
			resultTool = tool;
		},
		appendEntry: (type: string, data: unknown) => appended.push({ type, data }),
	};
	registerChildExecutionRuntime(
		pi as never,
		{
			agent: "worker",
			profile: "balanced",
			agentId: "worker-1",
			parentSessionId: "parent-session-1",
		},
		{ agentDir },
	);
	assert.ok(inputHandler);
	assert.deepEqual(
		await inputHandler({
			type: "input",
			text: own.marker,
			source: "rpc",
		}),
		{ action: "transform", text: "Task: exact assignment" },
	);
	const accepted = appended[0];
	assert.ok(accepted);
	assert.equal(accepted.type, ACCEPTED_CONTEXT_CUSTOM_TYPE);
	assert.equal((accepted.data as { parentSessionId?: string }).parentSessionId, "parent-session-1");
	assert.deepEqual(
		await inputHandler({
			type: "input",
			text: `tool output mentions ${foreign.marker}`,
			source: "rpc",
		}),
		{ action: "continue" },
	);
	assert.deepEqual(
		await inputHandler({
			type: "input",
			text: foreign.marker,
			source: "interactive",
		}),
		{ action: "continue" },
	);
	assert.ok(resultTool);
	await resultTool.execute("result-1", { page_index: 0, page: "exact result", final: true }, undefined, undefined, {
		sessionManager: { getBranch: () => [] },
	});
	const result = appended.at(-1);
	assert.ok(result);
	assert.equal(result.type, RESULT_PAGE_CUSTOM_TYPE);
	assert.equal((result.data as { resultId?: string }).resultId, own.metadata.resultId);
});

test("stale context cleanup removes abandoned pairs but preserves fresh artifacts", async (t) => {
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "subagent-prune-test-"));
	t.after(() => fs.rm(agentDir, { recursive: true, force: true }));
	const stale = await createContextArtifact("stale", {
		agentId: "scout-1",
		generation: 1,
		resultId: "f".repeat(64),
		kind: "assignment",
		agentDir,
	});
	const fresh = await createContextArtifact("fresh", {
		agentId: "scout-2",
		generation: 1,
		resultId: "a".repeat(64),
		kind: "assignment",
		agentDir,
	});
	const staleToken = parseContextMarker(stale.marker);
	assert.ok(staleToken);
	const old = new Date(1_000);
	for (const suffix of [".context", ".json"]) {
		await fs.utimes(path.join(contextArtifactDirectory(agentDir), `${staleToken}${suffix}`), old, old);
	}
	assert.equal(await pruneStaleContextArtifacts({ agentDir, olderThanMs: 1_000, now: 3_000 }), 1);
	await assert.rejects(readContextArtifact(stale.marker, agentDir), /ENOENT/);
	assert.equal((await readContextArtifact(fresh.marker, agentDir)).content, "fresh");
});

test("persisted run boundaries recover generation-scoped usage and assistant fallback", async (t) => {
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "subagent-stats-test-"));
	t.after(() => fs.rm(agentDir, { recursive: true, force: true }));
	const sessionDir = path.join(agentDir, "subagent-sessions");
	await fs.mkdir(sessionDir, { recursive: true });
	const manager = SessionManager.create("/tmp/subagent-stats-project", sessionDir);
	const first = await createContextArtifact("first", {
		agentId: "general-1",
		generation: 1,
		resultId: "1".repeat(64),
		kind: "assignment",
		agentDir,
	});
	manager.appendCustomEntry(
		ACCEPTED_CONTEXT_CUSTOM_TYPE,
		acceptedContextData(first.metadata, { agent: "general", profile: "balanced" }),
	);
	manager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "first expanded assignment" }],
		timestamp: 1,
	});
	manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "first answer" }],
		api: "openai-responses",
		provider: "test",
		model: "test",
		usage: {
			input: 10,
			output: 4,
			cacheRead: 20,
			cacheWrite: 2,
			totalTokens: 36,
			cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
		},
		stopReason: "stop",
		timestamp: 2,
	});
	const second = await createContextArtifact("second", {
		agentId: "general-1",
		generation: 2,
		resultId: "2".repeat(64),
		kind: "followup",
		agentDir,
	});
	manager.appendCustomEntry(
		ACCEPTED_CONTEXT_CUSTOM_TYPE,
		acceptedContextData(second.metadata, { agent: "general", profile: "balanced" }),
	);
	manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "second answer" }],
		api: "openai-responses",
		provider: "test",
		model: "test",
		usage: {
			input: 99,
			output: 99,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 198,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 9 },
		},
		stopReason: "stop",
		timestamp: 3,
	});
	const sessionFile = manager.getSessionFile();
	assert.ok(sessionFile);
	const stats = await readChildRunStats(sessionFile, 1, first.metadata.resultId, agentDir);
	assert.deepEqual(stats.usage, {
		input: 10,
		output: 4,
		reasoning: 0,
		cacheRead: 20,
		cacheWrite: 2,
		cost: 1,
		turns: 1,
	});
	const result = await readStoredAgentResult(sessionFile, 1, first.metadata.resultId, agentDir);
	assert.equal(result.text, "first answer");
	assert.equal(result.source, "assistant_fallback");
});

test("exact multi-page results reconstruct and paginate without splitting Unicode", () => {
	const generation = 7;
	const resultId = "d".repeat(64);
	const entries: SessionEntry[] = [];
	const exact = `first\n${"🙂界".repeat(20_000)}\nlast`;
	const pieces: string[] = [];
	let current = "";
	let currentBytes = 0;
	for (const character of exact) {
		const bytes = Buffer.byteLength(character, "utf8");
		if (currentBytes + bytes > 30_000) {
			pieces.push(current);
			current = "";
			currentBytes = 0;
		}
		current += character;
		currentBytes += bytes;
	}
	pieces.push(current);
	for (const [index, page] of pieces.entries()) {
		const data = createResultPageData(entries, {
			generation,
			resultId,
			pageIndex: index,
			page,
			final: index === pieces.length - 1,
		});
		entries.push({
			type: "custom",
			id: String(index).padStart(8, "0"),
			parentId: index === 0 ? null : String(index - 1).padStart(8, "0"),
			timestamp: new Date(index).toISOString(),
			customType: RESULT_PAGE_CUSTOM_TYPE,
			data,
		});
	}
	const result = assembleResultPages(entries, generation, resultId);
	assert.equal(result.text, exact);
	assert.equal(result.complete, true);
	assert.equal(result.pageCount, pieces.length);

	let reconstructed = "";
	let cursor: string | undefined;
	do {
		const page = paginateStoredResult("worker-1", result, {
			...(cursor === undefined ? { offset: 0 } : { cursor }),
			maxBytes: 101,
		});
		reconstructed += page.text;
		cursor = page.next_cursor;
		assert.ok(Buffer.byteLength(page.text, "utf8") <= 101);
	} while (cursor !== undefined);
	assert.equal(reconstructed, exact);
});

test("validated session reads discover a prior generation result identity without a path argument", async (t) => {
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "subagent-result-session-"));
	t.after(() => fs.rm(agentDir, { recursive: true, force: true }));
	const sessionDir = path.join(agentDir, "subagent-sessions");
	await fs.mkdir(sessionDir, { recursive: true });
	const manager = SessionManager.create("/tmp/subagent-result-project", sessionDir);
	manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "Submitting the persisted result." }],
		api: "openai-responses",
		provider: "test",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	});
	const generation = 2;
	const resultId = "e".repeat(64);
	const data = createResultPageData(manager.getBranch(), {
		generation,
		resultId,
		pageIndex: 0,
		page: "prior exact result",
		final: true,
	});
	manager.appendCustomEntry(RESULT_PAGE_CUSTOM_TYPE, data);
	const sessionFile = manager.getSessionFile();
	assert.ok(sessionFile);
	const result = await readStoredAgentResult(sessionFile, generation, undefined, agentDir);
	assert.equal(result.resultId, resultId);
	assert.equal(result.text, "prior exact result");
	assert.equal(result.complete, true);
	await assert.rejects(
		readStoredAgentResult(path.join(agentDir, "outside.jsonl"), generation, resultId, agentDir),
		/escapes the managed subagent session directory/,
	);
});

test("registry restores result locators from persisted settlement entries", async (t) => {
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "subagent-restore-test-"));
	t.after(() => fs.rm(agentDir, { recursive: true, force: true }));
	const sessionDir = path.join(agentDir, "subagent-sessions");
	await fs.mkdir(sessionDir, { recursive: true });
	const manager = SessionManager.create("/tmp/subagent-restore-project", sessionDir);
	const generation = 1;
	const resultId = "9".repeat(64);
	manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "submitting" }],
		api: "openai-responses",
		provider: "test",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	});
	manager.appendCustomEntry(
		RESULT_PAGE_CUSTOM_TYPE,
		createResultPageData(manager.getBranch(), {
			generation,
			resultId,
			pageIndex: 0,
			page: "restored exact result",
			final: true,
		}),
	);
	const sessionFile = manager.getSessionFile();
	assert.ok(sessionFile);
	const parentEntries: SessionEntry[] = [
		{
			type: "custom",
			id: "settlement",
			parentId: null,
			timestamp: new Date().toISOString(),
			customType: SUBAGENT_SETTLEMENT_CUSTOM_TYPE,
			data: {
				agent_id: "worker-999999",
				session_file: sessionFile,
				generation,
				result: { result_id: resultId },
			},
		},
	];
	const registry = new AgentRegistry(agentDir);
	assert.equal(registry.restoreResultLocators(parentEntries), 1);
	const restored = await registry.readResult("worker-999999");
	assert.equal(restored.text, "restored exact result");
	assert.equal(restored.done, true);
});
