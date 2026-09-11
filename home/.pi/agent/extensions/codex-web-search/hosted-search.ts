import { isRecord } from "../_shared/json.ts";
import type { CodexWebSearchConfig, WebSearchMode } from "./config.ts";

/** Responses APIs whose request accepts the hosted `web_search` tool. */
const HOSTED_WEB_SEARCH_APIS: ReadonlySet<string> = new Set(["openai-codex-responses", "openai-responses"]);

/**
 * Providers known to serve those APIs from OpenAI's own backend. The hosted tool runs
 * server-side, so injecting it into a third-party Responses proxy would fail the request.
 */
const HOSTED_WEB_SEARCH_PROVIDERS: ReadonlySet<string> = new Set(["openai-codex", "openai"]);

/** Responses `include` entry that makes the backend report the sources a search used. */
const SOURCES_INCLUDE = "web_search_call.action.sources";

export interface PayloadModel {
	readonly provider: string;
	readonly api: string;
}

/** Whether this provider/model pair should carry the hosted tool. */
export function usesHostedWebSearch(model: PayloadModel, config: CodexWebSearchConfig): boolean {
	return config.enabled && HOSTED_WEB_SEARCH_PROVIDERS.has(model.provider) && HOSTED_WEB_SEARCH_APIS.has(model.api);
}

/** The hosted tool shape Codex sends, mirroring codex-rs `ToolSpec::WebSearch`. */
interface HostedWebSearchTool {
	readonly type: "web_search";
	readonly external_web_access: boolean;
	readonly indexed_web_access?: true;
}

/** Record keys keep the mode-to-access mapping exhaustive. */
const HOSTED_TOOL_BY_MODE: Record<WebSearchMode, HostedWebSearchTool> = {
	cached: { type: "web_search", external_web_access: false },
	live: { type: "web_search", external_web_access: true },
	indexed: { type: "web_search", external_web_access: true, indexed_web_access: true },
};

/**
 * Add the hosted tool to a built Responses payload: drop the suppressed client tools,
 * append `web_search`, and ask for the search sources so the transcript can list them.
 * Returns undefined when this model is not served by the hosted tool or the payload
 * already carries one.
 */
export function applyHostedWebSearch(
	payload: Record<string, unknown>,
	model: PayloadModel | undefined,
	config: CodexWebSearchConfig,
): Record<string, unknown> | undefined {
	if (model === undefined || !usesHostedWebSearch(model, config)) return undefined;

	const tools = Array.isArray(payload.tools) ? payload.tools : [];
	if (tools.some((entry) => isRecord(entry) && entry.type === "web_search")) return undefined;

	const suppressed = new Set(config.suppressClientTools);
	const kept = tools.filter(
		(entry) => !(isRecord(entry) && typeof entry.name === "string" && suppressed.has(entry.name)),
	);
	const include = readInclude(payload.include);
	return {
		...payload,
		tools: [...kept, HOSTED_TOOL_BY_MODE[config.mode]],
		include: include.includes(SOURCES_INCLUDE) ? include : [...include, SOURCES_INCLUDE],
	};
}

function readInclude(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((entry): entry is string => typeof entry === "string");
}
