import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { discoverAgents, parseAgentFile } from "../agents.ts";

test("parseAgentFile rejects model policy and malformed identity frontmatter", () => {
	const parsed = parseAgentFile(
		"scout.md",
		`---
name: scout
description: Scout
model: provider/model
---
Prompt.
`,
	);
	assert.equal(parsed.success, false);
	if (parsed.success) return;
	assert.ok(parsed.errors.some((error) => error.includes("Unrecognized key")));
});

test("discoverAgents aggregates malformed files and duplicate names", (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-agents-test-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	fs.writeFileSync(path.join(dir, "one.md"), "---\nname: duplicate\ndescription: One\n---\nPrompt one.\n");
	fs.writeFileSync(path.join(dir, "two.md"), "---\nname: duplicate\ndescription: Two\n---\nPrompt two.\n");
	fs.writeFileSync(path.join(dir, "broken.md"), "---\nname: broken\n---\n");

	const result = discoverAgents(dir);
	assert.equal(result.isErr(), true);
	if (result.isOk() || result.error.kind !== "configuration") return;
	assert.ok(result.error.errors.some((error) => error.includes("broken.md")));
	assert.ok(result.error.errors.some((error) => error.includes("duplicate agent name")));
});
