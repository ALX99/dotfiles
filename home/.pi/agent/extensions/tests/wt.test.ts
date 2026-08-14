import assert from "node:assert/strict";
import test from "node:test";

import { moveSessionToWorktree, quoteShellArgument } from "../wt.ts";

type FakeContext = {
	readonly cwd: string;
	readonly hasUI: boolean;
	readonly sessionManager: {
		getSessionFile(): string | undefined;
	};
	readonly ui: {
		notify(message: string, level: "info" | "warning" | "error"): void;
	};
	shutdown(): void;
};

function createContext(sessionFile = "/tmp/session.jsonl"): {
	readonly context: FakeContext;
	readonly notifications: () => Array<{ message: string; level: string }>;
	readonly shutdowns: () => number;
} {
	const messages: Array<{ message: string; level: string }> = [];
	let shutdownCount = 0;
	return {
		context: {
			cwd: "/repo",
			hasUI: true,
			sessionManager: { getSessionFile: () => sessionFile },
			ui: {
				notify(message, level) {
					messages.push({ message, level });
				},
			},
			shutdown() {
				shutdownCount += 1;
			},
		},
		notifications: () => messages,
		shutdowns: () => shutdownCount,
	};
}

test("quotes shell arguments without allowing quote escapes", () => {
	assert.equal(quoteShellArgument("a'b"), "'a'\"'\"'b'");
});

test("omits the branch and label so Herdr can generate a worktree name", async () => {
	const { context, notifications, shutdowns } = createContext();
	const calls: Array<{ command: string; args: readonly string[] }> = [];
	const results = [
		{
			code: 0,
			stderr: "",
			stdout: JSON.stringify({
				result: {
					workspace: { workspace_id: "w9" },
					root_pane: { pane_id: "w9:p1" },
				},
			}),
		},
		{ code: 0, stderr: "", stdout: "" },
		{ code: 0, stderr: "", stdout: "" },
	];

	await moveSessionToWorktree(
		"",
		context,
		async (command, args) => {
			calls.push({ command, args });
			const result = results.shift();
			assert.ok(result);
			return result;
		},
		true,
	);

	assert.deepEqual(calls[0], {
		command: "herdr",
		args: ["worktree", "create", "--cwd", "/repo", "--no-focus"],
	});
	assert.equal(shutdowns(), 1);
	assert.deepEqual(notifications(), [{ message: "Moved Pi to a Herdr-generated worktree.", level: "info" }]);
});

test("requires a Herdr-managed Pi session", async () => {
	const { context, notifications } = createContext();
	let calls = 0;

	await moveSessionToWorktree(
		"feature",
		context,
		async () => {
			calls += 1;
			return { code: 0, stdout: "", stderr: "" };
		},
		false,
	);

	assert.equal(calls, 0);
	assert.deepEqual(notifications(), [{ message: "/wt requires Pi to run inside Herdr.", level: "error" }]);
});

test("creates a worktree, resumes Pi there, then exits the old Pi", async () => {
	const { context, notifications, shutdowns } = createContext("/tmp/session's.jsonl");
	const calls: Array<{ command: string; args: readonly string[] }> = [];
	const results = [
		{
			code: 0,
			stderr: "",
			stdout: JSON.stringify({
				result: {
					workspace: { workspace_id: "w9" },
					root_pane: { pane_id: "w9:p1" },
				},
			}),
		},
		{ code: 0, stderr: "", stdout: "" },
		{ code: 0, stderr: "", stdout: "" },
	];

	await moveSessionToWorktree(
		"feature",
		context,
		async (command, args) => {
			calls.push({ command, args });
			const result = results.shift();
			assert.ok(result);
			return result;
		},
		true,
	);

	assert.deepEqual(calls, [
		{
			command: "herdr",
			args: ["worktree", "create", "--cwd", "/repo", "--branch", "feature", "--label", "feature", "--no-focus"],
		},
		{
			command: "herdr",
			args: ["pane", "run", "w9:p1", `pi --session '/tmp/session'"'"'s.jsonl'`],
		},
		{ command: "herdr", args: ["workspace", "focus", "w9"] },
	]);
	assert.equal(shutdowns(), 1);
	assert.deepEqual(notifications(), [{ message: "Moved Pi to Herdr worktree feature.", level: "info" }]);
});

test("keeps the original session open when Pi cannot start", async () => {
	const { context, notifications, shutdowns } = createContext();
	const results = [
		{
			code: 0,
			stderr: "",
			stdout: JSON.stringify({
				result: {
					workspace: { workspace_id: "w9" },
					root_pane: { pane_id: "w9:p1" },
				},
			}),
		},
		{ code: 1, stderr: "pane is busy", stdout: "" },
	];

	await moveSessionToWorktree(
		"feature",
		context,
		async () => {
			const result = results.shift();
			assert.ok(result);
			return result;
		},
		true,
	);

	assert.equal(shutdowns(), 0);
	assert.deepEqual(notifications(), [
		{ message: "Herdr could not start Pi in the worktree: pane is busy", level: "error" },
	]);
});
