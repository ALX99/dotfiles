import * as assert from "node:assert/strict";
import { test } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import fc from "fast-check";
import { createSpawnAgentSchema, createWaitAgentSchema, DEFAULT_WAIT_MS } from "../index.ts";
import {
	parseAndValidateProfiles,
	parseProfilesJson,
	resolveRun,
	validateProfiles,
	type ProfilesConfig,
} from "../profiles.ts";

const config: ProfilesConfig = {
	rootPolicy: {
		maxConcurrentRootAgents: 4,
		maxConcurrentDeepAgents: 1,
		maxSpawnBudgetPerChild: 2,
	},
	profiles: {
		fast: {
			description: "Fast work",
			delegationEnabled: true,
			countsTowardDeepAgentCap: false,
			modelPriority: [
				{ id: "provider/first/model", defaultThinking: "low", maxThinking: "low" },
				{ id: "provider/second", defaultThinking: "medium", maxThinking: "high" },
			],
		},
		deep: {
			description: "Deep work",
			delegationEnabled: false,
			countsTowardDeepAgentCap: true,
			modelPriority: [{ id: "provider/deep", defaultThinking: "high", maxThinking: "xhigh" }],
		},
	},
	agentPolicies: {
		scout: { defaultProfile: "fast", allowedProfiles: ["fast"], delegation: { mode: "leaf" } },
		worker: { defaultProfile: "fast", allowedProfiles: ["fast", "deep"], delegation: { mode: "leaf" } },
	},
};

function model(
	provider: string,
	id: string,
	contextWindow = 128_000,
	reasoning = true,
	thinkingLevelMap?: Model<Api>["thinkingLevelMap"],
): Model<Api> {
	return {
		id,
		name: id,
		provider,
		api: "openai-responses",
		baseUrl: "https://example.test",
		reasoning,
		thinkingLevelMap,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: 16_000,
	} as Model<Api>;
}

test("parseProfilesJson reports every strict Zod error with a precise path", () => {
	const result = parseProfilesJson(
		{
			profiles: {
				fast: { description: "", modelPriority: [{ id: "missing-slash", maxThinking: "nope", extra: true }] },
			},
			agentPolicies: {},
			extra: true,
		},
		"fixture.json",
	);

	assert.equal(result.success, false);
	if (result.success) return;
	assert.ok(result.errors.length >= 4);
	assert.ok(result.errors.some((error) => error.includes("<root>")));
	assert.ok(result.errors.some((error) => error.includes("profiles.fast.description")));
	assert.ok(result.errors.some((error) => error.includes("profiles.fast.modelPriority.0.id")));
	assert.ok(result.errors.some((error) => error.includes("profiles.fast.modelPriority.0.maxThinking")));
});

test("profile parsing rejects defaultThinking above maxThinking", () => {
	const invalid = structuredClone(config);
	const fast = invalid.profiles.fast;
	assert.ok(fast);
	const candidate = fast.modelPriority[0];
	assert.ok(candidate);
	candidate.defaultThinking = "high";
	candidate.maxThinking = "low";
	const result = parseProfilesJson(invalid, "fixture.json");
	assert.equal(result.success, false);
	if (result.success) return;
	assert.ok(
		result.errors.some(
			(error) => error.includes("modelPriority.0.defaultThinking") && error.includes("must not exceed"),
		),
	);
});

test("validateProfiles aggregates duplicate and cross-reference errors", () => {
	const invalid: ProfilesConfig = structuredClone(config);
	const fast = invalid.profiles.fast;
	assert.ok(fast);
	fast.modelPriority.push({ id: "provider/first/model", defaultThinking: "low", maxThinking: "low" });
	invalid.agentPolicies.scout = {
		defaultProfile: "missing",
		allowedProfiles: ["deep", "deep"],
		delegation: { mode: "leaf" },
	};
	invalid.agentPolicies.unknown = { defaultProfile: "fast", allowedProfiles: ["fast"], delegation: { mode: "leaf" } };

	const errors = validateProfiles(invalid, ["scout", "worker", "general"], "fixture.json");
	assert.ok(errors.some((error) => error.includes("modelPriority.2.id: duplicate candidate model id")));
	assert.ok(errors.some((error) => error.includes("allowedProfiles.1: duplicate allowed profile")));
	assert.ok(errors.some((error) => error.includes("defaultProfile: references unknown profile")));
	assert.ok(errors.some((error) => error.includes("defaultProfile: must appear in allowedProfiles")));
	assert.ok(errors.some((error) => error.includes("agentPolicies.unknown: references unknown agent")));
	assert.ok(errors.some((error) => error.includes("agentPolicies.general: missing policy binding")));
});

