import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { Effect, Fiber } from "effect";
import { runFork, runPromise } from "../../_shared/effect-runtime.ts";
import { withExclusiveFileLock, writePrivateFileAtomic } from "../../_shared/fs.ts";
import { HarnessError, MAX_STORE_BYTES } from "../schema.ts";
import { appendStoreEvent, loadStore, loadStoreSnapshot, openStore, type HarnessStore } from "../store.ts";
import { renderGuidance } from "../procedures.ts";
import { activeProcedures } from "../state.ts";
import { decision, evaluatedHistory, evaluation, evidence, pendingHistory } from "./fixtures.ts";

async function fixture(t: TestContext): Promise<HarnessStore> {
	const root = await fs.mkdtemp(join(tmpdir(), "harness-learning-"));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const repo = join(root, "repo");
	await fs.mkdir(repo);
	return runPromise(openStore(repo, join(root, "private")));
}

async function exists(path: string): Promise<boolean> {
	return fs.lstat(path).then(
		() => true,
		(error: unknown) => {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
			throw error;
		},
	);
}

test("the store starts empty and writes a private, replayable history with no leftover lock or temporary file", async (t) => {
	const store = await fixture(t);
	const empty = await runPromise(loadStore(store));
	assert.equal(empty.state.head.id, "root");
	assert.equal(await exists(store.file), false);
	await runPromise(appendStoreEvent(store, evidence()));
	const loaded = await runPromise(loadStore(store));
	assert.deepEqual(loaded.document.events, [evidence()]);
	assert.equal((await fs.stat(store.root)).mode & 0o777, 0o700);
	assert.equal((await fs.stat(store.directory)).mode & 0o777, 0o700);
	assert.equal((await fs.stat(store.file)).mode & 0o777, 0o600);
	assert.deepEqual(await fs.readdir(store.directory), ["history.json"]);
	assert.equal(loaded.document.scope, store.scope);
});

test("offline snapshots create no directories and preserve permissions and change-time with private-file safety", async (t) => {
	const store = await fixture(t);
	assert.equal((await runPromise(loadStoreSnapshot(store))).state.head.id, "root");
	assert.equal(await exists(store.root), false);
	await runPromise(appendStoreEvent(store, evidence()));
	await fs.chmod(store.file, 0o644);
	const before = await fs.stat(store.file);
	assert.deepEqual((await runPromise(loadStoreSnapshot(store))).document.events, [evidence()]);
	const after = await fs.stat(store.file);
	assert.equal(after.mode, before.mode);
	assert.equal(after.ctimeMs, before.ctimeMs);
	await runPromise(loadStore(store));
	assert.equal((await fs.stat(store.file)).mode & 0o777, 0o600);
	await fs.link(store.file, join(store.root, "linked-history"));
	await assert.rejects(runPromise(loadStoreSnapshot(store)), /without links/);
});

test("canonical repository identity is shared by aliases and isolated from other scopes", async (t) => {
	const store = await fixture(t);
	const alias = join(store.root, "..", "alias");
	await fs.symlink(store.scope, alias);
	const aliased = await runPromise(openStore(alias, store.root));
	assert.deepEqual(aliased, store);
	const otherScope = join(store.root, "..", "other");
	await fs.mkdir(otherScope);
	const other = await runPromise(openStore(otherScope, store.root));
	assert.notEqual(other.directory, store.directory);
	await runPromise(appendStoreEvent(store, evidence()));
	assert.equal((await runPromise(loadStore(other))).state.evidence.length, 0);
});

test("approved versions, rejections, and rollback survive storage reload without rewriting earlier events", async (t) => {
	const store = await fixture(t);
	for (const event of evaluatedHistory().events) await runPromise(appendStoreEvent(store, event));
	await runPromise(appendStoreEvent(store, decision()));
	const approved = await runPromise(loadStore(store));
	const before = [...approved.document.events];
	const guidance = renderGuidance(activeProcedures(approved.state));
	assert.match(guidance, /Edit generator inputs/);
	await runPromise(
		appendStoreEvent(store, { kind: "rollback", id: "r1", at: 6000, versionId: "root", reason: "Human rollback" }),
	);
	const rolledBack = await runPromise(loadStore(store));
	assert.equal(renderGuidance(activeProcedures(rolledBack.state)), "");
	assert.deepEqual(rolledBack.document.events.slice(0, -1), before);
	await runPromise(
		appendStoreEvent(store, {
			kind: "rollback",
			id: "r2",
			at: 7000,
			versionId: "v1",
			reason: "Restore reviewed version",
		}),
	);
	assert.equal(renderGuidance(activeProcedures((await runPromise(loadStore(store))).state)), guidance);
});

