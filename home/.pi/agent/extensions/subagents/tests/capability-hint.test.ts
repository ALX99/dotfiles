import assert from "node:assert/strict";
import test from "node:test";
import { buildCapabilityHint } from "../capability-hint.ts";
import type { ProfilesConfig } from "../profiles.ts";

const config: ProfilesConfig = {
	rootPolicy: { maxConcurrentRootAgents: 2 },
	profiles: {
		fast: {
			description: "Mechanical execution",
			modelPriority: [{ id: "prov/luna", minThinking: "low", defaultThinking: "medium", maxThinking: "high" }],
		},
		balanced: {
			description: "Routine analysis",
			modelPriority: [{ id: "prov/terra", minThinking: "low", defaultThinking: "high", maxThinking: "max" }],
		},
	},
	agentPolicies: { worker: { defaultProfile: "fast", allowedProfiles: ["fast", "balanced"] } },
};

test("profile hints advertise authenticated choices and task guidance without model rankings", () => {
	const hint = buildCapabilityHint({
		config,
		agents: [{ name: "worker" }],
		availableModels: [{ model: { provider: "prov", id: "terra" } }] as never,
	});
	assert.ok(hint);
	assert.match(hint, /balanced → prov\/terra: Routine analysis/);
	assert.match(hint, /explicit requests override scoped defaults/);
	assert.doesNotMatch(hint, /fast|stronger|weaker|delegating demanding work.*safe/);
	assert.equal(buildCapabilityHint({ config, agents: [{ name: "worker" }], availableModels: [] }), undefined);
});
