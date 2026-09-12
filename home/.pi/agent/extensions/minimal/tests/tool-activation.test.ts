import * as assert from "node:assert/strict";
import { test } from "node:test";

import { applyTools, MINIMAL_CORE_TOOL_NAMES, minimalToolNames, missingMinimalTools } from "../tool-activation.ts";

const OTHER_TOOLS = ["apply_patch", "edit", "write", "spawn_agent"];
const TASK_TOOLS = ["create_tasks", "finish_task", "read_tasks", "update_tasks"];

function toolApi(initial: readonly string[], available = [...MINIMAL_CORE_TOOL_NAMES, ...OTHER_TOOLS]) {
	let active = [...initial];
	const writes: string[][] = [];
	return {
		getActiveTools: () => [...active],
		setActiveTools: (next: string[]) => {
			active = [...next];
			writes.push([...next]);
		},
		getAllTools: () => available.map((name) => ({ name })),
		active: () => active,
		writes,
	};
}

test("the minimal selection is the core tools plus the session's editing tool", () => {
	assert.deepEqual(minimalToolNames(["read", "bash", "edit", "write", "spawn_agent"]), ["bash", "read", "edit"]);
	assert.deepEqual(minimalToolNames(["read", "bash", "apply_patch", "spawn_agent"]), ["bash", "read", "apply_patch"]);
	// apply_patch wins when a session has both editing tools.
	assert.deepEqual(minimalToolNames(["read", "bash", "edit", "apply_patch"]), ["bash", "read", "apply_patch"]);
	// A session with no editing tool selected falls back to builtin edit.
	assert.deepEqual(minimalToolNames(["read", "bash"]), ["bash", "read", "edit"]);
});

test("the minimal selection carries over the task tools the tasks extension has exposed", () => {
	// The tasks extension reveals only its loader at session start, then activates the management
	// tools once a queue exists; the mode must keep both stages instead of stripping them.
	assert.deepEqual(minimalToolNames(["read", "bash", "edit", "create_tasks"]), [
		"bash",
		"read",
		"edit",
		"create_tasks",
	]);
	assert.deepEqual(minimalToolNames(["read", "bash", "edit", ...TASK_TOOLS, "spawn_agent"]), [
		"bash",
		"read",
		"edit",
		...TASK_TOOLS,
	]);
	// A session whose tasks extension is off exposes no task tools to carry over.
	assert.deepEqual(minimalToolNames(["read", "bash", "edit", "write"]), ["bash", "read", "edit"]);
});

test("the minimal selection is stable when it is re-derived", () => {
	for (const editor of ["apply_patch", "edit"]) {
		const minimal = minimalToolNames(["read", "bash", editor, "write"]);
		assert.deepEqual(minimalToolNames(minimal), minimal);
	}
	const withTasks = minimalToolNames(["read", "bash", "edit", ...TASK_TOOLS]);
	assert.deepEqual(minimalToolNames(withTasks), withTasks);
	// The tasks extension loads its management tools by appending them in TASK_TOOL_NAMES order, so
	// the turn re-assert must recompute that exact list and skip the write instead of rebuilding the
	// system prompt in the middle of a queue.
	const stable = toolApi(withTasks);
	applyTools(stable as never, withTasks);
	assert.deepEqual(stable.writes, []);
});

test("applying a selection writes only when it changes the live one", () => {
	const changed = toolApi(["read", "bash", "edit", "write"]);
	applyTools(changed as never, ["bash", "read", "edit"]);
	assert.deepEqual(changed.active(), ["bash", "read", "edit"]);
	assert.deepEqual(changed.writes, [["bash", "read", "edit"]]);

	for (const names of [
		["bash", "read", "edit"],
		["bash", "read", "apply_patch"],
	]) {
		const stable = toolApi(names);
		applyTools(stable as never, names);
		assert.deepEqual(stable.writes, []);
	}
});

test("selection comparison is order sensitive", () => {
	const api = toolApi(["read", "bash"]);

	applyTools(api as never, ["bash", "read"]);

	assert.deepEqual(api.active(), ["bash", "read"]);
	assert.deepEqual(api.writes, [["bash", "read"]]);
});

test("missing core tools are reported against the registry", () => {
	const complete = toolApi(["bash", "read", "apply_patch"]);
	const missingRead = toolApi(["bash", "edit"], ["bash", "edit"]);

	assert.deepEqual(missingMinimalTools(complete as never), []);
	assert.deepEqual(missingMinimalTools(missingRead as never), ["read"]);
});
