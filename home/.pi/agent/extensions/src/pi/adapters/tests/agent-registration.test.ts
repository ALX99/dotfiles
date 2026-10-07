import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { Check } from "typebox/value";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionToolContext,
	ModelRegistry,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import type { ApplicationEffects } from "../../../application.ts";
import type { ProfileSnapshot } from "../../../agents/profile.ts";
import { createActiveProfileState } from "../../../agents/active-profile.ts";
import { createCapabilityPolicy } from "../../../agents/policy.ts";
import { openAgentStore } from "../../../agents/store.ts";
import { createToolSelection } from "../../../integration/tool-selection.ts";
import { runPromise } from "../../../support/effect-runtime.ts";
import { installAgentAdapter } from "../agents.ts";

interface TestCommand {
	readonly handler: (args: string, context: ExtensionCommandContext) => Promise<void>;
}

interface TestPi {
	readonly api: ExtensionAPI;
	readonly events: Map<string, Array<(event: unknown, context: unknown) => unknown>>;
	readonly tools: Map<string, ToolDefinition>;
	readonly commands: Map<string, TestCommand>;
	readonly activeTools: string[];
	readonly modelChanges: unknown[];
	readonly thinkingLevels: string[];
	readonly start: (context: ExtensionContext) => Promise<void>;
	readonly runCommand: (name: string, args: string, context: ExtensionCommandContext) => Promise<void>;
	readonly shutdown: () => Promise<void>;
}

function testPi(
	options: {
		readonly existingCommands?: readonly string[];
		readonly setModel?: (model: unknown) => Promise<boolean>;
	} = {},
): TestPi {
	const events = new Map<string, Array<(event: unknown, context: unknown) => unknown>>();
	const tools = new Map<string, ToolDefinition>();
	const commands = new Map<string, TestCommand>();
	const activeTools = ["read", "bash", "edit"];
	const modelChanges: unknown[] = [];
	const thinkingLevels: string[] = [];
	const api = {
		on(event: string, handler: (event: unknown, context: unknown) => unknown) {
			const handlers = events.get(event) ?? [];
			handlers.push(handler);
			events.set(event, handlers);
			return () => undefined;
		},
		registerCommand(name: string, command: TestCommand) {
			commands.set(name, command);
		},
		getCommands: () => [
			...(options.existingCommands ?? []).map((name) => ({ name })),
			...[...commands.keys()].map((name) => ({ name })),
		],
		getActiveTools: () => [...activeTools],
		setActiveTools(names: string[]) {
			activeTools.splice(0, activeTools.length, ...names);
		},
		setModel: async (model: unknown) => {
			modelChanges.push(model);
			return options.setModel?.(model) ?? true;
		},
		setThinkingLevel: (level: string) => thinkingLevels.push(level),
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool);
		},
		sendMessage() {},
	} as unknown as ExtensionAPI;
	return {
		api,
		events,
		tools,
		commands,
		activeTools,
		modelChanges,
		thinkingLevels,
		async start(sessionContext) {
			for (const handler of events.get("session_start") ?? []) {
				await handler({ type: "session_start", reason: "startup" }, sessionContext);
			}
		},
		async runCommand(name, args, commandContext) {
			const command = commands.get(name);
			assert.ok(command, `/${name} is registered`);
			await command.handler(args, commandContext);
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

test("footer projections are scoped to the active parent and stale completions are ignored", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-agent-footer-scope-"));
	t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 10 }));
	const registryDirectory = join(directory, "registries");
	const sessionDirectory = join(directory, "sessions");
	const agentDir = join(directory, "agent");
	const profile: ProfileSnapshot = {
		name: "worker",
		model: { provider: "test", id: "model" },
		prompt: "A worker profile.",
		sourcePath: "/profiles/worker.md",
	};
	for (const [parentId, childId] of [
		["parent-one", "old-child"],
		["parent-two", "new-child"],
	] as const) {
		const store = await runPromise(openAgentStore({ ownerSessionId: parentId, directory: registryDirectory }));
		await runPromise(
			store.createAgent({
				profile,
				sessionId: `${childId}-session`,
				cwd: directory,
				invocationId: `${childId}-invocation`,
				createdAt: 1,
			}),
		);
	}

	const delayedProjections: Array<() => Promise<void>> = [];
	const isFooterProjection = (value: unknown): boolean =>
		Array.isArray(value) &&
		value.some(
			(row: unknown) =>
				typeof row === "object" && row !== null && "id" in row && typeof row.id === "string" && "contextTokens" in row,
		);
	const controlledEffects: ApplicationEffects = {
		run<A, E>(effect: Effect.Effect<A, E>, options?: { readonly signal?: AbortSignal | undefined }) {
			return Effect.runPromise(effect, options).then((value) => {
				if (!isFooterProjection(value)) return value;
				return new Promise<A>((resolve) => {
					delayedProjections.push(async () => {
						resolve(value);
					});
				});
			});
		},
		initiate: (effect) => Effect.runPromise(effect).then(() => undefined),
	};
	const visibleSnapshots: string[][] = [];
	const pi = testPi();
	const dispose = installAgentAdapter(pi.api, controlledEffects, {
		agentDir,
		storeDirectory: registryDirectory,
		sessionDirectory,
		onFooterRows: (rows) => visibleSnapshots.push(rows.map(({ id }) => id)),
	});

	await pi.start(context("parent-one", directory));
	await t.waitFor(() => assert.equal(delayedProjections.length, 1), { interval: 10, timeout: 1_000 });

	await pi.start(context("parent-two", directory));
	await t.waitFor(() => assert.equal(delayedProjections.length, 2), { interval: 10, timeout: 1_000 });

	await delayedProjections[0]!();
	await Promise.resolve();
	assert.ok(
		visibleSnapshots.every((ids) => !ids.includes("worker-agent-1")),
		"the previous parent snapshot cannot replace the active parent's rows",
	);

	await pi.shutdown();
	await delayedProjections[1]!();
	await Promise.resolve();
	assert.ok(
		visibleSnapshots.every((ids) => ids.length === 0),
		"a projection that completes after close cannot repopulate the footer",
	);
	await dispose();
});

