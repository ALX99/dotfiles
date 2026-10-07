import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { Deferred, Effect, Fiber, PubSub, Result } from "effect";

import { runPromise } from "../../support/effect-runtime.ts";
import { createCapabilityPolicy } from "../policy.ts";
import type { AgentInvocationResult, AgentSessionOwner } from "../session.ts";
import { AgentStateError, type LifecycleEventType } from "../state.ts";
import { openAgentStore, type AgentStore } from "../store.ts";
import { createAgentWorkflows } from "../workflows.ts";

const models = {
	find: (provider: string, id: string) => (provider === "test" && id === "model" ? { provider, id } : undefined),
};

interface InvocationControl {
	readonly invocationId: string;
	readonly completion: Deferred.Deferred<LifecycleEventType>;
	readonly done: Deferred.Deferred<void>;
}

function fakeSessionOwner(store: AgentStore, autoFinish?: LifecycleEventType) {
	const firstInvocations = new Set<string>();
	const controls = new Map<string, InvocationControl>();
	const messages: Array<{ readonly agent: string; readonly message: string; readonly invocationId: string }> = [];
	const steering: Array<{ readonly agent: string; readonly instruction: string }> = [];

	const owner: AgentSessionOwner = {
		registerAgent: (profile, cwd) =>
			Effect.gen(function* () {
				const agent = yield* store.createAgent({
					profile,
					sessionId: `session-${messages.length + firstInvocations.size + 1}`,
					cwd: cwd ?? "/parent",
					invocationId: `invocation-initial-${messages.length + firstInvocations.size + 1}`,
					createdAt: Date.now(),
				});
				firstInvocations.add(agent.id);
				return agent;
			}),
		invoke: (agentId, message, onStarted) =>
			Effect.gen(function* () {
				if (controls.has(agentId))
					return yield* new AgentStateError({ message: `Agent "${agentId}" is already running.` });
				const agent = yield* store.getAgent(agentId);
				if (agent === undefined) return yield* new AgentStateError({ message: `Unknown agent "${agentId}".` });
				let invocationId = agent.invocationId;
				if (firstInvocations.delete(agentId)) {
					if (agent.status !== "running")
						return yield* new AgentStateError({ message: "Initial invocation is not running." });
				} else {
					invocationId = `invocation-${messages.length + 1}`;
					yield* store.startInvocation(agentId, invocationId);
				}
				const control: InvocationControl = {
					invocationId,
					completion: yield* Deferred.make<LifecycleEventType>(),
					done: yield* Deferred.make<void>(),
				};
				controls.set(agentId, control);
				messages.push({ agent: agentId, message, invocationId });
				if (onStarted !== undefined) yield* onStarted;
				if (autoFinish !== undefined) yield* Deferred.succeed(control.completion, autoFinish);
				const status = yield* Deferred.await(control.completion);
				yield* store.finishInvocation({
					agentId,
					invocationId,
					status,
					...(status === "error" ? { error: "Fake invocation failed." } : {}),
					occurredAt: Date.now(),
				});
				controls.delete(agentId);
				yield* Deferred.succeed(control.done, undefined);
				return {
					agent: agentId,
					invocationId,
					status,
					...(status === "error" ? { error: "Fake invocation failed." } : {}),
				} satisfies AgentInvocationResult;
			}),
		stop: (agentId, intent) => {
			const control = controls.get(agentId);
			if (control === undefined)
				return Effect.fail(new AgentStateError({ message: `Agent "${agentId}" has no active invocation.` }));
			return Deferred.succeed(control.completion, intent).pipe(Effect.asVoid);
		},
		steer: (agentId, instruction) => {
			if (!controls.has(agentId))
				return Effect.fail(new AgentStateError({ message: `Agent "${agentId}" has no active invocation.` }));
			return Effect.sync(() => steering.push({ agent: agentId, instruction })).pipe(Effect.asVoid);
		},
		getSession: () => Effect.succeed(undefined),
		getActivity: () => Effect.succeed([]),
		getFooterRows: () => Effect.succeed([]),
		dispose: () =>
			Effect.gen(function* () {
				const active = [...controls.entries()];
				for (const [, control] of active) {
					yield* Deferred.succeed(control.completion, "interrupted");
				}
				for (const [, control] of active) yield* Deferred.await(control.done);
			}),
	};

	return {
		owner,
		messages,
		steering,
		finish: (agentId: string, status: LifecycleEventType = "settled") => {
			const control = controls.get(agentId);
			if (control === undefined) throw new Error(`No fake invocation for ${agentId}`);
			return Deferred.succeed(control.completion, status).pipe(Effect.asVoid);
		},
		active: (agentId: string) => controls.has(agentId),
	};
}

