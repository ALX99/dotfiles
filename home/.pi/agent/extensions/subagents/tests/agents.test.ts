import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { Effect, Result } from "effect";
import { runPromise } from "../../_shared/effect-runtime.ts";
import { AgentConfigurationError, discoverAgents, parseAgentFile } from "../agents.ts";

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
	assert.ok(parsed.errors.some((error) => error.includes("Expected no excess property")));
	assert.ok(parsed.errors.some((error) => error.includes("Expected array")));
});

test("parseAgentFile rejects duplicate tools and unsafe role names", () => {
	for (const [frontmatter, expected] of [
		["name: scout role\ndescription: Scout\ntools: [read]", "name must not contain whitespace"],
		[
			"name: scout\u001brole\ndescription: Scout\ntools: [read]",
			"name must not contain whitespace or control characters",
		],
		["name: scout\ndescription: Scout\ntools: [read, read]", "tools must not contain duplicates"],
	] as const) {
		const parsed = parseAgentFile("scout.md", `---\n${frontmatter}\n---\nPrompt.\n`);
		assert.equal(parsed.success, false);
		if (!parsed.success) assert.ok(parsed.errors.some((error) => error.includes(expected)));
	}
});

test("discoverAgents aggregates malformed files and duplicate names", async (t) => {
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

	const result = await runPromise(Effect.result(discoverAgents(dir)));
	assert.ok(Result.isFailure(result));
	if (Result.isFailure(result)) {
		assert.ok(result.failure instanceof AgentConfigurationError);
		assert.ok(result.failure.errors.some((error) => error.includes("broken.md")));
		assert.ok(result.failure.errors.some((error) => error.includes("duplicate agent name")));
	}
});
