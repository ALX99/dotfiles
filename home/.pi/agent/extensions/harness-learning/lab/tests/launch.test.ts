import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { NodeServices } from "@effect/platform-node";
import { Effect, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { runPromise } from "../../../_shared/effect-runtime.ts";
import {
	makeDirectory,
	readRegularFileStringIfExists,
	realPath,
	removeTree,
	writeFileString,
} from "../../../_shared/fs.ts";
import { decision, evaluatedHistory } from "../../tests/fixtures.ts";
import { appendStoreEvent, openStore } from "../../store.ts";
import { runLabCli } from "../cli.ts";
import { labRunReport, launchLab, planLabLaunch, resolveLabScope, type LabLaunchDependencies } from "../launch.ts";
import { LabError, type LabConfig } from "../schema.ts";
import { labReleaseGate } from "../state.ts";
import { loadLabStore, openLabStore } from "../store.ts";
import { controllerBoundaries, controllerConfig } from "./controller-fixtures.ts";

function launchFile(config: LabConfig) {
	return {
		researcherModel: config.researcherModel,
		targetModel: config.targetModel,
		image: config.image,
		suite: config.suite,
		limits: config.limits,
	};
}

async function fixture(t: TestContext) {
	const root = join(tmpdir(), `lab-launch-${randomUUID()}`);
	t.after(() => runPromise(removeTree(root)));
	const scope = join(root, "repo");
	await runPromise(makeDirectory(scope));
	const path = join(root, "experiment.json");
	await runPromise(writeFileString(path, JSON.stringify(launchFile(controllerConfig()))));
	return { root, scope: await runPromise(realPath(scope)), path, privateRoot: join(root, "private") };
}

test("offline planning derives the baseline and does not initialize production or laboratory history", async (t) => {
	const fixtureData = await fixture(t);
	const plan = await runPromise(planLabLaunch(fixtureData.scope, fixtureData.path, fixtureData.privateRoot));
	assert.equal(plan.scope, fixtureData.scope);
	assert.equal(plan.config.baseline.productionVersion, "root");
	assert.deepEqual(plan.config.baseline.procedures, []);
	assert.equal(plan.requestBounds.seed, 8);
	assert.equal(plan.requestBounds.developmentPerCandidate, 49);
	assert.equal(plan.requestBounds.holdout, 24);
	const store = await runPromise(openLabStore(plan.scope, "run1", fixtureData.privateRoot));
	assert.equal(await runPromise(readRegularFileStringIfExists(store.file, 1024)), undefined);
	assert.equal(
		await runPromise(readRegularFileStringIfExists(join(store.scopeDirectory, "history.json"), 1024)),
		undefined,
	);
	assert.equal(
		await runPromise(readRegularFileStringIfExists(fixtureData.path, 512 * 1024)),
		JSON.stringify(launchFile(controllerConfig())),
	);
});

test("planning snapshots model-applicable production procedures, and the launch file cannot forge its parent", async (t) => {
	const data = await fixture(t);
	const production = await runPromise(openStore(data.scope, data.privateRoot));
	for (const event of [...evaluatedHistory().events, decision()]) await runPromise(appendStoreEvent(production, event));
	const settings = controllerConfig();
	settings.targetModel = "test/model";
	await runPromise(writeFileString(data.path, JSON.stringify(launchFile(settings))));
	const plan = await runPromise(planLabLaunch(data.scope, data.path, data.privateRoot));
	assert.equal(plan.config.baseline.productionVersion, "v1");
	assert.equal(plan.config.baseline.procedures[0]!.id, "p1");
	const old = plan.config.baseline.productionVersion;
	await runPromise(
		appendStoreEvent(production, {
			kind: "rollback",
			id: "v2",
			at: 6000,
			versionId: "root",
			reason: "Synthetic rollback for snapshot verification",
		}),
	);
	assert.equal(plan.config.baseline.productionVersion, old);
	const current = await runPromise(planLabLaunch(data.scope, data.path, data.privateRoot));
	assert.equal(current.config.baseline.productionVersion, "v2");
	assert.deepEqual(current.config.baseline.procedures, []);
	await runPromise(
		writeFileString(
			data.path,
			JSON.stringify({
				...launchFile(settings),
				baseline: { productionVersion: "forged", procedures: [] },
			}),
		),
	);
	await assert.rejects(
		runPromise(planLabLaunch(data.scope, data.path, data.privateRoot)),
		/Invalid laboratory configuration/,
	);
});

test("missing, oversized, invalid-budget, and unknown-field launch files fail before runtime initialization", async (t) => {
	const data = await fixture(t);
	await assert.rejects(
		runPromise(planLabLaunch(data.scope, join(data.root, "missing"), data.privateRoot)),
		/not found/,
	);
	for (const value of [
		"{",
		JSON.stringify({ ...launchFile(controllerConfig()), allowPaid: true }),
		JSON.stringify({
			...launchFile(controllerConfig()),
			limits: { ...controllerConfig().limits, maxReportedCostUsd: 0 },
		}),
		" ".repeat(512 * 1024 + 4097),
	]) {
		await runPromise(writeFileString(data.path, value));
		await assert.rejects(runPromise(planLabLaunch(data.scope, data.path, data.privateRoot)));
	}
});

test("launch authorization is checked before models, Docker, or persistent run creation", async (t) => {
	const data = await fixture(t);
	const plan = await runPromise(planLabLaunch(data.scope, data.path, data.privateRoot));
	let initialized = 0;
	const dependencies: LabLaunchDependencies = {
		models: () =>
			Effect.sync(() => {
				initialized++;
				throw new Error("must not initialize");
			}),
		sandbox: () =>
			Effect.sync(() => {
				initialized++;
				throw new Error("must not initialize");
			}),
	};
	await assert.rejects(runPromise(launchLab(plan, "run1", false, data.privateRoot, dependencies)), /--allow-paid/);
	assert.equal(initialized, 0);
	const store = await runPromise(openLabStore(data.scope, "run1", data.privateRoot));
	assert.equal(await runPromise(readRegularFileStringIfExists(store.file, 1024)), undefined);
	await assert.rejects(runPromise(runLabCli(["run", "missing.json", "run1"])), /--allow-paid/);
});

test("explicit launch drives a complete fake experiment and refuses reuse without any further provider calls", async (t) => {
	const data = await fixture(t);
	const plan = await runPromise(planLabLaunch(data.scope, data.path, data.privateRoot));
	const fake = controllerBoundaries();
	const dependencies: LabLaunchDependencies = {
		models: () => Effect.succeed(fake.models.client),
		sandbox: (image) => {
			assert.equal(image, plan.config.image);
			return Effect.succeed(fake.sandbox);
		},
	};
	const state = await runPromise(launchLab(plan, "run1", true, data.privateRoot, dependencies));
	assert.equal(state.finished?.status, "completed");
	assert.equal(labReleaseGate(state).eligible, true);
	const count = fake.models.calls.length;
	await assert.rejects(runPromise(launchLab(plan, "run1", true, data.privateRoot, dependencies)), /already exists/);
	assert.equal(fake.models.calls.length, count);
	const report = labRunReport(state);
	assert.equal(report.runId, "run1");
	assert.equal(report.productionParent, "root");
	assert.ok(report.budget.requests > 0);
	assert.equal(JSON.stringify(report).includes("PRIVATE_HOLDOUT_PROMPT"), false);
	assert.equal(JSON.stringify(report).includes("readFileSync"), false);
	const store = await runPromise(openLabStore(data.scope, "run1", data.privateRoot));
	assert.deepEqual((await runPromise(loadLabStore(store))).state.finished, state.finished);
});

test("unknown physical models and unavailable sandbox images fail before paying or creating run history", async (t) => {
	const data = await fixture(t);
	const plan = await runPromise(planLabLaunch(data.scope, data.path, data.privateRoot));
	const fake = controllerBoundaries();
	for (const failure of ["model", "sandbox"] as const) {
		const dependencies: LabLaunchDependencies = {
			models: () =>
				Effect.succeed(
					failure === "model" ? { ...fake.models.client, getPhysicalModel: () => undefined } : fake.models.client,
				),
			sandbox: () => Effect.fail(new LabError({ message: "Docker unavailable" })),
		};
		await assert.rejects(
			runPromise(launchLab(plan, failure, true, data.privateRoot, dependencies)),
			failure === "model" ? /Physical model not found/ : /Docker unavailable/,
		);
		const store = await runPromise(openLabStore(data.scope, failure, data.privateRoot));
		assert.equal(await runPromise(readRegularFileStringIfExists(store.file, 1024)), undefined);
	}
	assert.equal(fake.models.calls.length, 0);
});

test("headless scope resolution matches Git top-level from subdirectories and supports non-repositories", async (t) => {
	const data = await fixture(t);
	await runPromise(resolveLabScope(data.scope)).then((scope) => assert.equal(scope, data.scope));
	await runPromise(
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			yield* spawner.string(ChildProcess.make("git", ["init", "--quiet", data.scope]));
		}).pipe(Effect.provide(NodeServices.layer)),
	);
	await runPromise(makeDirectory(join(data.scope, "nested")));
	assert.equal(await runPromise(resolveLabScope(join(data.scope, "nested"))), data.scope);
});

