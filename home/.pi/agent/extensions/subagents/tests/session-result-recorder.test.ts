import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { SessionResultRecorder } from "../session-result-recorder.ts";
import type { SessionEntriesRpc } from "../session-cursors.ts";

const resultId = "a".repeat(64);

test("records an initial boundary and settlement, then keeps follow-up cursors continuous", async () => {
	let entries: Array<Record<string, unknown>> = [];
	let leafId: string | null = null;
	const rpc: SessionEntriesRpc = {
		async request(command) {
			const since = typeof command.since === "string" ? entries.findIndex((entry) => entry.id === command.since) : -1;
			return { entries: entries.slice(since + 1), leafId };
		},
	};
	const capture = new SessionResultRecorder({
		agentId: "worker",
		agentDir: "/tmp",
		validateSessionIdentity: async (id) => id,
	});
	await capture.setIdentity({ sessionId: "session", sessionFile: "/tmp/session.jsonl" });
	await capture.prepareGeneration(rpc);
	entries = [message("one", null)];
	leafId = "one";
	assert.equal((await capture.captureSettlement(rpc, 1, resultId)).result.text, "one");
	await capture.prepareGeneration(rpc);
	entries.push(message("two", "one"));
	leafId = "two";
	assert.equal((await capture.captureSettlement(rpc, 2, resultId)).result.text, "two");
});

test("does not commit checkpoint or buffered entries when capture fails", async () => {
	let entries: Array<Record<string, unknown>> = [];
	let leafId: string | null = null;
	const rpc: SessionEntriesRpc = {
		async request(command) {
			const since = typeof command.since === "string" ? entries.findIndex((entry) => entry.id === command.since) : -1;
			return { entries: entries.slice(since + 1), leafId };
		},
	};
	const capture = new SessionResultRecorder({
		agentId: "worker",
		agentDir: "/tmp",
		validateSessionIdentity: async (id) => id,
	});
	await capture.setIdentity({ sessionId: "session", sessionFile: "/tmp/session.jsonl" });
	await capture.prepareGeneration(rpc);
	entries = [message("one", null)];
	leafId = "missing";
	await assert.rejects(capture.captureSettlement(rpc, 1, resultId), /outside its append range/);
	leafId = "one";
	assert.equal((await capture.captureSettlement(rpc, 1, resultId)).result.text, "one");
});

test("failed capture recovers the session delta from disk after transport loss", async (t) => {
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "generation-capture-test-"));
	t.after(() => fs.rm(agentDir, { recursive: true, force: true }));
	const manager = SessionManager.create(process.cwd(), path.join(agentDir, "subagent-sessions"));
	const sessionFile = manager.getSessionFile();
	assert.ok(sessionFile);
	const capture = new SessionResultRecorder({
		agentId: "worker",
		agentDir,
		validateSessionIdentity: async (id) => id,
	});
	await capture.setIdentity({ sessionId: manager.getSessionId(), sessionFile });
	await capture.prepareGeneration({
		async request() {
			return { entries: [], leafId: null };
		},
	});
	manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "recovered" }],
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
	const recovered = await capture.captureFailedGeneration({ isOpen: false } as never, 1, resultId);
	assert.equal(recovered?.result.text, "recovered");
});

function message(id: string, parentId: string | null): Record<string, unknown> {
	return {
		id,
		parentId,
		timestamp: new Date().toISOString(),
		type: "message",
		message: { role: "assistant", content: [{ type: "text", text: id }], stopReason: "stop" },
	};
}
