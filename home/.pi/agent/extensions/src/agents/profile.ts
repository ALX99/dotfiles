import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { Effect, Result, Schema } from "effect";
import { basename, join } from "node:path";

import { readDirectoryFileNamesIfExists, readFileString, readFileStringIfExists } from "../support/fs.ts";

type ProfileFrontmatter = {
	model?: unknown;
	tools?: unknown;
	skills?: unknown;
	spawn_profiles?: unknown;
};

const PROFILE_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

const profileNameSchema = Schema.String.check(
	Schema.makeFilter((value) =>
		PROFILE_NAME_PATTERN.test(value) ? undefined : "must use lowercase letters, numbers, and single hyphens",
	),
);

const nonBlankText = Schema.String.check(
	Schema.isMinLength(1),
	Schema.makeFilter((value) => (value.trim().length > 0 ? undefined : "must not be blank")),
);

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const thinkingLevelSchema = Schema.Literals(THINKING_LEVELS);
export type ProfileThinkingLevel = (typeof THINKING_LEVELS)[number];

function parseModelReference(
	value: string,
): { readonly provider: string; readonly id: string; readonly thinkingLevel?: ProfileThinkingLevel } | undefined {
	const levelSeparator = value.lastIndexOf(":");
	const reference = levelSeparator < 0 ? value : value.slice(0, levelSeparator);
	const thinkingLevel = levelSeparator < 0 ? undefined : value.slice(levelSeparator + 1);
	const separator = reference.indexOf("/");
	if (separator <= 0 || separator >= reference.length - 1 || /\s/u.test(reference)) return undefined;
	const decodedThinkingLevel =
		thinkingLevel === undefined ? undefined : Schema.decodeUnknownResult(thinkingLevelSchema)(thinkingLevel);
	if (decodedThinkingLevel !== undefined && Result.isFailure(decodedThinkingLevel)) return undefined;

	return {
		provider: reference.slice(0, separator),
		id: reference.slice(separator + 1),
		...(decodedThinkingLevel === undefined || Result.isFailure(decodedThinkingLevel)
			? {}
			: { thinkingLevel: decodedThinkingLevel.success }),
	};
}

const modelReference = Schema.String.check(
	Schema.makeFilter((value) => {
		return parseModelReference(value) !== undefined
			? undefined
			: "must use provider/model-id with an optional supported :thinking-level suffix";
	}),
);

const toolName = nonBlankText.check(
	Schema.makeFilter((value) => (!/\s/u.test(value) ? undefined : "must not contain whitespace")),
);

const uniqueNames = (values: readonly string[]) =>
	new Set(values).size === values.length ? undefined : "must not contain duplicates";

export const ProfileSnapshotSchema = Schema.Struct({
	name: profileNameSchema,
	model: Schema.Struct({
		provider: nonBlankText,
		id: nonBlankText,
	}),
	thinkingLevel: Schema.optionalKey(thinkingLevelSchema),
	prompt: nonBlankText,
	tools: Schema.optionalKey(Schema.Array(toolName).check(Schema.makeFilter(uniqueNames))),
	skills: Schema.optionalKey(Schema.Array(profileNameSchema).check(Schema.makeFilter(uniqueNames))),
	spawnProfiles: Schema.optionalKey(Schema.Array(profileNameSchema).check(Schema.makeFilter(uniqueNames))),
	sourcePath: Schema.String,
});

const profileFrontmatterSchema = Schema.Struct({
	model: modelReference,
	tools: Schema.optionalKey(Schema.Array(toolName).check(Schema.makeFilter(uniqueNames))),
	skills: Schema.optionalKey(Schema.Array(profileNameSchema).check(Schema.makeFilter(uniqueNames))),
	spawn_profiles: Schema.optionalKey(Schema.Array(profileNameSchema).check(Schema.makeFilter(uniqueNames))),
});

export class ProfileError extends Schema.TaggedError<ProfileError>()("ProfileError", {
	path: Schema.String,
	message: Schema.String,
}) {}

export interface ProfileModelLookup {
	find(provider: string, modelId: string): unknown;
}

export interface ProfileSnapshot {
	readonly name: string;
	readonly model: {
		readonly provider: string;
		readonly id: string;
	};
	readonly thinkingLevel?: ProfileThinkingLevel;
	readonly prompt: string;
	/** Omitted means unrestricted; an empty array permits no tools. */
	readonly tools?: readonly string[];
	/** Omitted means unrestricted; an empty array permits no skills. */
	readonly skills?: readonly string[];
	/** Omitted means any child profile is allowed; an empty array permits no child profiles. */
	readonly spawnProfiles?: readonly string[];
	readonly sourcePath: string;
}

export interface ProfileDiagnostic {
	readonly path: string;
	readonly message: string;
}

export interface ProfileDiscovery {
	readonly profiles: readonly ProfileSnapshot[];
	readonly diagnostics: readonly ProfileDiagnostic[];
}

