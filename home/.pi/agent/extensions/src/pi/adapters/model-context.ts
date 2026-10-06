import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { ApplicationEffects } from "../../application.ts";
import type { ProviderRequestTransform } from "../../context/model-context.ts";
import type { NestedContextEvents } from "../../context/nested-instructions/nested-context.ts";
import type { ToolSelection } from "../../integration/tool-selection.ts";
import type { SearchEventHandlers } from "../../openai/search/register.ts";
import nestedContext from "../../context/nested-instructions/nested-context.ts";
import skills from "../../context/skills/register.ts";
import systemPrompt from "../../context/system-prompt/systemprompt.ts";
import openAIServerCompaction from "../../openai/compaction/register.ts";
import codexWebSearch from "../../openai/search/register.ts";

/** Search, compaction replay, instructions, skills, and prompt share one model-context boundary. */
export async function installModelContextAdapter(
	pi: ExtensionAPI,
	dependencies: {
		readonly applicationEffects: ApplicationEffects;
		readonly isClosed: () => boolean;
		readonly providerRequest: (
			payload: unknown,
			context: ExtensionContext,
			transforms: readonly ProviderRequestTransform[],
		) => Promise<unknown>;
		readonly toolSelection: ToolSelection;
	},
): Promise<void> {
	const search = await codexWebSearch(pi, {
		applicationEffects: dependencies.applicationEffects,
		toolSelection: dependencies.toolSelection,
	});
	bindSearchEvents(pi, search.events);
	const compactionTransform = openAIServerCompaction(pi, {
		applicationEffects: dependencies.applicationEffects,
		toolSelection: dependencies.toolSelection,
	});
	const transforms = [search.transform, compactionTransform] as const;

	skills(pi, dependencies.applicationEffects);
	const nested = nestedContext(pi, dependencies.applicationEffects);
	bindNestedContextEvents(pi, nested);
	systemPrompt(pi, dependencies.applicationEffects);

	pi.on("before_provider_request", (event, context) => {
		if (dependencies.isClosed()) return undefined;
		return dependencies.providerRequest(event.payload, context, transforms);
	});
}

/** The ModelContext adapter owns subscriptions for recall/stream state and nested instructions. */
export function bindSearchEvents(pi: ExtensionAPI, events: SearchEventHandlers): void {
	pi.on("session_start", events.sessionStart);
	pi.on("session_shutdown", events.sessionShutdown);
	pi.on("provider_stream_event", events.providerStreamEvent);
	pi.on("session_compact", events.sessionCompact);
	pi.on("before_agent_start", events.beforeAgentStart);
	pi.on("agent_end", events.agentEnd);
}

export function bindNestedContextEvents(pi: ExtensionAPI, events: NestedContextEvents): void {
	pi.on("session_start", events.sessionStart);
	pi.on("session_tree", events.sessionTree);
	pi.on("tool_call", events.toolCall);
}
