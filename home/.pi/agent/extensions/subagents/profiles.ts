/** Subagent execution-profile configuration and deterministic model resolution. */

import * as path from "node:path";
import { getAgentDir, type ScopedModel } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels, type Api, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { Effect, Result, Schema } from "effect";
import { readFileString } from "../_shared/fs.ts";
import { parseJson } from "../_shared/json.ts";
import { formatSchemaFailure } from "../_shared/schema-issues.ts";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const ThinkingLevelSchema = Schema.Literals(THINKING_LEVELS);

/** A non-empty, unmodified identifier. Configuration must not hide whitespace typos. */
const nonEmptyString = (label: string) =>
	Schema.String.check(
		Schema.isMinLength(1, { message: `${label} must not be empty` }),
		Schema.makeFilter((value: string) =>
			value.trim() === value ? undefined : `${label} must not be empty or contain leading/trailing whitespace`,
		),
	);

const configKey = (label: string) =>
	Schema.String.check(
		Schema.isMinLength(1, { message: `${label} must not be empty` }),
		Schema.makeFilter((value: string) =>
			/[\s\p{C}]/u.test(value) ? `${label} must not contain whitespace or control characters` : undefined,
		),
	);

const ModelIdSchema = configKey("model id").check(
	Schema.makeFilter((id: string) => {
		const slash = id.indexOf("/");
		return slash > 0 && slash < id.length - 1 ? undefined : "model id must be provider/model-id";
	}),
);

const ModelCandidateSchema = Schema.Struct({
	id: ModelIdSchema,
	/** The omitted-request default and lowest permitted explicit override. */
	defaultThinking: ThinkingLevelSchema,
	maxThinking: ThinkingLevelSchema,
}).check(
	Schema.makeFilter((candidate) =>
		thinkingRank(candidate.defaultThinking) > thinkingRank(candidate.maxThinking)
			? [{ path: ["defaultThinking"], issue: "defaultThinking must not exceed maxThinking" }]
			: undefined,
	),
);

const ProfileSchema = Schema.Struct({
	description: nonEmptyString("description"),
	modelPriority: Schema.Array(ModelCandidateSchema).check(
		Schema.isMinLength(1, { message: "modelPriority must contain at least one candidate" }),
	),
});

const AgentPolicySchema = Schema.Struct({
	defaultProfile: configKey("defaultProfile"),
	allowedProfiles: Schema.Array(configKey("allowedProfiles item")).check(
		Schema.isMinLength(1, { message: "allowedProfiles must contain at least one profile" }),
	),
});

const RootPolicySchema = Schema.Struct({
	maxConcurrentRootAgents: Schema.Int.check(
		Schema.isGreaterThanOrEqualTo(1, { message: "maxConcurrentRootAgents must be at least 1" }),
	),
});

/** Record keys carry configuration names, so they are rejected on the same rules as values. */
const keyedRecord = <Value extends Schema.Constraint>(label: string, value: Value) =>
	Schema.Record(Schema.String, value).check(
		Schema.makeFilter((record: Readonly<Record<string, unknown>>) => {
			const issues = Object.keys(record).flatMap((key) =>
				key.length === 0 || /[\s\p{C}]/u.test(key)
					? [{ path: [key], issue: `${label} must not contain whitespace or control characters` }]
					: [],
			);
			return issues.length ? issues : undefined;
		}),
	);

export const ProfilesSchema = Schema.Struct({
	rootPolicy: RootPolicySchema,
	profiles: keyedRecord("profile name", ProfileSchema),
	agentPolicies: keyedRecord("agent name", AgentPolicySchema),
	/** Optional weakest-to-strongest ordering used only for capability-hint wording. Unlisted models degrade to neutral advice. */
	capabilityRanking: Schema.optional(Schema.Array(ModelIdSchema)),
});

export type ProfilesConfig = Schema.Schema.Type<typeof ProfilesSchema>;

export interface NamedAgent {
	name: string;
}

/** Problems that stop subagents from starting, tagged by whether JSON or its contents were rejected. */
export interface ProfileIssues {
	readonly kind: "parse" | "validation";
	readonly errors: readonly string[];
}

/** The profile file could not be read at all. */
export class ProfilesFileError extends Schema.TaggedError<ProfilesFileError>()("ProfilesFileError", {
	filePath: Schema.String,
	cause: Schema.Defect(),
	errors: Schema.Array(Schema.String),
}) {}

