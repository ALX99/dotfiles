import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import type { AgentConfig } from "../agents.ts";
import { AgentRegistry, DEFAULT_MAX_CLOSED_AGENT_HISTORY } from "../agent-registry.ts";
import { CHILD_CONTEXT_ENV, parseChildExecutionContext, type ChildExecutionContext } from "../child-process.ts";
import { ManagedAgent as ProductionManagedAgent, type ManagedAgentOptions } from "../managed-agent.ts";
import { parseAndValidateProfiles, type ProfilesConfig } from "../profiles.ts";
import { SpawnAdmissionController } from "../spawn-admission.ts";

const parsed = parseAndValidateProfiles(
	fs.readFileSync(path.join(import.meta.dirname, "..", "profiles.json"), "utf8"),
	["scout", "worker", "general"],
);
if (!parsed.success) throw new Error(parsed.errors.join("\n"));
const config: ProfilesConfig = parsed.config;
const testAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-policy-test-"));
after(() => fs.rmSync(testAgentDir, { recursive: true, force: true }));

class ManagedAgent extends ProductionManagedAgent {
	constructor(options: Omit<ManagedAgentOptions, "agentDir">) {
		super({ ...options, agentDir: testAgentDir });
	}
}

function context(agent = "scout", profile = "fast"): ChildExecutionContext {
	return { agent, profile };
}

function managed(childContext: ChildExecutionContext): ManagedAgent {
	const agent: AgentConfig = {
		name: childContext.agent,
		description: "test",
		systemPrompt: "",
		filePath: `${childContext.agent}.md`,
	};
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
		retain: true,
	});
}

test("child execution context is strict, minimal, and identifies leaf executions", () => {
	const inherited = process.env[CHILD_CONTEXT_ENV];
	delete process.env[CHILD_CONTEXT_ENV];
	try {
		assert.equal(parseChildExecutionContext(), undefined);
	} finally {
		if (inherited !== undefined) process.env[CHILD_CONTEXT_ENV] = inherited;
	}
	assert.deepEqual(parseChildExecutionContext(JSON.stringify(context())), context());
	assert.throws(
		() => parseChildExecutionContext(JSON.stringify({ ...context(), depth: 1 })),
		new RegExp(`Invalid ${CHILD_CONTEXT_ENV}`),
	);
	assert.throws(() => parseChildExecutionContext("{"), /Invalid PI_SUBAGENT_CONTEXT/);
});

test("root and deep capacity reflect only live processes", async () => {
	const registry = new AgentRegistry();
	const admission = new SpawnAdmissionController(config, registry);
	const agents: ManagedAgent[] = [];
	for (let index = 0; index < config.rootPolicy.maxConcurrentRootAgents; index++) {
		const agent = managed(admission.admit({ agent: "scout", profile: "fast" }));
		agents.push(agent);
		await registry.add(agent);
	}
	assert.deepEqual(admission.capacity().root, {
		live: config.rootPolicy.maxConcurrentRootAgents,
		limit: config.rootPolicy.maxConcurrentRootAgents,
	});
	assert.throws(() => admission.admit({ agent: "scout", profile: "fast" }), /concurrency cap/);
	await agents[0]!.close();
	assert.equal(admission.admit({ agent: "scout", profile: "fast" }).agent, "scout");
	await registry.closeAll();
});

test("deep-profile capacity is independent from ordinary root capacity", async () => {
	const registry = new AgentRegistry();
	const admission = new SpawnAdmissionController(config, registry);
	const deep = managed(admission.admit({ agent: "general", profile: "deep-thinker" }));
	await registry.add(deep);
	assert.deepEqual(admission.capacity().deep, { live: 1, limit: 1 });
	assert.throws(() => admission.admit({ agent: "worker", profile: "deep-thinker" }), /Deep-agent concurrency cap/);
	assert.equal(admission.admit({ agent: "scout", profile: "fast" }).profile, "fast");
	await registry.closeAll();
});

test("archived history remains bounded and never consumes capacity", async () => {
	const registry = new AgentRegistry();
	const admission = new SpawnAdmissionController(config, registry);
	for (let index = 0; index <= DEFAULT_MAX_CLOSED_AGENT_HISTORY; index++) {
		const child = managed(admission.admit({ agent: "scout", profile: "fast" }));
		await registry.add(child);
		await registry.close(child.id);
	}
	assert.equal(registry.list().length, DEFAULT_MAX_CLOSED_AGENT_HISTORY);
	assert.equal(admission.capacity().root.live, 0);
	await registry.closeAll();
});
