import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { AgentRegistry, SUBAGENT_SETTLEMENT_CUSTOM_TYPE } from "../agent-registry.ts";
import {
	captureGeneration,
	paginateStoredResult,
	readLegacyResultPages,
	readLocatedAgentResult,
	type GenerationResultLocator,
} from "../result-store.ts";
import type { SessionCheckpoint } from "../session-cursors.ts";

test("native generation locator reads an exact final active branch", async (t) => {
	const { agentDir, manager } = await session(t);
	const start = checkpoint(manager);
	const user = manager.appendMessage({ role: "user", content: [{ type: "text", text: "work" }], timestamp: 1 });
	const answer = manager.appendMessage(assistant("answer", 2));
	const end = checkpoint(manager);
	const captured = captureGeneration(
		{ sessionId: manager.getSessionId(), sessionFile: sessionFile(manager) },
		1,
		"a".repeat(64),
		start,
		end,
		entriesAfter(manager.getEntries(), start),
	);
	assert.equal(captured.result.text, "answer");
	assert.equal(captured.locator.resultEntryId, answer);
	assert.equal(user.length > 0, true);
	assert.equal((await readLocatedAgentResult(captured.locator, agentDir)).text, "answer");
});

test("append accounting includes abandoned retry entries while result selection follows the final leaf", async (t) => {
	const { agentDir, manager } = await session(t);
	const start = checkpoint(manager);
	manager.appendMessage({
		...assistant("", 1),
		content: [],
		usage: { ...assistant("", 1).usage, input: 4, totalTokens: 5 },
		stopReason: "error",
		errorMessage: "retry me",
	});
	manager.appendMessage({
		role: "toolResult",
		toolCallId: "edit-1",
		toolName: "edit",
		content: [],
		isError: false,
		timestamp: 2,
	});
	manager.resetLeaf();
	const final = manager.appendMessage(assistant("active final", 3));
	manager.appendMessage(assistant("abandoned late result", 4));
	manager.branch(final);
	const end = checkpoint(manager);
	const captured = captureGeneration(
		{ sessionId: manager.getSessionId(), sessionFile: sessionFile(manager) },
		1,
		"d".repeat(64),
		start,
		end,
		entriesAfter(manager.getEntries(), start),
	);

	assert.notEqual(end.appendCursor, end.leafId);
	assert.equal(captured.result.text, "active final");
	assert.equal(captured.locator.resultEntryId, final);
	assert.equal(captured.assistantError, undefined);
	assert.equal(captured.stats.usage.input, 6);
	assert.equal(captured.stats.usage.turns, 3);
	assert.equal(captured.stats.mutationToolCalls, 1);
	assert.equal((await readLocatedAgentResult(captured.locator, agentDir)).text, "active final");

	await assert.rejects(
		readLocatedAgentResult({ ...captured.locator, sessionId: "wrong-session" }, agentDir),
		/session identity/,
	);
});

test("native locators reject unknown and branch-divergent cursors", async (t) => {
	const { manager } = await session(t);
	manager.appendMessage(assistant("prior", 1));
	const start = checkpoint(manager);
	manager.appendMessage(assistant("answer", 2));
	const end = checkpoint(manager);
	const locator = captureGeneration(
		{ sessionId: manager.getSessionId(), sessionFile: sessionFile(manager) },
		1,
		"b".repeat(64),
		start,
		end,
		entriesAfter(manager.getEntries(), start),
	).locator;
	const unknown: GenerationResultLocator = { ...locator, end: { ...locator.end, appendCursor: "missing" } };
	await assert.rejects(
		readLocatedAgentResult(unknown, path.dirname(path.dirname(sessionFile(manager)))),
		/cursor 'missing'/,
	);
	assert.ok(start.leafId);
	if (start.leafId === null) manager.resetLeaf();
	else manager.branch(start.leafId);
	const fork = manager.appendMessage(assistant("fork", 3));
	assert.ok(fork);
	const divergent: GenerationResultLocator = { ...locator, end: { appendCursor: fork, leafId: fork } };
	await assert.rejects(
		readLocatedAgentResult(divergent, path.dirname(path.dirname(sessionFile(manager)))),
		/integrity|descended|outside/,
	);
});

