import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { Effect, Predicate, Result, Schema } from "effect";

import { toError } from "../../support/errors.ts";
import { readFileStringIfExists } from "../../support/fs.ts";
import { parseJson } from "../../support/json.ts";

/** Access level of the hosted search tool, mirroring Codex's `web_search` setting. */
export type WebSearchMode = "disabled" | "cached" | "indexed" | "live";
export type WebSearchContextSize = "low" | "medium" | "high";

export interface WebSearchFilters {
	readonly allowedDomains?: readonly string[];
}

export interface WebSearchUserLocation {
	readonly country?: string;
	readonly region?: string;
	readonly city?: string;
	readonly timezone?: string;
}

const WEB_SEARCH_MODES = ["disabled", "cached", "indexed", "live"] as const;
const webSearchModeSchema = Schema.Literals(WEB_SEARCH_MODES);
const WEB_SEARCH_CONTEXT_SIZES = ["low", "medium", "high"] as const;

export interface CodexWebSearchConfig {
	/** Inject the hosted web search tool at all. */
	readonly enabled: boolean;
	/**
	 * `disabled` omits hosted search; `cached` uses OpenAI's index; `indexed` limits
	 * live access to indexed URLs; `live` may fetch pages.
	 */
	readonly mode: WebSearchMode;
	/**
	 * Client tools dropped from a request that carries the hosted tool, so the model
	 * uses the backend search instead of a same-named client implementation.
	 */
	readonly suppressClientTools: readonly string[];
	/** Optional hosted-search restrictions, matching Codex's Responses tool settings. */
	readonly filters?: WebSearchFilters;
	/** Approximate location used to localize hosted search results. */
	readonly userLocation?: WebSearchUserLocation;
	/** Amount of context the hosted search tool should return. */
	readonly searchContextSize?: WebSearchContextSize;
}

export const DEFAULT_CONFIG: CodexWebSearchConfig = {
	enabled: true,
	mode: "disabled",
	suppressClientTools: ["web_search"],
};

export const CONFIG_PATH_ENV = "PI_CODEX_WEB_SEARCH_CONFIG";
export const CODEX_HOME_ENV = "CODEX_HOME";

/** The config file location, overridable for tests and alternate profiles. */
export function configPath(env: NodeJS.ProcessEnv = process.env): string {
	const override = env[CONFIG_PATH_ENV];
	if (override !== undefined && override.trim().length > 0) return override;
	return join(homedir(), ".pi", "codex-web-search.json");
}

/** Codex's active config file, using the same CODEX_HOME override as the CLI. */
export function codexConfigPath(env: NodeJS.ProcessEnv = process.env): string {
	const codexHome = env[CODEX_HOME_ENV];
	return join(
		codexHome !== undefined && codexHome.trim().length > 0 ? codexHome : join(homedir(), ".codex"),
		"config.toml",
	);
}

export interface LoadedConfig {
	readonly config: CodexWebSearchConfig;
	/** User-facing problems found while loading; a missing file is not one. */
	readonly diagnostics: readonly string[];
}

/** Load Pi's hosted-search overrides and apply Codex's configured access ceiling. */
export function loadConfig(
	path: string = configPath(),
	codexPath: string = codexConfigPath(),
): Effect.Effect<LoadedConfig> {
	return Effect.gen(function* () {
		const raw = yield* readConfigObject(path);
		const diagnostics = raw !== undefined && !raw.ok ? [...raw.diagnostics] : [];
		const codexMode = yield* readCodexWebSearchMode(codexPath, diagnostics);
		const piConfig = raw !== undefined && raw.ok ? raw.value : {};
		const enabled = readBoolean(piConfig.enabled, "enabled", path, diagnostics) ?? DEFAULT_CONFIG.enabled;
		const requestedMode = readMode(piConfig.mode, "mode", path, diagnostics);
		const mode = resolveWebSearchMode(codexMode, requestedMode);
		const suppressClientTools =
			readStringArray(piConfig.suppressClientTools, "suppressClientTools", path, diagnostics) ??
			DEFAULT_CONFIG.suppressClientTools;
		const filters = readFilters(piConfig.filters, path, diagnostics);
		const userLocation = readUserLocation(piConfig.userLocation, path, diagnostics);
		const searchContextSize = readSearchContextSize(piConfig.searchContextSize, path, diagnostics);
		const config: CodexWebSearchConfig = {
			enabled,
			mode,
			suppressClientTools,
			...(filters === undefined ? {} : { filters }),
			...(userLocation === undefined ? {} : { userLocation }),
			...(searchContextSize === undefined ? {} : { searchContextSize }),
		};
		return { config, diagnostics };
	});
}

/** A missing Codex setting leaves Pi's explicit mode in control; otherwise take the stricter mode. */
function resolveWebSearchMode(
	codexMode: WebSearchMode | undefined,
	requestedMode: WebSearchMode | undefined,
): WebSearchMode {
	if (codexMode === undefined) return requestedMode ?? "disabled";
	if (requestedMode === undefined) return codexMode;
	if (codexMode === "disabled" || requestedMode === "disabled") return "disabled";
	if (codexMode === "cached" || requestedMode === "cached") return "cached";
	if (codexMode === "indexed" || requestedMode === "indexed") return "indexed";
	return "live";
}

