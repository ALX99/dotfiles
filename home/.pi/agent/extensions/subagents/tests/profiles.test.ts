import * as assert from "node:assert/strict";
import { test } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { Effect, Result } from "effect";
import { runPromise } from "../../_shared/effect-runtime.ts";
import { parseAndValidateProfiles, resolveRun } from "../profiles.ts";

function model(id: string): Model<Api> {
	return {
		provider: "openai-codex",
		id,
		reasoning: true,
		contextWindow: 200_000,
	} as Model<Api>;
}

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
	assert.ok(Result.isFailure(parsed));
	if (Result.isFailure(parsed)) {
		assert.ok(
			parsed.failure.errors.some((error) =>
				error.includes("model id must not contain whitespace or control characters"),
			),
		);
		assert.ok(
			parsed.failure.errors.some((error) =>
				error.includes("defaultProfile must not contain whitespace or control characters"),
			),
		);
	}
});

test("an explicit empty model scope does not bypass the parent scope", async () => {
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
	assert.ok(Result.isSuccess(config));
	if (Result.isFailure(config)) return;

	const resolved = await runPromise(
		Effect.result(
			resolveRun({
				config: config.success,
				modelRegistry: { getAvailable: () => [model("gpt")] },
				scopedModels: [],
				agent: "scout",
			}),
		),
	);
	assert.ok(Result.isFailure(resolved));
	if (Result.isFailure(resolved)) {
		assert.equal(resolved.failure.reason, "no_authenticated_model");
		assert.match(resolved.failure.message, /No authenticated model is available/);
	}
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

	assert.ok(Result.isFailure(config));
	if (Result.isFailure(config))
		assert.deepEqual(config.failure.errors, [
			"test-profiles.json: profiles.fast.modelPriority.1.id: duplicate candidate model id 'openai-codex/gpt' (first at modelPriority.0.id)",
			"test-profiles.json: agentPolicies.scout: references unknown agent 'scout'",
			"test-profiles.json: agentPolicies.scout.defaultProfile: references unknown profile 'missing'",
			"test-profiles.json: agentPolicies.scout.allowedProfiles.1: references unknown profile 'missing'",
			"test-profiles.json: agentPolicies.worker: missing policy binding for agent 'worker'",
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
	assert.ok(Result.isSuccess(valid));
	assert.ok(Result.isSuccess(parseAndValidateProfiles(base)));
	assert.ok(Result.isSuccess(parseAndValidateProfiles({ ...base, capabilityRanking: ["prov/terra"] })));

	const duplicated = parseAndValidateProfiles(
		{ ...base, capabilityRanking: ["prov/luna", "prov/luna"] },
		[],
		"test-profiles.json",
	);
	assert.ok(Result.isFailure(duplicated));
	if (Result.isFailure(duplicated)) {
		assert.deepEqual(duplicated.failure.errors, [
			"test-profiles.json: capabilityRanking.1: duplicate model id 'prov/luna' (first at capabilityRanking.0)",
		]);
	}
});