test("restart restoration preserves multiple native generations for one agent", async (t) => {
	const { agentDir, manager } = await session(t);
	const locators = [1, 2].map((generation) => {
		const start = checkpoint(manager);
		manager.appendMessage(assistant(`generation ${generation}`, generation));
		const end = checkpoint(manager);
		return captureGeneration(
			{ sessionId: manager.getSessionId(), sessionFile: sessionFile(manager) },
			generation,
			String(generation).repeat(64),
			start,
			end,
			entriesAfter(manager.getEntries(), start),
		).locator;
	});
	const parent: SessionEntry[] = locators.map((locator, index) => ({
		type: "custom",
		id: `settlement-${index}`,
		parentId: index === 0 ? null : `settlement-${index - 1}`,
		timestamp: new Date().toISOString(),
		customType: SUBAGENT_SETTLEMENT_CUSTOM_TYPE,
		data: { agent_id: "worker-1", result_locator: locator },
	}));
	const registry = new AgentRegistry(agentDir);
	assert.equal(registry.restoreResultLocators(parent), 2);
	assert.equal((await registry.readResult("worker-1", { generation: 1 })).text, "generation 1");
	assert.equal((await registry.readResult("worker-1", { generation: 2 })).text, "generation 2");
});

test("v1 custom result pages and pagination remain readable", () => {
	const resultId = "c".repeat(64);
	const first = "legacy 🙂 ";
	const second = "result";
	const result = readLegacyResultPages(
		[legacyPage("one", 0, first, false, first, resultId), legacyPage("two", 1, second, true, first + second, resultId)],
		3,
		resultId,
	);
	const page = paginateStoredResult("worker", result, { maxBytes: 8 });
	assert.equal(page.text, "legacy ");
	assert.ok(page.next_cursor);
	assert.equal(paginateStoredResult("worker", result, { cursor: page.next_cursor, maxBytes: 8 }).text, "🙂 res");
});

async function session(t: { after(callback: () => void | Promise<void>): void }) {
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "subagent-native-locator-"));
	t.after(() => fs.rm(agentDir, { recursive: true, force: true }));
	const manager = SessionManager.create(process.cwd(), path.join(agentDir, "subagent-sessions"));
	return { agentDir, manager };
}

function checkpoint(manager: SessionManager): SessionCheckpoint {
	const entries = manager.getEntries();
	return { appendCursor: entries.at(-1)?.id ?? null, leafId: manager.getLeafId() };
}

function entriesAfter(entries: readonly SessionEntry[], start: SessionCheckpoint): readonly SessionEntry[] {
	const index = start.appendCursor === null ? -1 : entries.findIndex((entry) => entry.id === start.appendCursor);
	return entries.slice(index + 1);
}

function assistant(text: string, timestamp: number) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "openai-responses",
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
		stopReason: "stop" as const,
		timestamp,
	};
}

function legacyPage(
	id: string,
	pageIndex: number,
	page: string,
	final: boolean,
	total: string,
	resultId: string,
): SessionEntry {
	return {
		type: "custom",
		id,
		parentId: null,
		timestamp: new Date().toISOString(),
		customType: "subagent-result-page",
		data: {
			version: 1,
			generation: 3,
			resultId,
			pageIndex,
			final,
			page,
			pageBytes: Buffer.byteLength(page),
			pageSha256: hash(page),
			totalBytes: Buffer.byteLength(total),
			totalSha256: hash(total),
		},
	};
}

function hash(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function sessionFile(manager: SessionManager): string {
	const file = manager.getSessionFile();
	assert.ok(file);
	return file;
}