async function createFixture(t: TestContext, autoFinish?: LifecycleEventType) {
	const directory = await mkdtemp(join(tmpdir(), "pi-agent-workflows-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const profiles = join(directory, "profiles");
	await mkdir(profiles, { recursive: true });
	await writeFile(
		join(profiles, "engineer.md"),
		"---\nmodel: test/model\n---\nKeep the implementation careful and tested.\n",
	);
	const store = await runPromise(
		openAgentStore({ ownerSessionId: "parent-session", directory: join(directory, "registry") }),
	);
	const sessions = fakeSessionOwner(store, autoFinish);
	return { directory, profiles, store, sessions };
}

function assertAgentResult(value: unknown): asserts value is { readonly agent: string; readonly status: string } {
	assert.ok(typeof value === "object" && value !== null && "agent" in value && "status" in value);
}

test("spawn_agent wait mode blocks for a lifecycle event and returns only runtime status", async (t) => {
	const fixture = await createFixture(t, "settled");
	await runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const workflows = yield* createAgentWorkflows({
					store: fixture.store,
					sessions: fixture.sessions.owner,
					models,
					profileDirectory: fixture.profiles,
				});
				const result = yield* workflows.spawnAgent({
					profile: "engineer",
					message: "Run the initial invocation.",
					mode: "wait",
				});
				assert.ok("event" in result);
				assert.equal(result.agent, "engineer-agent-1");
				assert.equal(result.event, "settled");
				assert.equal((yield* fixture.store.getAgent(result.agent))?.status, "settled");
				assert.equal(fixture.sessions.messages[0]?.message, "Run the initial invocation.");
				yield* workflows.dispose();
			}),
		),
	);
});

test("spawn_agent checks the profile policy before loading a profile or creating an agent", async (t) => {
	const fixture = await createFixture(t);
	await writeFile(
		join(fixture.profiles, "designer.md"),
		"---\nmodel: test/model\n---\nThis profile is valid but disallowed.\n",
	);
	const modelLookups: string[] = [];
	await runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const workflows = yield* createAgentWorkflows({
					store: fixture.store,
					sessions: fixture.sessions.owner,
					models: {
						find: (provider, id) => {
							modelLookups.push(`${provider}/${id}`);
							return models.find(provider, id);
						},
					},
					profileDirectory: fixture.profiles,
					capabilityPolicy: createCapabilityPolicy({
						name: "parent",
						spawnProfiles: ["engineer"],
					}),
				});
				const denied = yield* Effect.result(
					workflows.spawnAgent({ profile: "designer", message: "Do not create anything." }),
				);
				assert.equal(Result.isFailure(denied), true);
				assert.equal(modelLookups.length, 0, "a denied profile must not be resolved or loaded");
				assert.deepEqual(yield* fixture.store.listAgents(), []);
				assert.equal(fixture.sessions.messages.length, 0);

				const spawned = yield* workflows.spawnAgent({ profile: "engineer", message: "Allowed child." });
				assertAgentResult(spawned);
				assert.equal(spawned.agent, "engineer-agent-1");
				assert.deepEqual(modelLookups, ["test/model"]);
				assert.equal(fixture.sessions.messages[0]?.message, "Allowed child.");
				yield* workflows.dispose();
			}),
		),
	);
});

test("spawn_agent reads the current parent profile policy for each invocation", async (t) => {
	const fixture = await createFixture(t, "settled");
	let capabilityPolicy = createCapabilityPolicy({ name: "researcher", spawnProfiles: [] });
	await runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const workflows = yield* createAgentWorkflows({
					store: fixture.store,
					sessions: fixture.sessions.owner,
					models,
					profileDirectory: fixture.profiles,
					getCapabilityPolicy: () => capabilityPolicy,
				});

				const denied = yield* Effect.result(
					workflows.spawnAgent({ profile: "engineer", message: "This should initially be denied." }),
				);
				assert.equal(Result.isFailure(denied), true);
				assert.deepEqual(yield* fixture.store.listAgents(), []);
				assert.equal(fixture.sessions.messages.length, 0);

				capabilityPolicy = createCapabilityPolicy({ name: "engineer", spawnProfiles: ["engineer"] });
				const allowed = yield* workflows.spawnAgent({
					profile: "engineer",
					message: "The active profile now permits this child.",
					mode: "wait",
				});
				assert.ok("event" in allowed);
				assert.equal(allowed.event, "settled");
				assert.equal(fixture.sessions.messages.length, 1);
				yield* workflows.dispose();
			}),
		),
	);
});

