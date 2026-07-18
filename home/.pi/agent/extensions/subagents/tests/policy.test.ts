import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import type { AgentConfig } from "../agents.ts";
import { AgentRegistry, DEFAULT_MAX_CLOSED_AGENT_HISTORY } from "../agent-registry.ts";
import { ManagedAgent, buildAgentSystemPrompt } from "../managed-agent.ts";
import { SpawnAdmissionController, executionCanDelegate } from "../spawn-admission.ts";
import { createSpawnAgentSchema } from "../index.ts";
import { CHILD_CONTEXT_ENV, parseChildExecutionContext, type ChildExecutionContext } from "../child-process.ts";
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

function context(agent = "general", profile = "balanced", delegationCredits = 0, depth = 1): ChildExecutionContext {
	return { treeId: "tree-1", depth, agent, profile, delegationCredits };
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
	const value = JSON.stringify(context("scout", "fast", 0, 2));
	assert.deepEqual(parseChildExecutionContext(value), context("scout", "fast", 0, 2));
	assert.throws(
		() => parseChildExecutionContext(JSON.stringify({ ...context(), extra: true })),
		new RegExp(`Invalid ${CHILD_CONTEXT_ENV}`),
	);
	assert.throws(() => parseChildExecutionContext("{"), /Invalid PI_SUBAGENT_CONTEXT/);
});

test("granted executions are told their initial non-refundable credit count", () => {
	assert.equal(buildAgentSystemPrompt("base", context()), "base");
	const prompt = buildAgentSystemPrompt("base", context("general", "balanced", 2));
	assert.match(prompt, /explicitly granted 2 delegation credits/);
	assert.match(prompt, /do not replenish/);
});

test("scout, worker, deep-profile, zero-credit general, and depth-2 executions are hard leaves", () => {
	for (const leaf of [
		context("scout", "fast", 2),
		context("worker", "balanced", 2),
		context("general", "deep-thinker", 2),
		context("general", "balanced", 0),
		context("general", "balanced", 1, 2),
	]) {
		assert.equal(executionCanDelegate(config, leaf), false);
		assert.equal(controller(leaf).canExposeSubagentTools(), false);
		assert.throws(() => controller(leaf).admit({ agent: "scout", profile: "fast" }), /leaf|cannot spawn/);
	}
});

test("root grants one or two credits only to delegation-enabled general executions", () => {
	for (const grant of [1, 2]) {
		const admitted = controller().admit({
			agent: "general",
			profile: "balanced",
			delegationCredits: grant,
		});
		assert.equal(admitted.delegationCredits, grant);
		assert.equal(executionCanDelegate(config, admitted), true);
	}
	for (const request of [
		{ agent: "scout", profile: "fast", delegationCredits: 1 },
		{ agent: "worker", profile: "balanced", delegationCredits: 1 },
		{ agent: "general", profile: "deep-thinker", delegationCredits: 1 },
	]) {
		assert.throws(() => controller().admit(request), /leaf|disables delegation/);
	}
});

test("nested runtime allows only scout/fast and never another grant", () => {
	const parent = context("general", "balanced", 2);
	const schemaText = JSON.stringify(createSpawnAgentSchema(config.rootPolicy.maxDelegationGrant));
	assert.match(schemaText, /Discovered subagent name/);
	assert.match(schemaText, /delegation_credits/);

	const admission = controller(parent);
	assert.throws(() => admission.admit({ agent: "worker", profile: "fast" }), /only: scout/);
	assert.throws(() => admission.admit({ agent: "scout", profile: "balanced" }), /only profiles: fast/);
	assert.throws(
		() => admission.admit({ agent: "scout", profile: "fast", delegationCredits: 0 }),
		/cannot transfer or re-grant/,
	);
});

test("two credits permit exactly two nested scouts and never replenish", async () => {
	const registry = new AgentRegistry();
	const admission = controller(context("general", "balanced", 2), registry);
	const first = admission.admit({ agent: "scout", profile: "fast" });
	const scout = managed(first);
	registry.add(scout);
	await scout.close();
	assert.equal(admission.remainingDelegationCredits(), 1, "closing a scout must not refund its credit");

	admission.admit({ agent: "scout", profile: "fast" });
	assert.equal(admission.remainingDelegationCredits(), 0);
	assert.throws(() => admission.admit({ agent: "scout", profile: "fast" }), /cap|No delegation credits/);
	// Follow-up generations do not call admission and therefore cannot reset it.
	assert.equal(admission.remainingDelegationCredits(), 0);
});

test("root admits four non-closed direct children, rejects the fifth, and closing releases a slot", async () => {
	const registry = new AgentRegistry();
	const admission = controller(undefined, registry);
	const existing: ManagedAgent[] = [];
	for (let index = 0; index < 4; index++) {
		const child = admission.admit({ agent: "scout", profile: "fast" });
		const agent = managed(child);
		existing.push(agent);
		registry.add(agent);
	}
	const before = registry.list();
	assert.throws(
		() => admission.admit({ agent: "scout", profile: "fast" }),
		/followup_agent.*close an agent.*current session/,
	);
	assert.deepEqual(registry.list(), before, "rejected admission must not mutate existing agents");

	const firstAgent = existing[0];
	assert.ok(firstAgent);
	await firstAgent.close();
	assert.equal(admission.admit({ agent: "scout", profile: "fast" }).depth, 1);
	await registry.closeAll();
});

test("bounded closed history never consumes root admission slots", async () => {
	const registry = new AgentRegistry();
	const admission = controller(undefined, registry);
	for (let index = 0; index <= DEFAULT_MAX_CLOSED_AGENT_HISTORY; index++) {
		const child = managed(admission.admit({ agent: "scout", profile: "fast" }));
		await registry.add(child);
		await registry.close(child.id);
	}
	assert.equal(registry.list().length, DEFAULT_MAX_CLOSED_AGENT_HISTORY);
	assert.equal(admission.admit({ agent: "scout", profile: "fast" }).depth, 1);
	await registry.closeAll();
});

test("one non-closed deep child is allowed; follow-up is unaffected; closing permits replacement", async () => {
	const registry = new AgentRegistry();
	const admission = controller(undefined, registry);
	const firstContext = admission.admit({ agent: "general", profile: "deep-thinker" });
	const deep = managed(firstContext);
	registry.add(deep);
	assert.throws(
		() => admission.admit({ agent: "general", profile: "deep-thinker" }),
		/followup_agent.*existing deep agent/,
	);
	assert.equal(deep.summary().generation, 0, "admission does not consume a follow-up generation");
	await deep.close();
	assert.equal(admission.admit({ agent: "general", profile: "deep-thinker" }).profile, "deep-thinker");
	await registry.closeAll();
});
