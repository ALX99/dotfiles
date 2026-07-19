import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import type { AgentConfig } from "../agents.ts";
import { AgentRegistry, DEFAULT_MAX_CLOSED_AGENT_HISTORY } from "../agent-registry.ts";
import { ManagedAgent, buildInitialTask } from "../managed-agent.ts";
import { SpawnAdmissionController, executionCanDelegate } from "../spawn-admission.ts";
import { createSpawnAgentSchema } from "../index.ts";
import {
	CHILD_CONTEXT_ENV,
	MAX_DELEGATION_DEPTH,
	parseChildExecutionContext,
	type ChildExecutionContext,
} from "../child-process.ts";
import { parseAndValidateProfiles, type ProfilesConfig } from "../profiles.ts";

const agentNames = ["scout", "worker", "general"];
const parsed = parseAndValidateProfiles(
	fs.readFileSync(path.join(import.meta.dirname, "..", "profiles.json"), "utf8"),
	agentNames,
);
if (!parsed.success) throw new Error(parsed.errors.join("\n"));
const config: ProfilesConfig = parsed.config;

const agents: AgentConfig[] = agentNames.map((name) => ({
	name,
	description: name,
	systemPrompt: name,
	filePath: `${name}.md`,
}));

function context(agent = "general", profile = "balanced", childSpawnBudget = 0, depth = 1): ChildExecutionContext {
	return { treeId: "tree-1", depth, agent, profile, childSpawnBudget };
}

function controller(
	executionContext?: ChildExecutionContext,
	registry = new AgentRegistry(),
): SpawnAdmissionController {
	return new SpawnAdmissionController(config, registry, "tree-1", executionContext);
}

function managed(childContext: ChildExecutionContext): ManagedAgent {
	const agent = agents.find((candidate) => candidate.name === childContext.agent)!;
	return new ManagedAgent({
		defaultCwd: process.cwd(),
		agent,
		resolvedRun: {
			agent: childContext.agent,
			profile: childContext.profile,
			model: "provider/model",
			effectiveThinking: "high",
			contextWindow: 128_000,
		},
		childContext,
		subagentToolsEnabled: executionCanDelegate(config, childContext),
	});
}

test("child execution context has one strict parser and absence identifies root", () => {
	const inheritedContext = process.env[CHILD_CONTEXT_ENV];
	delete process.env[CHILD_CONTEXT_ENV];
	try {
		assert.equal(parseChildExecutionContext(), undefined);
	} finally {
		if (inheritedContext !== undefined) process.env[CHILD_CONTEXT_ENV] = inheritedContext;
	}
	const value = JSON.stringify(context("scout", "fast", 0, MAX_DELEGATION_DEPTH));
	assert.deepEqual(parseChildExecutionContext(value), context("scout", "fast", 0, MAX_DELEGATION_DEPTH));
	assert.throws(
		() => parseChildExecutionContext(JSON.stringify({ ...context(), extra: true })),
		new RegExp(`Invalid ${CHILD_CONTEXT_ENV}`),
	);
	assert.throws(() => parseChildExecutionContext("{"), /Invalid PI_SUBAGENT_CONTEXT/);
});

test("initial tasks distinguish parent context from verified facts", () => {
	assert.equal(buildInitialTask("inspect", undefined), "Task: inspect");
	assert.equal(
		buildInitialTask("inspect", "  prior finding  "),
		`Task: inspect

Parent context (may be incomplete; use it to understand the assignment and verify factual claims when material):
prior finding`,
	);
});

test("scout, deep-profile, zero-credit, and depth-2 executions are hard leaves", () => {
	for (const leaf of [
		context("scout", "fast", 2),
		context("worker", "deep-thinker", 2),
		context("worker", "balanced", 0),
		context("worker", "balanced", 1, MAX_DELEGATION_DEPTH),
		context("general", "deep-thinker", 2),
		context("general", "balanced", 0),
		context("general", "balanced", 1, MAX_DELEGATION_DEPTH),
	]) {
		assert.equal(executionCanDelegate(config, leaf), false);
		assert.equal(controller(leaf).canExposeSubagentTools(), false);
		assert.throws(() => controller(leaf).reserve({ agent: "scout", profile: "fast" }), /leaf|cannot spawn/);
	}
});

test("root grants one or two credits to delegation-enabled general and worker executions", () => {
	for (const agent of ["general", "worker"]) {
		for (const grant of [1, 2]) {
			const admitted = controller().reserve({
				agent,
				profile: "balanced",
				childSpawnBudget: grant,
			}).childContext;
			assert.equal(admitted.childSpawnBudget, grant);
			assert.equal(executionCanDelegate(config, admitted), true);
		}
	}
	for (const request of [
		{ agent: "scout", profile: "fast", childSpawnBudget: 1 },
		{ agent: "worker", profile: "deep-thinker", childSpawnBudget: 1 },
		{ agent: "general", profile: "deep-thinker", childSpawnBudget: 1 },
	]) {
		assert.throws(() => controller().reserve(request), /leaf|disables delegation/);
	}
});