/** The profile file was read but rejected. */
export class ProfilesInvalidError extends Schema.TaggedError<ProfilesInvalidError>()("ProfilesInvalidError", {
	filePath: Schema.String,
	issues: Schema.Struct({
		kind: Schema.Literals(["parse", "validation"]),
		errors: Schema.Array(Schema.String),
	}),
}) {}

export type ProfilesConfigError = ProfilesFileError | ProfilesInvalidError;

/** The configuration fixed for an in-process child session. This object is frozen before return. */
export interface ResolvedRun {
	readonly agent: string;
	readonly profile: string;
	readonly model: string;
	/** Native SDK model selected from the parent's authenticated scope. */
	readonly modelInstance: Model<Api>;
	readonly effectiveThinking: ModelThinkingLevel;
	readonly contextWindow: number;
}

export interface ResolveRunOptions {
	config: ProfilesConfig;
	modelRegistry: AvailableModelRegistry;
	scopedModels?: readonly ScopedModel[];
	agent: string | NamedAgent;
	profile?: string;
	requestedThinking?: ModelThinkingLevel;
}

export interface AvailableModelRegistry {
	getAvailable(): readonly Model<Api>[];
}

/** Why a spawn could not be resolved to a model, before any session is created. */
export const RunResolutionReason = Schema.Literals([
	"missing_agent_policy",
	"profile_not_allowed",
	"unknown_profile",
	"no_authenticated_model",
	"unknown_thinking_level",
	"thinking_below_minimum",
	"thinking_above_cap",
	"no_supported_thinking",
]);
export type RunResolutionReason = Schema.Schema.Type<typeof RunResolutionReason>;

/** A rejected spawn configuration; `message` is the text a tool reports. */
export class RunResolutionError extends Schema.TaggedError<RunResolutionError>()("RunResolutionError", {
	reason: RunResolutionReason,
	agent: Schema.String,
	message: Schema.String,
}) {}

// Every failing field is reported, so one startup pass can fix the whole file.
const decodeProfiles = Schema.decodeUnknownResult(ProfilesSchema, { onExcessProperty: "error", errors: "all" });

/** Location used for ordinary extension startup; never resolve from process.cwd(). */
export function profilesPath(): string {
	return path.join(getAgentDir(), "extensions", "subagents", "profiles.json");
}

/** Parse JSON and its strict structural schema, keeping every issue and its path. */
export function parseProfilesJson(
	input: unknown,
	filePath = "profiles.json",
): Result.Result<ProfilesConfig, ProfileIssues> {
	let value: unknown = input;
	if (typeof input === "string") {
		const parsedJson = parseJson(input, filePath);
		if (Result.isFailure(parsedJson)) {
			return Result.fail({ kind: "parse", errors: [parsedJson.failure.message] });
		}
		value = parsedJson.success;
	}
	const decoded = decodeProfiles(value);
	return Result.isFailure(decoded)
		? Result.fail({ kind: "validation", errors: formatSchemaFailure(filePath, decoded.failure) })
		: Result.succeed(decoded.success);
}

/**
 * Validate relationships that the structural schema cannot express. All errors are
 * accumulated so a bad startup configuration is corrected in one pass.
 */
