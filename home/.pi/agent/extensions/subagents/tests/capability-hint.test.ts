import assert from "node:assert/strict";
import test from "node:test";

import type { ScopedModel } from "@earendil-works/pi-coding-agent";

import { buildCapabilityHint, findScopedRankingError } from "../capability-hint.ts";
import type { ProfilesConfig } from "../profiles.ts";

function config(ranking?: string[]): ProfilesConfig {
	return {
		rootPolicy: { maxConcurrentRootAgents: 10 },
		...(ranking === undefined ? {} : { capabilityRanking: ranking }),
		profiles: {
			fast: {
				description: "Fast",
				modelPriority: [{ id: "prov/luna", defaultThinking: "low", maxThinking: "low" }],
			},
			balanced: {
				description: "Balanced",
				modelPriority: [{ id: "prov/terra", defaultThinking: "high", maxThinking: "max" }],
			},
		},
		agentPolicies: {
			scout: { defaultProfile: "fast", allowedProfiles: ["fast"] },
			worker: { defaultProfile: "fast", allowedProfiles: ["fast"] },
			general: { defaultProfile: "fast", allowedProfiles: ["fast", "balanced"] },
		},
	};
}

test("scoped ranking coverage passes when ranked, fails with all missing ids, and skips unscoped sessions", () => {
	const ranked = findScopedRankingError(config(["prov/luna", "prov/terra"]), models(["luna", "terra"]));
	assert.equal(ranked, undefined);

	const failing = findScopedRankingError(config(["prov/luna"]), models(["luna", "terra"]));
	assert.ok(failing);
	assert.match(failing, /missing: prov\/terra/);
	assert.match(failing, /extensions\/subagents\/profiles\.json/);

	assert.equal(findScopedRankingError(config(), undefined), undefined);
	assert.equal(findScopedRankingError(config(), []), undefined);
});

const models = (ids: readonly string[]): readonly ScopedModel[] =>
	ids.map((id) => ({ model: { provider: "prov", id } }) as ScopedModel);

test("hint warns directionally when a ranked profile resolves below the parent", () => {
	const hint = buildCapabilityHint({
		config: config(["prov/luna", "prov/terra"]),
		agents: [{ name: "scout" }],
		availableModels: models(["luna"]),
		currentModel: { provider: "prov", id: "terra" },
	});
	assert.ok(hint);
	assert.match(hint, /fast → prov\/luna \(weaker than you\)/);
	assert.match(hint, /keep debugging, design decisions, and multi-step reasoning in your own context/);
});

test("hint reassures when every differing ranked profile resolves at or above the parent", () => {
	const hint = buildCapabilityHint({
		config: config(["prov/luna", "prov/terra"]),
		agents: [{ name: "scout" }, { name: "general" }],
		availableModels: models(["luna", "terra"]),
		currentModel: { provider: "prov", id: "luna" },
	});
	assert.ok(hint);
	assert.match(hint, /balanced → prov\/terra \(stronger than you\)/);
	assert.match(hint, /at least as capable as yours/);
	assert.doesNotMatch(hint, /weaker than you/);
});

test("hint stays neutral when children run the parent's own model", () => {
	const hint = buildCapabilityHint({
		config: config(["prov/luna", "prov/terra"]),
		agents: [{ name: "scout" }],
		availableModels: models(["luna"]),
		currentModel: { provider: "prov", id: "luna" },
	});
	assert.ok(hint);
	assert.match(hint, /fast → prov\/luna/);
	assert.match(hint, /same model/);
	assert.doesNotMatch(hint, /weaker|stronger/);
});

test("hint degrades to neutral advice when the parent model is unranked", () => {
	const hint = buildCapabilityHint({
		config: config(["prov/luna", "prov/terra"]),
		agents: [{ name: "scout" }],
		availableModels: models(["luna"]),
		currentModel: { provider: "poolside", id: "laguna-s-2.1:free" },
	});
	assert.ok(hint);
	assert.match(hint, /fast → prov\/luna;/);
	assert.match(hint, /Match task difficulty/);
	assert.doesNotMatch(hint, /weaker|stronger/);
});

test("hint degrades to neutral advice without any configured ranking", () => {
	const hint = buildCapabilityHint({
		config: config(),
		agents: [{ name: "scout" }],
		availableModels: models(["luna"]),
		currentModel: { provider: "prov", id: "terra" },
	});
	assert.ok(hint);
	assert.match(hint, /Match task difficulty/);
	assert.doesNotMatch(hint, /weaker|stronger/);
});

test("hint advertises the union of profiles allowed across agents", () => {
	const hint = buildCapabilityHint({
		config: config(["prov/luna", "prov/terra"]),
		agents: [{ name: "scout" }, { name: "general" }],
		availableModels: models(["luna", "terra"]),
		currentModel: { provider: "prov", id: "other/model" },
	});
	assert.ok(hint);
	assert.match(hint, /fast → prov\/luna/);
	assert.match(hint, /balanced → prov\/terra/);
});

test("hint skips unauthenticated candidates and returns undefined when nothing resolves", () => {
	const none = buildCapabilityHint({
		config: config(),
		agents: [{ name: "scout" }],
		availableModels: models(["terra"]),
		currentModel: { provider: "prov", id: "terra" },
	});
	assert.equal(none, undefined);

	const partial = buildCapabilityHint({
		config: config(),
		agents: [{ name: "scout" }, { name: "general" }],
		availableModels: models(["terra"]),
		currentModel: { provider: "prov", id: "other/model" },
	});
	assert.ok(partial);
	assert.doesNotMatch(partial, /fast/);
	assert.match(partial, /balanced → prov\/terra/);
});

test("hint requires a known parent model", () => {
	const hint = buildCapabilityHint({
		config: config(),
		agents: [{ name: "scout" }],
		availableModels: models(["luna"]),
	});
	assert.equal(hint, undefined);
});
