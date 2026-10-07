import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { RECALL_TOOL_NAME } from "../../openai/search/recall.ts";
import { createActiveProfileState } from "../../agents/active-profile.ts";
import { createCapabilityPolicy } from "../../agents/policy.ts";
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

test("profile policy filters active tools and blocks feature activation", () => {
	const registered = new Set(["read", "bash", APPLY_PATCH_TOOL_NAME, ...TASK_TOOL_NAMES]);
	let active = ["read", "bash", APPLY_PATCH_TOOL_NAME, ...TASK_TOOL_NAMES];
	const pi = {
		getActiveTools: () => [...active],
		setActiveTools(names: string[]) {
			active = names.filter((name) => registered.has(name));
		},
	} as unknown as ExtensionAPI;
	const policy = createCapabilityPolicy({ name: "researcher", tools: ["read"] });
	const selection = createToolSelection(pi, policy);

	selection.applyCapabilityPolicy();
	assert.deepEqual(active, ["read"]);
	assert.deepEqual(selection.getActiveTools(), ["read"]);

	selection.setApplyPatchActive(true);
	selection.setTaskTools(TASK_TOOL_NAMES);
	assert.deepEqual(active, ["read"], "owned feature changes cannot reactivate profile-denied tools");
});

test("switching profiles updates the shared policy and restores tools hidden by the previous profile", () => {
	const registered = new Set(["read", "bash", "edit"]);
	let active = ["read", "bash", "edit"];
	const pi = {
		getActiveTools: () => [...active],
		setActiveTools(names: string[]) {
			active = names.filter((name) => registered.has(name));
		},
	} as unknown as ExtensionAPI;
	const selection = createToolSelection(pi);
	const profiles = createActiveProfileState(selection);

	profiles.setProfile({
		name: "researcher",
		model: { provider: "test", id: "model" },
		prompt: "Separate evidence from inference.",
		tools: ["read"],
		skills: ["research"],
		spawnProfiles: [],
		sourcePath: "/profiles/researcher.md",
	});
	assert.equal(profiles.getProfile()?.name, "researcher");
	assert.equal(profiles.getPolicy()?.allowsTool("edit"), false);
	assert.deepEqual(active, ["read"]);

	profiles.setProfile({
		name: "engineer",
		model: { provider: "test", id: "model" },
		prompt: "Build carefully.",
		sourcePath: "/profiles/engineer.md",
	});
	assert.equal(profiles.getProfile()?.name, "engineer");
	assert.equal(profiles.getPolicy()?.allowsTool("edit"), true);
	assert.deepEqual(active, ["read", "bash", "edit"]);

	profiles.setProfile();
	assert.equal(profiles.getProfile(), undefined);
	assert.equal(profiles.getPolicy(), undefined);
	assert.deepEqual(active, ["read", "bash", "edit"]);
});
