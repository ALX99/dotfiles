import { getAgentDir, type ExtensionAPI, type InputEvent } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import type { ChildExecutionContext } from "./child-process.ts";
import {
	ACCEPTED_CONTEXT_CUSTOM_TYPE,
	acceptedContextData,
	parseContextMarker,
	readContextArtifact,
	type ContextArtifactMetadata,
} from "./context-artifacts.ts";
import { createResultPageData, RESULT_PAGE_CUSTOM_TYPE, RESULT_PAGE_MAX_BYTES } from "./result-store.ts";

const SubmitAgentResultParamsSchema = Type.Object(
	{
		page_index: Type.Integer({
			minimum: 0,
			description: "Zero-based page index. Start at 0 and increment by exactly one.",
		}),
		page: Type.String({
			maxLength: RESULT_PAGE_MAX_BYTES,
			description: `The next exact result chunk. Its UTF-8 encoding must be at most ${RESULT_PAGE_MAX_BYTES} bytes.`,
		}),
		final: Type.Boolean({
			description: "True only for the last page. Concatenating every page must reproduce the exact result.",
		}),
	},
	{ additionalProperties: false },
);

type SubmitAgentResultParams = Static<typeof SubmitAgentResultParamsSchema>;

export function registerChildExecutionRuntime(
	pi: ExtensionAPI,
	context: ChildExecutionContext,
	options: { readonly agentDir?: string } = {},
): void {
	let active: ContextArtifactMetadata | undefined;

	pi.on("input", async (event) => {
		if (event.source !== "rpc" || parseContextMarker(event.text) === undefined) {
			return { action: "continue" };
		}
		const artifact = await readContextArtifact(event.text, options.agentDir ?? getAgentDir());
		assertAcceptedContext(event, context, active, artifact.metadata);
		active = artifact.metadata;
		pi.appendEntry(
			ACCEPTED_CONTEXT_CUSTOM_TYPE,
			acceptedContextData(artifact.metadata, {
				agent: context.agent,
				profile: context.profile,
				...(context.parentSessionId === undefined ? {} : { parentSessionId: context.parentSessionId }),
			}),
		);
		return { action: "transform", text: artifact.content };
	});

	pi.registerTool({
		name: "submit_agent_result",
		label: "Submit Agent Result",
		description:
			`Persist one exact terminal-result page. Each page is a transport chunk of at most ${RESULT_PAGE_MAX_BYTES} UTF-8 bytes, not a semantic result limit. ` +
			"Call once per turn in increasing page_index order; set final=true only on the last page.",
		parameters: SubmitAgentResultParamsSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params: SubmitAgentResultParams, _signal, _onUpdate, ctx) {
			if (!active) throw new Error("No validated parent context marker is active for this result.");
			const page = createResultPageData(ctx.sessionManager.getBranch(), {
				generation: active.generation,
				resultId: active.resultId,
				pageIndex: params.page_index,
				page: params.page,
				final: params.final,
			});
			pi.appendEntry(RESULT_PAGE_CUSTOM_TYPE, page);
			return {
				content: [
					{
						type: "text",
						text: params.final
							? `Stored final result page ${params.page_index}.`
							: `Stored result page ${params.page_index}; submit page ${params.page_index + 1} next.`,
					},
				],
				details: {
					generation: page.generation,
					resultId: page.resultId,
					pageIndex: page.pageIndex,
					final: page.final,
					pageBytes: page.pageBytes,
					totalBytes: page.totalBytes,
					totalSha256: page.totalSha256,
				},
				terminate: params.final,
			};
		},
	});
}

function assertAcceptedContext(
	event: InputEvent,
	context: ChildExecutionContext,
	active: ContextArtifactMetadata | undefined,
	incoming: ContextArtifactMetadata,
): void {
	if (context.agentId !== undefined && incoming.agentId !== context.agentId) {
		throw new Error("Subagent context artifact belongs to a different child.");
	}
	if (context.parentSessionId !== undefined && incoming.parentSessionId !== context.parentSessionId) {
		throw new Error("Subagent context artifact belongs to a different parent session.");
	}
	const allowedKinds =
		event.streamingBehavior === "steer"
			? new Set(["steer"])
			: event.streamingBehavior === "followUp"
				? new Set(["followup"])
				: new Set(["assignment", "followup", "fallback"]);
	if (!allowedKinds.has(incoming.kind)) {
		throw new Error(
			`Subagent context kind '${incoming.kind}' is invalid for ${event.streamingBehavior ?? "an idle prompt"}.`,
		);
	}
	if (incoming.kind === "steer" && active === undefined) {
		throw new Error("A subagent steer context cannot precede its assignment.");
	}
	if (active === undefined) return;
	if (incoming.generation < active.generation) {
		throw new Error("Subagent context generation moved backwards.");
	}
	if (incoming.generation === active.generation && incoming.resultId !== active.resultId) {
		throw new Error("Subagent context changed result identity within one generation.");
	}
}