export function validateProfiles(
	config: ProfilesConfig,
	agents: Iterable<string | NamedAgent> = [],
	filePath = "profiles.json",
): string[] {
	const errors: string[] = [];
	const profileNames = new Set(Object.keys(config.profiles));
	const agentNames = new Set<string>();
	for (const agent of agents) agentNames.add(typeof agent === "string" ? agent : agent.name);

	for (const [profileName, profile] of Object.entries(config.profiles)) {
		const candidates = new Map<string, number>();
		for (const [index, candidate] of profile.modelPriority.entries()) {
			const previous = candidates.get(candidate.id);
			if (previous !== undefined) {
				errors.push(
					`${filePath}: profiles.${printPathPart(profileName)}.modelPriority.${index}.id: duplicate candidate model id '${candidate.id}' (first at modelPriority.${previous}.id)`,
				);
			} else {
				candidates.set(candidate.id, index);
			}
		}
	}

	for (const [agentName, policy] of Object.entries(config.agentPolicies)) {
		if (agentNames.size > 0 && !agentNames.has(agentName)) {
			errors.push(`${filePath}: agentPolicies.${printPathPart(agentName)}: references unknown agent '${agentName}'`);
		}
		if (!profileNames.has(policy.defaultProfile)) {
			errors.push(
				`${filePath}: agentPolicies.${printPathPart(agentName)}.defaultProfile: references unknown profile '${policy.defaultProfile}'`,
			);
		}
		const allowed = new Map<string, number>();
		for (const [index, profileName] of policy.allowedProfiles.entries()) {
			const previous = allowed.get(profileName);
			if (previous !== undefined) {
				errors.push(
					`${filePath}: agentPolicies.${printPathPart(agentName)}.allowedProfiles.${index}: duplicate allowed profile '${profileName}' (first at allowedProfiles.${previous})`,
				);
			} else {
				allowed.set(profileName, index);
			}
			if (!profileNames.has(profileName)) {
				errors.push(
					`${filePath}: agentPolicies.${printPathPart(agentName)}.allowedProfiles.${index}: references unknown profile '${profileName}'`,
				);
			}
		}
		if (!allowed.has(policy.defaultProfile)) {
			errors.push(
				`${filePath}: agentPolicies.${printPathPart(agentName)}.defaultProfile: must appear in allowedProfiles`,
			);
		}
	}
	for (const agentName of agentNames) {
		if (!Object.hasOwn(config.agentPolicies, agentName)) {
			errors.push(
				`${filePath}: agentPolicies.${printPathPart(agentName)}: missing policy binding for agent '${agentName}'`,
			);
		}
	}
	const seenRank = new Map<string, number>();
	for (const [index, id] of (config.capabilityRanking ?? []).entries()) {
		const previous = seenRank.get(id);
		if (previous !== undefined) {
			errors.push(
				`${filePath}: capabilityRanking.${index}: duplicate model id '${id}' (first at capabilityRanking.${previous})`,
			);
		} else {
			seenRank.set(id, index);
		}
	}
	return errors;
}

/** Parse and cross-reference validate arbitrary JSON for tests and callers with in-memory config. */
export function parseAndValidateProfiles(
	input: unknown,
	agents: Iterable<string | NamedAgent> = [],
	filePath = "profiles.json",
): Result.Result<ProfilesConfig, ProfileIssues> {
	const parsed = parseProfilesJson(input, filePath);
	if (Result.isFailure(parsed)) return parsed;
	const errors = validateProfiles(parsed.success, agents, filePath);
	return errors.length ? Result.fail({ kind: "validation", errors }) : parsed;
}

/** Load the normal configuration from the Pi agent directory. */
export function loadProfiles(
	agents: Iterable<string | NamedAgent>,
	filePath = profilesPath(),
): Effect.Effect<ProfilesConfig, ProfilesConfigError> {
	return Effect.gen(function* () {
		const contents = yield* readFileString(filePath).pipe(
			Effect.catchTag("FsError", (error) =>
				Effect.fail(
					new ProfilesFileError({
						filePath,
						cause: error.cause,
						errors: [`${filePath}: could not read configuration`],
					}),
				),
			),
		);
		const parsed = parseAndValidateProfiles(contents, agents, filePath);
		if (Result.isFailure(parsed)) {
			return yield* new ProfilesInvalidError({ filePath, issues: parsed.failure });
		}
		return parsed.success;
	});
}

/**
 * Resolve an authenticated candidate in configured order. The model registry is
 * deliberately queried through getAvailable(), not find(), because find() can
 * return a model for which the user has no configured authentication.
 */
