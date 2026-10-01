import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Effect, Predicate, Schema } from "effect";
import { runPromise } from "../_shared/effect-runtime.ts";
import { registerHarnessCommand } from "./commands.ts";
import { contextStore, selectedModel } from "./runtime.ts";
import { renderGuidance } from "./procedures.ts";
import { modelProcedures } from "./state.ts";
import { loadStore } from "./store.ts";
import { registerLearningTools } from "./tools.ts";

const RESPONSE_APIS = ["openai-responses", "openai-codex-responses", "azure-openai-responses"];
const decodeInstructions = Schema.decodeUnknownResult(
	Schema.Struct({
		input: Schema.Unknown,
		instructions: Schema.optional(Schema.String),
	}),
	{ onExcessProperty: "ignore" },
);

export default function harnessLearningExtension(pi: ExtensionAPI): void {
	registerHarnessLearning(pi);
}

/** A separate storage root keeps integration tests away from the installed learning history. */
export function registerHarnessLearning(pi: ExtensionAPI, root?: string): void {
	registerLearningTools(pi, root);
	registerHarnessCommand(pi, root);
	pi.on("context", (event, ctx) =>
		runPromise(
			Effect.gen(function* () {
				if (RESPONSE_APIS.includes(ctx.model?.api ?? "")) return undefined;
				const guidance = yield* contextGuidance(pi, ctx, root);
				if (guidance.length === 0) return undefined;
				// Request-local only: neither session replay nor compaction can retain a rolled-back instruction.
				return {
					messages: [
						...event.messages,
						{
							role: "custom" as const,
							customType: "harness-learning:guidance",
							content: guidance,
							display: false,
							timestamp: 0,
						},
					],
				};
			}),
			{ signal: ctx.signal },
		),
	);
	pi.on("before_provider_request", (event, ctx) =>
		runPromise(
			Effect.gen(function* () {
				if (!RESPONSE_APIS.includes(ctx.model?.api ?? "")) return undefined;
				if (!Predicate.isObject(event.payload) || !("input" in event.payload) || "messages" in event.payload)
					return undefined;
				const parsed = yield* Effect.fromResult(decodeInstructions(event.payload));
				const guidance = yield* contextGuidance(pi, ctx, root);
				if (guidance.length === 0) return undefined;
				// Responses history replay replaces input, but preserves these request-local instructions.
				return { ...event.payload, instructions: [parsed.instructions, guidance].filter(Boolean).join("\n\n") };
			}),
			{ signal: ctx.signal },
		),
	);
}

const contextGuidance = Effect.fn("harnessLearning.contextGuidance")(function* (
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	root?: string,
) {
	if (ctx.model === undefined) return "";
	const model = yield* Effect.fromResult(selectedModel(ctx));
	const store = yield* contextStore(pi, ctx, root);
	const { state } = yield* loadStore(store);
	return renderGuidance(modelProcedures(state, model));
});