test("a refused append leaves history byte-for-byte unchanged and releases its lock", async (t) => {
	const store = await fixture(t);
	await runPromise(appendStoreEvent(store, evidence()));
	const original = await fs.readFile(store.file, "utf8");
	await assert.rejects(runPromise(appendStoreEvent(store, evidence())), /Duplicate/);
	assert.equal(await fs.readFile(store.file, "utf8"), original);
	assert.equal(await exists(store.lock), false);
	await runPromise(appendStoreEvent(store, evidence("e2", "s2")));
	assert.equal((await runPromise(loadStore(store))).state.evidence.length, 2);
});

test("an existing lock is never stolen, even when it looks old or empty", async (t) => {
	const store = await fixture(t);
	await runPromise(appendStoreEvent(store, evidence()));
	await fs.writeFile(store.lock, "");
	const original = await fs.readFile(store.file, "utf8");
	await assert.rejects(
		runPromise(appendStoreEvent(store, evidence("e2", "s2"))),
		/inspect and remove the lock manually/,
	);
	assert.equal(await fs.readFile(store.file, "utf8"), original);
	assert.equal(await exists(store.lock), true);
});

test("a lock held by another process excludes a writer and is released on normal process exit", async (t) => {
	const store = await fixture(t);
	await runPromise(loadStore(store));
	const lockUrl = new URL("../../_shared/fs.ts", import.meta.url).href;
	const runtimeUrl = new URL("../../_shared/effect-runtime.ts", import.meta.url).href;
	const script = `
		import { Effect } from "effect";
		import { withExclusiveFileLock } from ${JSON.stringify(lockUrl)};
		import { runPromise } from ${JSON.stringify(runtimeUrl)};
		await runPromise(withExclusiveFileLock(${JSON.stringify(store.lock)}, Effect.promise(() =>
			new Promise(resolve => {
				process.stdin.resume();
				process.stdin.once("end", resolve);
				process.stdout.write("locked\\n");
			})
		)));
	`;
	const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
		cwd: new URL("../../", import.meta.url),
		stdio: ["pipe", "pipe", "pipe"],
	});
	t.after(() => {
		child.kill();
	});
	const exited = once(child, "exit");
	await once(child.stdout, "data");
	assert.equal(await exists(store.lock), true);
	await assert.rejects(runPromise(appendStoreEvent(store, evidence())), /another writer/);
	child.stdin.end();
	const [code] = await exited;
	assert.equal(code, 0);
	assert.equal(await exists(store.lock), false);
	await runPromise(appendStoreEvent(store, evidence()));
});

test("simultaneous append attempts either preserve an event or report contention; none silently overwrite", async (t) => {
	const store = await fixture(t);
	const results = await Promise.allSettled(
		Array.from({ length: 6 }, (_, i) => runPromise(appendStoreEvent(store, evidence(`e${i}`, `s${i}`)))),
	);
	const accepted = results.flatMap((result, i) => (result.status === "fulfilled" ? [`e${i}`] : []));
	assert.ok(accepted.length > 0);
	for (const result of results) {
		if (result.status === "rejected") {
			assert.ok(result.reason instanceof HarnessError);
			assert.match(result.reason.message, /another writer/);
		}
	}
	assert.deepEqual(
		(await runPromise(loadStore(store))).document.events.map((event) => event.id).toSorted(),
		accepted.toSorted(),
	);
	await runPromise(appendStoreEvent(store, evidence("last", "last")));
	assert.equal((await runPromise(loadStore(store))).document.events.length, accepted.length + 1);
});

test("interruption cannot release a lock while an uncancellable write is still running", async (t) => {
	const store = await fixture(t);
	await runPromise(loadStore(store));
	const entered = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	const fiber = runFork(
		withExclusiveFileLock(
			store.lock,
			Effect.gen(function* () {
				yield* Effect.sync(() => entered.resolve());
				yield* Effect.promise(() => finish.promise);
				yield* writePrivateFileAtomic(store.file, "finished");
			}),
		),
	);
	t.after(() => finish.resolve());
	await entered.promise;
	const interrupted = runPromise(Fiber.interrupt(fiber));
	assert.equal(await exists(store.lock), true);
	finish.resolve();
	await interrupted;
	assert.equal(await fs.readFile(store.file, "utf8"), "finished");
	assert.equal(await exists(store.lock), false);
});

test("corrupt, incompatible, or wrong-scope histories fail closed and are not replaced by an empty store", async (t) => {
	const store = await fixture(t);
	await runPromise(loadStore(store));
	for (const contents of [
		"{",
		JSON.stringify({ format: 2, scope: store.scope, events: [] }),
		JSON.stringify({ format: 1, scope: "/different", events: [] }),
		JSON.stringify({ format: 1, scope: store.scope, events: [evidence(), evidence()] }),
	]) {
		await fs.writeFile(store.file, contents);
		await assert.rejects(runPromise(loadStore(store)), HarnessError);
		await assert.rejects(runPromise(appendStoreEvent(store, evidence("e2", "s2"))), HarnessError);
		assert.equal(await fs.readFile(store.file, "utf8"), contents);
		assert.equal(await exists(store.lock), false);
	}
});

