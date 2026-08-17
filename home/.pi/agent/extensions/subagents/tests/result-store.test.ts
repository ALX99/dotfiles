import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { ResultCatalog, readLocatedAgentResult, storedResult } from "../result-store.ts";

test("a compact native entry locator restores and pages an exact result", async (t) => {
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-result-test-"));
	t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
	const manager = SessionManager.create(agentDir, path.join(agentDir, "subagent-sessions"));
	const text = "done\n界".repeat(2_000);
	const entryId = manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason: "stop",
	} as never);
	const result = storedResult(1, "a".repeat(64), text, true);
	const locator = {
		version: 2 as const,
		generation: 1,
		resultId: result.resultId,
		sessionId: manager.getSessionId(),
		sessionFile: manager.getSessionFile()!,
		resultEntryId: entryId,
		resultSha256: result.sha256,
	};
	assert.deepEqual(await readLocatedAgentResult(locator, agentDir), result);

	const catalog = new ResultCatalog(agentDir);
	catalog.record("agent-1", locator);
	let textRead = "";
	let cursor: string | undefined;
	do {
		const page = await catalog.readResult("agent-1", {
			maxBytes: 1_024,
			...(cursor === undefined ? {} : { cursor }),
		});
		assert.ok(Buffer.byteLength(page.text) <= 1_024);
		textRead += page.text;
		cursor = page.next_cursor;
	} while (cursor);
	assert.equal(textRead, text);
});

test("a locator cannot treat a missing native result entry as an empty result", async (t) => {
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-result-test-"));
	t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
	const manager = SessionManager.create(agentDir, path.join(agentDir, "subagent-sessions"));
	manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "unrelated" }],
		stopReason: "stop",
	} as never);
	const result = storedResult(1, "a".repeat(64), "", false);
	await assert.rejects(
		readLocatedAgentResult(
			{
				version: 2,
				generation: 1,
				resultId: result.resultId,
				sessionId: manager.getSessionId(),
				sessionFile: manager.getSessionFile()!,
				resultEntryId: "missing-entry",
				resultSha256: result.sha256,
			},
			agentDir,
		),
		/missing or is not an assistant message/,
	);
});

test("result catalog restores locators from both foreground tool details and background settlements", () => {
	const locator = {
		version: 2 as const,
		generation: 3,
		resultId: "a".repeat(64),
		sessionId: "child-session",
		sessionFile: "/managed/subagent-sessions/child.jsonl",
		resultEntryId: "entry",
		resultSha256: "b".repeat(64),
	};
	const catalog = new ResultCatalog();
	assert.equal(
		catalog.restore([
			{
				type: "message",
				message: { role: "toolResult", details: { agentId: "foreground-1", resultLocator: locator } },
			},
			{
				type: "message",
				message: { role: "toolResult", details: { summaries: [{ agent_id: "wait-1", result_locator: locator }] } },
			},
			{
				type: "custom",
				customType: "subagent-settlement",
				data: { agent_id: "background-1", result_locator: locator },
			},
		] as never),
		3,
	);
});
