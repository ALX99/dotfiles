/** Subagent execution-profile configuration and deterministic model resolution. */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, type ScopedModel } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels, type Api, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { toError } from "../_shared/errors.ts";
import { parseJson } from "../_shared/json.ts";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const ThinkingLevelSchema = z.enum(THINKING_LEVELS);

/** A non-empty, unmodified identifier. Configuration must not hide whitespace typos. */
const nonEmptyString = (label: string) =>
	z
		.string()
		.min(1, `${label} must not be empty`)
		.refine(
			(value) => value.trim() === value && value.trim().length > 0,
			`${label} must not be empty or contain leading/trailing whitespace`,
		);

const configKey = (label: string) =>
	z
		.string()
		.min(1, `${label} must not be empty`)
		.refine((value) => !/\s/u.test(value), `${label} must not contain whitespace`);

export const ModelCandidateSchema = z
	.strictObject({
		id: nonEmptyString("model id").refine((id) => {
			const slash = id.indexOf("/");
			return slash > 0 && slash < id.length - 1;
		}, "model id must be provider/model-id"),
		/** The omitted-request default and lowest permitted explicit override. */
		defaultThinking: ThinkingLevelSchema,
		maxThinking: ThinkingLevelSchema,
	})
	.superRefine((candidate, ctx) => {
		if (thinkingRank(candidate.defaultThinking) > thinkingRank(candidate.maxThinking)) {
			ctx.addIssue({
				code: "custom",
				path: ["defaultThinking"],
				message: "defaultThinking must not exceed maxThinking",
			});
		}
	});

export const ProfileSchema = z.strictObject({
	description: nonEmptyString("description"),
	modelPriority: z.array(ModelCandidateSchema).min(1, "modelPriority must contain at least one candidate"),
});

export const AgentPolicySchema = z.strictObject({
	defaultProfile: nonEmptyString("defaultProfile"),
	allowedProfiles: z
		.array(nonEmptyString("allowedProfiles item"))
		.min(1, "allowedProfiles must contain at least one profile"),
});

export const RootPolicySchema = z.strictObject({
	maxConcurrentRootAgents: z.number().int().min(1),
});

export const ProfilesSchema = z.strictObject({
	rootPolicy: RootPolicySchema,
	profiles: z.record(configKey("profile name"), ProfileSchema),
	agentPolicies: z.record(configKey("agent name"), AgentPolicySchema),
});

export type ProfilesConfig = z.infer<typeof ProfilesSchema>;

export interface NamedAgent {
	name: string;
}

export interface ProfileConfigurationError {
	kind: "read" | "parse" | "validation";
	filePath: string;
	errors: string[];
	cause?: NodeJS.ErrnoException;
}

export interface AvailableModelRegistry {
	getAvailable(): readonly Model<Api>[];
}

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

/** Location used for ordinary extension startup; never resolve from process.cwd(). */
export function profilesPath(): string {
	return path.join(getAgentDir(), "extensions", "subagents", "profiles.json");
}

/** Parse JSON and its strict structural schema, keeping every Zod issue and its path. */
export function parseProfilesJson(
	input: unknown,
	filePath = "profiles.json",
): { success: true; config: ProfilesConfig } | { success: false; errors: string[] } {
	let value: unknown = input;
	if (typeof input === "string") {
		const parsedJson = parseJson(input, filePath);
		if (!parsedJson.ok) {
			return {
				success: false,
				errors: [parsedJson.diagnostic.message],
			};
		}
		value = parsedJson.value;
	}
	const parsed = ProfilesSchema.safeParse(value);
	if (!parsed.success) {
		return {
			success: false,
			errors: parsed.error.issues.map((issue) => formatZodIssue(filePath, issue.path, issue.message)),
		};
	}
	return { success: true, config: parsed.data };
}

/**
 * Validate relationships that JSON Schema cannot express. All errors are
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
		if (!profileName || /\s/u.test(profileName))
			errors.push(
				`${filePath}: profiles.${printPathPart(profileName)}: profile name must not be empty or contain whitespace`,
			);
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
		if (!agentName || /\s/u.test(agentName))
			errors.push(
				`${filePath}: agentPolicies.${printPathPart(agentName)}: agent name must not be empty or contain whitespace`,
			);
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
	return errors;
}

/** Parse and cross-reference validate arbitrary JSON for tests and callers with in-memory config. */
export function parseAndValidateProfiles(
	input: unknown,
	agents: Iterable<string | NamedAgent> = [],
	filePath = "profiles.json",
): { success: true; config: ProfilesConfig } | { success: false; errors: string[] } {
	const parsed = parseProfilesJson(input, filePath);
	if (!parsed.success) return parsed;
	const errors = validateProfiles(parsed.config, agents, filePath);
	return errors.length ? { success: false, errors } : parsed;
}