test("profile commands switch the root session atomically and preserve the base tool selection", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-profile-command-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const profiles = join(directory, "profiles");
	await mkdir(profiles, { recursive: true });
	await writeFile(
		join(profiles, "researcher.md"),
		[
			"---",
			"model: test/research:high",
			"tools: [read]",
			"skills: [research]",
			"spawn_profiles: []",
			"---",
			"Separate evidence from inference.",
		].join("\n"),
	);
	await writeFile(join(profiles, "general.md"), "---\nmodel: test/general\n---\nUse the normal assistant role.\n");
	await writeFile(join(profiles, "unavailable.md"), "---\nmodel: test/later\n---\nThis model may disappear.\n");
	await writeFile(join(profiles, "broken.md"), "---\nmodel: not-a-model\n---\nInvalid profile.\n");
	await writeFile(join(profiles, "taken.md"), "---\nmodel: test/general\n---\nThis command collides.\n");

	const registeredModels = new Map([
		["test/research", { provider: "test", id: "research" }],
		["test/general", { provider: "test", id: "general" }],
		["test/later", { provider: "test", id: "later" }],
	]);
	let unavailableAtInvocation = false;
	let modelSwitchSucceeds = true;
	const registry = {
		find: (provider: string, id: string) =>
			unavailableAtInvocation && id === "later" ? undefined : registeredModels.get(`${provider}/${id}`),
		getRegisteredProviderIds: () => [],
		getRegisteredNativeProvider: () => undefined,
		getRegisteredProviderConfig: () => undefined,
	} as unknown as ModelRegistry;
	const notifications: string[] = [];
	const pi = testPi({
		existingCommands: ["taken"],
		setModel: async () => modelSwitchSucceeds,
	});
	const activeProfile = createActiveProfileState(createToolSelection(pi.api));
	const options = {
		agentDir: join(directory, "agent"),
		storeDirectory: join(directory, "registries"),
		sessionDirectory: join(directory, "sessions"),
		profileDirectory: profiles,
		activeProfile,
	};
	installAgentAdapter(pi.api, applicationEffects, options);
	await pi.start({
		...context("profile-session", directory),
		modelRegistry: registry,
		hasUI: true,
		ui: { notify: (message: string) => notifications.push(message) },
	} as unknown as ExtensionContext);

	assert.deepEqual([...pi.commands.keys()].toSorted(), ["general", "researcher", "unavailable"]);
	assert.ok(!pi.commands.has("broken"), "invalid profile files do not register commands");
	assert.ok(!pi.commands.has("taken"), "profiles do not shadow an existing slash command");
	assert.ok(notifications.some((message) => message.includes("Could not load profile")));

	const commandContext = {
		...context("profile-session", directory),
		modelRegistry: registry,
		hasUI: true,
		ui: { notify: (message: string) => notifications.push(message) },
		waitForIdle: async () => {},
	} as unknown as ExtensionCommandContext;

	await pi.runCommand("researcher", "some message", commandContext);
	assert.equal(activeProfile.getProfile(), undefined, "a profile command does not consume message text");
	assert.deepEqual(pi.modelChanges, []);

	await pi.runCommand("researcher", "", commandContext);
	assert.deepEqual(pi.modelChanges, [registeredModels.get("test/research")]);
	assert.deepEqual(pi.thinkingLevels, ["high"]);
	assert.equal(activeProfile.getProfile()?.name, "researcher");
	assert.equal(activeProfile.getPolicy()?.allowsSpawnProfile("researcher"), false);
	assert.deepEqual(pi.activeTools, ["read"]);
	const restrictedDispatch = (pi.events.get("tool_call") ?? []).map((handler) =>
		handler({ toolName: "edit" }, commandContext),
	);
	assert.ok(
		restrictedDispatch.some(
			(result) => typeof result === "object" && result !== null && "block" in result && result.block === true,
		),
		"the active profile policy also blocks direct tool dispatch",
	);

	modelSwitchSucceeds = false;
	await pi.runCommand("general", "", commandContext);
	assert.equal(
		activeProfile.getProfile()?.name,
		"researcher",
		"missing credentials leave the active profile unchanged",
	);
	assert.deepEqual(pi.activeTools, ["read"]);
	assert.ok(notifications.some((message) => message.includes("profile was not changed")));

	unavailableAtInvocation = true;
	await pi.runCommand("unavailable", "", commandContext);
	assert.equal(activeProfile.getProfile()?.name, "researcher", "a model removed after discovery is not applied");
	assert.deepEqual(pi.activeTools, ["read"]);
	assert.ok(notifications.some((message) => message.includes("Model not found for profile")));

	unavailableAtInvocation = false;
	modelSwitchSucceeds = true;
	await pi.runCommand("general", "", commandContext);
	assert.equal(activeProfile.getProfile()?.name, "general");
	assert.equal(activeProfile.getPolicy()?.allowsTool("edit"), true);
	assert.deepEqual(pi.activeTools, ["read", "bash", "edit"], "a broader profile restores the original selection");
	assert.ok(
		(pi.events.get("tool_call") ?? []).every((handler) => handler({ toolName: "edit" }, commandContext) === undefined),
		"the new active profile policy is used at the dispatch boundary",
	);
	assert.equal(pi.thinkingLevels.length, 1, "profiles without a thinking level do not change it");

	await pi.shutdown();
});
