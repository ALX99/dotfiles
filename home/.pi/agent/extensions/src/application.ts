import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Cause, Context, Effect, Layer, Ref } from "effect";

import { AgentActivity, type ActivitySignal, type ActivitySnapshot } from "./application/activity.ts";
import { ModelContext, type ProviderRequestTransform } from "./context/model-context.ts";
import type { EffectRunner } from "./support/effect-runtime.ts";

export interface ApplicationEffects extends EffectRunner {
	initiate(effect: Effect.Effect<void>): Promise<void>;
}

export interface SettlementPlan {
	readonly taskCheckpoint: Effect.Effect<Effect.Effect<void> | undefined>;
	readonly rescuedInput: Effect.Effect<Effect.Effect<void> | undefined>;
	readonly scheduledMessage: Effect.Effect<Effect.Effect<void> | undefined>;
	readonly taskInput: Effect.Effect<Effect.Effect<void> | undefined>;
	readonly taskReminder: Effect.Effect<Effect.Effect<void> | undefined>;
}

const PREPARATION_ORDER = ["taskCheckpoint", "taskInput", "taskReminder", "rescuedInput", "scheduledMessage"] as const;
const SETTLEMENT_ORDER = ["taskCheckpoint", "rescuedInput", "scheduledMessage", "taskInput", "taskReminder"] as const;

class WorkCoordinator extends Context.Service<
	WorkCoordinator,
	{
		settle(plan: SettlementPlan): Effect.Effect<void>;
		initiate(action: Effect.Effect<void>): Effect.Effect<void>;
		startSession(): Effect.Effect<void>;
		shutdown(): Effect.Effect<void>;
	}
>()("personal/WorkCoordinator") {
	static readonly layer = Layer.effect(
		WorkCoordinator,
		Effect.gen(function* () {
			const state = yield* Ref.make({ closed: false, running: false });

			const execute = (action: Effect.Effect<void>): Effect.Effect<void> =>
				Effect.uninterruptibleMask((restore) =>
					Effect.gen(function* () {
						const admitted = yield* Ref.modify(state, (current) => {
							if (current.closed || current.running) return [false, current] as const;
							return [true, { ...current, running: true }] as const;
						});
						if (admitted) {
							yield* Effect.ensuring(
								restore(action),
								Ref.update(state, (current) => ({
									...current,
									running: false,
								})),
							);
						}
					}),
				);

			const settle = Effect.fnUntraced(function* (plan: SettlementPlan) {
				const prepared: Partial<Record<(typeof SETTLEMENT_ORDER)[number], Effect.Effect<void> | undefined>> = {};
				for (const name of PREPARATION_ORDER) {
					prepared[name] = yield* plan[name].pipe(
						Effect.catchCause((cause) =>
							Cause.hasInterrupts(cause)
								? Effect.failCause(cause)
								: Effect.logError(`Personal ${name} work preparation failed: ${String(cause)}`).pipe(
										Effect.as(undefined),
									),
						),
					);
				}

				for (const name of SETTLEMENT_ORDER) {
					const action = prepared[name];
					if (action !== undefined) {
						yield* execute(action);
						break;
					}
				}
			});

			return WorkCoordinator.of({
				settle,
				initiate: execute,
				startSession: Effect.fnUntraced(function* () {
					yield* Ref.update(state, (current) => ({ ...current, closed: false }));
				}),
				shutdown: Effect.fnUntraced(function* () {
					yield* Ref.update(state, (current) => ({ ...current, closed: true }));
				}),
			});
		}),
	);
}

/** Application-level workflows. Domain features contribute concrete work; the application owns when it may run. */
export class PersonalApplication extends Context.Service<
	PersonalApplication,
	{
		settle(plan: SettlementPlan): Effect.Effect<void>;
		initiate(action: Effect.Effect<void>): Effect.Effect<void>;
		startSession: Effect.Effect<void>;
		shutdown: Effect.Effect<void>;
		providerRequest(
			payload: unknown,
			context: ExtensionContext,
			transforms: readonly ProviderRequestTransform[],
		): Effect.Effect<unknown>;
		activity(signal: ActivitySignal): Effect.Effect<ActivitySnapshot>;
	}
>()("personal/Application") {
	static readonly layer = Layer.effect(
		PersonalApplication,
		Effect.gen(function* () {
			const work = yield* WorkCoordinator;
			const modelContext = yield* ModelContext;
			const activity = yield* AgentActivity;
			return PersonalApplication.of({
				settle: (plan) => work.settle(plan),
				initiate: (action) => work.initiate(action),
				startSession: work.startSession(),
				shutdown: work.shutdown(),
				providerRequest: (payload, context, transforms) => modelContext.transformRequest(payload, context, transforms),
				activity: (signal) => activity.update(signal),
			});
		}),
	).pipe(Layer.provide(Layer.mergeAll(WorkCoordinator.layer, ModelContext.layer, AgentActivity.layer)));
}

export const PersonalApplicationLayer = PersonalApplication.layer;

export default function registerPersonalExtension(
	pi: import("@earendil-works/pi-coding-agent").ExtensionAPI,
): Promise<void> {
	return import("./pi/adapter.ts").then(({ installPersonalExtension }) => installPersonalExtension(pi));
}
