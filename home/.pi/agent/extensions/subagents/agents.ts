/** Subagent identity and capability discovery. */

import * as path from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { Effect, Result, Schema } from "effect";
import { toError } from "../_shared/errors.ts";
import { readDirectory, readFileString } from "../_shared/fs.ts";
import { formatSchemaFailure } from "../_shared/schema-issues.ts";

export interface AgentConfig {
	name: string;
	description: string;
	tools: string[];
	systemPrompt: string;
	filePath: string;
}

/** Frontmatter values are trimmed, then must not be blank. */
const nonBlank = (label: string) => Schema.Trim.check(Schema.isMinLength(1, { message: `${label} must not be blank` }));

/** Unknown keys are rejected, so a renamed or unsupported field cannot be ignored silently. */
const AgentFrontmatterSchema = Schema.Struct({
	name: nonBlank("name").check(
		Schema.makeFilter((name: string) =>
			/[\s\p{C}]/u.test(name) ? "name must not contain whitespace or control characters" : undefined,
		),
	),
	description: nonBlank("description"),
	tools: Schema.Array(nonBlank("tool")).check(
		Schema.isMinLength(1, { message: "tools must contain at least one tool" }),
	),
});

const decodeFrontmatter = Schema.decodeUnknownResult(AgentFrontmatterSchema, {
	onExcessProperty: "error",
	errors: "all",
});

/** The agents directory itself could not be read. */
export class AgentsDirectoryError extends Schema.TaggedError<AgentsDirectoryError>()("AgentsDirectoryError", {
	dir: Schema.String,
	cause: Schema.Defect(),
}) {}

/** The directory is readable but holds no agent roles. */
export class NoAgentsError extends Schema.TaggedError<NoAgentsError>()("NoAgentsError", {
	dir: Schema.String,
}) {}

/** At least one role file is invalid or two files claim the same role name. */
export class AgentConfigurationError extends Schema.TaggedError<AgentConfigurationError>()("AgentConfigurationError", {
	dir: Schema.String,
	errors: Schema.Array(Schema.String),
	/** Roles parsed before the failure; profile validation still checks these names. */
	knownNames: Schema.Array(Schema.String),
}) {}

export type AgentDiscoveryError = AgentsDirectoryError | NoAgentsError | AgentConfigurationError;

const AGENTS_DIR = path.join(getAgentDir(), "extensions", "subagents", "agents");

/** Read and validate every Markdown agent. Invalid files are startup errors. */
export function discoverAgents(dir: string = AGENTS_DIR): Effect.Effect<AgentConfig[], AgentDiscoveryError> {
	return Effect.gen(function* () {
		const entries = yield* readDirectory(dir).pipe(
			Effect.catchTag("FsError", (error) => Effect.fail(new AgentsDirectoryError({ dir, cause: error.cause }))),
		);

		const errors: string[] = [];
		const contents: Array<{ readonly filePath: string; readonly text: string }> = [];
		// Entry order is the diagnostic order, so a failure list stays stable.
		for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
			if (!entry.name.endsWith(".md")) continue;
			if (!entry.isFile && !entry.isSymbolicLink) continue;
			const filePath = path.join(dir, entry.name);
			const text = yield* readFileString(filePath).pipe(
				Effect.catchTag("FsError", (error) => {
					errors.push(`${filePath}: could not read file: ${toError(error.cause).message}`);
					return Effect.succeed<string | undefined>(undefined);
				}),
			);
			if (text !== undefined) contents.push({ filePath, text });
		}

		const agents: AgentConfig[] = [];
		for (const file of contents) {
			const parsed = parseAgentFile(file.filePath, file.text);
			if (parsed.success) agents.push(parsed.agent);
			else errors.push(...parsed.errors);
		}
		errors.push(...duplicateNameErrors(agents));

		if (errors.length) {
			return yield* new AgentConfigurationError({ dir, errors, knownNames: agents.map((agent) => agent.name) });
		}
		if (agents.length === 0) return yield* new NoAgentsError({ dir });
		return agents.toSorted((a, b) => a.name.localeCompare(b.name));
	});
}

function duplicateNameErrors(agents: readonly AgentConfig[]): string[] {
	const filesByName = new Map<string, string[]>();
	for (const agent of agents) {
		const files = filesByName.get(agent.name) ?? [];
		files.push(agent.filePath);
		filesByName.set(agent.name, files);
	}
	return [...filesByName].flatMap(([name, files]) =>
		files.length > 1 ? [`agents.${name}: duplicate agent name in ${files.join(", ")}`] : [],
	);
}

export function parseAgentFile(
	filePath: string,
	content: string,
): { success: true; agent: AgentConfig } | { success: false; errors: string[] } {
	let frontmatter: Record<string, unknown>;
	let body: string;
	try {
		({ frontmatter, body } = parseFrontmatter(content));
	} catch (cause) {
		return { success: false, errors: [`${filePath}: invalid frontmatter: ${toError(cause).message}`] };
	}
	const decoded = decodeFrontmatter(frontmatter);
	if (Result.isFailure(decoded)) {
		return { success: false, errors: formatSchemaFailure(filePath, decoded.failure) };
	}
	if (!body.trim()) return { success: false, errors: [`${filePath}: system prompt must not be empty`] };
	const { name, description, tools } = decoded.success;
	const duplicateTools = tools.filter((tool, index) => tools.indexOf(tool) !== index);
	if (duplicateTools.length) {
		return { success: false, errors: [`${filePath}: tools must not contain duplicates`] };
	}
	return {
		success: true,
		agent: { name, description, tools: [...tools], systemPrompt: body.trim(), filePath },
	};
}

export function formatAgentList(agents: readonly AgentConfig[]): string {
	return agents.map((agent) => `${agent.name}: ${agent.description}`).join("; ") || "none";
}

export function resolveAgent(agents: readonly AgentConfig[], name: string): AgentConfig | undefined {
	return agents.find((agent) => agent.name === name);
}

/** The startup message for a discovery failure, matching what the user must fix. */
export function discoveryErrorMessage(error: AgentDiscoveryError): string {
	if (error instanceof AgentsDirectoryError) {
		return `Could not read agents dir ${error.dir}: ${toError(error.cause).message || "unknown error"}.`;
	}
	if (error instanceof AgentConfigurationError) {
		return error.errors.join("\n") || `Invalid agent configuration in ${error.dir}.`;
	}
	return `No agent files found in ${error.dir}.`;
}
