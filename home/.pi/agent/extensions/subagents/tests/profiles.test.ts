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

test("balanced runs prefer Terra at its economical default thinking level", () => {
	const config = parseAndValidateProfiles(fs.readFileSync(new URL("../profiles.json", import.meta.url), "utf8"), [
		"scout",
		"worker",
		"general",
	]);
	assert.ok(config.success);

	const run = resolveRun({
		config: config.config,
		modelRegistry: { getAvailable: () => [] },
		scopedModels: [{ model: model("gpt-5.6-luna") }, { model: model("gpt-5.6-terra") }],
		agent: "worker",
	});

	assert.equal(run.model, "openai-codex/gpt-5.6-terra");
	assert.equal(run.effectiveThinking, "medium");
});