test("oversized files are rejected before parsing; failed reads leave the original bytes intact", async (t) => {
	const store = await fixture(t);
	await runPromise(loadStore(store));
	await fs.writeFile(store.file, "x".repeat(MAX_STORE_BYTES + 1));
	await assert.rejects(runPromise(loadStore(store)), /exceeds/);
	await assert.rejects(runPromise(appendStoreEvent(store, evidence())), /exceeds/);
	assert.equal((await fs.stat(store.file)).size, MAX_STORE_BYTES + 1);
	assert.equal(await exists(store.lock), false);
});

test("an append that would cross the byte budget preserves the existing audit history", async (t) => {
	const store = await fixture(t);
	await runPromise(loadStore(store));
	const document = { ...pendingHistory(), scope: store.scope };
	const large = evaluation("large");
	const pairs = large.pairs.map((pair) => ({
		...pair,
		baselineOutput: "b".repeat(2048),
		candidateOutput: "c".repeat(2048),
	}));
	let event = { ...large, pairs };
	for (let i = 0; ; i++) {
		event = { ...large, id: `large${i}`, pairs };
		const next = { ...document, events: [...document.events, event] };
		if (Buffer.byteLength(`${JSON.stringify(next)}\n`, "utf8") > MAX_STORE_BYTES) break;
		document.events = next.events;
	}
	const original = `${JSON.stringify(document)}\n`;
	await fs.writeFile(store.file, original);
	await assert.rejects(runPromise(appendStoreEvent(store, event)), /byte capacity/);
	assert.equal(await fs.readFile(store.file, "utf8"), original);
	assert.deepEqual(await fs.readdir(store.directory), ["history.json"]);
});

test("owned existing directories and files have their private permissions restored", async (t) => {
	const store = await fixture(t);
	await runPromise(appendStoreEvent(store, evidence()));
	await fs.chmod(store.root, 0o755);
	await fs.chmod(store.directory, 0o755);
	await fs.chmod(store.file, 0o644);
	await runPromise(loadStore(store));
	assert.equal((await fs.stat(store.root)).mode & 0o777, 0o700);
	assert.equal((await fs.stat(store.directory)).mode & 0o777, 0o700);
	assert.equal((await fs.stat(store.file)).mode & 0o777, 0o600);
});

test("store directories and history files cannot redirect through symlinks", async (t) => {
	const store = await fixture(t);
	const external = join(store.root, "..", "external");
	await fs.mkdir(external);
	await fs.symlink(external, store.root);
	await assert.rejects(runPromise(loadStore(store)), /non-symlink directory/);
	assert.deepEqual(await fs.readdir(external), []);
	await fs.unlink(store.root);
	await fs.mkdir(store.root);
	await fs.symlink(external, store.directory);
	await assert.rejects(runPromise(loadStore(store)), /non-symlink directory/);
	await fs.unlink(store.directory);
	await fs.mkdir(store.directory);
	const target = join(external, "target");
	await fs.writeFile(target, "do not change");
	await fs.symlink(target, store.file);
	await assert.rejects(runPromise(loadStore(store)), HarnessError);
	await assert.rejects(runPromise(appendStoreEvent(store, evidence())), HarnessError);
	await assert.rejects(runPromise(writePrivateFileAtomic(store.file, "changed")));
	assert.equal(await fs.readFile(target, "utf8"), "do not change");
});

test("dangling links and hard-linked files are not treated as missing histories", async (t) => {
	const store = await fixture(t);
	await runPromise(loadStore(store));
	const target = join(store.root, "..", "target");
	await fs.symlink(target, store.file);
	await assert.rejects(runPromise(loadStore(store)), HarnessError);
	assert.equal(await exists(target), false);
	await fs.unlink(store.file);
	await fs.writeFile(target, "external file", { mode: 0o644 });
	await fs.link(target, store.file);
	await assert.rejects(runPromise(loadStore(store)), /without links/);
	await assert.rejects(runPromise(writePrivateFileAtomic(store.file, "changed")));
	assert.equal((await fs.stat(target)).mode & 0o777, 0o644);
	assert.equal(await fs.readFile(target, "utf8"), "external file");
});

test("readers observe complete old or new documents while atomic replacements occur", async (t) => {
	const store = await fixture(t);
	await runPromise(appendStoreEvent(store, evidence()));
	const writer = async () => {
		for (let i = 2; i < 10; i++) await runPromise(appendStoreEvent(store, evidence(`e${i}`, `s${i}`)));
	};
	const reader = async () => {
		for (let i = 0; i < 30; i++) {
			const loaded = await runPromise(loadStore(store));
			assert.ok(loaded.document.events.length >= 1 && loaded.document.events.length <= 9);
			assert.equal(loaded.document.events[0]?.id, "e1");
		}
	};
	await Promise.all([writer(), reader(), reader()]);
	assert.equal((await runPromise(loadStore(store))).document.events.length, 9);
	assert.deepEqual(await fs.readdir(store.directory), ["history.json"]);
});
