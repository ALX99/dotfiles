import * as assert from "node:assert/strict";
import { test } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { createSpawnAgentSchema, createWaitAgentSchema, DEFAULT_WAIT_MS } from "../index.ts";
import {
	parseAndValidateProfiles,
	parseProfilesJson,
	resolveRun,
	validateProfiles,
	type ProfilesConfig,
} from "../profiles.ts";

const config: ProfilesConfig = {
	profiles: {
		fast: {
			description: "Fast work",
			models: [
				{ id: "provider/first/model", maxThinking: "low" },
				{ id: "provider/second", maxThinking: "high" },
			],
		},
		deep: {
			description: "Deep work",
			models: [{ id: "provider/deep", maxThinking: "high" }],
		},
	},
	agentPolicies: {
		scout: { defaultProfile: "fast", allowedProfiles: ["fast"] },
		worker: { defaultProfile: "fast", allowedProfiles: ["fast", "deep"] },
	},
};

function model(provider: string, id: string, contextWindow = 128_000, reasoning = true, thinkingLevelMap?: Model<Api>["thinkingLevelMap"]): Model<Api> {
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
	const result = parseProfilesJson({
		profiles: {
			fast: { description: "", models: [{ id: "missing-slash", maxThinking: "nope", extra: true }] },
		},
		agentPolicies: {},
		extra: true,
	}, "fixture.json");

	assert.equal(result.success, false);
	if (result.success) return;
	assert.ok(result.errors.length >= 4);
	assert.ok(result.errors.some((error) => error.includes("<root>")));
	assert.ok(result.errors.some((error) => error.includes("profiles.fast.description")));
	assert.ok(result.errors.some((error) => error.includes("profiles.fast.models.0.id")));
	assert.ok(result.errors.some((error) => error.includes("profiles.fast.models.0.maxThinking")));
});

test("validateProfiles aggregates duplicate and cross-reference errors", () => {
	const invalid: ProfilesConfig = structuredClone(config);
	invalid.profiles.fast.models.push({ id: "provider/first/model", maxThinking: "low" });
	invalid.agentPolicies.scout = {
		defaultProfile: "missing",
		allowedProfiles: ["deep", "deep"],
	};
	invalid.agentPolicies.unknown = { defaultProfile: "fast", allowedProfiles: ["fast"] };

	const errors = validateProfiles(invalid, ["scout", "worker", "general"], "fixture.json");
	assert.ok(errors.some((error) => error.includes("models.2.id: duplicate candidate model id")));
	assert.ok(errors.some((error) => error.includes("allowedProfiles.1: duplicate allowed profile")));
	assert.ok(errors.some((error) => error.includes("defaultProfile: references unknown profile")));
	assert.ok(errors.some((error) => error.includes("defaultProfile: must appear in allowedProfiles")));
	assert.ok(errors.some((error) => error.includes("agentPolicies.unknown: references unknown agent")));
	assert.ok(errors.some((error) => error.includes("agentPolicies.general: missing policy binding")));
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

test("resolveRun permits allowed profile overrides and rejects disallowed overrides or requests above a cap", () => {
	const registry = { getAvailable: () => [model("provider", "deep"), model("provider", "first/model")] };
	assert.equal(resolveRun({ config, agent: "worker", profile: "deep", modelRegistry: registry }).profile, "deep");
	assert.throws(() => resolveRun({ config, agent: "scout", profile: "deep", modelRegistry: registry }), /not allowed/);
	assert.throws(() => resolveRun({ config, agent: "scout", requestedThinking: "high", modelRegistry: registry }), /exceeds/);
});

test("wait uses a fixed ten-minute timeout without exposing an override", () => {
	assert.equal(DEFAULT_WAIT_MS, 600_000);
	const schema = createWaitAgentSchema() as unknown as {
		properties: Record<string, unknown>;
		required?: string[];
	};
	assert.deepEqual(Object.keys(schema.properties), ["agent_ids"]);
	assert.deepEqual(schema.required, ["agent_ids"]);
});

test("spawn schema requires agent and exposes only profile-based execution overrides", () => {
	const schema = createSpawnAgentSchema([
		{ name: "scout", description: "Scout", systemPrompt: "Scout", filePath: "scout.md" },
		{ name: "worker", description: "Worker", systemPrompt: "Worker", filePath: "worker.md" },
	], config);
	assert.ok(schema.required?.includes("agent"));
	assert.ok(schema.required?.includes("message"));
	assert.ok(Object.hasOwn(schema.properties, "profile"));
	assert.ok(Object.hasOwn(schema.properties, "thinking"));
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
		() => resolveRun({
			config,
			agent: "scout",
			modelRegistry: {
				getAvailable: () => [model("provider", "first/model", 100, true, {
					off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: null,
				})],
			},
		}),
		/supports no thinking level at or below/,
	);
});
