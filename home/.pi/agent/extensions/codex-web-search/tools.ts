import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { formatSearchLog, RECALL_TOOL_NAME, searchRecords } from "./recall.ts";

/** The recall tool takes one optional filter; its description carries the rest. */
const RECALL_PARAMETERS = Type.Object({
	query: Type.Optional(
		Type.String({
			description: "Only list recorded searches whose queries, sources, or opened URLs contain this text.",
		}),
	),
});

export function registerRecallTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: RECALL_TOOL_NAME,
		label: "Web Search Log",
		description:
			"List the web searches recorded earlier in this session, with their source URLs. Use it when you need a source from before a compaction, or before repeating a search.",
		parameters: RECALL_PARAMETERS,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, toolContext) {
			const records = searchRecords(toolContext.sessionManager.getBranch());
			return {
				content: [{ type: "text", text: formatSearchLog(records, params.query) }],
				details: { searches: records.length },
			};
		},
	});
}