export function profilesDirectory(agentDir = getAgentDir()): string {
	return join(agentDir, "profiles");
}

/** Parse and validate one profile without retaining mutable frontmatter data. */
export function parseProfile(
	name: string,
	sourcePath: string,
	content: string,
	models: ProfileModelLookup,
): Result.Result<ProfileSnapshot, ProfileError> {
	const decodedName = Schema.decodeUnknownResult(profileNameSchema)(name);
	if (Result.isFailure(decodedName)) {
		return Result.fail(profileError(sourcePath, `Invalid profile name "${name}": ${String(decodedName.failure)}`));
	}

	let parsed: ReturnType<typeof parseFrontmatter<ProfileFrontmatter>>;
	try {
		parsed = parseFrontmatter<ProfileFrontmatter>(content);
	} catch (cause) {
		return Result.fail(profileError(sourcePath, `Could not parse profile frontmatter: ${errorMessage(cause)}`));
	}

	const decoded = Schema.decodeUnknownResult(profileFrontmatterSchema)(parsed.frontmatter);
	if (Result.isFailure(decoded)) {
		return Result.fail(profileError(sourcePath, `Invalid profile frontmatter: ${String(decoded.failure)}`));
	}

	const prompt = parsed.body.trim();
	if (prompt.length === 0) {
		return Result.fail(profileError(sourcePath, "Profile prompt fragment must not be empty."));
	}

	const model = parseModelReference(decoded.success.model);
	if (model === undefined) {
		return Result.fail(
			profileError(
				sourcePath,
				"Profile model must use provider/model-id with a supported optional :thinking-level suffix.",
			),
		);
	}
	const { provider, id, thinkingLevel } = model;
	if (models.find(provider, id) === undefined) {
		return Result.fail(profileError(sourcePath, `Unknown profile model "${provider}/${id}".`));
	}

	return Result.succeed(
		Object.freeze({
			name: decodedName.success,
			model: Object.freeze({ provider, id }),
			...(thinkingLevel === undefined ? {} : { thinkingLevel }),
			prompt,
			...(decoded.success.tools === undefined ? {} : { tools: Object.freeze([...decoded.success.tools]) }),
			...(decoded.success.skills === undefined ? {} : { skills: Object.freeze([...decoded.success.skills]) }),
			...(decoded.success.spawn_profiles === undefined
				? {}
				: { spawnProfiles: Object.freeze([...decoded.success.spawn_profiles]) }),
			sourcePath,
		}),
	);
}

/** Resolve a named profile from the user's profile directory. */
export function loadProfile(
	name: string,
	models: ProfileModelLookup,
	directory = profilesDirectory(),
): Effect.Effect<ProfileSnapshot, ProfileError | import("../support/errors.ts").FsError> {
	const path = join(directory, `${name}.md`);
	const decodedName = Schema.decodeUnknownResult(profileNameSchema)(name);
	if (Result.isFailure(decodedName)) {
		return Effect.fail(profileError(path, `Invalid profile name "${name}": ${String(decodedName.failure)}`));
	}

	return Effect.gen(function* () {
		const content = yield* readFileString(path);
		const parsed = parseProfile(name, path, content, models);
		if (Result.isFailure(parsed)) return yield* Effect.fail(parsed.failure);
		return parsed.success;
	});
}

/** Invalid profile files are reported and skipped; a missing profile directory is empty. */
export function discoverProfiles(
	models: ProfileModelLookup,
	directory = profilesDirectory(),
): Effect.Effect<ProfileDiscovery, import("../support/errors.ts").FsError> {
	return Effect.gen(function* () {
		const entries = yield* readDirectoryFileNamesIfExists(directory, { includeSymlinkedFiles: true });
		if (entries === undefined) return { profiles: [], diagnostics: [] };

		const profileFiles = entries.filter((entry) => entry.endsWith(".md")).toSorted();
		const loaded = yield* Effect.forEach(
			profileFiles,
			(fileName) =>
				Effect.gen(function* () {
					const path = join(directory, fileName);
					const content = yield* readFileStringIfExists(path);
					if (content === undefined) return { profile: undefined, diagnostic: undefined };

					const name = basename(fileName, ".md");
					const parsed = parseProfile(name, path, content, models);
					if (Result.isFailure(parsed)) {
						return {
							profile: undefined,
							diagnostic: { path, message: parsed.failure.message },
						};
					}
					return { profile: parsed.success, diagnostic: undefined };
				}),
			{ concurrency: "unbounded" },
		);

		return {
			profiles: loaded.flatMap(({ profile }) => (profile === undefined ? [] : [profile])),
			diagnostics: loaded.flatMap(({ diagnostic }) => (diagnostic === undefined ? [] : [diagnostic])),
		};
	});
}

function profileError(path: string, message: string): ProfileError {
	return new ProfileError({ path, message: `${path}: ${message}` });
}

function errorMessage(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}
