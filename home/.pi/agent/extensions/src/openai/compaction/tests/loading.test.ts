import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { createApplyPatchTool } from "../../../tools/apply-patch/register.ts";
import { buildRemoteCompactionDetails } from "../session-history.ts";

test("compaction loads and replays native session context through Pi's extension loader", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "compaction-loading-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const entry = fileURLToPath(new URL("../../../../index.ts", import.meta.url));
	const searchConfigPath = join(root, "search.json");
	const projectConfigPath = join(root, ".pi", "openai-server-compaction.json");
	await mkdir(join(root, ".pi"), { recursive: true });
	await writeFile(searchConfigPath, JSON.stringify({ enabled: true }));
	await writeFile(projectConfigPath, JSON.stringify({ enabled: true }));
	const previousSearchConfigPath = process.env.PI_CODEX_WEB_SEARCH_CONFIG;
	const previousCompactionEnabled = process.env.PI_OPENAI_SERVER_COMPACTION_ENABLED;
	process.env.PI_CODEX_WEB_SEARCH_CONFIG = searchConfigPath;
	process.env.PI_OPENAI_SERVER_COMPACTION_ENABLED = "true";
	let loaded: Awaited<ReturnType<typeof discoverAndLoadExtensions>>;
	try {
		loaded = await discoverAndLoadExtensions([entry], root, join(root, "agent"));
	} finally {
		if (previousSearchConfigPath === undefined) delete process.env.PI_CODEX_WEB_SEARCH_CONFIG;
		else process.env.PI_CODEX_WEB_SEARCH_CONFIG = previousSearchConfigPath;
		if (previousCompactionEnabled === undefined) delete process.env.PI_OPENAI_SERVER_COMPACTION_ENABLED;
		else process.env.PI_OPENAI_SERVER_COMPACTION_ENABLED = previousCompactionEnabled;
	}

	assert.deepEqual(loaded.errors, []);
	assert.equal(loaded.extensions.length, 1);
	assert.equal(loaded.extensions[0]!.handlers.get("session_before_compact")?.length, 1);
	assert.equal(loaded.extensions[0]!.handlers.get("before_provider_request")?.length, 1);

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
	const handlers = loaded.extensions[0]!.handlers.get("before_provider_request")!;
	let payload: Record<string, unknown> = {
		input: [],
		previous_response_id: "stale-chain",
		tools: [
			{ type: "function", name: "web_search" },
			{ type: "function", name: "read" },
		],
	};
	for (const handler of handlers) {
		const result = await handler({ type: "before_provider_request", payload }, ctx);
		if (result !== undefined) payload = result as Record<string, unknown>;
	}
	assert.deepEqual(payload.tools, [
		{ type: "function", name: "read" },
		{ type: "web_search", external_web_access: true },
	]);
	assert.deepEqual(payload.include, ["web_search_call.action.sources"]);
	assert.equal(payload.previous_response_id, undefined);
	const result = payload as { input: unknown[] };
	assert.partialDeepStrictEqual(result.input, [
		{ type: "compaction", encrypted_content: "opaque" },
		{ type: "message", role: "user", content: [{ type: "input_text", text: "Never edit secrets." }] },
		{ type: "message", role: "user", content: [{ type: "input_text", text: "corrected request" }] },
		{ type: "custom_tool_call", name: tool.name, input: patch },
		{ type: "custom_tool_call_output", output: "Success" },
	]);
	assert.doesNotMatch(JSON.stringify(result.input), /obsolete request/);
});
