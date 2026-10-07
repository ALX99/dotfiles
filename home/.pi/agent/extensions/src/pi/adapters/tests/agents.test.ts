import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect } from "effect";

import type { ApplicationEffects } from "../../../application.ts";
import { createAgentMailboxDelivery } from "../agents.ts";
import { openAgentStore } from "../../../agents/store.ts";
import type { ProfileSnapshot } from "../../../agents/profile.ts";
import { runPromise } from "../../../support/effect-runtime.ts";

const profile: ProfileSnapshot = {
	name: "engineer",
	model: { provider: "test", id: "model" },
	prompt: "Test profile.",
	sourcePath: "/profiles/engineer.md",
};

const applicationEffects: ApplicationEffects = {
	run: (effect, options) => Effect.runPromise(effect, options),
	initiate: (effect) => Effect.runPromise(effect).then(() => undefined),
};

async function waitFor(condition: () => boolean | Promise<boolean>, description: string): Promise<void> {
	const deadline = Date.now() + 1_000;
	while (!(await condition())) {
		if (Date.now() >= deadline) assert.fail(`Timed out waiting for ${description}.`);
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
	}
}

test("mailbox delivery waits for the parent safe point, batches pending events, and acknowledges after send", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-agent-delivery-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const store = await runPromise(openAgentStore({ ownerSessionId: "parent", directory }));
	for (let index = 1; index <= 2; index += 1) {
		const agent = await runPromise(
			store.createAgent({
				profile,
				sessionId: `child-session-${index}`,
				cwd: "/repo",
				invocationId: `invocation-${index}`,
				createdAt: index,
			}),
		);
		await runPromise(
			store.finishInvocation({
				agentId: agent.id,
				invocationId: agent.invocationId,
				status: "settled",
				occurredAt: index + 10,
			}),
		);
	}

	let busy = true;
	const sent: Array<readonly { id: string; agentId: string; type: string }[]> = [];
	const delivery = createAgentMailboxDelivery({
		store,
		applicationEffects,
		isBusy: () => busy,
		isCurrent: () => true,
		send: (events) => sent.push(events),
	});

	delivery.request();
	await new Promise<void>((resolve) => setTimeout(resolve, 15));
	assert.equal(sent.length, 0, "events stay queued while the parent is generating or executing a tool");
	assert.equal((await runPromise(store.pendingEvents())).length, 2);

	busy = false;
	delivery.request();
	await waitFor(() => sent.length === 1, "the pending event batch to be sent");
	await waitFor(async () => (await runPromise(store.pendingEvents())).length === 0, "events to be acknowledged");
	assert.equal(sent.length, 1, "already-pending events are delivered together");
	assert.deepEqual(
		sent[0]?.map(({ type }) => type),
		["settled", "settled"],
	);
	assert.equal(
		(await runPromise(store.pendingEvents())).length,
		0,
		"events are acknowledged after Pi accepts the message",
	);
	delivery.close();
});

test("failed mailbox delivery releases its claim so the durable event can be retried", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-agent-delivery-retry-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const store = await runPromise(openAgentStore({ ownerSessionId: "parent", directory }));
	const agent = await runPromise(
		store.createAgent({
			profile,
			sessionId: "child-session",
			cwd: "/repo",
			invocationId: "invocation",
			createdAt: 1,
		}),
	);
	await runPromise(
		store.finishInvocation({
			agentId: agent.id,
			invocationId: agent.invocationId,
			status: "settled",
			occurredAt: 2,
		}),
	);
	let fail = true;
	let attempts = 0;
	const delivery = createAgentMailboxDelivery({
		store,
		applicationEffects,
		isBusy: () => false,
		isCurrent: () => true,
		send: () => {
			attempts += 1;
			if (fail) throw new Error("Pi is shutting down.");
		},
	});

	delivery.request();
	await waitFor(async () => {
		const [event] = await runPromise(store.pendingEvents());
		return attempts === 1 && event !== undefined && event.claimId === undefined;
	}, "the failed delivery claim to be released");
	assert.equal((await runPromise(store.pendingEvents())).length, 1);
	assert.equal((await runPromise(store.pendingEvents()))[0]?.claimId, undefined);

	fail = false;
	delivery.request();
	await waitFor(
		async () => attempts === 2 && (await runPromise(store.pendingEvents())).length === 0,
		"the retried event to be acknowledged",
	);
	assert.equal((await runPromise(store.pendingEvents())).length, 0);
	delivery.close();
});
