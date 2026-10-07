import assert from "node:assert/strict";
import { test } from "node:test";

import { createCapabilityPolicy } from "../policy.ts";

test("omitted capability lists allow everything", () => {
	const policy = createCapabilityPolicy({ name: "engineer" });
	const tools = [{ name: "read" }, { name: "codemode" }];
	const skills = [{ name: "research" }, { name: "design" }];

	assert.equal(policy.allowsTool("read"), true);
	assert.equal(policy.allowsSkill("research"), true);
	assert.equal(policy.allowsSpawnProfile("researcher"), true);
	assert.deepEqual(policy.filterToolNames(["read", "codemode"]), ["read", "codemode"]);
	assert.deepEqual(policy.filterTools(tools), tools);
	assert.deepEqual(policy.filterSkills(skills), skills);
});

test("explicit empty capability lists deny all and filters preserve order", () => {
	const denied = createCapabilityPolicy({ name: "restricted", tools: [], skills: [] });
	assert.equal(denied.allowsTool("read"), false);
	assert.equal(denied.allowsTool("ask_parent"), true);
	assert.equal(denied.allowsSkill("research"), false);
	assert.equal(denied.allowsSpawnProfile("researcher"), true);
	assert.deepEqual(denied.filterToolNames(["read", "ask_parent", "bash"]), ["ask_parent"]);
	assert.deepEqual(denied.filterTools([{ name: "read" }]), []);
	assert.deepEqual(denied.filterTools([{ name: "ask_parent" }]), [{ name: "ask_parent" }]);
	assert.deepEqual(denied.filterSkills([{ name: "research" }]), []);

	const limited = createCapabilityPolicy({
		name: "engineer",
		tools: ["bash", "read"],
		skills: ["engineering"],
		spawnProfiles: ["engineer", "researcher"],
	});
	assert.equal(limited.allowsSpawnProfile("researcher"), true);
	assert.equal(limited.allowsSpawnProfile("designer"), false);
	assert.deepEqual(limited.filterToolNames(["read", "edit", "bash"]), ["read", "bash"]);
	assert.deepEqual(limited.filterTools([{ name: "read" }, { name: "edit" }]), [{ name: "read" }]);
	assert.deepEqual(limited.filterSkills([{ name: "engineering" }, { name: "design" }]), [{ name: "engineering" }]);
});

test("an empty spawn-profile allowlist denies spawning every profile", () => {
	const policy = createCapabilityPolicy({ name: "restricted", spawnProfiles: [] });
	assert.equal(policy.allowsSpawnProfile("engineer"), false);
	assert.equal(policy.allowsSpawnProfile("restricted"), false);
});

test("an explicit deferred-tool allowlist keeps only the lazy discovery and dispatch mechanisms", () => {
	const policy = createCapabilityPolicy({ name: "researcher", tools: ["mcp__docs__search"] });
	assert.equal(policy.allowsTool("tool_search"), true);
	assert.equal(policy.allowsTool("codemode"), true);
	assert.equal(policy.allowsTool("mcp__docs__search"), true);
	assert.equal(policy.allowsTool("mcp__private__delete"), false);
	assert.deepEqual(
		policy.filterToolNames(["read", "tool_search", "codemode", "mcp__docs__search", "mcp__private__delete"]),
		["tool_search", "codemode", "mcp__docs__search"],
	);
});

test("policy captures the resolved allowlists rather than later source mutations", () => {
	const tools = ["read"];
	const skills = ["engineering"];
	const spawnProfiles = ["researcher"];
	const policy = createCapabilityPolicy({ name: "engineer", tools, skills, spawnProfiles });
	assert.deepEqual(policy.spawnProfiles, ["researcher"]);
	assert.equal(Object.isFrozen(policy.spawnProfiles), true);
	tools.push("bash");
	skills.push("design");
	spawnProfiles.push("designer");

	assert.equal(policy.allowsTool("bash"), false);
	assert.equal(policy.allowsSkill("design"), false);
	assert.equal(policy.allowsSpawnProfile("designer"), false);
});
