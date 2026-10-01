import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { DateTime, Effect, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { readRegularFileStringIfExists, realPath } from "../../_shared/fs.ts";
import { parseJson } from "../../_shared/json.ts";
import { modelProcedures } from "../state.ts";
import { loadStoreSnapshot, openStore } from "../store.ts";
import { runLabController } from "./controller.ts";
import { openDockerSandbox, type LabSandbox } from "./docker.ts";
import { createLabModels, type LabModels } from "./model.ts";
import { LabConfigSchema, LabError, LabExperimentSchema, MAX_LAB_SUITE_BYTES, type LabConfig } from "./schema.ts";
import { labBudget, labReleaseGate, labRequestBounds, type LabState } from "./state.ts";
import { createLabStore, openLabStore } from "./store.ts";

export interface LabLaunchPlan {
	readonly scope: string;
	readonly config: LabConfig;
	readonly requestBounds: ReturnType<typeof labRequestBounds>;
}

/** Git environment overrides are not inherited; the canonical top-level owns the run. */
export const resolveLabScope = Effect.fn("harnessLearning.resolveLabScope")(
	function* (cwd: string) {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		const processHandle = yield* spawner.spawn(
			ChildProcess.make("git", ["-C", resolve(cwd), "rev-parse", "--show-toplevel"], {
				env: { PATH: process.env.PATH ?? "", LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
				extendEnv: false,
				forceKillAfter: 100,
			}),
		);
		let bytes = 0;
		const collect = (stream: typeof processHandle.stdout) =>
			Effect.gen(function* () {
				const chunks: Uint8Array[] = [];
				yield* Stream.runForEach(stream, (chunk) =>
					Effect.gen(function* () {
						bytes += chunk.byteLength;
						if (bytes > 8192) return yield* new LabError({ message: "Git scope output exceeded its limit" });
						chunks.push(chunk);
						return undefined;
					}),
				);
				return Buffer.concat(chunks).toString("utf8").trim();
			});
		const [stdout, stderr, code] = yield* Effect.all(
			[collect(processHandle.stdout), collect(processHandle.stderr), processHandle.exitCode],
			{ concurrency: 3 },
		);
		if (Number(code) === 0 && stdout.length > 0) return yield* realPath(stdout);
		if (/not a git repository/i.test(stderr)) return yield* realPath(resolve(cwd));
		return yield* new LabError({ message: `Cannot resolve repository scope: ${stderr || "empty Git output"}` });
	},
	Effect.timeout(5000),
	Effect.scoped,
	Effect.provide(NodeServices.layer),
	Effect.mapError((error) => (error instanceof LabError ? error : new LabError({ message: error.message }))),
);

/** Offline and read-only: no model initialization, container access, or store creation. */
export const planLabLaunch = Effect.fn("harnessLearning.planLabLaunch")(function* (
	scope: string,
	path: string,
	root?: string,
): Effect.fn.Return<LabLaunchPlan, LabError> {
	const contents = yield* readRegularFileStringIfExists(resolve(path), MAX_LAB_SUITE_BYTES + 4096).pipe(
		Effect.mapError((error) => new LabError({ message: `Cannot read laboratory configuration: ${error.message}` })),
	);
	if (contents === undefined) return yield* new LabError({ message: `Laboratory configuration not found: ${path}` });
	const input = yield* Effect.fromResult(parseJson(contents, path)).pipe(
		Effect.mapError((error) => new LabError({ message: error.message })),
	);
	const experiment = yield* Schema.decodeUnknownEffect(LabExperimentSchema, { onExcessProperty: "error" })(input).pipe(
		Effect.mapError((error) => new LabError({ message: `Invalid laboratory configuration: ${error.message}` })),
	);
	const production = yield* openStore(scope, root).pipe(
		Effect.mapError((error) => new LabError({ message: error.message })),
	);
	const { state } = yield* loadStoreSnapshot(production).pipe(
		Effect.mapError((error) => new LabError({ message: error.message })),
	);
	const config = yield* Schema.decodeUnknownEffect(LabConfigSchema, { onExcessProperty: "error" })({
		...experiment,
		baseline: {
			productionVersion: state.head.id,
			procedures: modelProcedures(state, experiment.targetModel).map(({ id, procedure }) => ({ id, procedure })),
		},
	}).pipe(Effect.mapError((error) => new LabError({ message: `Invalid frozen baseline: ${error.message}` })));
	return { scope: production.scope, config, requestBounds: labRequestBounds(config) };
});

export interface LabLaunchDependencies {
	readonly models: () => Effect.Effect<LabModels, LabError>;
	readonly sandbox: (image: string) => Effect.Effect<LabSandbox, LabError>;
}
const defaultDependencies: LabLaunchDependencies = { models: createLabModels, sandbox: openDockerSandbox };

/** Explicit authorization covers one immutable run; neither existing runs nor production can be overwritten. */
export const launchLab = Effect.fn("harnessLearning.launchLab")(function* (
	plan: LabLaunchPlan,
	runId: string,
	allowPaid: boolean,
	root?: string,
	dependencies: LabLaunchDependencies = defaultDependencies,
) {
	if (!allowPaid)
		return yield* new LabError({ message: "Paid execution requires --allow-paid; plan/status/review remain offline" });
	const store = yield* openLabStore(plan.scope, runId, root);
	const models = yield* dependencies.models();
	for (const identity of [plan.config.researcherModel, plan.config.targetModel]) {
		const slash = identity.indexOf("/");
		const model = models.getPhysicalModel(identity.slice(0, slash), identity.slice(slash + 1));
		if (model === undefined || `${model.provider}/${model.id}` !== identity)
			return yield* new LabError({ message: `Physical model not found: ${identity}` });
		if (plan.config.limits.maxOutputTokens > model.maxTokens)
			return yield* new LabError({ message: `Configured output exceeds the declared model limit: ${identity}` });
	}
	const sandbox = yield* dependencies.sandbox(plan.config.image);
	yield* createLabStore(store, {
		id: randomUUID(),
		at: DateTime.toEpochMillis(yield* DateTime.now),
		kind: "started",
		config: plan.config,
	});
	return yield* runLabController(store, models, sandbox);
});

/** User-facing reports do not need to dump evaluator files or complete execution traces. */
export function labRunReport(state: LabState) {
	const budget = labBudget(state);
	return {
		scope: state.scope,
		runId: state.runId,
		targetModel: state.started.config.targetModel,
		researcherModel: state.started.config.researcherModel,
		productionParent: state.started.config.baseline.productionVersion,
		experimentalVersion: state.head.id,
		activeProcedureIds: state.head.procedureIds,
		finished: state.finished,
		budget: { ...budget, pending: budget.pending.map(({ id }) => id) },
		limits: state.started.config.limits,
		releaseGate: labReleaseGate(state),
		candidates: state.candidates.map(({ id, parentVersion, procedure, hypothesis, attribution, evidenceIds }) => ({
			id,
			parentVersion,
			procedure,
			hypothesis,
			attribution,
			evidenceIds,
			selection: state.selections.find((selection) => selection.candidateId === id) ?? null,
		})),
	};
}