test("root workflows without a profile policy may spawn any profile", async (t) => {
	const fixture = await createFixture(t);
	await runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const workflows = yield* createAgentWorkflows({
					store: fixture.store,
					sessions: fixture.sessions.owner,
					models,
					profileDirectory: fixture.profiles,
				});
				const spawned = yield* workflows.spawnAgent({ profile: "engineer", message: "Root spawn." });
				assertAgentResult(spawned);
				assert.equal(spawned.agent, "engineer-agent-1");
				yield* workflows.dispose();
			}),
		),
	);
});

test("a stricter spawn policy does not restrict communication with existing children", async (t) => {
	const fixture = await createFixture(t);
	await runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const existing = yield* fixture.store.createAgent({
					profile: {
						name: "designer",
						model: { provider: "test", id: "model" },
						prompt: "Design carefully.",
						sourcePath: join(fixture.profiles, "designer.md"),
					},
					sessionId: "existing-designer-session",
					cwd: "/parent",
					invocationId: "designer-initial-invocation",
					createdAt: Date.now(),
				});
				yield* fixture.store.finishInvocation({
					agentId: existing.id,
					invocationId: existing.invocationId,
					status: "settled",
					occurredAt: Date.now(),
				});
				const workflows = yield* createAgentWorkflows({
					store: fixture.store,
					sessions: fixture.sessions.owner,
					models,
					profileDirectory: fixture.profiles,
					capabilityPolicy: createCapabilityPolicy({
						name: "parent",
						spawnProfiles: ["engineer"],
					}),
				});

				const sent = yield* workflows.sendAgent(existing.id, "Continue the existing design session.");
				assert.deepEqual(sent, { agent: "designer-agent-1", status: "running" });
				assert.equal(fixture.sessions.messages[0]?.agent, existing.id);
				assert.equal(fixture.sessions.messages[0]?.message, "Continue the existing design session.");
				assert.equal((yield* fixture.store.getAgent(existing.id))?.sessionId, existing.sessionId);

				yield* fixture.sessions.finish(existing.id);
				yield* Effect.sleep("10 millis");
				assert.equal((yield* fixture.store.getAgent(existing.id))?.status, "settled");
				yield* workflows.dispose();
			}),
		),
	);
});

test("list_agents and inspect_agent expose direct-child metadata without inferred progress", async (t) => {
	const fixture = await createFixture(t, "settled");
	await runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const workflows = yield* createAgentWorkflows({
					store: fixture.store,
					sessions: fixture.sessions.owner,
					models,
					profileDirectory: fixture.profiles,
				});
				const spawned = yield* workflows.spawnAgent({ profile: "engineer", message: "Start.", mode: "wait" });
				assert.ok("event" in spawned);
				const agentId = spawned.agent;
				const [listed] = yield* workflows.listAgents();
				assert.deepEqual(listed, {
					agent: agentId,
					profile: "engineer",
					status: "settled",
				});
				assert.deepEqual(yield* workflows.inspectAgent(agentId), {
					agent: agentId,
					profile: "engineer",
					status: "settled",
					cwd: "/parent",
					latest_events: [],
				});
				yield* workflows.dispose();
			}),
		),
	);
});

test("spawn, ask_parent, wait, and answer preserve one child invocation and deliver the request directly", async (t) => {
	const fixture = await createFixture(t);
	await runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const workflows = yield* createAgentWorkflows({
					store: fixture.store,
					sessions: fixture.sessions.owner,
					models,
					profileDirectory: fixture.profiles,
				});
				const spawned = yield* workflows.spawnAgent({
					profile: "engineer",
					message: "Investigate the requested change.",
				});
				assertAgentResult(spawned);
				assert.equal(spawned.status, "running");
				const agentId = spawned.agent;
				assert.equal(agentId, "engineer-agent-1");

				const asking = yield* Effect.forkChild(
					workflows.childCommunication(agentId).askParent("Which database should I use?", ["SQLite", "Postgres"]),
				);
				const [request] = yield* workflows.waitAgent([agentId]);
				assert.equal(request?.agent, agentId);
				assert.equal(request?.event, "parent_request");
				assert.equal(request?.message, "Which database should I use?");
				assert.deepEqual(request?.options, ["SQLite", "Postgres"]);
				assert.equal((yield* fixture.store.getAgent(agentId))?.status, "waiting_parent");

				const answered = yield* workflows.answerAgent(agentId, "Use the existing MySQL database.");
				assert.equal(answered.answer, "Use the existing MySQL database.");
				assert.equal(yield* Fiber.join(asking), "Use the existing MySQL database.");
				assert.equal((yield* fixture.store.getAgent(agentId))?.status, "running");
				assert.equal((yield* fixture.store.getAgent(agentId))?.parentRequest, undefined);

				yield* fixture.sessions.finish(agentId);
				const [settled] = yield* workflows.waitAgent([agentId]);
				assert.equal(settled?.event, "settled");
				assert.equal((yield* fixture.store.getAgent(agentId))?.sessionId, "session-1");
				assert.equal(fixture.sessions.messages[0]?.message, "Investigate the requested change.");

				assert.ok(Result.isFailure(yield* Effect.result(workflows.answerAgent(agentId, "stale answer"))));
				yield* workflows.dispose();
			}),
		),
	);
});

