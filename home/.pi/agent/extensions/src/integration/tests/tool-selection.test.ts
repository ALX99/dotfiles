import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { RECALL_TOOL_NAME } from "../../openai/search/recall.ts";
import { TASK_TOOL_NAMES } from "../../tasks/tools.ts";
import { APPLY_PATCH_TOOL_NAME } from "../../tools/apply-patch/types.ts";
import { createToolSelection } from "../tool-selection.ts";

test("feature activation preserves live external tools and Pi's excluded-tool selection", () => {
	const excluded = new Set([RECALL_TOOL_NAME]);
	const registered = new Set([
		"read",
		"bash",
		"mcp__notes__search",
		"fff_custom",
		APPLY_PATCH_TOOL_NAME,
		...TASK_TOOL_NAMES,
		RECALL_TOOL_NAME,
	]);
	let active = ["read", "bash", "mcp__notes__search", APPLY_PATCH_TOOL_NAME, ...TASK_TOOL_NAMES];
	const pi = {
		getActiveTools: () => [...active],
		setActiveTools(names: string[]) {
			active = names.filter((name) => registered.has(name) && !excluded.has(name));
		},
	} as unknown as ExtensionAPI;
	const selection = createToolSelection(pi);

	selection.setApplyPatchActive(false);
	selection.setTaskTools(["create_tasks"]);
	active.push("fff_custom");
	selection.setSearchRecallActive(true);

	assert.deepEqual(active, ["read", "bash", "mcp__notes__search", "create_tasks", "fff_custom"]);
	assert.deepEqual(selection.getActiveTools(), active);

	selection.setTaskTools(TASK_TOOL_NAMES);
	selection.setSearchRecallActive(false);
	assert.deepEqual(active, ["read", "bash", "mcp__notes__search", "create_tasks", "fff_custom", "finish_task"]);
	assert.throws(() => selection.setTaskTools([RECALL_TOOL_NAME]), /cannot activate tool/);
});
