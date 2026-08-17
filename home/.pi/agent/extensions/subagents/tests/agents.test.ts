import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { discoverAgents, parseAgentFile } from "../agents.ts";

test("bundled agent files parse with explicit, role-specific tool allowlists", () => {
	const expectedTools = {
		general: ["read", "bash", "edit", "write", "apply_patch", "grep", "find", "ls", "ask_question"],
		scout: ["read", "find", "grep", "ask_question"],
		worker: ["read", "bash", "edit", "write", "apply_patch", "grep", "find", "ls", "ask_question"],
	};
	for (const name of ["general", "scout", "worker"] as const) {
		const content = fs.readFileSync(path.join(import.meta.dirname, "..", "agents", `${name}.md`), "utf8");
		const parsed = parseAgentFile(`${name}.md`, content);
		assert.equal(parsed.success, true);
		if (!parsed.success) continue;
		assert.equal(parsed.agent.name, name);
		assert.deepEqual(parsed.agent.tools, expectedTools[name]);
	}
});

test("parseAgentFile requires an explicit YAML tool list and rejects unsupported metadata", () => {
	const parsed = parseAgentFile(
		"scout.md",
		`---
name: scout
description: Scout
tools: read,find
model: provider/model
---
Prompt.
`,
	);
	assert.equal(parsed.success, false);
	if (parsed.success) return;
	assert.ok(parsed.errors.some((error) => error.includes("Unrecognized key")));
	assert.ok(parsed.errors.some((error) => error.includes("expected array")));
});

test("parseAgentFile rejects duplicate tools and whitespace-containing role names", () => {
	for (const [frontmatter, expected] of [
		["name: scout role\ndescription: Scout\ntools: [read]", "name must not contain whitespace"],
		["name: scout\ndescription: Scout\ntools: [read, read]", "tools must not contain duplicates"],
	] as const) {
		const parsed = parseAgentFile("scout.md", `---\n${frontmatter}\n---\nPrompt.\n`);
		assert.equal(parsed.success, false);
		if (!parsed.success) assert.ok(parsed.errors.some((error) => error.includes(expected)));
	}
});

test("discoverAgents aggregates malformed files and duplicate names", (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-agents-test-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	fs.writeFileSync(
		path.join(dir, "one.md"),
		"---\nname: duplicate\ndescription: One\ntools: [read]\n---\nPrompt one.\n",
	);
	fs.writeFileSync(
		path.join(dir, "two.md"),
		"---\nname: duplicate\ndescription: Two\ntools: [read]\n---\nPrompt two.\n",
	);
	fs.writeFileSync(path.join(dir, "broken.md"), "---\nname: broken\n---\n");

	const result = discoverAgents(dir);
	assert.equal(result.isErr(), true);
	if (result.isOk() || result.error.kind !== "configuration") return;
	assert.ok(result.error.errors.some((error) => error.includes("broken.md")));
	assert.ok(result.error.errors.some((error) => error.includes("duplicate agent name")));
});