test("profile parsing rejects whitespace-bearing profile and agent-policy keys", () => {
	for (const [section, key] of [
		["profiles", " fast"],
		["profiles", "deep profile"],
		["agentPolicies", "scout "],
		["agentPolicies", "general\tagent"],
	] as const) {
		const invalid = structuredClone(config) as unknown as Record<string, Record<string, unknown>>;
		const records = invalid[section];
		assert.ok(records);
		records[key] =
			section === "profiles" ? structuredClone(config.profiles.fast) : structuredClone(config.agentPolicies.scout);
		const result = parseProfilesJson(invalid, "fixture.json");
		assert.equal(result.success, false, `${section}.${JSON.stringify(key)} should be rejected`);
		if (!result.success) assert.ok(result.errors.some((error) => error.includes("Invalid key in record")));
	}
});

test("delegation rejects every advertised child agent/profile pair the child policy does not allow", () => {
	const cases = [
		{ childAgent: "scout", childProfiles: ["fast", "deep"], allowedProfiles: ["fast"], incompatible: "deep" },
		{ childAgent: "worker", childProfiles: ["fast"], allowedProfiles: ["deep"], incompatible: "fast" },
	] as const;

	for (const fixture of cases) {
		const invalid = structuredClone(config);
		const childPolicy = invalid.agentPolicies[fixture.childAgent];
		assert.ok(childPolicy);
		childPolicy.defaultProfile = fixture.allowedProfiles[0];
		childPolicy.allowedProfiles = [...fixture.allowedProfiles];
		const parentPolicy = invalid.agentPolicies.worker;
		assert.ok(parentPolicy);
		parentPolicy.delegation = {
			mode: "grant-required",
			maxLifetimeChildSpawns: 1,
			allowedChildAgents: [fixture.childAgent],
			allowedChildProfiles: [...fixture.childProfiles],
		};

		const errors = validateProfiles(invalid, ["scout", "worker"], "fixture.json");
		assert.ok(
			errors.some(
				(error) =>
					error.includes(`profile '${fixture.incompatible}'`) &&
					error.includes(`child agent '${fixture.childAgent}'`) &&
					error.includes("does not allow it"),
			),
		);
	}
});

test("every child agent/profile combination exposed by a valid delegation policy is compatible", () => {
	const valid = structuredClone(config);
	const parentPolicy = valid.agentPolicies.worker;
	assert.ok(parentPolicy);
	parentPolicy.delegation = {
		mode: "grant-required",
		maxLifetimeChildSpawns: 2,
		allowedChildAgents: ["scout", "worker"],
		allowedChildProfiles: ["fast"],
	};
	assert.deepEqual(validateProfiles(valid, ["scout", "worker"], "fixture.json"), []);

	const delegation = parentPolicy.delegation;
	assert.equal(delegation.mode, "grant-required");
	for (const childAgent of delegation.allowedChildAgents) {
		const policy = valid.agentPolicies[childAgent];
		assert.ok(policy);
		for (const childProfile of delegation.allowedChildProfiles) {
			assert.ok(policy.allowedProfiles.includes(childProfile), `${childAgent}/${childProfile} must resolve`);
		}
	}
});

test("parseAndValidateProfiles combines loading and agent-binding validation", () => {
	const result = parseAndValidateProfiles(JSON.stringify(config), ["scout", "worker", "general"], "fixture.json");
	assert.equal(result.success, false);
	if (result.success) return;
	assert.deepEqual(result.errors, ["fixture.json: agentPolicies.general: missing policy binding for agent 'general'"]);
});

test("resolveRun uses the default profile, authenticated candidate order, and a supported lower level", () => {
	const run = resolveRun({
		config,
		agent: "scout",
		modelRegistry: {
			getAvailable: () => [
				model("provider", "second"),
				model("provider", "first/model", 96_000, true, { high: "high", xhigh: null, max: null }),
			],
		},
		requestedThinking: "low",
	});

	assert.deepEqual(run, {
		agent: "scout",
		profile: "fast",
		model: "provider/first/model",
		effectiveThinking: "low",
		contextWindow: 96_000,
	});
	assert.ok(Object.isFrozen(run));
});

test("resolveRun uses defaultThinking when thinking is omitted", () => {
	const run = resolveRun({
		config,
		agent: "scout",
		modelRegistry: { getAvailable: () => [model("provider", "first/model")] },
	});
	assert.equal(run.effectiveThinking, "low");
});

