import { Predicate } from "effect";
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
	readonly input?: readonly ("text" | "image")[];
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
	readonly filters?: { readonly allowed_domains: readonly string[] };
	readonly user_location?: {
		readonly type: "approximate";
		readonly country?: string;
		readonly region?: string;
		readonly city?: string;
		readonly timezone?: string;
	};
	readonly search_context_size?: CodexWebSearchConfig["searchContextSize"];
	readonly search_content_types?: readonly ["text", "image"];
}

/** Record keys keep the mode-to-access mapping exhaustive. */
const HOSTED_TOOL_BY_MODE: Record<WebSearchMode, HostedWebSearchTool> = {
	cached: { type: "web_search", external_web_access: false },
	live: { type: "web_search", external_web_access: true },
	indexed: { type: "web_search", external_web_access: true, indexed_web_access: true },
};

/**
 * Add or augment a hosted tool in a built Responses payload, drop the suppressed client
 * tools when adding it, and ask for search sources so the transcript can list them.
 * Returns undefined when this model is not served by the hosted tool or no payload
 * changes are needed.
 */
export function applyHostedWebSearch(
	payload: Record<string, unknown>,
	model: PayloadModel | undefined,
	config: CodexWebSearchConfig,
): Record<string, unknown> | undefined {
	if (model === undefined || !usesHostedWebSearch(model, config)) return undefined;

	const tools = Array.isArray(payload.tools) ? payload.tools : [];
	const include = readInclude(payload.include);
	const hasHostedSearch = tools.some((entry) => Predicate.isObject(entry) && entry.type === "web_search");
	if (hasHostedSearch) {
		return include.includes(SOURCES_INCLUDE) ? undefined : { ...payload, include: [...include, SOURCES_INCLUDE] };
	}

	const suppressed = new Set(config.suppressClientTools);
	const kept = tools.filter(
		(entry) => !(Predicate.isObject(entry) && typeof entry.name === "string" && suppressed.has(entry.name)),
	);
	const hostedTool: HostedWebSearchTool = {
		...HOSTED_TOOL_BY_MODE[config.mode],
		...(config.filters?.allowedDomains === undefined
			? {}
			: { filters: { allowed_domains: [...config.filters.allowedDomains] } }),
		...(config.userLocation === undefined ? {} : { user_location: { type: "approximate", ...config.userLocation } }),
		...(config.searchContextSize === undefined ? {} : { search_context_size: config.searchContextSize }),
		...(model.input?.includes("image") === true ? { search_content_types: ["text", "image"] as const } : {}),
	};
	return {
		...payload,
		tools: [...kept, hostedTool],
		include: include.includes(SOURCES_INCLUDE) ? include : [...include, SOURCES_INCLUDE],
	};
}

function readInclude(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((entry): entry is string => typeof entry === "string");
}
