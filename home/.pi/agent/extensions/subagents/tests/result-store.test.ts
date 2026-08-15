import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { ResultCatalog, readLocatedAgentResult, storedResult } from "../result-store.ts";

test("a compact native entry locator restores an exact result with bounded pages", async (t) => {
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
	const restored = await readLocatedAgentResult(
		{
			version: 2,
			generation: 1,
			resultId: result.resultId,
			sessionId: manager.getSessionId(),
			sessionFile: manager.getSessionFile()!,
			resultEntryId: entryId,
			resultSha256: result.sha256,
		},
		agentDir,
	);
	assert.deepEqual(restored, result);
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
				type: "custom",
				customType: "subagent-settlement",
				data: { agent_id: "background-1", result_locator: locator },
			},
		] as never),
		2,
	);
});
