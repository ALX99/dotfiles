import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	assertSameChildSession,
	getRpcSessionEntries,
	parseChildSessionIdentity,
	parseRpcSessionEntries,
	readChildSessionEntriesSince,
	type SessionCheckpoint,
	type SessionEntriesRpc,
} from "../session-cursors.ts";
import { validateChildSessionIdentity } from "../result-store.ts";

const EMPTY_CHECKPOINT: SessionCheckpoint = { appendCursor: null, leafId: null };

test("session checkpoints keep append and leaf cursors independent", async (t) => {
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "subagent-session-cursor-test-"));
	t.after(() => fs.rm(agentDir, { recursive: true, force: true }));
	const sessionDir = path.join(agentDir, "subagent-sessions");
	await fs.mkdir(sessionDir);
	const sessionFile = path.join(sessionDir, "empty.jsonl");
	await fs.writeFile(
		sessionFile,
		`${JSON.stringify({ type: "session", version: 3, id: "empty", timestamp: new Date().toISOString(), cwd: process.cwd() })}\n`,
	);

	assert.deepEqual(await readChildSessionEntriesSince(sessionFile, EMPTY_CHECKPOINT, agentDir), {
		entries: [],
		checkpoint: EMPTY_CHECKPOINT,
	});

	const commands: Array<Readonly<Record<string, unknown>>> = [];
	const rpc: SessionEntriesRpc = {
		async request(command) {
			commands.push(command);
			return { entries: [], leafId: null };
		},
	};
	const previous = { appendCursor: "persisted-append", leafId: "persisted-leaf" };
	assert.deepEqual(await getRpcSessionEntries(rpc, previous), {
		entries: [],
		checkpoint: { appendCursor: "persisted-append", leafId: null },
	});
	assert.deepEqual(commands, [{ type: "get_entries", since: "persisted-append" }]);
});

test("RPC entries advance only the append cursor", async () => {
	const previous = { appendCursor: "before", leafId: "old-leaf" };
	const entry = sessionEntry("appended");
	const rpc: SessionEntriesRpc = {
		async request() {
			return { entries: [entry], leafId: "older-leaf" };
		},
	};

	assert.deepEqual(await getRpcSessionEntries(rpc, previous), {
		entries: [entry],
		checkpoint: { appendCursor: "appended", leafId: "older-leaf" },
	});
});

test("session checkpoints preserve abandoned append cursors across branch movement", async (t) => {
	const { agentDir, manager, sessionFile } = await childSession(t);
	const root = appendMessage(manager, "root");
	const abandoned = appendMessage(manager, "abandoned");
	manager.branch(root);

	const rpc: SessionEntriesRpc = {
		async request(command) {
			const entries = manager.getEntries();
			const since = command.since;
			const start = typeof since === "string" ? entries.findIndex((entry) => entry.id === since) : -1;
			return { entries: entries.slice(start + 1), leafId: manager.getLeafId() };
		},
	};
	assert.deepEqual(await getRpcSessionEntries(rpc, { appendCursor: abandoned, leafId: abandoned }), {
		entries: [],
		checkpoint: { appendCursor: abandoned, leafId: root },
	});

	const retained = appendMessage(manager, "retained");
	assert.deepEqual(await getRpcSessionEntries(rpc, { appendCursor: abandoned, leafId: root }), {
		entries: [entryById(manager.getEntries(), retained)],
		checkpoint: { appendCursor: retained, leafId: retained },
	});
	assert.deepEqual(
		await readChildSessionEntriesSince(sessionFile, { appendCursor: abandoned, leafId: root }, agentDir),
		{
			entries: [entryById(manager.getEntries(), retained)],
			checkpoint: { appendCursor: retained, leafId: retained },
		},
	);
});

test("disk recovery rejects a missing non-null append cursor", async (t) => {
	const { agentDir, manager, sessionFile } = await childSession(t);
	appendMessage(manager, "entry");
	await assert.rejects(
		readChildSessionEntriesSince(sessionFile, { appendCursor: "missing", leafId: null }, agentDir),
		/append cursor 'missing' does not exist/,
	);
});

test("session checkpoints reject malformed RPC entries but accept compaction variants", () => {
	assert.throws(
		() => parseRpcSessionEntries({ entries: [], leafId: 1 }, EMPTY_CHECKPOINT),
		/invalid get_entries response/,
	);
	assert.throws(
		() =>
			parseRpcSessionEntries(
				{ entries: [{ id: "", parentId: null, timestamp: "now", type: "message" }], leafId: "bad" },
				EMPTY_CHECKPOINT,
			),
		/invalid get_entries entries/,
	);

	const compaction = { id: "compact", parentId: null, timestamp: "now", type: "compaction", summary: "legacy" };
	assert.deepEqual(parseRpcSessionEntries({ entries: [compaction], leafId: "compact" }, EMPTY_CHECKPOINT), {
		entries: [compaction],
		checkpoint: { appendCursor: "compact", leafId: "compact" },
	});
});

test("child session identity validation rejects missing and mismatched resume state", () => {
	assert.throws(() => parseChildSessionIdentity({ sessionFile: "/tmp/session.jsonl" }), /invalid session identity/);
	const identity = parseChildSessionIdentity({ sessionId: "session-1", sessionFile: "/tmp/session.jsonl" });
	assert.deepEqual(identity, { sessionId: "session-1", sessionFile: "/tmp/session.jsonl" });
	assert.throws(
		() => assertSameChildSession(identity, { sessionId: "session-2", sessionFile: identity.sessionFile }),
		/different session identity or file/,
	);
	assert.throws(
		() => assertSameChildSession(identity, { sessionId: identity.sessionId, sessionFile: "/tmp/other.jsonl" }),
		/different session identity or file/,
	);
});

test("child session identity admits Pi's prospective first-turn session file", async (t) => {
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "subagent-session-identity-test-"));
	t.after(() => fs.rm(agentDir, { recursive: true, force: true }));
	const sessionDir = path.join(agentDir, "subagent-sessions");
	await fs.mkdir(sessionDir);
	const sessionFile = path.join(sessionDir, "future.jsonl");

	assert.deepEqual(await validateChildSessionIdentity({ sessionId: "future-session", sessionFile }, agentDir), {
		sessionId: "future-session",
		sessionFile,
	});
	await assert.rejects(
		validateChildSessionIdentity({ sessionId: "outside", sessionFile: path.join(agentDir, "outside.jsonl") }, agentDir),
		/escapes the managed subagent session directory/,
	);
});

async function childSession(t: { after(callback: () => void | Promise<void>): void }): Promise<{
	readonly agentDir: string;
	readonly manager: SessionManager;
	readonly sessionFile: string;
}> {
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "subagent-session-cursor-test-"));
	t.after(() => fs.rm(agentDir, { recursive: true, force: true }));
	const manager = SessionManager.create(process.cwd(), path.join(agentDir, "subagent-sessions"));
	const sessionFile = manager.getSessionFile();
	assert.ok(sessionFile);
	return { agentDir, manager, sessionFile };
}

function appendMessage(manager: SessionManager, text: string): string {
	return manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text }],
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
		stopReason: "stop",
		timestamp: Date.now(),
	});
}

function sessionEntry(id: string): SessionEntry {
	return {
		id,
		parentId: null,
		timestamp: new Date().toISOString(),
		type: "custom",
		customType: "test",
	};
}

function entryById(entries: readonly SessionEntry[], id: string): SessionEntry {
	const entry = entries.find((candidate) => candidate.id === id);
	assert.ok(entry);
	return entry;
}
