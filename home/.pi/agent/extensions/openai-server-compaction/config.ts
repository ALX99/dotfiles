import { homedir } from "node:os";
import { join } from "node:path";
import { Effect, Predicate, Result } from "effect";

import { toError } from "../_shared/errors.ts";
import { readFileStringIfExists } from "../_shared/fs.ts";
import { parseJson } from "../_shared/json.ts";

/**
 * The one setting this extension has. Everything else it acts on, the model, the
 * credential behind it, and Pi's own compaction behaviour, it derives from the
 * session, so there is nothing else to keep consistent.
 */
export interface OpenAIServerCompactionConfig {
	readonly enabled: boolean;
}

export const DEFAULT_CONFIG: OpenAIServerCompactionConfig = { enabled: true };

export interface LoadedConfig {
	readonly config: OpenAIServerCompactionConfig;
	/** User-facing problems found while loading; a missing file is not one. */
	readonly diagnostics: readonly string[];
}

/** The global config file, which a project-local file of the same name overrides. */
export function globalConfigPath(): string {
	return join(homedir(), ".pi", "agent", "openai-server-compaction.json");
}

/** The project-local config file, relative to the session's working directory. */
export function projectConfigPath(cwd: string): string {
	return join(cwd, ".pi", "openai-server-compaction.json");
}

/**
 * Load the extension config from the global file, the project file, and the environment,
 * in increasing precedence. An unusable value falls back to the default with a diagnostic
 * rather than disabling the extension.
 */
export function loadConfig(cwd: string, env: NodeJS.ProcessEnv = process.env): Effect.Effect<LoadedConfig> {
	return Effect.gen(function* () {
		const diagnostics: string[] = [];
		const global = yield* readConfigFile(globalConfigPath(), diagnostics);
		const project = yield* readConfigFile(projectConfigPath(cwd), diagnostics);
		const enabled =
			readBoolean(env.PI_OPENAI_SERVER_COMPACTION_ENABLED, "PI_OPENAI_SERVER_COMPACTION_ENABLED", diagnostics) ??
			project.enabled ??
			global.enabled ??
			DEFAULT_CONFIG.enabled;
		return { config: { enabled }, diagnostics };
	});
}

/** Read one config file; a missing file contributes nothing and a refused read is a diagnostic. */
function readConfigFile(path: string, diagnostics: string[]): Effect.Effect<{ enabled?: boolean }> {
	return Effect.gen(function* () {
		const read = yield* Effect.result(readFileStringIfExists(path));
		if (Result.isFailure(read)) {
			diagnostics.push(`${path}: ${toError(read.failure.cause).message}`);
			return {};
		}
		const text = read.success;
		if (text === undefined) return {};
		const parsed = parseJson(text, path);
		if (Result.isFailure(parsed)) {
			diagnostics.push(parsed.failure.message);
			return {};
		}
		if (!Predicate.isObject(parsed.success)) {
			diagnostics.push(`${path}: expected a JSON object`);
			return {};
		}
		const enabled = readBoolean(parsed.success.enabled, "enabled", diagnostics, path);
		return enabled === undefined ? {} : { enabled };
	});
}

/** Accept a boolean, or the string and number spellings a shell environment produces. */
function readBoolean(value: unknown, field: string, diagnostics: string[], path?: string): boolean | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "boolean") return value;
	if (typeof value === "number") return value !== 0;
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (["1", "true", "yes", "on"].includes(normalized)) return true;
		if (["0", "false", "no", "off"].includes(normalized)) return false;
	}
	diagnostics.push(`${path === undefined ? field : `${path}: "${field}"`} must be a boolean`);
	return undefined;
}
