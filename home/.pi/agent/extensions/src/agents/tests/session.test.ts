import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Result } from "effect";

import { runPromise } from "../../support/effect-runtime.ts";
import { AgentStateError } from "../state.ts";
import { openAgentStore } from "../store.ts";
import { applyProfileThinkingLevel, classifyInvocationOutcome, createAgentSessionOwner } from "../session.ts";
import { parseProfile, type ProfileModelLookup } from "../profile.ts";

const modelLookup: ProfileModelLookup = {
	find: (provider, id) => (provider === "anthropic" && id === "claude-sonnet-4-5" ? { provider, id } : undefined),
};

function profile(name = "engineer", skills?: readonly string[], tools?: readonly string[], thinkingLevel?: string) {
	const skillsField = skills === undefined ? "" : `skills: [${skills.join(", ")}]\n`;
	const toolsField = tools === undefined ? "" : `tools: [${tools.join(", ")}]\n`;
	const parsed = parseProfile(
		name,
		`/profiles/${name}.md`,
		`---\nmodel: anthropic/claude-sonnet-4-5${thinkingLevel === undefined ? "" : `:${thinkingLevel}`}\n${toolsField}${skillsField}---\nKeep the implementation careful and tested.\n`,
		modelLookup,
	);
	if (Result.isFailure(parsed)) assert.fail(parsed.failure.message);
	return parsed.success;
}