/** Load the normal configuration from the Pi agent directory. */
export function loadProfiles(
	agents: Iterable<string | NamedAgent>,
	filePath = profilesPath(),
): Result<ProfilesConfig, ProfileConfigurationError> {
	let contents: string;
	try {
		contents = fs.readFileSync(filePath, "utf8");
	} catch (cause) {
		return err({
			kind: "read",
			filePath,
			cause: toError(cause),
			errors: [`${filePath}: could not read configuration`],
		});
	}
	const parsed = parseAndValidateProfiles(contents, agents, filePath);
	return parsed.success
		? ok(parsed.config)
		: err({
				kind: parsed.errors.some((message) => message.includes("invalid JSON")) ? "parse" : "validation",
				filePath,
				errors: parsed.errors,
			});
}

/**
 * Resolve an authenticated candidate in configured order. The model registry is
 * deliberately queried through getAvailable(), not find(), because find() can
 * return a model for which the user has no configured authentication.
 */
export function resolveRun(options: ResolveRunOptions): ResolvedRun {
	const agent = typeof options.agent === "string" ? options.agent : options.agent.name;
	const policy = options.config.agentPolicies[agent];
	if (!policy) throw new Error(`No profile policy is configured for agent '${agent}'.`);

	const profileName = options.profile ?? policy.defaultProfile;
	if (options.profile !== undefined && !policy.allowedProfiles.includes(options.profile)) {
		throw new Error(
			`Profile '${options.profile}' is not allowed for agent '${agent}'. Allowed: ${policy.allowedProfiles.join(", ")}.`,
		);
	}
	const profile = options.config.profiles[profileName];
	if (!profile) throw new Error(`Profile '${profileName}' configured for agent '${agent}' does not exist.`);

	const available =
		options.scopedModels && options.scopedModels.length > 0
			? options.scopedModels
			: options.modelRegistry.getAvailable().map((model): ScopedModel => ({ model }));
	const authenticated = profile.modelPriority.flatMap((candidate) => {
		const [provider, modelId] = splitModelId(candidate.id);
		const scopedModel = available.find(({ model }) => model.provider === provider && model.id === modelId);
		return scopedModel ? [{ candidate, ...scopedModel }] : [];
	});
	if (authenticated.length === 0) {
		throw new Error(
			`No authenticated model is available for profile '${profileName}'. Configured model priority: ${profile.modelPriority.map((candidate) => candidate.id).join(", ")}.`,
		);
	}

	const candidate = authenticated[0];
	if (!candidate) {
		throw new Error(`Profile '${profileName}' has no authenticated model candidates.`);
	}
	return resolveCandidate(
		agent,
		profileName,
		candidate.candidate,
		candidate.model,
		options.requestedThinking,
		candidate.thinkingLevel,
	);
}

function resolveCandidate(
	agent: string,
	profileName: string,
	candidate: ProfilesConfig["profiles"][string]["modelPriority"][number],
	model: Model<Api>,
	requestedThinking: ModelThinkingLevel | undefined,
	scopedThinking: ModelThinkingLevel | undefined,
): ResolvedRun {
	const requested = scopedThinking ?? requestedThinking ?? candidate.defaultThinking;
	assertThinkingLevel(requested);
	if (thinkingRank(requested) < thinkingRank(candidate.defaultThinking)) {
		throw new Error(
			`Requested thinking '${requested}' is below profile '${profileName}' candidate '${candidate.id}' minimum '${candidate.defaultThinking}'.`,
		);
	}
	if (thinkingRank(requested) > thinkingRank(candidate.maxThinking)) {
		throw new Error(
			`Requested thinking '${requested}' exceeds profile '${profileName}' candidate '${candidate.id}' cap '${candidate.maxThinking}'.`,
		);
	}
	const effectiveThinking = supportedThinkingAtOrBelow(model, requested);
	if (!effectiveThinking) {
		throw new Error(`Model '${candidate.id}' supports no thinking level at or below requested '${requested}'.`);
	}
	return freezeResolvedRun(agent, profileName, candidate.id, effectiveThinking, model.contextWindow, model);
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

function splitModelId(id: string): [string, string] {
	const slash = id.indexOf("/");
	return [id.slice(0, slash), id.slice(slash + 1)];
}

function thinkingRank(level: ModelThinkingLevel): number {
	return THINKING_LEVELS.indexOf(level);
}

function assertThinkingLevel(level: string): asserts level is ModelThinkingLevel {
	if (!THINKING_LEVELS.some((candidate) => candidate === level)) {
		throw new Error(`Unknown thinking level '${level}'.`);
	}
}

function formatZodIssue(filePath: string, pathParts: PropertyKey[], message: string): string {
	const location = pathParts.length ? pathParts.map(printPathPart).join(".") : "<root>";
	return `${filePath}: ${location}: ${message}`;
}

function printPathPart(part: PropertyKey): string {
	return typeof part === "number"
		? String(part)
		: /^[A-Za-z_$][\w$-]*$/.test(String(part))
			? String(part)
			: `[${JSON.stringify(String(part))}]`;
}
