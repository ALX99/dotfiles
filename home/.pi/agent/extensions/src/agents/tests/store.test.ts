import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect, Result } from "effect";

import { runPromise } from "../../support/effect-runtime.ts";
import { parseProfile, type ProfileModelLookup } from "../profile.ts";
import { AgentStoreError, agentStorePath, openAgentStore } from "../store.ts";

const models: ProfileModelLookup = {
	find: (provider, id) => (provider === "test" && id === "model" ? { provider, id } : undefined),
};

const profile = () => {
	const parsed = parseProfile(
		"engineer",
		"/profiles/engineer.md",
		"---\nmodel: test/model\ntools: [read]\n---\nUse a careful, tested approach.\n",
		models,
	);
	if (Result.isFailure(parsed)) assert.fail(parsed.failure.message);
	return parsed.success;
};

test("persists profile snapshots, stable agent IDs, lifecycle events, and mailbox acknowledgments", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-agent-store-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const options = { ownerSessionId: "root-session", directory };
	const store = await runPromise(openAgentStore(options));

	const first = await runPromise(
		store.createAgent({
			profile: profile(),
			sessionId: "child-session-1",
			cwd: "/repo",
			invocationId: "invocation-1",
			createdAt: 1_000,
		}),
	);
	assert.equal(first.id, "engineer-agent-1");
	assert.equal(first.parentSessionId, "root-session");

	await runPromise(
		store.finishInvocation({
			agentId: first.id,
			invocationId: "invocation-1",
			status: "settled",
			occurredAt: 2_000,
		}),
	);
	const [event] = await runPromise(store.claimEvents("parent-turn-1"));
	assert.equal(event?.type, "settled");

	const reloaded = await runPromise(openAgentStore(options));
	assert.equal((await runPromise(reloaded.getAgent(first.id)))?.profile.prompt, "Use a careful, tested approach.");
	assert.deepEqual((await runPromise(reloaded.getAgent(first.id)))?.profile.tools, ["read"]);
	assert.equal((await runPromise(reloaded.getAgent(first.id)))?.status, "settled");

	// An unacknowledged claim belonged to the previous process and is redelivered.
	const [redelivered] = await runPromise(reloaded.claimEvents("parent-turn-2"));
	assert.equal(redelivered?.id, event?.id);
	await runPromise(reloaded.acknowledgeEvents("parent-turn-2", [redelivered!.id], 3_000));
	assert.deepEqual(await runPromise(reloaded.pendingEvents()), []);

	await runPromise(reloaded.startInvocation(first.id, "invocation-2"));
	const second = await runPromise(
		reloaded.createAgent({
			profile: profile(),
			sessionId: "child-session-2",
			cwd: "/repo/other",
			invocationId: "invocation-3",
			createdAt: 4_000,
		}),
	);
	assert.equal(second.id, "engineer-agent-2");
	assert.equal((await runPromise(reloaded.snapshot())).agents.length, 2);

	const serialized = JSON.parse(await readFile(reloaded.path, "utf8")) as {
		readonly version: number;
		readonly ownerSessionId: string;
		readonly mailbox: readonly { readonly acknowledgedAt?: number }[];
	};
	assert.equal(serialized.version, 1);
	assert.equal(serialized.ownerSessionId, "root-session");
	assert.equal(serialized.mailbox[0]?.acknowledgedAt, 3_000);
});

test("concurrent allocations through one store are serialized and parent scoped", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-agent-concurrent-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const parent = await runPromise(openAgentStore({ ownerSessionId: "parent-a", directory }));
	const inputs = Array.from({ length: 12 }, (_, index) => ({
		profile: profile(),
		sessionId: `child-${index}`,
		cwd: "/repo",
		invocationId: `run-${index}`,
		createdAt: index,
	}));
	const created = await runPromise(
		Effect.forEach(inputs, (input) => parent.createAgent(input), { concurrency: "unbounded" }),
	);
	assert.deepEqual(
		created.map((agent) => agent.id).toSorted(),
		Array.from({ length: 12 }, (_, index) => `engineer-agent-${index + 1}`).toSorted(),
	);

	const otherParent = await runPromise(openAgentStore({ ownerSessionId: "parent-b", directory }));
	const otherChild = await runPromise(
		otherParent.createAgent({
			profile: profile(),
			sessionId: "different-parent-child",
			cwd: "/repo",
			invocationId: "other-run",
			createdAt: 1,
		}),
	);
	assert.equal(otherChild.id, "engineer-agent-1");
	assert.notEqual(parent.path, otherParent.path);
	assert.equal(agentStorePath("parent-a", directory), parent.path);
});

