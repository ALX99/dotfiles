import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { getModel } from "@earendil-works/pi-ai/compat";
import {
	createAgentSession,
	createToolSearchExtension,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type ExtensionFactory,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Check } from "typebox/value";

import { createSpawnAgentParams, registerSpawnAgentTool } from "../src/agents/tools.ts";
import type { AgentToolHandlers } from "../src/agents/tools.ts";
import { createCapabilityPolicy, installToolExecutionPolicy } from "../src/agents/policy.ts";
import { createToolSelection } from "../src/integration/tool-selection.ts";

test("Pi SDK isolates configured child sessions and restores normal JSONL history without a provider", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-agent-sdk-feasibility-"));
	t.after(() => rm(root, { recursive: true, force: true }));

	const first = await createHarness(root, "first", "claude-sonnet-4-5");
	const second = await createHarness(root, "second", "claude-opus-4-5");
	t.after(() => {
		first.session.dispose();
		second.session.dispose();
	});

	assert.equal(first.session.model?.id, "claude-sonnet-4-5");
	assert.equal(second.session.model?.id, "claude-opus-4-5");
	assert.notEqual(first.session.sessionId, second.session.sessionId);
	assert.equal(first.session.sessionManager.getCwd(), first.cwd);
	assert.equal(second.session.sessionManager.getCwd(), second.cwd);

	first.session.sessionManager.appendMessage({
		role: "user",
		content: "initial ordinary message",
		timestamp: Date.now(),
	});
	const sessionFile = first.session.sessionFile;
	assert.ok(sessionFile, "a normal user message materializes the JSONL session file");
	assert.match(await readFile(sessionFile, "utf8"), /initial ordinary message/);

	first.session.dispose();
	const restored = await createHarness(root, "first", "claude-sonnet-4-5", sessionFile);
	t.after(() => restored.session.dispose());

	assert.equal(restored.session.sessionId, first.session.sessionId);
	assert.equal(restored.session.model?.id, "claude-sonnet-4-5");
	assert.ok(
		restored.session.messages.some(
			(message) => message.role === "user" && message.content === "initial ordinary message",
		),
		"the reopened Pi session restores its ordinary conversation entry",
	);
});

test("Pi refreshes a same-name spawn_agent schema at session start", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-agent-spawn-schema-refresh-"));
	t.after(() => rm(root, { recursive: true, force: true }));

	const initialSchema: ToolDefinition["parameters"] = createSpawnAgentParams();
	const spawn: AgentToolHandlers["spawn"] = async () => ({
		content: [{ type: "text", text: "not invoked" }],
		details: {},
	});
	const factory: ExtensionFactory = (pi) => {
		registerSpawnAgentTool(pi, spawn);
		pi.on("session_start", () => {
			registerSpawnAgentTool(pi, spawn, ["engineer", "researcher"]);
		});
	};
	const harness = await createHarness(root, "schema-refresh", "claude-sonnet-4-5", undefined, [factory]);
	t.after(() => harness.session.dispose());

	assert.equal(Check(initialSchema, { profile: "designer", message: "Design the screen." }), true);

	const activeSchema = harness.session.getToolDefinition("spawn_agent")?.parameters;
	assert.ok(activeSchema);
	assert.equal(Check(activeSchema, { profile: "engineer", message: "Implement the feature." }), true);
	assert.equal(Check(activeSchema, { profile: "designer", message: "Design the screen." }), false);
	assert.ok(harness.session.getActiveToolNames().includes("spawn_agent"));
});