test("general and worker nested runtimes allow only scout/fast and never another grant", () => {
	const schemaText = JSON.stringify(createSpawnAgentSchema({ agents: ["scout"], profiles: ["fast"] }));
	assert.match(schemaText, /"enum":\["scout"\]/);
	assert.match(schemaText, /"enum":\["fast"\]/);
	assert.doesNotMatch(schemaText, /child_spawn_budget/);

	for (const agent of ["general", "worker"]) {
		const admission = controller(context(agent, "balanced", 2));
		assert.throws(() => admission.reserve({ agent: "worker", profile: "fast" }), /only: scout/);
		assert.throws(() => admission.reserve({ agent: "scout", profile: "balanced" }), /only profiles: fast/);
		assert.throws(
			() => admission.reserve({ agent: "scout", profile: "fast", childSpawnBudget: 0 }),
			/cannot transfer or re-grant/,
		);
	}
});

test("two credits permit exactly two nested scouts and never replenish", async () => {
	const registry = new AgentRegistry();
	const admission = controller(context("worker", "balanced", 2), registry);
	const first = admission.reserve({ agent: "scout", profile: "fast" });
	first.commit();
	const scout = managed(first.childContext);
	registry.add(scout);
	await scout.close();
	assert.equal(admission.remainingDelegationCredits(), 1, "closing a scout must not refund its credit");

	admission.reserve({ agent: "scout", profile: "fast" }).commit();
	assert.equal(admission.remainingDelegationCredits(), 0);
	assert.throws(() => admission.reserve({ agent: "scout", profile: "fast" }), /cap|No delegation credits/);
	// Follow-up generations do not call admission and therefore cannot reset it.
	assert.equal(admission.remainingDelegationCredits(), 0);
});

test("releasing a pending nested spawn refunds its lifetime slot and credit", () => {
	const admission = controller(context("worker", "balanced", 1));
	const failedStartup = admission.reserve({ agent: "scout", profile: "fast" });
	assert.equal(admission.remainingDelegationCredits(), 0);
	failedStartup.release();
	failedStartup.release();
	assert.equal(admission.remainingDelegationCredits(), 1);

	const replacement = admission.reserve({ agent: "scout", profile: "fast" });
	replacement.commit();
	replacement.release();
	assert.equal(admission.remainingDelegationCredits(), 0, "release after commit must not refund a successful spawn");
});

test("root admits four non-closed direct children, rejects the fifth, and closing releases a slot", async () => {
	const registry = new AgentRegistry();
	const admission = controller(undefined, registry);
	const existing: ManagedAgent[] = [];
	for (let index = 0; index < 4; index++) {
		const child = admission.reserve({ agent: "scout", profile: "fast" });
		child.commit();
		const agent = managed(child.childContext);
		existing.push(agent);
		registry.add(agent);
	}
	const before = registry.list();
	assert.throws(
		() => admission.reserve({ agent: "scout", profile: "fast" }),
		/followup_agent.*close an agent.*current session/,
	);
	assert.deepEqual(registry.list(), before, "rejected admission must not mutate existing agents");

	const firstAgent = existing[0];
	assert.ok(firstAgent);
	await firstAgent.close();
	assert.equal(admission.reserve({ agent: "scout", profile: "fast" }).childContext.depth, 1);
	await registry.closeAll();
});

test("bounded closed history never consumes root admission slots", async () => {
	const registry = new AgentRegistry();
	const admission = controller(undefined, registry);
	for (let index = 0; index <= DEFAULT_MAX_CLOSED_AGENT_HISTORY; index++) {
		const reservation = admission.reserve({ agent: "scout", profile: "fast" });
		reservation.commit();
		const child = managed(reservation.childContext);
		await registry.add(child);
		await registry.close(child.id);
	}
	assert.equal(registry.list().length, DEFAULT_MAX_CLOSED_AGENT_HISTORY);
	assert.equal(admission.reserve({ agent: "scout", profile: "fast" }).childContext.depth, 1);
	await registry.closeAll();
});

test("one non-closed deep child is allowed; follow-up is unaffected; closing permits replacement", async () => {
	const registry = new AgentRegistry();
	const admission = controller(undefined, registry);
	const first = admission.reserve({ agent: "general", profile: "deep-thinker" });
	first.commit();
	const deep = managed(first.childContext);
	registry.add(deep);
	assert.throws(
		() => admission.reserve({ agent: "general", profile: "deep-thinker" }),
		/existing deep agent.*followup_agent|followup_agent.*existing deep agent/,
	);
	assert.equal(deep.summary().generation, 0, "admission does not consume a follow-up generation");
	await deep.close();
	assert.equal(admission.reserve({ agent: "general", profile: "deep-thinker" }).childContext.profile, "deep-thinker");
	await registry.closeAll();
});