function readCodexWebSearchMode(path: string, diagnostics: string[]): Effect.Effect<WebSearchMode | undefined> {
	return Effect.gen(function* () {
		const read = yield* Effect.result(readFileStringIfExists(path));
		if (Result.isFailure(read)) {
			diagnostics.push(`${path}: ${toError(read.failure.cause).message}`);
			return "disabled";
		}
		if (read.success === undefined) return undefined;

		try {
			const config = parseToml(read.success);
			if (config.web_search === undefined) return undefined;
			return readMode(config.web_search, "web_search", path, diagnostics) ?? "disabled";
		} catch (cause) {
			diagnostics.push(`${path}: invalid TOML: ${toError(cause).message}`);
			return "disabled";
		}
	});
}

type ConfigObjectRead =
	| { readonly ok: true; readonly value: Record<string, unknown> }
	| { readonly ok: false; readonly diagnostics: readonly string[] };

/** Reading a file that is missing is not a diagnostic; a refused read is. */
type ConfigFileRead =
	| { readonly ok: true; readonly text: string | undefined }
	| { readonly ok: false; readonly diagnostics: readonly string[] };

/** Read the config file as an object; `undefined` when the file does not exist. */
function readConfigObject(path: string): Effect.Effect<ConfigObjectRead | undefined> {
	return Effect.gen(function* () {
		const read = yield* readConfigText(path);
		if (!read.ok) return { ok: false, diagnostics: read.diagnostics };
		if (read.text === undefined) return undefined;
		const parsed = parseJson(read.text, path);
		if (Result.isFailure(parsed)) return { ok: false, diagnostics: [parsed.failure.message] };
		if (!Predicate.isObject(parsed.success)) return { ok: false, diagnostics: [`${path}: expected a JSON object`] };
		return { ok: true, value: parsed.success };
	});
}

function readConfigText(path: string): Effect.Effect<ConfigFileRead> {
	return Effect.gen(function* () {
		return yield* readFileStringIfExists(path).pipe(
			Effect.map((text): ConfigFileRead => ({ ok: true, text })),
			Effect.catchTag("FsError", (error) =>
				Effect.succeed<ConfigFileRead>({ ok: false, diagnostics: [`${path}: ${toError(error.cause).message}`] }),
			),
		);
	});
}

function readBoolean(value: unknown, field: string, path: string, diagnostics: string[]): boolean | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "boolean") return value;
	diagnostics.push(`${path}: "${field}" must be a boolean`);
	return undefined;
}

function readMode(value: unknown, field: string, path: string, diagnostics: string[]): WebSearchMode | undefined {
	if (value === undefined) return undefined;
	const decoded = Schema.decodeUnknownResult(webSearchModeSchema)(value);
	if (Result.isSuccess(decoded)) return decoded.success;
	diagnostics.push(`${path}: "${field}" must be one of ${WEB_SEARCH_MODES.join(", ")}`);
	return undefined;
}

function readStringArray(value: unknown, field: string, path: string, diagnostics: string[]): string[] | undefined {
	if (value === undefined) return undefined;
	if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) return [...value];
	diagnostics.push(`${path}: "${field}" must be an array of strings`);
	return undefined;
}

function readFilters(value: unknown, path: string, diagnostics: string[]): WebSearchFilters | undefined {
	if (value === undefined) return undefined;
	if (!Predicate.isObject(value)) {
		diagnostics.push(`${path}: "filters" must be an object`);
		return undefined;
	}
	const allowedDomains = readStringArray(value.allowedDomains, "filters.allowedDomains", path, diagnostics);
	return allowedDomains === undefined ? undefined : { allowedDomains };
}

function readUserLocation(value: unknown, path: string, diagnostics: string[]): WebSearchUserLocation | undefined {
	if (value === undefined) return undefined;
	if (!Predicate.isObject(value)) {
		diagnostics.push(`${path}: "userLocation" must be an object`);
		return undefined;
	}
	const country = readOptionalString(value.country, "userLocation.country", path, diagnostics);
	const region = readOptionalString(value.region, "userLocation.region", path, diagnostics);
	const city = readOptionalString(value.city, "userLocation.city", path, diagnostics);
	const timezone = readOptionalString(value.timezone, "userLocation.timezone", path, diagnostics);
	if ([country, region, city, timezone].every((field) => field === undefined)) return undefined;
	return {
		...(country === undefined ? {} : { country }),
		...(region === undefined ? {} : { region }),
		...(city === undefined ? {} : { city }),
		...(timezone === undefined ? {} : { timezone }),
	};
}

function readOptionalString(value: unknown, field: string, path: string, diagnostics: string[]): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "string") return value;
	diagnostics.push(`${path}: "${field}" must be a string`);
	return undefined;
}

function readSearchContextSize(value: unknown, path: string, diagnostics: string[]): WebSearchContextSize | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "string") {
		const match = WEB_SEARCH_CONTEXT_SIZES.find((size) => size === value);
		if (match !== undefined) return match;
	}
	diagnostics.push(`${path}: "searchContextSize" must be one of ${WEB_SEARCH_CONTEXT_SIZES.join(", ")}`);
	return undefined;
}
