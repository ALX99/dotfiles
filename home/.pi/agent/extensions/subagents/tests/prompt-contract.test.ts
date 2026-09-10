import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";

const extensionsDir = path.resolve(import.meta.dirname, "../..");

// These are static instruction checks, not evidence of equivalent model decisions.
function promptSource(relativePath: string): string {
	return fs.readFileSync(path.join(extensionsDir, relativePath), "utf8");
}

test("roles keep terminal delivery and material uncertainty explicit", () => {
	for (const role of ["general", "scout", "worker"]) {
		assert.match(promptSource(`subagents/agents/${role}.md`), /final assistant response/);
	}
	assert.match(promptSource("subagents/agents/general.md"), /material gaps or blockers/);
	assert.match(promptSource("subagents/agents/worker.md"), /unverified items/);
});

test("shared guidance preserves evidence, alternatives, and safe no-op outcomes", () => {
	const system = promptSource("../APPEND_SYSTEM.md");
	assert.match(system, /Never claim unobserved results or validation/);
	assert.match(system, /simpler or safer alternative.*tradeoff/);
	assert.match(system, /query its usage locally before using web tools/);
	assert.match(system, /current official docs/);
	assert.match(promptSource("../prompts/minimize-complexity.md"), /no safe simplification.*rather than creating churn/);
});

test("checkpoint and thinking guidance retain attribution and defaults", () => {
	const tasks = promptSource("tasks/index.ts");
	assert.match(tasks, /since the previous checkpoint, not shell or external changes/);
	// The queue-direction contract lives with the status it describes, not in a prompt guideline.
	assert.match(tasks, /Every status is a terminal checkpoint and advances the queue; put unresolved work in remaining/);
	assert.match(promptSource("subagents/schemas.ts"), /omit for its default/);
});

test("subagent role prompts preserve ownership, leaf, and bounded-work contracts", () => {
	const general = promptSource("subagents/agents/general.md");
	assert.match(general, /Own synthesis and final correctness/);
	assert.match(general, /leaf execution\. Do not delegate/);

	const scout = promptSource("subagents/agents/scout.md");
	assert.match(scout, /leaf execution\. Do not delegate/);
	assert.match(scout, /read-only/);
	assert.match(scout, /Do not implement.*final review.*verdicts/s);

	const worker = promptSource("subagents/agents/worker.md");
	assert.match(worker, /Preserve.*unrelated.*concurrent edits/s);
	assert.match(worker, /leaf execution\. Do not delegate/);
	assert.match(worker, /exact validation commands and observed outcomes/);
});

test("prompt guidance retains lifecycle, safety, and approval boundaries", () => {
	const tasks = promptSource("tasks/index.ts");
	assert.match(tasks, /only for genuinely complex work/);
	assert.match(tasks, /Every status is a terminal checkpoint and advances the queue/);
	assert.match(tasks, /do not claim the queue succeeded/);

	const spawn = promptSource("subagents/tools/spawn-agent.ts");
	assert.match(spawn, /one-shot subagent by default/);
	assert.match(spawn, /do not duplicate its assigned scope/);
	assert.match(spawn, /do not build repeated automatic turns or a task scheduler/i);

	const askQuestion = promptSource("ask-question/index.ts");
	assert.match(askQuestion, /materially changes implementation, scope, or an authorization decision/);
	assert.match(askQuestion, /Never treat cancellation.*as approval/s);
});
