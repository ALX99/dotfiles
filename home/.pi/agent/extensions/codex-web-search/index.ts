import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { isRecord } from "../_shared/json.ts";
import { createActivityTracker, type SearchSummary } from "./activity.ts";
import { configPath, loadConfig } from "./config.ts";
import { applyHostedWebSearch, usesHostedWebSearch } from "./hosted-search.ts";
import {
	advertisedEntryIds,
	formatRecallDigest,
	formatSearchLog,
	hiddenSearchRecords,
	RECALL_MESSAGE_TYPE,
	RECALL_TOOL_NAME,
	SEARCH_ENTRY_TYPE,
	searchRecords,
} from "./recall.ts";
import { installCodexFrameObserver } from "./websocket-observer.ts";

/**
 * Hosted Codex web search for Pi.
 *
 * Codex does not implement search in its client: it sends the Responses API hosted
 * `web_search` tool (codex-rs `hosted_spec.rs`) and the backend searches inside the model
 * turn, so one request both searches and answers. This extension adds that tool to Codex
 * requests and mirrors Codex's transcript feedback by summarizing the streamed
 * `web_search_call` items.
 *
 * Config lives in `~/.pi/codex-web-search.json` (override with
 * `PI_CODEX_WEB_SEARCH_CONFIG`), all fields optional:
 *
 * ```json
 * {
 *   "enabled": true,
 *   "mode": "live",
 *   "suppressClientTools": ["web_search"]
 * }
 * ```
 *
 * Activity reporting reads WebSocket frames, the transport Pi uses by default; with
 * `"transport": "sse"` the search still runs, only the transcript summary is skipped.
 *
 * Those summaries are recorded as TUI-only entries, so the server-side response chain is the
 * model's only copy of a search until compaction summarizes it away. When that happens the
 * extension advertises the records it still holds and exposes `web_search_log` to read them
 * back; the tool stays out of the tool list until then.
 */
const STATUS_KEY = "codex-web-search";

/** The recall tool takes one optional filter; its description carries the rest. */
const RECALL_PARAMETERS = Type.Object({
	query: Type.Optional(
		Type.String({
			description: "Only list recorded searches whose queries, sources, or opened URLs contain this text.",
		}),
	),
});

