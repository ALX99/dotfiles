import { resolve } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { Console, Effect } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { labRunReport, launchLab, planLabLaunch, resolveLabScope } from "./launch.ts";
import { LabError, LabIdSchema } from "./schema.ts";
import { loadLabStore, openLabStore } from "./store.ts";

const scope = Flag.String("scope").pipe(
	Flag.withDefault("."),
	Flag.withDescription("Repository directory (canonical Git root is resolved automatically)"),
);
const configPath = Argument.String("config").pipe(Argument.withDescription("Independently authored experiment JSON"));
const runId = Argument.String("run-id").pipe(Argument.withSchema(LabIdSchema));
const paidWarning =
	"Reported-cost and local deadline limits are not provider-enforced billing caps. " +
	"Interrupted streams can have unreported charges. Deployment remains manual.";

const plan = Command.make(
	"plan",
	{ config: configPath, scope },
	Effect.fn(function* (args) {
		const planned = yield* planLabLaunch(yield* resolveLabScope(args.scope), resolve(args.config));
		// Holdout data is not printed into development feedback.
		yield* Console.log(
			JSON.stringify(
				{
					scope: planned.scope,
					targetModel: planned.config.targetModel,
					researcherModel: planned.config.researcherModel,
					productionParent: planned.config.baseline.productionVersion,
					image: planned.config.image,
					limits: planned.config.limits,
					requestBounds: planned.requestBounds,
					warning: paidWarning,
				},
				null,
				2,
			),
		);
	}),
).pipe(Command.withDescription("Validate and inspect a launch without requests, Docker access, or storage writes"));

const run = Command.make(
	"run",
	{
		config: configPath,
		runId,
		scope,
		allowPaid: Flag.Boolean("allow-paid").pipe(
			Flag.withDefault(false),
			Flag.withDescription("Authorize this bounded run to issue paid model requests"),
		),
	},
	Effect.fn(function* (args) {
		if (!args.allowPaid)
			return yield* new LabError({ message: "run requires explicit --allow-paid; use plan to inspect it offline" });
		const planned = yield* planLabLaunch(yield* resolveLabScope(args.scope), resolve(args.config));
		yield* Console.log(paidWarning);
		const state = yield* launchLab(planned, args.runId, args.allowPaid);
		yield* Console.log(JSON.stringify(labRunReport(state), null, 2));
		if (state.finished?.status !== "completed")
			return yield* new LabError({ message: `Run ended without release eligibility: ${state.finished?.reason}` });
		return undefined;
	}),
).pipe(Command.withDescription("Run automatic research and coding evaluations; never deploy or resume a run"));

const inspect = (name: "status" | "review") =>
	Command.make(
		name,
		{ runId, scope },
		Effect.fn(function* (args) {
			const store = yield* openLabStore(yield* resolveLabScope(args.scope), args.runId);
			const { state } = yield* loadLabStore(store);
			yield* Console.log(JSON.stringify(labRunReport(state), null, 2));
		}),
	).pipe(Command.withDescription("Read laboratory history offline without initializing missing runs"));

const cli = Command.make("improve:harness").pipe(
	Command.withDescription("Bounded procedural harness research with separate laboratory lineage"),
	Command.withSubcommands([plan, run, inspect("status"), inspect("review")]),
);

export const runLabCli = (args: readonly string[]) =>
	Command.runWith(cli, { version: "1.0.0" })(args).pipe(Effect.provide(NodeServices.layer));
