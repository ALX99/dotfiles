import assert from "node:assert/strict";
import { test } from "node:test";

import { CREATE_TASKS_DESCRIPTION, CreateTasksParams, FINISH_TASK_DESCRIPTION, FinishTaskParams } from "../tools.ts";

/**
 * The tool descriptions are re-sent on every request of every session, so they
 * are trimmed for size. These tests exist so that trimming can only remove
 * wording: every rule the outcome guidance depends on is pinned here, and a
 * future edit that drops one fails the suite instead of silently degrading
 * handoffs in production.
 */

const descriptions = () => JSON.stringify(CreateTasksParams) + JSON.stringify(FinishTaskParams);

const OUTCOME_RULES: ReadonlyArray<readonly [string, RegExp]> = [
	["the audience is whoever continues after context is removed", /continues after this task's context is removed/u],
	["the three section headings", /Result, Verification, and Preserve\/Next headings/u],
	["the concrete result", /State the result/u],
	["files and symbols", /files and symbols involved/u],
	["decisions with their rationale", /decisions with their rationale/u],
	["checks actually run and their results", /Report the checks you ran and their results/u],
	["confirmed versus assumed", /separate confirmed from assumed/u],
	["what remains unverified", /unverified/u],
	["ruled-out approaches and why", /ruled-out approaches and why they failed/u],
	["so later tasks do not retry them", /do not retry them/u],
	["binding user constraints", /user constraints/u],
	["scope and authorization limits", /scope and authorization limits/u],
	["unresolved blockers", /unresolved blockers/u],
	["conciseness", /Be concise/u],
	["do not omit what a later task needs", /omit only what a later task needs/u],
	["no narration", /Do not narrate/u],
];

test("the outcome description keeps every rule the handoff depends on", () => {
	const text = descriptions();
	for (const [rule, pattern] of OUTCOME_RULES) {
		assert.match(text, pattern, `the outcome description must keep: ${rule}`);
	}
});

test("the status description keeps the meaning of each outcome", () => {
	const text = JSON.stringify(FinishTaskParams);
	assert.match(text, /completed when the stated result is achieved/u);
	assert.match(text, /failed when the attempt did not achieve it/u);
	assert.match(text, /blocked when a prerequisite prevents progress/u);
	assert.match(text, /Disclose verification gaps/u);
});

test("the queue description keeps how a queue is meant to be used", () => {
	const text = descriptions();
	assert.match(text, /observable result and how completion will be checked/u);
	assert.match(text, /Ordered task titles/u);
	assert.match(text, /Add follow-up tasks discovered during this task/u);
	assert.match(text, /Omit after to run them next, use end to append, or a pending task ID/u);
});

test("the tool description keeps the rules that take effect before the call", () => {
	// These ship on every request, so the question is not their size but whether
	// each rule survives. Rules that shape the first create_tasks call have to
	// live here: the model reads this to decide what to pass, so a rule moved into
	// the tool result arrives after it has already chosen the queue.
	for (const [rule, pattern] of [
		["what it creates", /ordered task queue of 1/u],
		["plan before doing", /plan work before doing it/u],
		["start with one planning task", /create one planning task to work out the approach/u],
		["add the tasks the planning produced", /add the tasks the planning produced/u],
		["a discovery task when follow-ups are unknown", /one discovery task if follow-ups are unknown/u],
		["add discovered follow-ups with addTasks", /finish_task\.addTasks/u],
		["the codemode boundary rule", /only nested tool call/u],
	] as ReadonlyArray<readonly [string, RegExp]>) {
		assert.match(CREATE_TASKS_DESCRIPTION, pattern, `create_tasks must still say: ${rule}`);
	}
	assert.match(FINISH_TASK_DESCRIPTION, /outcome of the current task/u);
	assert.match(FINISH_TASK_DESCRIPTION, /only nested tool call/u, "the codemode rule is a hard constraint");
});

test("task schemas and descriptions stay within their per-request size budgets", () => {
	assert.ok(JSON.stringify(CreateTasksParams).length + CREATE_TASKS_DESCRIPTION.length <= 800);
	assert.ok(JSON.stringify(FinishTaskParams).length + FINISH_TASK_DESCRIPTION.length <= 1_900);
});
