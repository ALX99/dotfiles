import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { composeRoleSystemPrompt } from "../child-process.ts";
import { discoverAgents, parseAgentFile } from "../agents.ts";

test("bundled agent files parse with explicit, role-specific tool allowlists", () => {
	const expectedTools = {
		general: ["read", "bash", "edit", "write", "grep", "find", "ls"],
		scout: ["read", "find", "grep"],
		worker: ["read", "bash", "edit", "write", "grep", "find", "ls"],
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

test("role append preserves Pi APPEND_SYSTEM precedence and RPC trust fallback", (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-append-test-"));
	const project = path.join(root, "project");
	const agentDir = path.join(root, "agent");
	const projectAppend = path.join(project, ".pi", "APPEND_SYSTEM.md");
	touch(projectAppend, "PROJECT_APPEND\n");
	touch(path.join(agentDir, "APPEND_SYSTEM.md"), "GLOBAL_APPEND\n");
	const role = "ROLE_APPEND";
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));

	// APPEND_SYSTEM itself requires project trust. An unset decision in RPC mode
	// follows Pi's non-interactive "ask" fallback and therefore selects global.
	assert.equal(composeRoleSystemPrompt(role, project, agentDir), "GLOBAL_APPEND\n\n\nROLE_APPEND");

	const trust = path.join(agentDir, "trust.json");
	fs.writeFileSync(trust, `${JSON.stringify({ [fs.realpathSync(project)]: true })}\n`);
	assert.equal(composeRoleSystemPrompt(role, project, agentDir), "PROJECT_APPEND\n\n\nROLE_APPEND");

	fs.writeFileSync(trust, `${JSON.stringify({ [fs.realpathSync(project)]: false })}\n`);
	assert.equal(composeRoleSystemPrompt(role, project, agentDir), "GLOBAL_APPEND\n\n\nROLE_APPEND");
});

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

function touch(filePath: string, content: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content);
}
