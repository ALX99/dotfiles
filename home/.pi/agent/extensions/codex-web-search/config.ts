import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { hasNodeErrorCode, toError } from "../_shared/errors.ts";
import { isRecord, parseJson } from "../_shared/json.ts";

/** Access level of the hosted search tool, mirroring Codex's `web_search` setting. */
export type WebSearchMode = "cached" | "live" | "indexed";

const WEB_SEARCH_MODES = ["cached", "live", "indexed"] as const;

export interface CodexWebSearchConfig {
	/** Inject the hosted web search tool at all. */
	readonly enabled: boolean;
	/**
	 * `cached` keeps the search inside OpenAI's index, `live` may fetch pages, and
	 * `indexed` restricts live fetches to URLs the index already knows.
	 */
	readonly mode: WebSearchMode;
	/**
	 * Client tools dropped from a request that carries the hosted tool, so the model
	 * uses the backend search instead of a same-named client implementation.
	 */
	readonly suppressClientTools: readonly string[];
}

export const DEFAULT_CONFIG: CodexWebSearchConfig = {
	enabled: true,
	mode: "live",
	suppressClientTools: ["web_search"],
};

export const CONFIG_PATH_ENV = "PI_CODEX_WEB_SEARCH_CONFIG";

/** The config file location, overridable for tests and alternate profiles. */
export function configPath(env: NodeJS.ProcessEnv = process.env): string {
	const override = env[CONFIG_PATH_ENV];
	if (override !== undefined && override.trim().length > 0) return override;
	return join(homedir(), ".pi", "codex-web-search.json");
}

export interface LoadedConfig {
	readonly config: CodexWebSearchConfig;
	/** User-facing problems found while loading; a missing file is not one. */
	readonly diagnostics: readonly string[];
}

/**
 * Load `~/.pi/codex-web-search.json`. Every field is optional, and an invalid field
 * falls back to its default with a diagnostic rather than disabling the extension.
 */
export function loadConfig(path: string = configPath()): LoadedConfig {
	const raw = readConfigObject(path);
	if (raw === undefined) return { config: DEFAULT_CONFIG, diagnostics: [] };
	if (!raw.ok) return { config: DEFAULT_CONFIG, diagnostics: raw.diagnostics };

	const diagnostics: string[] = [];
	const config: CodexWebSearchConfig = {
		enabled: readBoolean(raw.value.enabled, "enabled", path, diagnostics) ?? DEFAULT_CONFIG.enabled,
		mode: readMode(raw.value.mode, path, diagnostics) ?? DEFAULT_CONFIG.mode,
		suppressClientTools:
			readStringArray(raw.value.suppressClientTools, "suppressClientTools", path, diagnostics) ??
			DEFAULT_CONFIG.suppressClientTools,
	};
	return { config, diagnostics };
}

type ConfigObjectRead =
	| { readonly ok: true; readonly value: Record<string, unknown> }
	| { readonly ok: false; readonly diagnostics: readonly string[] };

/** Read the config file as an object; `undefined` when the file does not exist. */
function readConfigObject(path: string): ConfigObjectRead | undefined {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (cause) {
		if (hasNodeErrorCode(cause, "ENOENT")) return undefined;
		return { ok: false, diagnostics: [`${path}: ${toError(cause).message}`] };
	}
	const parsed = parseJson(text, path);
	if (!parsed.ok) return { ok: false, diagnostics: [parsed.diagnostic.message] };
	if (!isRecord(parsed.value)) return { ok: false, diagnostics: [`${path}: expected a JSON object`] };
	return { ok: true, value: parsed.value };
}

function readBoolean(value: unknown, field: string, path: string, diagnostics: string[]): boolean | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "boolean") return value;
	diagnostics.push(`${path}: "${field}" must be a boolean`);
	return undefined;
}

function readMode(value: unknown, path: string, diagnostics: string[]): WebSearchMode | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "string") {
		const match = WEB_SEARCH_MODES.find((mode) => mode === value);
		if (match !== undefined) return match;
	}
	diagnostics.push(`${path}: "mode" must be one of ${WEB_SEARCH_MODES.join(", ")}`);
	return undefined;
}

function readStringArray(value: unknown, field: string, path: string, diagnostics: string[]): string[] | undefined {
	if (value === undefined) return undefined;
	if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) return [...value];
	diagnostics.push(`${path}: "${field}" must be an array of strings`);
	return undefined;
}
