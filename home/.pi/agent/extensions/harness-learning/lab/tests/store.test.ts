import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { runPromise } from "../../../_shared/effect-runtime.ts";
import { appendStoreEvent, loadStore, openStore } from "../../store.ts";
import { evidence, proposal, success } from "../../tests/fixtures.ts";
import { LabError, MAX_LAB_STORE_BYTES, type LabDocument, type LabEvent, type LabTaskEvent } from "../schema.ts";
import { replayLabDocument } from "../state.ts";
import { appendLabStoreEvent, createLabStore, loadLabStore, openLabStore, type LabStore } from "../store.ts";
import { config, finishedDocument, seededDocument, startedDocument } from "./fixtures.ts";

async function fixture(t: TestContext): Promise<LabStore> {
	const root = await fs.mkdtemp(join(tmpdir(), "harness-lab-"));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const repo = join(root, "repo");
	await fs.mkdir(repo);
	return runPromise(openLabStore(repo, "run1", join(root, "private")));
}

function start(store: LabStore): LabEvent {
	return startedDocument(config(), store.scope, store.runId).events[0]!;
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

test("opening or reviewing a missing run creates no files and never initializes history", async (t) => {
	const store = await fixture(t);
	assert.equal(await exists(store.root), false);
	await assert.rejects(runPromise(loadLabStore(store)), /not found/);
	assert.equal(await exists(store.root), false);
	await assert.rejects(runPromise(openLabStore(store.scope, "../escape", store.root)), /Invalid laboratory run ID/);
	assert.equal(await exists(store.root), false);
});

test("creation is private, atomic, explicit, and never replaces an existing run", async (t) => {
	const store = await fixture(t);
	const state = await runPromise(createLabStore(store, start(store)));
	assert.equal(state.head.id, "root");
	assert.equal(state.runId, "run1");
	const original = await fs.readFile(store.file, "utf8");
	for (const path of [store.root, store.scopeDirectory, store.labDirectory, store.directory])
		assert.equal((await fs.stat(path)).mode & 0o777, 0o700);
	assert.equal((await fs.stat(store.file)).mode & 0o777, 0o600);
	assert.deepEqual(await fs.readdir(store.directory), ["history.json"]);
	await assert.rejects(runPromise(createLabStore(store, start(store))), /already exists/);
	assert.equal(await fs.readFile(store.file, "utf8"), original);
	assert.equal(await exists(store.lock), false);
});

test("offline laboratory review preserves permissions and change-time rather than performing a private write", async (t) => {
	const store = await fixture(t);
	await runPromise(createLabStore(store, start(store)));
	await fs.chmod(store.file, 0o644);
	const before = await fs.stat(store.file);
	const bytes = await fs.readFile(store.file, "utf8");
	assert.equal((await runPromise(loadLabStore(store))).state.head.id, "root");
	const after = await fs.stat(store.file);
	assert.equal(after.mode, before.mode);
	assert.equal(after.ctimeMs, before.ctimeMs);
	assert.equal(await fs.readFile(store.file, "utf8"), bytes);
	await fs.link(store.file, join(store.root, "linked-history"));
	await assert.rejects(runPromise(loadLabStore(store)), /without links/);
});

test("canonical scope aliases share a run, but different runs and repositories do not", async (t) => {
	const store = await fixture(t);
	const alias = join(store.scope, "..", "alias");
	await fs.symlink(store.scope, alias);
	assert.deepEqual(await runPromise(openLabStore(alias, "run1", store.root)), store);
	const otherRun = await runPromise(openLabStore(store.scope, "run2", store.root));
	assert.notEqual(otherRun.file, store.file);
	const otherRepo = join(store.scope, "..", "other");
	await fs.mkdir(otherRepo);
	const other = await runPromise(openLabStore(otherRepo, "run1", store.root));
	assert.notEqual(other.file, store.file);
	await runPromise(createLabStore(store, start(store)));
	await assert.rejects(runPromise(loadLabStore(otherRun)), /not found/);
	await assert.rejects(runPromise(loadLabStore(other)), /not found/);
});

test("request accounting, selections, final evidence, and immutable ancestry survive reload", async (t) => {
	const store = await fixture(t);
	const document = finishedDocument();
	await runPromise(createLabStore(store, document.events[0]));
	for (const event of document.events.slice(1)) await runPromise(appendLabStoreEvent(store, event));
	const loaded = await runPromise(loadLabStore(store));
	assert.deepEqual(loaded.document.events, document.events);
	assert.deepEqual(loaded.state, success(replayLabDocument({ ...document, scope: store.scope })));
	const original = await fs.readFile(store.file, "utf8");
	await assert.rejects(
		runPromise(
			appendLabStoreEvent(store, {
				kind: "finished",
				id: "resume",
				at: loaded.state.lastAt + 1,
				status: "stopped",
				reason: "Try reopening.",
			}),
		),
		/cannot be changed/,
	);
	assert.equal(await fs.readFile(store.file, "utf8"), original);
	assert.deepEqual(await fs.readdir(store.directory), ["history.json"]);
});

test("lab creation and accepted versions leave production history byte-for-byte unchanged", async (t) => {
	const store = await fixture(t);
	const production = await runPromise(openStore(store.scope, store.root));
	await runPromise(appendStoreEvent(production, evidence()));
	const original = await fs.readFile(production.file, "utf8");
	const document = finishedDocument();
	await runPromise(createLabStore(store, document.events[0]));
	for (const event of document.events.slice(1)) await runPromise(appendLabStoreEvent(store, event));
	assert.equal(await fs.readFile(production.file, "utf8"), original);
	assert.equal((await runPromise(loadStore(production))).state.head.id, "root");
});

test("refused events preserve exact bytes and release the lock", async (t) => {
	const store = await fixture(t);
	await runPromise(createLabStore(store, start(store)));
	const original = await fs.readFile(store.file, "utf8");
	await assert.rejects(runPromise(appendLabStoreEvent(store, { ...start(store), id: "start2" })), /cannot be changed/);
	assert.equal(await fs.readFile(store.file, "utf8"), original);
	assert.equal(await exists(store.lock), false);
	await runPromise(
		appendLabStoreEvent(store, {
			id: "stop",
			kind: "finished",
			at: 1001,
			status: "stopped",
			reason: "No experiments.",
		}),
	);
	assert.equal((await runPromise(loadLabStore(store))).state.finished?.status, "stopped");
});

test("an existing lock is never stolen and concurrent creators cannot overwrite one another", async (t) => {
	const store = await fixture(t);
	await runPromise(createLabStore(store, start(store)));
	await fs.writeFile(store.lock, "");
	const original = await fs.readFile(store.file, "utf8");
	await assert.rejects(
		runPromise(
			appendLabStoreEvent(store, {
				id: "stop",
				kind: "finished",
				at: 1001,
				status: "stopped",
				reason: "No experiments.",
			}),
		),
		/another writer.*inspect and remove the lock manually/,
	);
	assert.equal(await fs.readFile(store.file, "utf8"), original);
	assert.equal(await exists(store.lock), true);
	await fs.unlink(store.lock);
	const other = await runPromise(openLabStore(store.scope, "race", store.root));
	const outcomes = await Promise.allSettled(
		Array.from({ length: 5 }, () => runPromise(createLabStore(other, start(other)))),
	);
	assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
	for (const outcome of outcomes) {
		if (outcome.status === "rejected") {
			assert.ok(outcome.reason instanceof LabError);
			assert.match(outcome.reason.message, /another writer|already exists/);
		}
	}
	assert.deepEqual((await runPromise(loadLabStore(other))).document.events, [start(other)]);
});

test("concurrent append attempts preserve the sole accepted terminal event without silent lost updates", async (t) => {
	const store = await fixture(t);
	await runPromise(createLabStore(store, start(store)));
	const outcomes = await Promise.allSettled(
		["a", "b", "c"].map((id) =>
			runPromise(
				appendLabStoreEvent(store, {
					id,
					kind: "finished",
					at: 1001,
					status: "stopped",
					reason: `Stop ${id}.`,
				}),
			),
		),
	);
	const accepted = outcomes.flatMap((outcome, i) => (outcome.status === "fulfilled" ? [["a", "b", "c"][i]] : []));
	assert.equal(accepted.length, 1);
	const loaded = await runPromise(loadLabStore(store));
	assert.equal(loaded.document.events.at(-1)?.id, accepted[0]);
	assert.equal(loaded.document.events.length, 2);
	assert.equal(await exists(store.lock), false);
});

test("corrupt, incompatible, wrong-scope, and wrong-run histories never reset or overwrite", async (t) => {
	const store = await fixture(t);
	await runPromise(createLabStore(store, start(store)));
	const valid = (await runPromise(loadLabStore(store))).document;
	for (const raw of [
		"{",
		JSON.stringify({ ...valid, format: 2 }),
		JSON.stringify({ ...valid, scope: "/other" }),
		JSON.stringify({ ...valid, runId: "other" }),
		JSON.stringify({ ...valid, events: [] }),
		JSON.stringify({ ...valid, events: [start(store), start(store)] }),
	]) {
		await fs.writeFile(store.file, raw);
		await assert.rejects(runPromise(loadLabStore(store)), LabError);
		await assert.rejects(
			runPromise(
				appendLabStoreEvent(store, {
					id: "stop",
					at: 1001,
					kind: "finished",
					status: "stopped",
					reason: "Do not recover silently.",
				}),
			),
			LabError,
		);
		assert.equal(await fs.readFile(store.file, "utf8"), raw);
		assert.equal(await exists(store.lock), false);
	}
});

test("symlink endpoints, hard links, linked run directories, and oversized files fail closed", async (t) => {
	const store = await fixture(t);
	await runPromise(createLabStore(store, start(store)));
	const external = join(store.scope, "outside");
	await fs.writeFile(external, "external contents", { mode: 0o644 });
	await fs.unlink(store.file);
	await fs.symlink(external, store.file);
	await assert.rejects(runPromise(loadLabStore(store)), LabError);
	await assert.rejects(runPromise(appendLabStoreEvent(store, start(store))), LabError);
	assert.equal(await fs.readFile(external, "utf8"), "external contents");
	assert.equal((await fs.stat(external)).mode & 0o777, 0o644);
	await fs.unlink(store.file);
	await fs.link(external, store.file);
	await assert.rejects(runPromise(loadLabStore(store)), /without links/);
	await fs.unlink(store.file);
	await fs.writeFile(store.file, "x".repeat(MAX_LAB_STORE_BYTES + 1));
	await assert.rejects(runPromise(loadLabStore(store)), /exceeds/);
	assert.equal((await fs.stat(store.file)).size, MAX_LAB_STORE_BYTES + 1);
	const linked = await runPromise(openLabStore(store.scope, "linked", store.root));
	await fs.symlink(store.scope, linked.directory);
	await assert.rejects(runPromise(createLabStore(linked, start(linked))), /non-symlink directory/);
	assert.equal(await exists(join(store.scope, "history.json")), false);
});

/** Build a valid near-capacity history without repeatedly replaying its large prefixes. */
function nearCapacityDocument(scope: string): { document: LabDocument; next: LabTaskEvent } {
	const settings = config();
	settings.limits.maxCandidates = 10;
	settings.limits.repeats = 5;
	for (let i = 0; i < 6; i++)
		settings.suite.tasks.push({
			...settings.suite.tasks[3]!,
			id: `regression-extra-${i}`,
		});
	const seeded = seededDocument(settings);
	const events = [...seeded.events];
	const document = { ...seeded, scope, events };
	let bytes = Buffer.byteLength(`${JSON.stringify(document)}\n`, "utf8");
	let at = events.at(-1)!.at;
	const add = (event: LabEvent) => {
		events.push(event);
		bytes += Buffer.byteLength(JSON.stringify(event), "utf8") + 1;
	};
	const evidenceIds = events
		.filter((event): event is LabTaskEvent => event.kind === "task" && event.taskId.startsWith("target"))
		.map((event) => event.id);
	for (let candidateIndex = 0; candidateIndex < 10; candidateIndex++) {
		const id = `candidate-${candidateIndex}`;
		const requestId = `research-${candidateIndex}`;
		add({ id: requestId, at: ++at, kind: "request-start", role: "researcher", reservedTokens: 512 });
		add({
			id: `research-response-${candidateIndex}`,
			at: ++at,
			kind: "request-end",
			requestId,
			status: "completed",
			usage: { tokens: 100, costUsd: 0 },
		});
		add({
			id,
			at: ++at,
			kind: "candidate",
			parentVersion: "root",
			replaces: null,
			requestId,
			procedure: { ...proposal().procedure, action: `Unique strategy ${candidateIndex}.` },
			hypothesis: "A bounded hypothesis.",
			attribution: "HARNESS_DEFICIENCY",
			evidenceIds,
		});
		for (const task of settings.suite.tasks.filter((entry) => entry.kind !== "holdout")) {
			for (let repeat = 0; repeat < settings.limits.repeats; repeat++) {
				for (const arm of ["baseline", "candidate"] as const) {
					const next: LabTaskEvent = {
						id: `trial-${candidateIndex}-${task.id}-${repeat}-${arm}`,
						at: ++at,
						kind: "task",
						phase: "development",
						candidateId: id,
						baselineVersion: "root",
						taskId: task.id,
						repeat,
						arm,
						model: settings.targetModel,
						requestIds: [],
						trace: "x".repeat(16_384),
						outcome: { status: "error", failure: "environment", message: "e".repeat(1000) },
					};
					if (bytes + Buffer.byteLength(JSON.stringify(next), "utf8") + 1 > MAX_LAB_STORE_BYTES)
						return { document, next };
					add(next);
				}
			}
		}
		add({
			id: `reject-${candidateIndex}`,
			at: ++at,
			kind: "selection",
			candidateId: id,
			decision: "reject",
			reason: "Environment failed; no improvement was retained.",
		});
	}
	throw new Error("Fixture did not reach the byte capacity");
}

test("an append crossing the byte budget keeps all earlier evidence and exact bytes intact", async (t) => {
	const store = await fixture(t);
	await runPromise(createLabStore(store, start(store)));
	const large = nearCapacityDocument(store.scope);
	assert.ok(success(replayLabDocument(large.document)));
	const original = `${JSON.stringify(large.document)}\n`;
	assert.ok(Buffer.byteLength(original, "utf8") <= MAX_LAB_STORE_BYTES);
	await fs.writeFile(store.file, original);
	await assert.rejects(runPromise(appendLabStoreEvent(store, large.next)), /byte capacity/);
	assert.equal(await fs.readFile(store.file, "utf8"), original);
	assert.deepEqual(await fs.readdir(store.directory), ["history.json"]);
});
