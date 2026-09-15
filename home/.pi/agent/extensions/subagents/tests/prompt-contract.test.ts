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
	const tools = promptSource("tasks/tools.ts");
	assert.match(tasks, /Previous task summaries remain in the conversation history/);
	assert.match(tools, /Call finish_task as the only tool in its turn/);
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

test("tool prompts stay capability-focused and keep only enforced protocol guidance", () => {
	const tasks = promptSource("tasks/tools.ts");
	const taskRuntime = promptSource("tasks/index.ts");
	assert.match(tasks, /Create an ordered task queue for multi-step work/);
	assert.match(tasks, /Call create_tasks as the only tool in its turn/);
	assert.match(tasks, /Call finish_task as the only tool in its turn/);
	assert.doesNotMatch(tasks, /genuinely complex|do not pad|independently useful/i);
	assert.match(taskRuntime, /do not claim the queue succeeded/);

	const spawn = promptSource("subagents/tools.ts");
	assert.match(spawn, /Run a subagent on a self-contained task/);
	assert.doesNotMatch(spawn, /promptSnippet|promptGuidelines|do not duplicate its assigned scope|task scheduler/);

	const askQuestion = promptSource("ask-question/tools.ts");
	assert.match(askQuestion, /Ask 1-3 multiple-choice questions/);
	assert.doesNotMatch(askQuestion, /materially changes implementation|Never treat cancellation/);
});