test("agent change listeners can read the committed status after registry updates", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-agent-store-listener-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const store = await runPromise(openAgentStore({ ownerSessionId: "listener-session", directory }));
	const agent = await runPromise(
		store.createAgent({
			profile: profile(),
			sessionId: "listener-child",
			cwd: "/repo",
			invocationId: "listener-invocation",
			createdAt: 1,
		}),
	);

	let observedStatus: string | undefined;
	let notifications = 0;
	let resolveObserved!: () => void;
	const observed = new Promise<void>((resolve) => {
		resolveObserved = resolve;
	});
	const unsubscribe = store.subscribeAgentChanges(() => {
		notifications += 1;
		void runPromise(store.getAgent(agent.id)).then((current) => {
			observedStatus = current?.status;
			resolveObserved();
		});
	});
	t.after(unsubscribe);

	await runPromise(
		store.finishInvocation({
			agentId: agent.id,
			invocationId: agent.invocationId,
			status: "settled",
			occurredAt: 2,
		}),
	);
	await observed;
	assert.equal(observedStatus, "settled", "the listener reads the status after the synchronized state commits");
	assert.equal(notifications, 1);

	await runPromise(store.claimEvents("listener-turn"));
	assert.equal(notifications, 1, "mailbox-only changes do not refresh child rows");
});

test("records and restores a suspended parent request and its answer", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-agent-request-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const options = { ownerSessionId: "parent-session", ownerAgentId: "researcher-agent-1", directory };
	const store = await runPromise(openAgentStore(options));
	const agent = await runPromise(
		store.createAgent({
			profile: profile(),
			sessionId: "child-session",
			cwd: "/repo",
			invocationId: "invoke-1",
			createdAt: 1,
		}),
	);
	const request = await runPromise(
		store.requestParent({
			agentId: agent.id,
			invocationId: "invoke-1",
			requestId: "request-1",
			message: "Use SQLite or Postgres?",
			options: ["SQLite", "Postgres"],
			occurredAt: 2,
		}),
	);
	assert.equal(request.event.type, "parent_request");
	assert.equal(request.event.message, "Use SQLite or Postgres?");
	assert.deepEqual(request.event.options, ["SQLite", "Postgres"]);
	assert.equal((await runPromise(store.getAgent(agent.id)))?.status, "waiting_parent");

	const restarted = await runPromise(openAgentStore(options));
	assert.equal((await runPromise(restarted.getAgent(agent.id)))?.parentRequest?.requestId, "request-1");
	assert.equal((await runPromise(restarted.pendingEvents()))[0]?.id, request.event.id);
	const answered = await runPromise(restarted.answerParent(agent.id, "Use the existing MySQL database."));
	assert.equal(answered.answer, "Use the existing MySQL database.");
	assert.equal((await runPromise(restarted.getAgent(agent.id)))?.status, "running");

	const resumed = await runPromise(openAgentStore(options));
	assert.equal(await runPromise(resumed.consumeParentAnswer(agent.id, "invoke-1")), "Use the existing MySQL database.");
	assert.equal((await runPromise(resumed.getAgent(agent.id)))?.parentRequest, undefined);
});

test("rejects a corrupt registry instead of replacing it with empty state", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-agent-corrupt-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	await mkdir(directory, { recursive: true });
	const path = agentStorePath("corrupt-session", directory);
	await writeFile(path, "{broken");

	await assert.rejects(runPromise(openAgentStore({ ownerSessionId: "corrupt-session", directory })), AgentStoreError);
	assert.equal(await readFile(path, "utf8"), "{broken");
});
