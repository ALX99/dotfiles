import { randomUUID } from "node:crypto";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Cause, DateTime, Effect, Exit, Result, Schema } from "effect";
import { toError } from "../../_shared/errors.ts";
import { LabError, type LabRequestStart } from "./schema.ts";
import { requestGate } from "./state.ts";
import { appendLabStoreEvent, loadLabStore, type LabStore } from "./store.ts";

export type LabModels = Pick<ModelRuntime, "getPhysicalModel" | "streamSimple">;
export const MAX_MODEL_RESPONSE_BYTES = 64 * 1024;
const MAX_CONTEXT_BYTES = 256 * 1024;
const REQUEST_OVERHEAD_TOKENS = 1024;
const decodeUsage = Schema.decodeUnknownResult(
	Schema.Struct({
		totalTokens: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
		cost: Schema.Struct({ total: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)) }),
	}),
	{ onExcessProperty: "ignore" },
);

export class LabRequestError extends Schema.TaggedError<LabRequestError>()("LabRequestError", {
	message: Schema.String,
	failure: Schema.Literals(["budget", "model"]),
}) {}

/** Headless model access only: no resource discovery, extension loading, or startup catalog requests. */
export const createLabModels = Effect.fn("harnessLearning.createLabModels")(function* () {
	return yield* Effect.tryPromise({
		try: (signal) => ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: false, signal }),
		catch: (cause) => new LabError({ message: `Cannot initialize model access: ${toError(cause).message}` }),
	});
});

/** Reservations and completions bracket every provider call, including interruption and invalid responses. */
export const requestLabModel = Effect.fn("harnessLearning.requestLabModel")(
	(
		store: LabStore,
		models: LabModels,
		role: LabRequestStart["role"],
		context: Context,
		onReserved?: (id: string) => void,
	) =>
		Effect.uninterruptibleMask((restore) =>
			Effect.gen(function* () {
				const { state } = yield* loadLabStore(store);
				const config = state.started.config;
				const identity = role === "researcher" ? config.researcherModel : config.targetModel;
				const slash = identity.indexOf("/");
				const model = models.getPhysicalModel(identity.slice(0, slash), identity.slice(slash + 1));
				if (model === undefined || `${model.provider}/${model.id}` !== identity)
					return yield* new LabRequestError({ failure: "model", message: `Physical model not found: ${identity}` });
				if (config.limits.maxOutputTokens > model.maxTokens)
					return yield* new LabRequestError({
						failure: "model",
						message: "Requested output exceeds the model's declared limit",
					});
				if (role === "researcher" && (context.tools?.length ?? 0) > 0)
					return yield* new LabRequestError({ failure: "model", message: "Researcher requests cannot declare tools" });
				const inputBytes = Buffer.byteLength(JSON.stringify(context), "utf8");
				const reservedTokens = inputBytes + config.limits.maxOutputTokens + REQUEST_OVERHEAD_TOKENS;
				if (inputBytes > MAX_CONTEXT_BYTES || reservedTokens > model.contextWindow)
					return yield* new LabRequestError({
						failure: "budget",
						message: "Model context exceeds its bounded allowance",
					});
				const at = DateTime.toEpochMillis(yield* DateTime.now);
				const gate = requestGate(state, reservedTokens, at);
				if (!gate.eligible)
					return yield* new LabRequestError({
						failure: "budget",
						message: `Request refused: ${gate.reasons.join("; ")}`,
					});
				const requestId = randomUUID();
				yield* appendLabStoreEvent(store, { id: requestId, at, kind: "request-start", role, reservedTokens });
				if (onReserved !== undefined) yield* Effect.sync(() => onReserved(requestId));
				const beforeCall = DateTime.toEpochMillis(yield* DateTime.now);
				const deadline =
					Math.min(at + config.limits.maxRequestTimeMs, state.started.at + config.limits.maxWallTimeMs) - beforeCall;
				let usage: { tokens: number; costUsd: number } | null = null;
				const observeUsage = (message: AssistantMessage): void => {
					const parsed = decodeUsage(message.usage);
					if (Result.isSuccess(parsed))
						usage = { tokens: parsed.success.totalTokens, costUsd: parsed.success.cost.total };
				};
				const response = yield* Effect.exit(
					restore(
						(deadline <= 0
							? Effect.fail(
									new LabRequestError({ failure: "budget", message: "Request deadline elapsed before dispatch" }),
								)
							: Effect.tryPromise({
									try: async (signal) => {
										const controller = new AbortController();
										try {
											const stream = models.streamSimple(model, context, {
												signal: AbortSignal.any([signal, controller.signal]),
												maxTokens: config.limits.maxOutputTokens,
												timeoutMs: deadline,
												maxRetries: 0,
												maxRetryDelayMs: 1,
												cacheRetention: "none",
											});
											let bytes = 0;
											for await (const event of stream) {
												if (event.type === "done") observeUsage(event.message);
												if (event.type === "error") observeUsage(event.error);
												if (
													event.type === "text_delta" ||
													event.type === "thinking_delta" ||
													event.type === "toolcall_delta"
												) {
													bytes += Buffer.byteLength(event.delta, "utf8");
													if (bytes > MAX_MODEL_RESPONSE_BYTES)
														throw new Error("Model exceeded the streamed output limit");
												}
											}
											const message = await stream.result();
											observeUsage(message);
											if (Buffer.byteLength(JSON.stringify(message), "utf8") > MAX_MODEL_RESPONSE_BYTES)
												throw new Error("Model exceeded the retained output limit");
											if (usage === null) throw new Error("Model response has invalid or unreported usage");
											if (message.provider !== model.provider || message.model !== model.id)
												throw new Error("Response came from a different physical model");
											if (message.stopReason !== "stop" && !(role === "executor" && message.stopReason === "toolUse"))
												throw new Error(`Model did not complete normally: ${message.stopReason}`);
											if (role === "researcher" && message.content.some((block) => block.type === "toolCall"))
												throw new Error("Researcher attempted a tool call");
											return message;
										} finally {
											controller.abort();
										}
									},
									catch: (cause) => new LabRequestError({ failure: "model", message: toError(cause).message }),
								})
						).pipe(
							Effect.timeout(deadline),
							Effect.mapError((error) =>
								error instanceof LabRequestError
									? error
									: new LabRequestError({ failure: "model", message: "Model request timed out" }),
							),
						),
					),
				);
				const current = yield* loadLabStore(store);
				yield* appendLabStoreEvent(store, {
					id: randomUUID(),
					at: Math.max(current.state.lastAt, DateTime.toEpochMillis(yield* DateTime.now)),
					kind: "request-end",
					requestId,
					status: Exit.isSuccess(response) ? "completed" : Cause.hasInterrupts(response.cause) ? "cancelled" : "failed",
					usage,
				});
				if (Exit.isFailure(response)) return yield* Effect.failCause(response.cause);
				return { requestId, message: response.value };
			}),
		),
);
