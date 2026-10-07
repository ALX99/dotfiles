import assert from "node:assert/strict";
import test from "node:test";
import { Result, Schema } from "effect";

import { parseProfile, type ProfileModelLookup } from "../profile.ts";
import {
	AgentStoreStateSchema,
	acknowledgeMailboxEvents,
	answerParentRequest,
	askParent,
	claimMailboxEvents,
	createAgent,
	emptyAgentStore,
	finishAgentInvocation,
	pendingMailboxEvents,
	releaseAllMailboxClaims,
	releaseMailboxClaim,
	startAgentInvocation,
	consumeParentAnswer,
	type AgentStoreState,
} from "../state.ts";

const models: ProfileModelLookup = {
	find: (provider, id) => (provider === "test" && id === "model" ? { provider, id } : undefined),
};

const profile = (name = "engineer") => {
	const parsed = parseProfile(
		name,
		`/profiles/${name}.md`,
		"---\nmodel: test/model\ntools: [read]\nspawn_profiles: [researcher]\n---\nKeep the implementation tested.\n",
		models,
	);
	if (Result.isFailure(parsed)) assert.fail(parsed.failure.message);
	return parsed.success;
};

const unwrap = <A, E>(result: Result.Result<A, E>): A => {
	if (Result.isFailure(result)) assert.fail(String(result.failure));
	return result.success;
};

const create = (state: AgentStoreState, name: string, sessionId: string, invocationId = `invoke-${sessionId}`) => {
	return unwrap(
		createAgent(state, {
			profile: profile(name),
			sessionId,
			cwd: "/repo",
			invocationId,
			createdAt: 100,
		}),
	);
};

test("allocates stable IDs within the direct parent's profile namespace", () => {
	const root = emptyAgentStore("root-session");
	const first = create(root, "engineer", "child-session-1");
	const second = create(first.state, "engineer", "child-session-2");
	const designer = create(second.state, "designer", "child-session-3");

	assert.equal(first.value.id, "engineer-agent-1");
	assert.equal(second.value.id, "engineer-agent-2");
	assert.equal(designer.value.id, "designer-agent-1");
	assert.equal(first.value.parentSessionId, "root-session");
	assert.equal(first.value.parentAgentId, undefined);
	assert.deepEqual(root.agents, []);
	assert.ok(Object.isFrozen(first.value.profile));
	assert.ok(Object.isFrozen(first.value.profile.tools));
	assert.deepEqual(first.value.profile.spawnProfiles, ["researcher"]);
	assert.ok(Object.isFrozen(first.value.profile.spawnProfiles));

	const nested = emptyAgentStore(second.value.sessionId, second.value.id);
	const grandchild = create(nested, "engineer", "grandchild-session");
	assert.equal(grandchild.value.id, "engineer-agent-1");
	assert.equal(grandchild.value.parentSessionId, "child-session-2");
	assert.equal(grandchild.value.parentAgentId, "engineer-agent-2");
});

test("terminal lifecycle events do not remove agents and a later invocation reuses identity", () => {
	const registered = create(emptyAgentStore("parent-session"), "engineer", "child-session");
	const first = unwrap(
		finishAgentInvocation(registered.state, {
			agentId: registered.value.id,
			invocationId: registered.value.invocationId,
			status: "settled",
			occurredAt: 200,
		}),
	);
	assert.equal(first.state.agents[0]?.status, "settled");
	assert.equal(first.value.type, "settled");
	assert.equal(first.state.mailbox.length, 1);

	const repeated = unwrap(
		finishAgentInvocation(first.state, {
			agentId: registered.value.id,
			invocationId: registered.value.invocationId,
			status: "settled",
			occurredAt: 201,
		}),
	);
	assert.equal(repeated.state.mailbox.length, 1);

	const restarted = unwrap(startAgentInvocation(repeated.state, registered.value.id, "invoke-next"));
	assert.equal(restarted.agents[0]?.id, registered.value.id);
	assert.equal(restarted.agents[0]?.sessionId, registered.value.sessionId);
	assert.equal(restarted.agents[0]?.status, "running");
	assert.equal(restarted.agents[0]?.invocationId, "invoke-next");
	assert.equal(restarted.mailbox.length, 1);

	const invalid = startAgentInvocation(restarted, registered.value.id, "another");
	assert.equal(Result.isFailure(invalid), true);
	assert.equal(
		Result.isFailure(
			finishAgentInvocation(restarted, {
				agentId: registered.value.id,
				invocationId: "invoke-next",
				status: "error",
				occurredAt: 202,
			}),
		),
		true,
	);
	const failed = unwrap(
		finishAgentInvocation(restarted, {
			agentId: registered.value.id,
			invocationId: "invoke-next",
			status: "error",
			error: "Runtime stopped unexpectedly.",
			occurredAt: 203,
		}),
	);
	assert.equal(failed.value.type, "error");
	assert.equal(failed.value.error, "Runtime stopped unexpectedly.");
});