test("child agents keep stable IDs, inherit or override cwd, and continue one normal JSONL session", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-agent-session-owner-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const agentDir = join(root, "agent-config");
	const previousAnthropicKey = process.env.ANTHROPIC_API_KEY;
	process.env.ANTHROPIC_API_KEY = "provider-free-test-key";
	t.after(() => {
		if (previousAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
		else process.env.ANTHROPIC_API_KEY = previousAnthropicKey;
	});
	const cwd = join(root, "parent-cwd");
	const explicitCwd = join(root, "explicit-cwd");
	await Promise.all([
		mkdir(agentDir, { recursive: true }),
		mkdir(cwd, { recursive: true }),
		mkdir(explicitCwd, { recursive: true }),
		mkdir(join(agentDir, "skills", "allowed-skill"), { recursive: true }),
		mkdir(join(agentDir, "skills", "denied-skill"), { recursive: true }),
	]);
	await Promise.all([
		writeFile(
			join(agentDir, "skills", "allowed-skill", "SKILL.md"),
			"---\nname: allowed-skill\ndescription: A permitted test skill.\n---\nAllowed instructions.\n",
		),
		writeFile(
			join(agentDir, "skills", "denied-skill", "SKILL.md"),
			"---\nname: denied-skill\ndescription: A restricted test skill.\n---\nDenied instructions.\n",
		),
	]);

	const registryDirectory = join(root, "registry");
	const storeOptions = { ownerSessionId: "parent-session", directory: registryDirectory };
	const store = await runPromise(openAgentStore(storeOptions));
	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	const replies: AssistantMessage["content"][] = [
		[{ type: "text", text: "First response." }],
		[{ type: "text", text: "Second response in the same session." }],
		[{ type: "text", text: "Response after reopening the child runtime." }],
	];
	const observedSystemMessages: string[] = [];
	let nestedAdapterDisposals = 0;
	const owner = await runPromise(
		createAgentSessionOwner({
			store,
			parentCwd: cwd,
			agentDir,
			sessionDirectory: join(root, "sessions"),
			modelRuntime,
			noConfiguredExtensions: true,
			extensionFactories: (_agent, _observation, _runtime, registerDisposer) => [
				() => {
					registerDisposer(() => {
						nestedAdapterDisposals += 1;
					});
				},
			],
			onSessionCreated(session) {
				session.agent.streamFunction = (model, context) => {
					observedSystemMessages.push(
						JSON.stringify(context.messages.filter((message) => message.role === "system")) ?? "",
					);
					const content = replies.shift();
					assert.ok(content, "each child invocation receives one deterministic model response");
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
						stopReason: "stop",
						timestamp: Date.now(),
					};
					const stream = new AssistantMessageEventStream();
					stream.push({ type: "done", message, reason: "stop" } satisfies AssistantMessageEvent);
					return stream;
				};
			},
		}),
	);
	t.after(() => runPromise(owner.dispose()));

	const initial = await runPromise(owner.registerAgent(profile("engineer", ["allowed-skill"], ["read"], "off")));
	const explicit = await runPromise(owner.registerAgent(profile("designer", []), explicitCwd));
	assert.equal(initial.id, "engineer-agent-1");
	assert.equal(explicit.id, "designer-agent-1");
	assert.equal(initial.cwd, cwd);
	assert.equal(explicit.cwd, explicitCwd);

	const first = await runPromise(owner.invoke(initial.id, "First ordinary user message."));
	assert.equal(first.status, "settled", first.error ?? "");
	assert.ok(
		(await runPromise(owner.getActivity(initial.id))).some(
			(event) => event.type === "output" && event.content.includes("First response."),
		),
		"inspection includes observable model output from the live session",
	);
	const session = await runPromise(owner.getSession(initial.id));
	assert.ok(session);
	assert.equal(session.sessionId, initial.sessionId);
	assert.equal(session.sessionManager.getCwd(), cwd);
	assert.equal(session.model?.id, "claude-sonnet-4-5");
	assert.equal(session.thinkingLevel, "off", "the profile thinking level is applied before the first prompt");
	assert.ok(
		observedSystemMessages[0]?.includes("Profile instructions (engineer)"),
		"the provider request includes the profile layer composed with Pi's normal prompt",
	);
	assert.deepEqual(
		session.resourceLoader.getSkills().skills.map(({ name }) => name),
		["allowed-skill"],
		"the native child resource loader exposes only skills permitted by its profile snapshot",
	);
	assert.ok(session.getActiveToolNames().includes("read"));
	assert.ok(!session.getActiveToolNames().includes("bash"), "the profile allowlist also restricts activation");

	const second = await runPromise(owner.invoke(initial.id, "Continue the existing conversation."));
	assert.equal(second.status, "settled", second.error ?? "");
	assert.equal(second.invocationId === first.invocationId, false);
	assert.equal((await runPromise(owner.getSession(initial.id)))?.sessionId, initial.sessionId);
	assert.equal(replies.length, 1);

	const sessionFile = session.sessionFile;
	assert.ok(sessionFile, "normal user messages materialize a regular Pi JSONL session");
	const jsonl = await readFile(sessionFile, "utf8");
	assert.match(jsonl, /First ordinary user message\./u);
	assert.match(jsonl, /Continue the existing conversation\./u);
	assert.match(jsonl, /Second response in the same session\./u);
	assert.equal((await runPromise(store.getAgent(initial.id)))?.status, "settled");

	await runPromise(owner.dispose());
	assert.equal(nestedAdapterDisposals, 1, "disposing the child session closes nested extension resources");
	const restartedStore = await runPromise(openAgentStore(storeOptions));
	const restartedOwner = await runPromise(
		createAgentSessionOwner({
			store: restartedStore,
			parentCwd: cwd,
			agentDir,
			sessionDirectory: join(root, "sessions"),
			modelRuntime,
			noConfiguredExtensions: true,
			onSessionCreated(childSession) {
				childSession.agent.streamFunction = (model, context) => {
					observedSystemMessages.push(
						JSON.stringify(context.messages.filter((entry) => entry.role === "system")) ?? "",
					);
					const content = replies.shift();
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
						stopReason: "stop",
						timestamp: Date.now(),
					};
					const stream = new AssistantMessageEventStream();
					stream.push({ type: "done", message, reason: "stop" } satisfies AssistantMessageEvent);
					return stream;
				};
			},
		}),
	);
	t.after(() => runPromise(restartedOwner.dispose()));
	assert.ok(
		(await runPromise(restartedOwner.getActivity(initial.id))).some(
			(event) => event.type === "output" && event.content.includes("Second response in the same session."),
		),
		"inspection reads the persisted JSONL transcript even before the child runtime is reopened",
	);
	const afterRestart = await runPromise(restartedOwner.invoke(initial.id, "Continue after reopening the runtime."));
	assert.equal(afterRestart.status, "settled", afterRestart.error ?? "");
	assert.notEqual(afterRestart.invocationId, second.invocationId);
	assert.equal(replies.length, 0);
	const reopenedSession = await runPromise(restartedOwner.getSession(initial.id));
	assert.equal(reopenedSession?.sessionId, initial.sessionId);
	assert.match(await readFile(sessionFile, "utf8"), /Continue after reopening the runtime\./u);
});

test("a fresh owner recovers an invocation without a live runtime as interrupted, without deleting its session", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-agent-session-recovery-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const agentDir = join(root, "agent-config");
	await mkdir(agentDir, { recursive: true });
	const registry = join(root, "registry");
	const options = { ownerSessionId: "parent-recovery", directory: registry };
	const firstStore = await runPromise(openAgentStore(options));
	const record = await runPromise(
		firstStore.createAgent({
			profile: profile(),
			sessionId: "persistent-session-id",
			cwd: root,
			invocationId: "lost-invocation",
			createdAt: 1,
		}),
	);

	const restartedStore = await runPromise(openAgentStore(options));
	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	const owner = await runPromise(
		createAgentSessionOwner({
			store: restartedStore,
			parentCwd: root,
			agentDir,
			sessionDirectory: join(root, "sessions"),
			modelRuntime,
			noConfiguredExtensions: true,
		}),
	);
	t.after(() => runPromise(owner.dispose()));

	const recovered = await runPromise(restartedStore.getAgent(record.id));
	assert.equal(recovered?.id, record.id);
	assert.equal(recovered?.sessionId, "persistent-session-id");
	assert.equal(recovered?.status, "interrupted");
	assert.equal((await runPromise(restartedStore.pendingEvents()))[0]?.type, "interrupted");
});

