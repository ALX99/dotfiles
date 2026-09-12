import * as assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Effect } from "effect";
import { test, type TestContext } from "node:test";
import { runPromise } from "../../_shared/effect-runtime.ts";
import { getProcessReaper, ProcessReaper } from "../index.ts";

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

async function retainJob(
	reaper: ProcessReaper,
	ownerId: string,
	toolCallId: string,
	pid: number,
	command: string,
): Promise<void> {
	await runPromise(reaper.prepareCommand(ownerId, toolCallId, command));
	await fs.writeFile(reaper.markerPath(ownerId, toolCallId), `${pid}\n`, "utf8");
	await runPromise(reaper.finishCommand(ownerId, toolCallId));
}

test("shares owner state across in-process extension instances", async () => {
	const first = getProcessReaper();
	const second = getProcessReaper();
	const ownerId = `session-${randomUUID()}`;
	const toolCallId = "call";
	await runPromise(first.prepareCommand(ownerId, toolCallId, "true"));
	const marker = first.markerPath(ownerId, toolCallId);

	await runPromise(second.finishCommand(ownerId, toolCallId));

	assert.equal(await pathExists(marker), false);
});

test("retains background job metadata and lists jobs in PID order", async (t) => {
	const reaper = new ProcessReaper({
		rootDir: await temporaryRoot(t),
		groupExists: () => true,
	});
	await retainJob(reaper, "session-b", "call-b", 9876, "sleep 30 &");
	await retainJob(reaper, "session-a", "call-a", 4321, "echo first");

	assert.deepEqual(reaper.listBackgroundJobs(), [
		{
			pid: 4321,
			ownerId: "session-a",
			toolCallId: "call-a",
			command: "echo first",
		},
		{
			pid: 9876,
			ownerId: "session-b",
			toolCallId: "call-b",
			command: "sleep 30 &",
		},
	]);
});

test("pruneFinishedJobs drops retained groups that have exited", async (t) => {
	const live = new Set([4321]);
	const reaper = new ProcessReaper({
		rootDir: await temporaryRoot(t),
		groupExists: (pid) => live.has(pid),
	});
	await retainJob(reaper, "session", "call", 4321, "sleep 30 &");

	await runPromise(reaper.pruneFinishedJobs());
	assert.equal(reaper.listBackgroundJobs().length, 1);

	live.delete(4321);
	await runPromise(reaper.pruneFinishedJobs());
	assert.deepEqual(reaper.listBackgroundJobs(), []);
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
		sleep: () => Effect.void,
	});

	for (const [ownerId, toolCallId, pid] of [
		["session-a", "call-a", 4321],
		["session-b", "call-b", 9876],
	] as const) {
		await runPromise(reaper.prepareCommand(ownerId, toolCallId, "true"));
		await fs.writeFile(reaper.markerPath(ownerId, toolCallId), `${pid}\n`, "utf8");
		await runPromise(reaper.finishCommand(ownerId, toolCallId));
	}

	await runPromise(reaper.terminateOwner("session-a"));
	assert.deepEqual(signals, [
		[4321, "SIGTERM"],
		[4321, "SIGKILL"],
	]);
	assert.equal(live.has(9876), true);

	await runPromise(reaper.terminateOwner("session-b"));
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
		sleep: () => Effect.void,
	});
	await runPromise(reaper.prepareCommand("session", "call", "sleep 30"));
	await fs.writeFile(reaper.markerPath("session", "call"), "4321\n", "utf8");

	await runPromise(reaper.terminateOwner("session"));

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
		sleep: () => Effect.void,
	});
	for (const [toolCallId, pid] of [
		["call-a", 4321],
		["call-b", 9876],
	] as const) {
		await runPromise(reaper.prepareCommand("session", toolCallId, "true"));
		await fs.writeFile(reaper.markerPath("session", toolCallId), `${pid}\n`, "utf8");
		await runPromise(reaper.finishCommand("session", toolCallId));
	}

	await assert.rejects(runPromise(reaper.terminateOwner("session")), /9876/u);
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
		sleep: () => Effect.void,
	});
	await runPromise(reaper.prepareCommand("session", "call", "true"));
	await fs.writeFile(reaper.markerPath("session", "call"), "4321\n", "utf8");
	await runPromise(reaper.finishCommand("session", "call"));

	await runPromise(reaper.terminateOwner("session"));

	assert.deepEqual(signals, []);
});

test("kills a background descendant after its Bash shell exits", async (t) => {
	if (process.platform === "win32") return;
	const reaper = new ProcessReaper({ rootDir: await temporaryRoot(t) });
	const ownerId = "integration-session";
	const toolCallId = "integration-call";
	const command = await runPromise(reaper.prepareCommand(ownerId, toolCallId, "sleep 30 &"));
	const child = spawn("/bin/bash", ["-c", command], {
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
	await runPromise(reaper.finishCommand(ownerId, toolCallId));
	await runPromise(reaper.terminateOwner(ownerId));

	assert.throws(() => process.kill(-child.pid!, 0), /ESRCH/u);
});
