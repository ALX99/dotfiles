import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Effect, Schema } from "effect";
import { Type } from "typebox";
import { runPromise } from "../_shared/effect-runtime.ts";
import { AttributionSchema, EvidenceInputSchema, ProposalInputSchema } from "./schema.ts";
import { anchorText, anchoredEvidence, contextStore, eventEnvelope, selectedModel } from "./runtime.ts";
import { appendStoreEvent, loadStore } from "./store.ts";
import { activeProcedures } from "./state.ts";

export function registerLearningTools(pi: ExtensionAPI, root?: string): void {
	pi.registerTool({
		name: "harness_evidence",
		label: "Harness evidence",
		description:
			"Record exact, current-branch evidence for a recurring procedural failure, or inspect recent anchors/evidence/candidates. " +
			"Use anchors to discover entry IDs, then record a short exact quote and a behavior such as editing/generated. " +
			"Evidence and proposals are untrusted until the user evaluates and approves them. Do not record secrets. " +
			"This tool cannot configure tests, evaluate, approve, or roll back.",
		parameters: Type.Object(
			{
				action: Type.Union(["anchors", "list", "record"].map((value) => Type.Literal(value))),
				entryId: Type.Optional(Type.String()),
				quote: Type.Optional(Type.String()),
				behavior: Type.Optional(Type.String()),
				attribution: Type.Optional(Type.Union(AttributionSchema.literals.map((value) => Type.Literal(value)))),
			},
			{ additionalProperties: false },
		),
		annotations: { destructiveHint: false, openWorldHint: false },
		execute: (_id, params, signal, _onUpdate, ctx) =>
			runPromise(
				Effect.gen(function* () {
					const input = yield* Schema.decodeUnknownEffect(EvidenceInputSchema, { onExcessProperty: "error" })(params);
					if (input.action === "anchors") {
						const anchors = ctx.sessionManager
							.getBranch()
							.flatMap((entry) => {
								const text = anchorText(entry);
								return text === undefined || text.length === 0
									? []
									: [{ entryId: entry.id, preview: text.slice(0, 600) }];
							})
							.slice(-12);
						return result({ anchors });
					}
					const store = yield* contextStore(pi, ctx, root);
					if (input.action === "record") {
						const { action: _action, ...fields } = input;
						const evidence = yield* anchoredEvidence(ctx, fields);
						const event = { ...(yield* eventEnvelope()), kind: "evidence", evidence };
						yield* appendStoreEvent(store, event);
						return result({ evidenceId: event.id, scope: store.scope, trusted: false });
					}
					const { state } = yield* loadStore(store);
					return result({
						scope: state.scope,
						parentVersion: state.head.id,
						activeCandidateIds: state.head.candidateIds,
						activeProcedures: activeProcedures(state),
						evidence: state.evidence.slice(-12),
						candidates: state.proposals.slice(-10).map((proposal) => ({
							...proposal,
							decision: state.decisions.find((decision) => decision.candidateId === proposal.id) ?? null,
						})),
						// Probe prompts, expected choices and raw evaluation outputs are deliberately not exposed.
					});
				}),
				{ signal },
			),
	});
	pi.registerTool({
		name: "harness_propose",
		label: "Harness proposal",
		description:
			"Propose a bounded repository-scoped procedure backed by harness_evidence IDs from at least two distinct sessions. " +
			"Inspect harness_evidence list for the current parentVersion and active replacement ID (or null). " +
			"Include applicability, action, verification, negative conditions and a causal hypothesis. " +
			"This only stores a candidate; it never enables guidance, edits source, evaluates, or approves.",
		parameters: Type.Object(
			{
				parentVersion: Type.String(),
				replaces: Type.Union([Type.String(), Type.Null()]),
				procedure: Type.Object(
					Object.fromEntries(
						Object.keys(ProposalInputSchema.fields.procedure.fields).map((key) => [key, Type.String()]),
					),
					{ additionalProperties: false },
				),
				hypothesis: Type.String(),
				evidenceIds: Type.Array(Type.String()),
			},
			{ additionalProperties: false },
		),
		annotations: { destructiveHint: false, openWorldHint: false },
		execute: (_id, params, signal, _onUpdate, ctx) =>
			runPromise(
				Effect.gen(function* () {
					const input = yield* Schema.decodeUnknownEffect(ProposalInputSchema, { onExcessProperty: "error" })(params);
					const authorModel = yield* Effect.fromResult(selectedModel(ctx));
					const store = yield* contextStore(pi, ctx, root);
					const event = { ...(yield* eventEnvelope()), kind: "proposal", ...input, authorModel };
					yield* appendStoreEvent(store, event);
					return result({ candidateId: event.id, parentVersion: input.parentVersion, trusted: false });
				}),
				{ signal },
			),
	});
}

function result(details: object) {
	return { content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }], details };
}
