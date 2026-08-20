import * as assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import { getProcessReaper, ProcessReaper, registerProcessReaper } from "../index.ts";

async function temporaryRoot(t: TestContext): Promise<string> {
	const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "process-reaper-test-"));
	t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
	return rootDir;
}

async function pathExists(filePath: string): Promise<boolean> {
	return fs.stat(filePath).then(
		() => true,
		() => false,
	);
}

test("registers Bash lifecycle hooks for the owning session", async (t) => {
	const reaper = new ProcessReaper({ rootDir: await temporaryRoot(t) });
	const handlers = new Map<string, (event: never, ctx: never) => unknown>();
	const fakePi = {
		on(event: string, handler: (event: never, ctx: never) => unknown) {
			handlers.set(event, handler);
		},
	};
	registerProcessReaper(fakePi as never, reaper);
	const ctx = {
		sessionManager: {
			getSessionId: () => "session",
		},
	};
	const toolCall = {
		toolName: "bash",
		toolCallId: "call",
		input: { command: "echo tracked" },
	};

	handlers.get("tool_call")!(toolCall as never, ctx as never);
	assert.match(toolCall.input.command, /printf '%s\\n' "\$\$"/u);
	const marker = reaper.markerPath("session", "call");
	assert.equal(await pathExists(marker), true);

	await handlers.get("tool_result")!(
		{
			toolName: "bash",
			toolCallId: "call",
			input: toolCall.input,
			content: [],
			details: undefined,
			isError: false,
		} as never,
		ctx as never,
	);
	assert.equal(await pathExists(marker), false);
});

test("shares owner state across in-process extension instances", async () => {
	const first = getProcessReaper();
	const second = getProcessReaper();
	const ownerId = `session-${randomUUID()}`;
	const toolCallId = "call";
	first.prepareCommand(ownerId, toolCallId, "true");
	const marker = first.markerPath(ownerId, toolCallId);

	await second.finishCommand(ownerId, toolCallId);

	assert.equal(await pathExists(marker), false);
});

test("terminates only the requested owner's process groups", async (t) => {
	const signals: Array<readonly [number, "SIGTERM" | "SIGKILL"]> = [];
	const live = new Set([4321, 9876]);
	const reaper = new ProcessReaper({
		rootDir: await temporaryRoot(t),
		groupExists: (pid) => live.has(pid),
		processExists: () => false,
		signalGroup: (pid, signal) => {
			signals.push([pid, signal]);
			if (signal === "SIGKILL") live.delete(pid);
		},
		sleep: async () => {},
	});

	for (const [ownerId, toolCallId, pid] of [
		["session-a", "call-a", 4321],
		["session-b", "call-b", 9876],
	] as const) {
		reaper.prepareCommand(ownerId, toolCallId, "true");
		await fs.writeFile(reaper.markerPath(ownerId, toolCallId), `${pid}\n`, "utf8");
		await reaper.finishCommand(ownerId, toolCallId);
	}

	await reaper.terminateOwner("session-a");
	assert.deepEqual(signals, [
		[4321, "SIGTERM"],
		[4321, "SIGKILL"],
	]);
	assert.equal(live.has(9876), true);

	await reaper.terminateOwner("session-b");
});

test("terminates a running Bash group before its tool result", async (t) => {
	const signals: Array<readonly [number, "SIGTERM" | "SIGKILL"]> = [];
	const live = new Set([4321]);
	const reaper = new ProcessReaper({
		rootDir: await temporaryRoot(t),
		groupExists: (pid) => live.has(pid),
		processExists: () => false,
		signalGroup: (pid, signal) => {
			signals.push([pid, signal]);
			if (signal === "SIGKILL") live.delete(pid);
		},
		sleep: async () => {},
	});
	reaper.prepareCommand("session", "call", "sleep 30");
	await fs.writeFile(reaper.markerPath("session", "call"), "4321\n", "utf8");

	await reaper.terminateOwner("session");

	assert.deepEqual(signals, [
		[4321, "SIGTERM"],
		[4321, "SIGKILL"],
	]);
	assert.equal(await pathExists(reaper.markerPath("session", "call")), false);
});

test("signals all groups concurrently and reports survivors", async (t) => {
	const signals: Array<readonly [number, "SIGTERM" | "SIGKILL"]> = [];
	const live = new Set([4321, 9876]);
	const reaper = new ProcessReaper({
		rootDir: await temporaryRoot(t),
		groupExists: (pid) => live.has(pid),
		processExists: () => false,
		signalGroup: (pid, signal) => {
			signals.push([pid, signal]);
			if (pid === 4321 && signal === "SIGKILL") live.delete(pid);
		},
		sleep: async () => {},
	});
	for (const [toolCallId, pid] of [
		["call-a", 4321],
		["call-b", 9876],
	] as const) {
		reaper.prepareCommand("session", toolCallId, "true");
		await fs.writeFile(reaper.markerPath("session", toolCallId), `${pid}\n`, "utf8");
		await reaper.finishCommand("session", toolCallId);
	}

	await assert.rejects(reaper.terminateOwner("session"), /9876/u);
	assert.deepEqual(signals, [
		[4321, "SIGTERM"],
		[9876, "SIGTERM"],
		[4321, "SIGKILL"],
		[9876, "SIGKILL"],
	]);
});

test("does not signal a settled group whose leader PID was reused", async (t) => {
	const signals: number[] = [];
	const reaper = new ProcessReaper({
		rootDir: await temporaryRoot(t),
		groupExists: () => true,
		processExists: () => true,
		signalGroup: (pid) => signals.push(pid),
		sleep: async () => {},
	});
	reaper.prepareCommand("session", "call", "true");
	await fs.writeFile(reaper.markerPath("session", "call"), "4321\n", "utf8");
	await reaper.finishCommand("session", "call");

	await reaper.terminateOwner("session");

	assert.deepEqual(signals, []);
});

test("kills a background descendant after its Bash shell exits", async (t) => {
	if (process.platform === "win32") return;
	const reaper = new ProcessReaper({ rootDir: await temporaryRoot(t) });
	const ownerId = "integration-session";
	const toolCallId = "integration-call";
	const child = spawn("/bin/bash", ["-c", reaper.prepareCommand(ownerId, toolCallId, "sleep 30 &")], {
		detached: true,
		stdio: "ignore",
	});
	assert.ok(child.pid);
	t.after(() => {
		try {
			process.kill(-child.pid!, "SIGKILL");
		} catch {}
	});

	await once(child, "exit");
	await reaper.finishCommand(ownerId, toolCallId);
	await reaper.terminateOwner(ownerId);

	assert.throws(() => process.kill(-child.pid!, 0), /ESRCH/u);
});