test("ask_parent suspends one invocation, delivers the full request, and resumes it with a free-form answer", () => {
	const registered = create(emptyAgentStore("parent-session"), "engineer", "child-session");
	const asking = askParent(registered.state, {
		agentId: registered.value.id,
		invocationId: registered.value.invocationId,
		requestId: "request-1",
		message: "Which database should I use?",
		options: ["SQLite", "Postgres"],
		occurredAt: 300,
	});
	const suspended = unwrap(asking);
	assert.equal(suspended.state.agents[0]?.status, "waiting_parent");
	assert.deepEqual(suspended.value.event, {
		id: "event-1",
		sequence: 1,
		dedupeKey: "parent-request:engineer-agent-1:invoke-child-session:request-1",
		agentId: "engineer-agent-1",
		invocationId: "invoke-child-session",
		type: "parent_request",
		occurredAt: 300,
		message: "Which database should I use?",
		options: ["SQLite", "Postgres"],
	});

	const secondRequest = askParent(suspended.state, {
		agentId: registered.value.id,
		invocationId: registered.value.invocationId,
		requestId: "request-2",
		message: "Another question",
		occurredAt: 301,
	});
	assert.equal(Result.isFailure(secondRequest), true);

	const answered = unwrap(
		answerParentRequest(suspended.state, registered.value.id, "Use the existing MySQL database."),
	);
	assert.equal(answered.state.agents[0]?.status, "running");
	assert.equal(answered.value.answer, "Use the existing MySQL database.");

	const consumed = unwrap(consumeParentAnswer(answered.state, registered.value.id, registered.value.invocationId));
	assert.equal(consumed.value, "Use the existing MySQL database.");
	assert.equal(consumed.state.agents[0]?.parentRequest, undefined);

	const secondQuestion = unwrap(
		askParent(consumed.state, {
			agentId: registered.value.id,
			invocationId: registered.value.invocationId,
			requestId: "request-2",
			message: "Should I include migration notes?",
			occurredAt: 302,
		}),
	);
	assert.equal(secondQuestion.state.mailbox.length, 2);
	assert.equal(secondQuestion.value.event.type, "parent_request");
});

test("mailbox claims, acknowledgment, release, and restart preserve unacknowledged events", () => {
	const registered = create(emptyAgentStore("parent-session"), "engineer", "child-session");
	const ended = unwrap(
		finishAgentInvocation(registered.state, {
			agentId: registered.value.id,
			invocationId: registered.value.invocationId,
			status: "interrupted",
			occurredAt: 400,
		}),
	);
	assert.equal(ended.value.type, "interrupted");
	assert.equal(pendingMailboxEvents(ended.state).length, 1);

	const claimed = unwrap(claimMailboxEvents(ended.state, "waiter-1"));
	assert.equal(claimed.value.length, 1);
	assert.equal(claimed.value[0]?.claimId, "waiter-1");
	assert.equal(unwrap(claimMailboxEvents(claimed.state, "waiter-2")).value.length, 0);
	assert.equal(unwrap(claimMailboxEvents(claimed.state, "waiter-1")).value.length, 1);

	const restarted = releaseAllMailboxClaims(claimed.state);
	assert.equal(restarted.mailbox[0]?.claimId, undefined);
	const reclaimed = unwrap(claimMailboxEvents(restarted, "waiter-3"));
	assert.equal(reclaimed.value.length, 1);

	const rejectedAck = acknowledgeMailboxEvents(reclaimed.state, "other-claim", [reclaimed.value[0]!.id], 500);
	assert.equal(Result.isFailure(rejectedAck), true);
	const acknowledged = unwrap(acknowledgeMailboxEvents(reclaimed.state, "waiter-3", [reclaimed.value[0]!.id], 500));
	assert.equal(pendingMailboxEvents(acknowledged).length, 0);
	assert.equal(acknowledged.mailbox[0]?.acknowledgedAt, 500);

	const released = releaseMailboxClaim(claimed.state, "waiter-1");
	assert.equal(released.mailbox[0]?.claimId, undefined);
	assert.equal(pendingMailboxEvents(released).length, 1);
});

test("persisted state schema rejects inconsistent pending requests and duplicate IDs", () => {
	const registered = create(emptyAgentStore("parent-session"), "engineer", "child-session");
	const decoded = Schema.decodeUnknownResult(AgentStoreStateSchema)(registered.state);
	assert.equal(Result.isSuccess(decoded), true);

	const duplicate = Schema.decodeUnknownResult(AgentStoreStateSchema)({
		...registered.state,
		agents: [...registered.state.agents, registered.state.agents[0]],
	});
	assert.equal(Result.isFailure(duplicate), true);

	const inconsistent = Schema.decodeUnknownResult(AgentStoreStateSchema)({
		...registered.state,
		agents: [{ ...registered.value, status: "waiting_parent" }],
	});
	assert.equal(Result.isFailure(inconsistent), true);

	const invalidSpawnProfile = Schema.decodeUnknownResult(AgentStoreStateSchema)({
		...registered.state,
		agents: [
			{
				...registered.value,
				profile: { ...registered.value.profile, spawnProfiles: ["bad_name"] },
			},
		],
	});
	assert.equal(Result.isFailure(invalidSpawnProfile), true);
});