test("the Pi tool_call boundary blocks direct and nested deferred tools without a provider", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-agent-policy-feasibility-"));
	t.after(() => rm(root, { recursive: true, force: true }));

	let directExecutions = 0;
	let deferredExecutions = 0;
	const observed: Array<{ name: string; parentToolCallId?: string }> = [];
	const policy = createCapabilityPolicy({ name: "engineer", tools: ["outer"] });
	const factory: ExtensionFactory = (pi) => {
		pi.registerTool({
			name: "restricted_direct",
			label: "Restricted direct tool",
			description: "A direct tool denied by the test profile.",
			parameters: Type.Object({}),
			execute: async () => {
				directExecutions += 1;
				return { content: [{ type: "text", text: "unexpected execution" }], details: {} };
			},
		});
		pi.registerTool({
			name: "restricted_deferred",
			label: "Restricted deferred tool",
			description: "A lazy tool denied by the test profile.",
			parameters: Type.Object({}),
			exposure: "deferred",
			execute: async () => {
				deferredExecutions += 1;
				return { content: [{ type: "text", text: "unexpected execution" }], details: {} };
			},
		});
		pi.registerTool({
			name: "outer",
			label: "Outer tool",
			description: "Calls a deferred tool through Pi's nested execution API.",
			parameters: Type.Object({}),
			execute: async (_id, _params, _signal, _onUpdate, ctx) => {
				const result = await ctx.executeTool("restricted_deferred", {});
				return {
					content: [{ type: "text", text: result.isError ? "nested call blocked" : "nested call ran" }],
					details: {},
				};
			},
		});
		pi.on("tool_call", (event) => {
			if (event.toolName !== "restricted_direct" && event.toolName !== "restricted_deferred") return;
			observed.push({
				name: event.toolName,
				...(event.parentToolCallId === undefined ? {} : { parentToolCallId: event.parentToolCallId }),
			});
		});
		installToolExecutionPolicy(pi, policy);
	};
	const harness = await createHarness(root, "policy", "claude-sonnet-4-5", undefined, [factory]);
	t.after(() => harness.session.dispose());

	const { session } = harness;
	assert.ok(session.getActiveToolNames().includes("restricted_direct"));
	assert.ok(session.getActiveToolNames().includes("outer"));
	assert.ok(!session.getActiveToolNames().includes("restricted_deferred"));
	assert.ok(session.getCallableToolNames().includes("restricted_deferred"));

	const responses: Array<AssistantMessage["content"]> = [
		[{ type: "toolCall", id: "direct-call", name: "restricted_direct", arguments: {} }],
		[{ type: "text", text: "direct attempt finished" }],
		[{ type: "toolCall", id: "outer-call", name: "outer", arguments: {} }],
		[{ type: "text", text: "nested attempt finished" }],
	];
	session.agent.streamFunction = (model) => {
		const content = responses.shift();
		assert.ok(content, "the test provides a fake response for each provider request");
		const message: AssistantMessage = {
			role: "assistant",
			content,
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
			timestamp: Date.now(),
		};
		const stream = new AssistantMessageEventStream();
		const reason = message.stopReason as "toolUse" | "stop";
		stream.push({ type: "done", message, reason } satisfies AssistantMessageEvent);
		return stream;
	};

	await session.agent.prompt("Try the direct restricted tool.");
	await session.agent.prompt("Call the outer tool, which tries the deferred restricted tool.");

	assert.equal(directExecutions, 0);
	assert.equal(deferredExecutions, 0);
	assert.deepEqual(
		observed.map(({ name, parentToolCallId }) => ({ name, nested: parentToolCallId !== undefined })),
		[
			{ name: "restricted_direct", nested: false },
			{ name: "restricted_deferred", nested: true },
		],
		"the same SDK execution hook sees both direct and nested/deferred calls",
	);
	assert.equal(responses.length, 0, "all fake responses were used; no provider was contacted");
});

