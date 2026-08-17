import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import type { AgentSummary } from "../agent-types.ts";
import { showAgentDashboard } from "../dashboard.ts";

function summary(sessionFile: string): AgentSummary {
	return {
		agent_id: "worker-1",
		agent: "worker",
		task_name: "test",
		profile: "balanced",
		model: "provider/model",
		effective_thinking: "medium",
		generation: 1,
		retained: false,
		status: "idle",
		started_at: 0,
		session_file: sessionFile,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
	};
}

function childSessionFile(t: TestContext): string {
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-dashboard-test-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(() => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		fs.rmSync(agentDir, { recursive: true, force: true });
	});
	const sessionDir = path.join(getAgentDir(), "subagent-sessions");
	fs.mkdirSync(sessionDir, { recursive: true });
	const sessionFile = path.join(sessionDir, "worker-1.jsonl");
	fs.writeFileSync(sessionFile, "");
	return sessionFile;
}

test("taking over a session ends the dashboard before its command context becomes stale", async (t) => {
	const sessionFile = childSessionFile(t);
	const agent = summary(sessionFile);
	let stale = false;
	let closeCalls = 0;
	const selections = [`${agent.agent_id} · ${agent.status} · ${agent.task_name}`, "Take over session"];
	const ctx = {
		mode: "tui",
		ui: {
			select: async () => {
				assert.equal(stale, false, "dashboard must not use the replaced command context");
				return selections.shift();
			},
			confirm: async () => true,
			notify: () => {},
		},
		switchSession: async (file: string) => {
			assert.equal(file, sessionFile);
			stale = true;
			return { cancelled: false };
		},
	};
	const registry = {
		views: () => [{ summary: agent }],
		view: () => ({ summary: agent }),
		close: async () => {
			closeCalls++;
		},
	};

	await showAgentDashboard(ctx as never, registry as never);
	assert.equal(closeCalls, 0, "session shutdown owns subagent cleanup");
	assert.deepEqual(selections, []);
});

test("a cancelled session takeover leaves the dashboard usable", async (t) => {
	const agent = summary(childSessionFile(t));
	const selections = [`${agent.agent_id} · ${agent.status} · ${agent.task_name}`, "Take over session", "← Back"];
	const ctx = {
		mode: "tui",
		ui: {
			select: async () => selections.shift(),
			confirm: async () => true,
			notify: () => {},
		},
		switchSession: async () => ({ cancelled: true }),
	};
	const registry = {
		views: () => [{ summary: agent }],
		view: () => ({ summary: agent }),
		close: async () => assert.fail("a cancelled takeover must not close the subagent"),
	};

	await showAgentDashboard(ctx as never, registry as never);
	assert.deepEqual(selections, []);
});
