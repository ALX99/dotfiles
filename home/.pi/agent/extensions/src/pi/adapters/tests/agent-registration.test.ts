import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { Check } from "typebox/value";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionToolContext,
	ModelRegistry,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import type { ApplicationEffects } from "../../../application.ts";
import { createCapabilityPolicy } from "../../../agents/policy.ts";
import { installAgentAdapter } from "../agents.ts";

interface TestPi {
	readonly api: ExtensionAPI;
	readonly events: Map<string, Array<(event: unknown, context: unknown) => unknown>>;
	readonly tools: Map<string, ToolDefinition>;
	readonly start: (context: ExtensionContext) => Promise<void>;
	readonly shutdown: () => Promise<void>;
}

function testPi(): TestPi {
	const events = new Map<string, Array<(event: unknown, context: unknown) => unknown>>();
	const tools = new Map<string, ToolDefinition>();
	const api = {
		on(event: string, handler: (event: unknown, context: unknown) => unknown) {
			const handlers = events.get(event) ?? [];
			handlers.push(handler);
			events.set(event, handlers);
			return () => undefined;
		},
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool);
		},
		sendMessage() {},
	} as unknown as ExtensionAPI;
	return {
		api,
		events,
		tools,
		async start(sessionContext) {
			for (const handler of events.get("session_start") ?? []) {
				await handler({ type: "session_start", reason: "startup" }, sessionContext);
			}
		},
		async shutdown() {
			for (const handler of events.get("session_shutdown") ?? []) {
				await handler({ type: "session_shutdown", reason: "quit" }, {});
			}
		},
	};
}

const modelRegistry = {
	find: () => undefined,
	getRegisteredProviderIds: () => [],
	getRegisteredNativeProvider: () => undefined,
	getRegisteredProviderConfig: () => undefined,
} as unknown as ModelRegistry;

function context(sessionId: string, cwd: string): ExtensionContext {
	return {
		cwd,
		sessionManager: { getSessionId: () => sessionId },
		modelRegistry,
		isIdle: () => true,
	} as unknown as ExtensionContext;
}

const applicationEffects: ApplicationEffects = {
	run: (effect, options) => Effect.runPromise(effect, options),
	initiate: (effect) => Effect.runPromise(effect).then(() => undefined),
};

test("the Pi adapter binds parent and child tool surfaces to session-scoped workflows", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-agent-adapter-registration-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const agentDir = join(directory, "agent");
	await mkdir(agentDir, { recursive: true });
	const options = {
		agentDir,
		storeDirectory: join(directory, "registries"),
		sessionDirectory: join(directory, "sessions"),
		profileDirectory: join(directory, "profiles"),
	};

	const parent = testPi();
	installAgentAdapter(parent.api, applicationEffects, options);
	await parent.start(context("parent-session", directory));
	assert.ok(parent.tools.has("spawn_agent"));
	assert.ok(parent.tools.has("list_agents"));
	assert.ok(parent.tools.has("inspect_agent"));
	assert.equal(parent.tools.has("ask_parent"), false, "a root parent cannot ask itself");

	const answer = { askParent: () => Effect.succeed("Use Postgres.") };
	const child = testPi();
	const disposeChild = installAgentAdapter(child.api, applicationEffects, {
		...options,
		ownerAgentId: "engineer-agent-1",
		parentCommunication: answer,
		capabilityPolicy: createCapabilityPolicy({
			name: "engineer",
			spawnProfiles: ["researcher", "designer"],
		}),
	});
	await child.start(context("child-session", directory));
	assert.ok(child.tools.has("spawn_agent"), "child agents can spawn their own direct children");
	assert.ok(child.tools.has("ask_parent"), "only the child runtime receives ask_parent");
	const spawn = child.tools.get("spawn_agent");
	assert.ok(spawn);
	assert.equal(Check(spawn.parameters, { profile: "researcher", message: "Research the API." }), true);
	assert.equal(Check(spawn.parameters, { profile: "designer", message: "Design the screen." }), true);
	assert.equal(Check(spawn.parameters, { profile: "engineer", message: "Implement the feature." }), false);

	const askParent = child.tools.get("ask_parent");
	assert.ok(askParent);
	const result = await askParent.execute(
		"request-1",
		{ message: "Which database?", options: ["SQLite", "Postgres"] },
		undefined,
		undefined,
		context("child-session", directory) as unknown as ExtensionToolContext,
	);
	assert.deepEqual(result.details, { answer: "Use Postgres." });

	await disposeChild();
	await assert.rejects(
		Promise.resolve().then(() =>
			child.tools
				.get("list_agents")!
				.execute(
					"list-after-dispose",
					{},
					undefined,
					undefined,
					context("child-session", directory) as unknown as ExtensionToolContext,
				),
		),
		/Agent workflows are not ready/u,
		"the explicit adapter disposer closes session-scoped workflows without session_shutdown",
	);

	await child.shutdown();
	await parent.shutdown();
});
