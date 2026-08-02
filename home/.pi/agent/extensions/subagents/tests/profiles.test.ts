import * as fs from "node:fs";
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
import { thinkingLevelsForProfiles } from "../tools/spawn-agent.ts";

const config: ProfilesConfig = {
	rootPolicy: {
		maxConcurrentRootAgents: 4,
		maxConcurrentDeepAgents: 1,
	},
	profiles: {
		fast: {
			description: "Fast work",
			countsTowardDeepAgentCap: false,
			modelPriority: [
				{ id: "provider/first/model", defaultThinking: "low", maxThinking: "low" },
				{ id: "provider/second", defaultThinking: "medium", maxThinking: "high" },
			],
		},
		deep: {
			description: "Deep work",
			countsTowardDeepAgentCap: true,
			modelPriority: [{ id: "provider/deep", defaultThinking: "high", maxThinking: "xhigh" }],
		},
	},
	agentPolicies: {
		scout: { defaultProfile: "fast", allowedProfiles: ["fast"] },
		worker: { defaultProfile: "fast", allowedProfiles: ["fast", "deep"] },
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
	};
	invalid.agentPolicies.unknown = { defaultProfile: "fast", allowedProfiles: ["fast"] };

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

test("resolveRun rejects a thinking request below the candidate default", () => {
	const restricted = structuredClone(config);
	const fast = restricted.profiles.fast;
	assert.ok(fast);
	const candidate = fast.modelPriority[0];
	assert.ok(candidate);
	candidate.defaultThinking = "medium";
	candidate.maxThinking = "high";

	assert.throws(
		() =>
			resolveRun({
				config: restricted,
				agent: "scout",
				requestedThinking: "low",
				modelRegistry: { getAvailable: () => [model("provider", "first/model")] },
			}),
		/below .* minimum/,
	);
});

test("resolveRun selects the first authenticated candidate", () => {
	let availableCalls = 0;
	const run = resolveRun({
		config,
		agent: "scout",
		modelRegistry: {
			getAvailable: () => {
				availableCalls += 1;
				return [model("provider", "first/model")];
			},
		},
		scopedModels: [{ model: model("provider", "second"), thinkingLevel: "high" }],
	});

	assert.equal(run.model, "provider/second");
	assert.equal(run.effectiveThinking, "high");
	assert.equal(availableCalls, 0);
	assert.throws(
		() =>
			resolveRun({
				config,
				agent: "scout",
				modelRegistry: { getAvailable: () => [] },
				scopedModels: [{ model: model("provider", "first/model"), thinkingLevel: "high" }],
			}),
		/exceeds profile .* cap/,
	);
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

test("wait defaults to fifteen minutes and exposes a bounded caller override", () => {
	assert.equal(DEFAULT_WAIT_MS, 900_000);
	const schema = createWaitAgentSchema();
	assert.deepEqual(Object.keys(schema.properties), ["agent_ids", "timeout_ms"]);
	assert.deepEqual(schema.required, ["agent_ids"]);
});

test("root spawn schema exposes only configured agents and profiles", () => {
	const schema = createSpawnAgentSchema({
		agents: Object.keys(config.agentPolicies),
		profiles: Object.keys(config.profiles),
		thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
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
	assert.ok(Object.hasOwn(schema.properties, "retain"));
	assert.equal(Object.hasOwn(schema.properties, "child_spawn_budget"), false);
	assert.equal(Object.hasOwn(schema.properties, "agent_type"), false);
	assert.equal(Object.hasOwn(schema.properties, "reasoning_effort"), false);
	assert.equal(Object.hasOwn(schema.properties, "model"), false);
});

test("thinking-level advertisement respects configured defaults and caps", () => {
	assert.deepEqual(thinkingLevelsForProfiles(config, ["fast", "deep"]), ["low"]);

	const restricted = structuredClone(config);
	const fast = restricted.profiles.fast;
	assert.ok(fast);
	const candidate = fast.modelPriority[0];
	assert.ok(candidate);
	candidate.defaultThinking = "medium";
	candidate.maxThinking = "high";
	assert.deepEqual(thinkingLevelsForProfiles(restricted, ["fast", "deep"]), ["medium", "high"]);
});

test("configured scout profile does not permit low thinking", () => {
	const parsed = parseProfilesJson(fs.readFileSync(new URL("../profiles.json", import.meta.url), "utf8"));
	assert.equal(parsed.success, true);
	if (!parsed.success) return;

	assert.equal(thinkingLevelsForProfiles(parsed.config, ["fast"]).includes("low"), false);
	assert.throws(
		() =>
			resolveRun({
				config: parsed.config,
				agent: "scout",
				requestedThinking: "low",
				modelRegistry: { getAvailable: () => [model("openai-codex", "gpt-5.6-luna")] },
			}),
		/below .* minimum/,
	);
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