test("tool_search cannot activate a deferred tool outside the profile allowlist", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-agent-lazy-policy-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const previousAnthropicKey = process.env.ANTHROPIC_API_KEY;
	process.env.ANTHROPIC_API_KEY = "provider-free-test-key";
	t.after(() => {
		if (previousAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
		else process.env.ANTHROPIC_API_KEY = previousAnthropicKey;
	});
	const policy = createCapabilityPolicy({ name: "researcher", tools: ["allowed_deferred"] });
	let activeAtSessionStart: string[] = [];
	let registeredAtSessionStart: string[] = [];
	const factory: ExtensionFactory = (pi) => {
		createToolSearchExtension()(pi);
		pi.registerTool({
			name: "allowed_deferred",
			label: "Allowed deferred tool",
			description: "Search public documentation.",
			parameters: Type.Object({}),
			exposure: "deferred",
			execute: async () => ({ content: [{ type: "text", text: "allowed" }], details: {} }),
		});
		pi.registerTool({
			name: "restricted_deferred",
			label: "Restricted deferred tool",
			description: "Delete private records.",
			parameters: Type.Object({}),
			exposure: "deferred",
			execute: async () => ({ content: [{ type: "text", text: "should not run" }], details: {} }),
		});
		const selection = createToolSelection(pi, policy);
		installToolExecutionPolicy(pi, policy);
		pi.on("session_start", () => {
			pi.setActiveTools(["tool_search"]);
			selection.applyCapabilityPolicy();
			activeAtSessionStart = pi.getActiveTools();
			registeredAtSessionStart = pi.getAllTools().map((tool) => tool.name);
		});
		pi.on("tool_result", () => selection.applyCapabilityPolicy());
	};
	const harness = await createHarness(
		root,
		"lazy-policy",
		"claude-sonnet-4-5",
		undefined,
		[factory],
		["tool_search", "allowed_deferred"],
	);
	t.after(() => harness.session.dispose());

	const responses: Array<AssistantMessage["content"]> = [
		[{ type: "toolCall", id: "search-call", name: "tool_search", arguments: { query: "delete private records" } }],
		[{ type: "text", text: "Search complete." }],
	];
	harness.session.agent.streamFunction = (model) => {
		const content = responses.shift();
		assert.ok(content);
		const message: AssistantMessage = {
			role: "assistant",
			content,
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
			timestamp: Date.now(),
		};
		const stream = new AssistantMessageEventStream();
		stream.push({
			type: "done",
			message,
			reason: message.stopReason as "toolUse" | "stop",
		} satisfies AssistantMessageEvent);
		return stream;
	};

	await harness.session.prompt("Find the private deletion tool.");
	assert.ok(
		activeAtSessionStart.includes("tool_search"),
		`the profile permits the lazy tool discovery mechanism; active=${JSON.stringify(activeAtSessionStart)}; registered=${JSON.stringify(registeredAtSessionStart)}`,
	);
	assert.ok(!harness.session.getActiveToolNames().includes("restricted_deferred"));
	assert.ok(!harness.session.getActiveToolNames().includes("allowed_deferred"));
	assert.equal(responses.length, 0, "the test used only its fake provider responses");
});

async function createHarness(
	root: string,
	name: string,
	modelId: "claude-sonnet-4-5" | "claude-opus-4-5",
	sessionFile?: string,
	extensionFactories: ExtensionFactory[] = [],
	tools?: string[],
) {
	const cwd = join(root, `${name}-cwd`);
	const agentDir = join(root, `${name}-agent`);
	const sessionDir = join(root, `${name}-sessions`);
	await Promise.all([mkdir(cwd, { recursive: true }), mkdir(agentDir, { recursive: true })]);

	const model = getModel("anthropic", modelId);
	assert.ok(model, `the installed Pi model catalog contains ${modelId}`);
	const settingsManager = SettingsManager.inMemory();
	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
	});
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		extensionFactories,
	});
	await resourceLoader.reload();

	const sessionManager =
		sessionFile === undefined
			? SessionManager.create(cwd, sessionDir)
			: SessionManager.open(sessionFile, sessionDir, cwd);
	const { session, extensionsResult } = await createAgentSession({
		cwd,
		agentDir,
		model,
		modelRuntime,
		settingsManager,
		resourceLoader,
		sessionManager,
		noTools: "builtin",
		...(tools === undefined ? {} : { tools }),
		thinkingLevel: "off",
	});
	assert.deepEqual(extensionsResult.errors, []);
	await session.bindExtensions({ mode: "print" });
	return { cwd, session };
}