test("classifies normal, aborted, cancelled, and failed invocations from outcome plus explicit intent", () => {
	assert.deepEqual(classifyInvocationOutcome("completed"), { status: "settled" });
	assert.deepEqual(classifyInvocationOutcome("aborted"), { status: "interrupted" });
	assert.deepEqual(classifyInvocationOutcome("aborted", "cancelled"), { status: "cancelled" });
	assert.deepEqual(classifyInvocationOutcome("aborted", "interrupted"), { status: "interrupted" });
	assert.deepEqual(classifyInvocationOutcome("error"), {
		status: "error",
		error: "The agent runtime reported an error.",
	});
	assert.deepEqual(classifyInvocationOutcome(undefined, undefined, new Error("Provider failed.")), {
		status: "error",
		error: "Provider failed.",
	});
});

test("an unsupported profile thinking level fails explicitly instead of being clamped", () => {
	const parsed = parseProfile(
		"engineer",
		"/profiles/engineer.md",
		"---\nmodel: anthropic/claude-sonnet-4-5:xhigh\n---\nPrompt.\n",
		modelLookup,
	);
	if (Result.isFailure(parsed)) assert.fail(parsed.failure.message);

	assert.throws(
		() =>
			applyProfileThinkingLevel(
				{
					getAvailableThinkingLevels: () => ["off"],
					setThinkingLevel: () => assert.fail("unsupported level must not be applied"),
				},
				parsed.success,
			),
		/requests unsupported thinking level "xhigh".*Available levels: off/u,
	);
});

test("child runtime failures persist an error lifecycle event and retain the agent", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-agent-session-error-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const agentDir = join(root, "agent-config");
	await mkdir(agentDir, { recursive: true });
	const store = await runPromise(openAgentStore({ ownerSessionId: "parent-error", directory: join(root, "registry") }));
	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	const owner = await runPromise(
		createAgentSessionOwner({
			store,
			parentCwd: root,
			agentDir,
			sessionDirectory: join(root, "sessions"),
			modelRuntime,
			noConfiguredExtensions: true,
			extensionFactories: () => {
				throw new Error("Child extension setup failed.");
			},
		}),
	);
	t.after(() => runPromise(owner.dispose()));
	const record = await runPromise(owner.registerAgent(profile()));

	const result = await runPromise(owner.invoke(record.id, "Start the child invocation."));
	assert.equal(result.agent, record.id);
	assert.equal(result.status, "error");
	assert.match(result.error ?? "", /Child extension setup failed/u);
	assert.equal((await runPromise(store.getAgent(record.id)))?.status, "error");
	const [event] = await runPromise(store.pendingEvents());
	assert.equal(event?.type, "error");
	assert.match(event?.error ?? "", /Child extension setup failed/u);
});

test("one agent cannot run overlapping invocations or stop after settling", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-agent-session-races-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const previousAnthropicKey = process.env.ANTHROPIC_API_KEY;
	process.env.ANTHROPIC_API_KEY = "provider-free-test-key";
	t.after(() => {
		if (previousAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
		else process.env.ANTHROPIC_API_KEY = previousAnthropicKey;
	});
	const agentDir = join(root, "agent-config");
	await mkdir(agentDir, { recursive: true });
	const store = await runPromise(openAgentStore({ ownerSessionId: "parent-races", directory: join(root, "registry") }));
	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	let announceStarted!: () => void;
	const started = new Promise<void>((resolve) => {
		announceStarted = resolve;
	});
	let releaseResponse!: () => void;
	const owner = await runPromise(
		createAgentSessionOwner({
			store,
			parentCwd: root,
			agentDir,
			sessionDirectory: join(root, "sessions"),
			modelRuntime,
			noConfiguredExtensions: true,
			onSessionCreated(session) {
				session.agent.streamFunction = (model) => {
					const stream = new AssistantMessageEventStream();
					const message: AssistantMessage = {
						role: "assistant",
						content: [{ type: "text", text: "Done." }],
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
						stopReason: "stop",
						timestamp: Date.now(),
					};
					releaseResponse = () => {
						stream.push({ type: "done", message, reason: "stop" } satisfies AssistantMessageEvent);
					};
					announceStarted();
					return stream;
				};
			},
		}),
	);
	t.after(() => runPromise(owner.dispose()));
	const record = await runPromise(owner.registerAgent(profile()));
	const firstInvocation = runPromise(owner.invoke(record.id, "Hold until the test releases the model response."));
	await started;

	await assert.rejects(
		runPromise(owner.invoke(record.id, "This concurrent invocation must be rejected.")),
		(error: unknown) => error instanceof AgentStateError && /already running/u.test(error.message),
	);
	releaseResponse();
	assert.equal((await firstInvocation).status, "settled");
	await assert.rejects(
		runPromise(owner.stop(record.id, "cancelled")),
		(error: unknown) => error instanceof AgentStateError && /no active invocation/u.test(error.message),
	);
});