test("resolveRun permits allowed profile overrides and rejects disallowed overrides or requests above a cap", () => {
	const registry = {
		getAvailable: () => [
			model("provider", "deep", 128_000, true, { high: "high", xhigh: "xhigh", max: null }),
			model("provider", "first/model"),
		],
	};
	assert.equal(resolveRun({ config, agent: "worker", profile: "deep", modelRegistry: registry }).profile, "deep");
	assert.equal(
		resolveRun({ config, agent: "worker", profile: "deep", modelRegistry: registry }).effectiveThinking,
		"high",
	);
	assert.equal(
		resolveRun({ config, agent: "worker", profile: "deep", requestedThinking: "xhigh", modelRegistry: registry })
			.effectiveThinking,
		"xhigh",
	);
	assert.throws(() => resolveRun({ config, agent: "scout", profile: "deep", modelRegistry: registry }), /not allowed/);
	assert.throws(
		() => resolveRun({ config, agent: "scout", requestedThinking: "high", modelRegistry: registry }),
		/exceeds/,
	);
});

test("wait uses a fixed fifteen-minute timeout without exposing an override", () => {
	assert.equal(DEFAULT_WAIT_MS, 900_000);
	const schema = createWaitAgentSchema();
	assert.deepEqual(Object.keys(schema.properties), ["agent_ids"]);
	assert.deepEqual(schema.required, ["agent_ids"]);
});

test("root spawn schema exposes only configured agents and profiles", () => {
	const schema = createSpawnAgentSchema({
		agents: Object.keys(config.agentPolicies),
		profiles: Object.keys(config.profiles),
		maxSpawnBudgetPerChild: config.rootPolicy.maxSpawnBudgetPerChild,
	});
	const schemaJson = JSON.parse(JSON.stringify(schema)) as {
		properties: { agent: { enum: string[] }; profile: { enum: string[] } };
	};
	assert.ok(schema.required?.includes("agent"));
	assert.ok(schema.required?.includes("message"));
	assert.deepEqual(schemaJson.properties.agent.enum, ["scout", "worker"]);
	assert.deepEqual(schemaJson.properties.profile.enum, ["fast", "deep"]);
	assert.ok(Object.hasOwn(schema.properties, "profile"));
	assert.ok(Object.hasOwn(schema.properties, "thinking"));
	assert.ok(Object.hasOwn(schema.properties, "child_spawn_budget"));
	assert.equal(Object.hasOwn(schema.properties, "agent_type"), false);
	assert.equal(Object.hasOwn(schema.properties, "reasoning_effort"), false);
	assert.equal(Object.hasOwn(schema.properties, "model"), false);
});

test("resolveRun requires an authenticated exact match and never clamps upward", () => {
	assert.throws(
		() => resolveRun({ config, agent: "scout", modelRegistry: { getAvailable: () => [model("provider", "other")] } }),
		/No authenticated model is available/,
	);
	assert.throws(
		() =>
			resolveRun({
				config,
				agent: "scout",
				modelRegistry: {
					getAvailable: () => [
						model("provider", "first/model", 100, true, {
							off: null,
							minimal: null,
							low: null,
							medium: null,
							high: null,
							xhigh: null,
							max: null,
						}),
					],
				},
			}),
		/supports no thinking level at or below/,
	);
});

test("resolveRun always honors configured candidate priority regardless of registry order", () => {
	const candidatesAndAvailable = fc
		.uniqueArray(fc.integer({ min: 0, max: 100 }), { minLength: 1, maxLength: 12 })
		.chain((candidates) =>
			fc.shuffledSubarray(candidates, { minLength: 1 }).map((available) => ({ candidates, available })),
		);

	fc.assert(
		fc.property(candidatesAndAvailable, ({ candidates, available }) => {
			const generated: ProfilesConfig = {
				rootPolicy: config.rootPolicy,
				profiles: {
					generated: {
						description: "Generated profile",
						delegationEnabled: false,
						countsTowardDeepAgentCap: false,
						modelPriority: candidates.map((candidate) => ({
							id: `provider/model-${candidate}`,
							defaultThinking: "low",
							maxThinking: "low",
						})),
					},
				},
				agentPolicies: {
					general: {
						defaultProfile: "generated",
						allowedProfiles: ["generated"],
						delegation: { mode: "leaf" },
					},
				},
			};
			const availableSet = new Set(available);
			const expected = candidates.find((candidate) => availableSet.has(candidate));
			assert.notEqual(expected, undefined);

			const run = resolveRun({
				config: generated,
				agent: "general",
				modelRegistry: {
					getAvailable: () => available.map((candidate) => model("provider", `model-${candidate}`)),
				},
			});
			assert.equal(run.model, `provider/model-${expected}`);
		}),
	);
});