export default function codexWebSearchExtension(pi: ExtensionAPI): void {
	const { config, diagnostics } = loadConfig();
	const tracker = createActivityTracker();
	let ctx: ExtensionContext | undefined;
	let disposeObserver: (() => void) | undefined;
	/**
	 * Record ids whose search results this process can no longer reach. Reachability is a property
	 * of the live request chain, not of the record, so it is tracked here rather than derived from
	 * the branch alone.
	 */
	const unreachable = new Set<string>();
	pi.on("session_start", (_event, context) => {
		ctx = context;
		setStatus(context, undefined);
		for (const diagnostic of diagnostics) context.ui.notify(`codex-web-search: ${diagnostic}`, "warning");
		unreachable.clear();
		disposeObserver?.();
		disposeObserver = config.enabled
			? installCodexFrameObserver(context.sessionManager.getSessionId(), handleFrame)
			: undefined;
	});

	/** Every record currently on the branch is now beyond the model's reach. */
	function markUnreachable(context: ExtensionContext): void {
		for (const record of searchRecords(context.sessionManager.getBranch())) unreachable.add(record.entryId);
	}

	pi.on("session_shutdown", () => {
		disposeObserver?.();
		disposeObserver = undefined;
		setStatus(ctx, undefined);
	});

	function handleFrame(frame: unknown): void {
		const outcome = tracker.handle(frame);
		switch (outcome.kind) {
			case "response-started":
				setStatus(ctx, undefined);
				break;
			case "search-started":
				setStatus(ctx, ctx?.ui.theme.fg("accent", "web search…"));
				break;
			case "response-completed":
				setStatus(ctx, undefined);
				if (outcome.summary.callCount > 0) pi.appendEntry<SearchSummary>(SEARCH_ENTRY_TYPE, outcome.summary);
				break;
			case "ignored":
				break;
		}
	}

	pi.on("before_provider_request", (event, context) => {
		ctx = context;
		const payload = event.payload;
		if (!isRecord(payload)) return undefined;
		const model = context.model;
		return applyHostedWebSearch(payload, model, config);
	});

	/**
	 * The recall tool is registered from the start but earns a place in the tool list only once a
	 * recorded search is out of the model's reach, which is the one time it can help. Pi's native
	 * deferred loading needs a loader tool execution to trigger it, so activation here takes the
	 * ordinary path: the definition joins the next request. Minimal mode narrows the selection back
	 * to its core tools every turn, which is why the pointer also names the session file.
	 */
	function applyRecallTool(wanted: boolean): void {
		const active = pi.getActiveTools();
		const present = active.includes(RECALL_TOOL_NAME);
		if (wanted === present) return;
		pi.setActiveTools(wanted ? [...active, RECALL_TOOL_NAME] : active.filter((name) => name !== RECALL_TOOL_NAME));
	}

	pi.on("session_compact", (_event, context) => applyRecallTool(hiddenSearches(context, unreachable).length > 0));

	pi.on("before_agent_start", (_event, context) => {
		// This runs before the turn's first request, so every record already on the branch belongs
		// to an earlier turn. A search reaches the model only through the server-side response
		// chain, which a new prompt may or may not still continue, and that is not observable from
		// here. Announcing the records costs one short message and keeps their sources usable; the
		// alternative is a model that asserts a search returned nothing.
		markUnreachable(context);
		const hidden = hiddenSearches(context, unreachable);
		applyRecallTool(hidden.length > 0);

		// Records already advertised on this branch stay quiet, so a resumed or re-prompted
		// session never repeats itself.
		const advertised = advertisedEntryIds(context.sessionManager.getBranch());
		const fresh = hidden.filter((record) => !advertised.has(record.entryId));
		if (fresh.length === 0) return undefined;
		// Read the live selection rather than assuming activation took effect: minimal mode narrows
		// it, and the digest must not name a tool the model cannot call.
		const toolActive = pi.getActiveTools().includes(RECALL_TOOL_NAME);
		return {
			message: {
				customType: RECALL_MESSAGE_TYPE,
				content: formatRecallDigest(fresh, toolActive),
				display: true,
				details: { entryIds: fresh.map((record) => record.entryId) },
			},
		};
	});

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

	pi.on("agent_end", () => setStatus(ctx, undefined));

	pi.registerEntryRenderer<SearchSummary>(SEARCH_ENTRY_TYPE, (entry, options, theme) => {
		const summary = entry.data;
		if (summary === undefined) return undefined;
		const box = new Box(1, 0, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(theme.fg("accent", searchHeader(summary))));
		if (summary.queries.length > 0) {
			box.addChild(new Text(theme.fg("dim", summary.queries.map((query) => `“${query}”`).join(", "))));
		}
		const shown = options.expanded ? summary.sources : summary.sources.slice(0, 3);
		for (const url of shown) box.addChild(new Text(theme.fg("muted", url)));
		for (const url of options.expanded ? summary.openedUrls : summary.openedUrls.slice(0, 1)) {
			box.addChild(new Text(theme.fg("muted", `opened ${url}`)));
		}
		const hidden = summary.sources.length - shown.length;
		if (hidden > 0) box.addChild(new Text(theme.fg("dim", `+${hidden} more sources (expand)`)));
		return box;
	});

	pi.registerMessageRenderer(RECALL_MESSAGE_TYPE, (message, options, theme) => {
		const details = isRecord(message.details) ? message.details : undefined;
		const recorded = details?.entryIds;
		const count = Array.isArray(recorded) ? recorded.length : 0;
		// The message body is the digest sent to the model; the transcript shows only what changed.
		const label = `${count} earlier web ${count === 1 ? "search" : "searches"} re-sent with sources`;
		return new Text(theme.fg("dim", label), options.outputPad, 0);
	});

	pi.registerCommand("codex-web-search", {
		description: "Show hosted Codex web search status",
		handler: async (_args, commandCtx) => {
			const model = commandCtx.model;
			const target = model === undefined ? "no model" : `${model.provider}/${model.id}`;
			const active = model !== undefined && usesHostedWebSearch(model, config);
			commandCtx.ui.notify(
				`codex-web-search ${active ? "on" : "off"} for ${target} · mode=${config.mode} · config=${configPath()}`,
				"info",
			);
		},
	});
}

/** Search summaries compaction or an unreachable chain has left out of the model's view. */
function hiddenSearches(context: ExtensionContext, unreachable: ReadonlySet<string>) {
	return hiddenSearchRecords(context.sessionManager.getBranch(), unreachable);
}

function setStatus(ctx: ExtensionContext | undefined, text: string | undefined): void {
	ctx?.ui.setStatus(STATUS_KEY, text);
}

function searchHeader(summary: SearchSummary): string {
	const searches = `${summary.callCount} ${summary.callCount === 1 ? "search" : "searches"}`;
	if (summary.sources.length === 0) return `web search · ${searches}`;
	const sources = `${summary.sources.length} ${summary.sources.length === 1 ? "source" : "sources"}`;
	return `web search · ${searches} · ${sources}`;
}