export function resolveRun(options: ResolveRunOptions): Effect.Effect<ResolvedRun, RunResolutionError> {
	return Effect.gen(function* () {
		const agent = typeof options.agent === "string" ? options.agent : options.agent.name;
		const policy = options.config.agentPolicies[agent];
		if (!policy) {
			return yield* resolutionError(
				"missing_agent_policy",
				agent,
				`No profile policy is configured for agent '${agent}'.`,
			);
		}

		const profileName = options.profile ?? policy.defaultProfile;
		if (options.profile !== undefined && !policy.allowedProfiles.includes(options.profile)) {
			return yield* resolutionError(
				"profile_not_allowed",
				agent,
				`Profile '${options.profile}' is not allowed for agent '${agent}'. Allowed: ${policy.allowedProfiles.join(", ")}.`,
			);
		}
		const profile = options.config.profiles[profileName];
		if (!profile) {
			return yield* resolutionError(
				"unknown_profile",
				agent,
				`Profile '${profileName}' configured for agent '${agent}' does not exist.`,
			);
		}

		// An explicit empty scope means no model is permitted. Only callers that omit
		// scope entirely fall back to every authenticated model.
		const available =
			options.scopedModels ?? options.modelRegistry.getAvailable().map((model): ScopedModel => ({ model }));
		for (const candidate of profile.modelPriority) {
			const [provider, modelId] = splitModelId(candidate.id);
			const scopedModel = available.find(({ model }) => model.provider === provider && model.id === modelId);
			if (scopedModel) {
				return yield* resolveCandidate(
					agent,
					profileName,
					candidate,
					scopedModel.model,
					options.requestedThinking,
					scopedModel.thinkingLevel,
				);
			}
		}
		return yield* resolutionError(
			"no_authenticated_model",
			agent,
			`No authenticated model is available for profile '${profileName}'. Configured model priority: ${profile.modelPriority.map((candidate) => candidate.id).join(", ")}.`,
		);
	});
}

function resolveCandidate(
	agent: string,
	profileName: string,
	candidate: ModelCandidate,
	model: Model<Api>,
	requestedThinking: ModelThinkingLevel | undefined,
	scopedThinking: ModelThinkingLevel | undefined,
): Effect.Effect<ResolvedRun, RunResolutionError> {
	return Effect.gen(function* () {
		// A scoped or requested level is untrusted input, so it is narrowed here.
		const requestedLevel: string = scopedThinking ?? requestedThinking ?? candidate.defaultThinking;
		if (!isThinkingLevel(requestedLevel)) {
			return yield* resolutionError("unknown_thinking_level", agent, `Unknown thinking level '${requestedLevel}'.`);
		}
		const requested = requestedLevel;
		if (thinkingRank(requested) < thinkingRank(candidate.defaultThinking)) {
			return yield* resolutionError(
				"thinking_below_minimum",
				agent,
				`Requested thinking '${requested}' is below profile '${profileName}' candidate '${candidate.id}' minimum '${candidate.defaultThinking}'.`,
			);
		}
		if (thinkingRank(requested) > thinkingRank(candidate.maxThinking)) {
			return yield* resolutionError(
				"thinking_above_cap",
				agent,
				`Requested thinking '${requested}' exceeds profile '${profileName}' candidate '${candidate.id}' cap '${candidate.maxThinking}'.`,
			);
		}
		const effectiveThinking = supportedThinkingAtOrBelow(model, requested);
		if (!effectiveThinking) {
			return yield* resolutionError(
				"no_supported_thinking",
				agent,
				`Model '${candidate.id}' supports no thinking level at or below requested '${requested}'.`,
			);
		}
		return freezeResolvedRun(agent, profileName, candidate.id, effectiveThinking, model.contextWindow, model);
	});
}

type ModelCandidate = Schema.Schema.Type<typeof ModelCandidateSchema>;

function resolutionError(reason: RunResolutionReason, agent: string, message: string): RunResolutionError {
	return new RunResolutionError({ reason, agent, message });
}

function supportedThinkingAtOrBelow(model: Model<Api>, requested: ModelThinkingLevel): ModelThinkingLevel | undefined {
	return getSupportedThinkingLevels(model)
		.filter((level) => thinkingRank(level) <= thinkingRank(requested))
		.at(-1);
}

function freezeResolvedRun(
	agent: string,
	profile: string,
	modelName: string,
	effectiveThinking: ModelThinkingLevel,
	contextWindow: number,
	modelInstance: Model<Api>,
): ResolvedRun {
	return Object.freeze({ agent, profile, model: modelName, modelInstance, effectiveThinking, contextWindow });
}

export function splitModelId(id: string): [string, string] {
	const slash = id.indexOf("/");
	return [id.slice(0, slash), id.slice(slash + 1)];
}

function thinkingRank(level: ModelThinkingLevel): number {
	return THINKING_LEVELS.indexOf(level);
}

function isThinkingLevel(level: string): level is ModelThinkingLevel {
	return THINKING_LEVELS.some((candidate) => candidate === level);
}

function printPathPart(part: PropertyKey): string {
	return typeof part === "number"
		? String(part)
		: /^[A-Za-z_$][\w$-]*$/.test(String(part))
			? String(part)
			: `[${JSON.stringify(String(part))}]`;
}