test("send_agent steers running invocations by default and can interrupt before continuing the same session", async (t) => {
	const fixture = await createFixture(t);
	await runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const workflows = yield* createAgentWorkflows({
					store: fixture.store,
					sessions: fixture.sessions.owner,
					models,
					profileDirectory: fixture.profiles,
				});
				const spawned = yield* workflows.spawnAgent({ profile: "engineer", message: "Start." });
				assertAgentResult(spawned);
				const agentId = spawned.agent;
				const original = yield* fixture.store.getAgent(agentId);
				assert.ok(original);

				const steered = yield* workflows.sendAgent(agentId, "Continue, but focus on the API.");
				assert.ok("status" in steered);
				assert.equal(steered.status, "running");
				assert.deepEqual(fixture.sessions.steering, [
					{ agent: agentId, instruction: "Continue, but focus on the API." },
				]);
				assert.equal(fixture.sessions.messages.length, 1);

				const interrupted = yield* workflows.sendAgent(agentId, "Stop and inspect the handler instead.", "interrupt");
				assert.ok("status" in interrupted);
				assert.equal(interrupted.status, "running");
				const afterInterrupt = yield* fixture.store.getAgent(agentId);
				assert.equal(afterInterrupt?.sessionId, original.sessionId);
				assert.notEqual(afterInterrupt?.invocationId, original.invocationId);
				assert.equal(fixture.sessions.messages.length, 2);
				assert.equal(fixture.sessions.messages[1]?.message, "Stop and inspect the handler instead.");

				const cancelled = yield* workflows.cancelAgent(agentId);
				assert.equal(cancelled.status, "cancelled");
				assert.equal((yield* fixture.store.getAgent(agentId))?.sessionId, original.sessionId);
				const resumed = yield* workflows.sendAgent(agentId, "Continue the same session with tests.");
				assert.ok("status" in resumed);
				assert.equal(resumed.status, "running");
				assert.equal((yield* fixture.store.getAgent(agentId))?.sessionId, original.sessionId);
				assert.equal(fixture.sessions.messages.length, 3);
				const steeredAgain = yield* workflows.sendAgent(agentId, "One more direction.");
				assert.ok("status" in steeredAgain);
				assert.equal(steeredAgain.status, "running");
				assert.equal(fixture.sessions.steering.length, 2);
				const active = yield* fixture.store.getAgent(agentId);
				assert.equal(active?.status, "running");
				yield* workflows.dispose();
			}),
		),
	);
});

test("send_agent wait returns the steered invocation's settlement, not an intermediate parent request", async (t) => {
	const fixture = await createFixture(t);
	await runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const workflows = yield* createAgentWorkflows({
					store: fixture.store,
					sessions: fixture.sessions.owner,
					models,
					profileDirectory: fixture.profiles,
				});
				const spawned = yield* workflows.spawnAgent({ profile: "engineer", message: "Start." });
				assertAgentResult(spawned);
				const events = yield* PubSub.subscribe(workflows.events);

				const send = yield* Effect.forkChild(
					workflows.sendAgent(spawned.agent, "Please finish the investigation.", "steer", true),
				);
				const asking = yield* Effect.forkChild(
					workflows.childCommunication(spawned.agent).askParent("Which approach should I use?"),
				);
				assert.equal((yield* PubSub.take(events)).type, "parent_request");

				yield* workflows.answerAgent(spawned.agent, "Use the existing approach.");
				assert.equal(yield* Fiber.join(asking), "Use the existing approach.");
				yield* fixture.sessions.finish(spawned.agent);
				assert.deepEqual(yield* Fiber.join(send), { agent: spawned.agent, event: "settled" });
				assert.deepEqual(
					(yield* fixture.store.pendingEvents([spawned.agent])).map((event) => event.type),
					["parent_request"],
				);
				assert.deepEqual(yield* workflows.waitAgent([spawned.agent]), [
					{ agent: spawned.agent, event: "parent_request", message: "Which approach should I use?" },
				]);
				yield* workflows.dispose();
			}),
		),
	);
});

