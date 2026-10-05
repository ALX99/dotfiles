import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	createSyntheticSourceInfo,
	discoverAndLoadExtensions,
	SessionManager,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { createApplyPatchTool } from "../../codex-apply-patch/index.ts";
import { buildRemoteCompactionDetails } from "../session-history.ts";

test("compaction loads and replays native session context through Pi's extension loader", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "compaction-loading-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const entry = fileURLToPath(new URL("../index.ts", import.meta.url));

	const loaded = await discoverAndLoadExtensions([entry], root, join(root, "agent"));

	assert.deepEqual(loaded.errors, []);
	assert.equal(loaded.extensions.length, 1);
	assert.deepEqual([...loaded.extensions[0]!.handlers.keys()], ["session_before_compact", "before_provider_request"]);

	const model: Model<"openai-responses"> = {
		id: "test",
		name: "Test",
		provider: "openai",
		api: "openai-responses",
		baseUrl: "https://api.openai.com/v1",
		contextWindow: 10_000,
		maxTokens: 1_000,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		compat: { supportsOpenAIGrammarTools: true },
	};
	const tool = createApplyPatchTool();
	const session = SessionManager.inMemory(root);
	session.appendMessage({ role: "system", content: "system prompt", toolsAdded: [tool], timestamp: 0 });
	session.appendMessage({ role: "user", content: "before checkpoint", timestamp: 0 });
	session.appendCompaction("portable checkpoint", null, 1_000, {
		remoteCompaction: buildRemoteCompactionDetails(model, [{ type: "compaction", encrypted_content: "opaque" }]),
	});
	session.appendCustomMessageEntry("nested-context", "Never edit secrets.", false);
	const userId = session.appendMessage({ role: "user", content: "obsolete request", timestamp: 0 });
	session.appendContextEdit(userId, { content: "corrected request" });
	const patch = "*** Begin Patch\n*** Add File: file.txt\n+hello\n*** End Patch\n";
	session.appendMessage({
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content: [{ type: "toolCall", name: tool.name, id: "call_patch|ctc_patch", arguments: { patch } }],
		stopReason: "toolUse",
		timestamp: 0,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	});
	session.appendMessage({
		role: "toolResult",
		toolName: tool.name,
		toolCallId: "call_patch|ctc_patch",
		content: [{ type: "text", text: "Success" }],
		isError: false,
		timestamp: 0,
	});
	loaded.runtime.getActiveTools = () => [tool.name];
	loaded.runtime.getAllTools = () => [
		{
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
			exposure: "direct",
			sourceInfo: createSyntheticSourceInfo("test:apply_patch", { source: "test" }),
		},
	];
	const ctx = { cwd: root, hasUI: false, sessionManager: session, model } as unknown as ExtensionContext;
	const replay = loaded.extensions[0]!.handlers.get("before_provider_request")![0]!;
	const result = (await replay({ type: "before_provider_request", payload: { input: [] } }, ctx)) as {
		input: unknown[];
	};
	assert.partialDeepStrictEqual(result.input, [
		{ type: "compaction", encrypted_content: "opaque" },
		{ type: "message", role: "user", content: [{ type: "input_text", text: "Never edit secrets." }] },
		{ type: "message", role: "user", content: [{ type: "input_text", text: "corrected request" }] },
		{ type: "custom_tool_call", name: tool.name, input: patch },
		{ type: "custom_tool_call_output", output: "Success" },
	]);
	assert.doesNotMatch(JSON.stringify(result.input), /obsolete request/);
});
