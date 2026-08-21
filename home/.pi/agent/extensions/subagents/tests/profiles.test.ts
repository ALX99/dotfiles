import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { parseAndValidateProfiles, resolveRun } from "../profiles.ts";

function model(id: string): Model<Api> {
	return {
		provider: "openai-codex",
		id,
		reasoning: true,
		contextWindow: 200_000,
	} as Model<Api>;
}

test("bundled profiles parse and bind every discovered role", () => {
	const config = parseAndValidateProfiles(fs.readFileSync(new URL("../profiles.json", import.meta.url), "utf8"), [
		"scout",
		"worker",
		"general",
	]);
	assert.ok(config.success);
});

test("profile identifiers reject whitespace and terminal-control characters", () => {
	const parsed = parseAndValidateProfiles({
		rootPolicy: { maxConcurrentRootAgents: 1 },
		profiles: {
			fast: {
				description: "Fast",
				modelPriority: [{ id: "openai-codex/gpt\u001b", defaultThinking: "low", maxThinking: "high" }],
			},
		},
		agentPolicies: { scout: { defaultProfile: "fast profile", allowedProfiles: ["fast"] } },
	});
	assert.equal(parsed.success, false);
	if (parsed.success) return;
	assert.ok(
		parsed.errors.some((error) => error.includes("model id must not contain whitespace or control characters")),
	);
	assert.ok(
		parsed.errors.some((error) => error.includes("defaultProfile must not contain whitespace or control characters")),
	);
});

test("an explicit empty model scope does not bypass the parent scope", () => {
	const config = parseAndValidateProfiles(
		{
			rootPolicy: { maxConcurrentRootAgents: 1 },
			profiles: {
				fast: {
					description: "Fast",
					modelPriority: [{ id: "openai-codex/gpt", defaultThinking: "low", maxThinking: "high" }],
				},
			},
			agentPolicies: { scout: { defaultProfile: "fast", allowedProfiles: ["fast"] } },
			capabilityRanking: ["openai-codex/gpt"],
		},
		["scout"],
	);
	assert.ok(config.success);
	if (!config.success) return;

	assert.throws(
		() =>
			resolveRun({
				config: config.config,
				modelRegistry: { getAvailable: () => [model("gpt")] },
				scopedModels: [],
				agent: "scout",
			}),
		/No authenticated model is available/,
	);
});

test("profile validation reports configuration relationships before a run can resolve", () => {
	const config = parseAndValidateProfiles(
		{
			rootPolicy: { maxConcurrentRootAgents: 1 },
			profiles: {
				fast: {
					description: "Fast",
					modelPriority: [
						{ id: "openai-codex/gpt", defaultThinking: "low", maxThinking: "high" },
						{ id: "openai-codex/gpt", defaultThinking: "low", maxThinking: "high" },
					],
				},
			},
			agentPolicies: {
				scout: { defaultProfile: "missing", allowedProfiles: ["fast", "missing"] },
			},
		},
		["worker"],
		"test-profiles.json",
	);

	assert.equal(config.success, false);
	if (config.success) return;
	assert.deepEqual(config.errors, [
		"test-profiles.json: profiles.fast.modelPriority.1.id: duplicate candidate model id 'openai-codex/gpt' (first at modelPriority.0.id)",
		"test-profiles.json: agentPolicies.scout: references unknown agent 'scout'",
		"test-profiles.json: agentPolicies.scout.defaultProfile: references unknown profile 'missing'",
		"test-profiles.json: agentPolicies.scout.allowedProfiles.1: references unknown profile 'missing'",
		"test-profiles.json: agentPolicies.worker: missing policy binding for agent 'worker'",
		"test-profiles.json: capabilityRanking: must list every profile candidate model; missing: openai-codex/gpt",
	]);
});

test("capabilityRanking accepts a unique ordering and rejects duplicate model ids", () => {
	const base = {
		rootPolicy: { maxConcurrentRootAgents: 1 },
		profiles: {
			fast: {
				description: "Fast",
				modelPriority: [{ id: "prov/luna", defaultThinking: "low", maxThinking: "high" }],
			},
		},
		agentPolicies: { scout: { defaultProfile: "fast", allowedProfiles: ["fast"] } },
	};

	const valid = parseAndValidateProfiles({ ...base, capabilityRanking: ["prov/luna", "prov/terra"] });
	assert.ok(valid.success);

	const duplicated = parseAndValidateProfiles(
		{ ...base, capabilityRanking: ["prov/luna", "prov/luna"] },
		[],
		"test-profiles.json",
	);
	assert.equal(duplicated.success, false);
	if (duplicated.success) return;
	assert.deepEqual(duplicated.errors, [
		"test-profiles.json: capabilityRanking.1: duplicate model id 'prov/luna' (first at capabilityRanking.0)",
	]);
});
