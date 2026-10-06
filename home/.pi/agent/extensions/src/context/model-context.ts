import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Context, Effect, Layer, Schema } from "effect";

export type ProviderRequestTransform = (payload: unknown, context: ExtensionContext) => unknown;

class ProviderTransformError extends Schema.TaggedError<ProviderTransformError>()("ProviderTransformError", {
	message: Schema.String,
	cause: Schema.Defect(),
}) {}

/** Sequences the personal model-facing request policies without owning provider transport state. */
export class ModelContext extends Context.Service<
	ModelContext,
	{
		transformRequest(
			payload: unknown,
			context: ExtensionContext,
			transforms: readonly ProviderRequestTransform[],
		): Effect.Effect<unknown>;
	}
>()("personal/ModelContext") {
	static readonly layer = Layer.succeed(this)({
		transformRequest: Effect.fn("ModelContext.transformRequest")(function* (payload, context, transforms) {
			let current = payload;
			let changed = false;

			for (const transform of transforms) {
				const result = yield* Effect.result(
					Effect.tryPromise({
						try: () => Promise.resolve(transform(current, context)),
						catch: (cause) => new ProviderTransformError({ message: "Provider request transform failed", cause }),
					}),
				);
				if ("failure" in result) {
					// Keep each transform isolated like Pi's former per-handler boundary.
					yield* Effect.logError(`Personal provider request transform failed: ${result.failure.message}`);
					continue;
				}
				if (result.success !== undefined) {
					current = result.success;
					changed = true;
				}
			}

			return changed ? current : undefined;
		}),
	});
}