test("the real CLI plan/help are offline, and run refuses missing authorization before reading configuration", async (t) => {
	const data = await fixture(t);
	const capture = Effect.fnUntraced(
		function* (args: string[]) {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const handle = yield* spawner.spawn(
				ChildProcess.make(process.execPath, [fileURLToPath(new URL("../main.ts", import.meta.url)), ...args], {
					env: { PI_OFFLINE: "1", HOME: data.root, PI_CODING_AGENT_DIR: join(data.root, "agent") },
					extendEnv: true,
				}),
			);
			const [stdout, stderr, exitCode] = yield* Effect.all(
				[
					Stream.mkString(Stream.decodeText(handle.stdout)),
					Stream.mkString(Stream.decodeText(handle.stderr)),
					handle.exitCode,
				],
				{ concurrency: 3 },
			);
			return { stdout, stderr, exitCode: Number(exitCode) };
		},
		Effect.scoped,
		Effect.provide(NodeServices.layer),
	);
	const help = await runPromise(capture(["--help"]));
	assert.equal(help.exitCode, 0);
	assert.ok(help.stdout.includes("plan"));
	assert.ok(help.stdout.includes("review"));
	const planned = await runPromise(capture(["plan", data.path, "--scope", data.scope]));
	assert.equal(planned.exitCode, 0, planned.stderr);
	const output = JSON.parse(planned.stdout) as {
		scope: string;
		productionParent: string;
		requestBounds: { seed: number };
	};
	assert.equal(output.scope, data.scope);
	assert.equal(output.productionParent, "root");
	assert.equal(output.requestBounds.seed, 8);
	assert.equal(planned.stdout.includes("PRIVATE_HOLDOUT_PROMPT"), false);
	assert.equal(planned.stdout.includes("readFileSync"), false);
	const refused = await runPromise(capture(["run", "missing.json", "run1"]));
	assert.equal(refused.exitCode, 1);
	assert.match(refused.stderr, /--allow-paid/);
});