test("send_agent wait starts a new invocation for a settled child and returns its settlement", async (t) => {
	const fixture = await createFixture(t, "settled");
	await runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const workflows = yield* createAgentWorkflows({
					store: fixture.store,
					sessions: fixture.sessions.owner,
					models,
					profileDirectory: fixture.profiles,
				});
				const spawned = yield* workflows.spawnAgent({
					profile: "engineer",
					message: "Initial invocation.",
					mode: "wait",
				});
				assert.ok("event" in spawned);
				const sent = yield* workflows.sendAgent(spawned.agent, "Start the follow-up.", undefined, true);
				assert.deepEqual(sent, { agent: spawned.agent, event: "settled" });
				assert.equal(fixture.sessions.messages.length, 2);
				assert.equal(fixture.sessions.messages[1]?.message, "Start the follow-up.");
				yield* workflows.dispose();
			}),
		),
	);
});

test("send_agent wait releases its event claim when acknowledging the completion fails", async (t) => {
	const fixture = await createFixture(t, "settled");
	const store: AgentStore = {
		...fixture.store,
		acknowledgeEvents: () => Effect.fail(new AgentStateError({ message: "Simulated acknowledgment failure." })),
	};
	await runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const workflows = yield* createAgentWorkflows({
					store,
					sessions: fixture.sessions.owner,
					models,
					profileDirectory: fixture.profiles,
				});
				const spawned = yield* workflows.spawnAgent({ profile: "engineer", message: "Start." });
				assertAgentResult(spawned);

				const result = yield* Effect.result(workflows.sendAgent(spawned.agent, "Finish the task.", undefined, true));
				assert.equal(Result.isFailure(result), true);
				const pending = yield* fixture.store.pendingEvents([spawned.agent]);
				assert.ok(pending.length > 0);
				assert.ok(pending.every((event) => event.claimId === undefined));
				yield* workflows.dispose();
			}),
		),
	);
});

test("cancelling an invocation suspended in ask_parent invalidates the live answer path but keeps the agent", async (t) => {
	const fixture = await createFixture(t);
	await runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const workflows = yield* createAgentWorkflows({
					store: fixture.store,
					sessions: fixture.sessions.owner,
					models,
					profileDirectory: fixture.profiles,
				});
				const spawned = yield* workflows.spawnAgent({ profile: "engineer", message: "Start." });
				assertAgentResult(spawned);
				const agentId = spawned.agent;
				const asking = yield* Effect.forkChild(workflows.childCommunication(agentId).askParent("Need a decision."));
				const [request] = yield* workflows.waitAgent([agentId]);
				assert.equal(request?.event, "parent_request");

				yield* Fiber.interrupt(asking);
				const cancelled = yield* workflows.cancelAgent(agentId);
				assert.equal(cancelled.status, "cancelled");
				const retained = yield* fixture.store.getAgent(agentId);
				assert.equal(retained?.status, "cancelled");
				assert.equal(retained?.parentRequest, undefined);
				assert.ok(Result.isFailure(yield* Effect.result(workflows.answerAgent(agentId, "too late"))));
				yield* workflows.dispose();
			}),
		),
	);
});

test("wait cancellation does not stop children and wait_agent supports a batch of already-pending events", async (t) => {
	const fixture = await createFixture(t);
	await runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const workflows = yield* createAgentWorkflows({
					store: fixture.store,
					sessions: fixture.sessions.owner,
					models,
					profileDirectory: fixture.profiles,
				});
				const first = yield* workflows.spawnAgent({ profile: "engineer", message: "First." });
				assertAgentResult(first);
				const second = yield* workflows.spawnAgent({ profile: "engineer", message: "Second." });
				assertAgentResult(second);

				const waiting = yield* Effect.forkChild(workflows.waitAgent([first.agent]));
				yield* Fiber.interrupt(waiting);
				assert.equal(fixture.sessions.active(first.agent), true);
				assert.equal((yield* fixture.store.getAgent(first.agent))?.status, "running");

				yield* fixture.sessions.finish(first.agent);
				yield* fixture.sessions.finish(second.agent);
				const events = [];
				while (events.length < 2) {
					events.push(...(yield* workflows.waitAgent([first.agent, second.agent])));
				}
				assert.deepEqual(events.map((event) => event.agent).toSorted(), [first.agent, second.agent].toSorted());
				assert.deepEqual(
					events.map((event) => event.event),
					["settled", "settled"],
				);
				yield* workflows.dispose();
			}),
		),
	);
});
