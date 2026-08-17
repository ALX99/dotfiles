/** Subagent identity and capability discovery. */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { toError } from "../_shared/errors.ts";

export interface AgentConfig {
	name: string;
	description: string;
	tools: string[];
	systemPrompt: string;
	filePath: string;
}

const nonBlank = (label: string) => z.string().trim().min(1, `${label} must not be blank`);

export const AgentFrontmatterSchema = z.strictObject({
	name: nonBlank("name").refine((name) => !/\s/u.test(name), "name must not contain whitespace"),
	description: nonBlank("description"),
	tools: z.array(nonBlank("tool")).min(1, "tools must contain at least one tool"),
});

export type DiscoverError =
	| { kind: "read_dir"; dir: string; cause: NodeJS.ErrnoException }
	| { kind: "empty"; dir: string }
	| { kind: "configuration"; dir: string; errors: string[]; agents: AgentConfig[] };

const AGENTS_DIR = path.join(getAgentDir(), "extensions", "subagents", "agents");

/** Read and validate every Markdown agent. Invalid files are startup errors. */
export function discoverAgents(dir = AGENTS_DIR): Result<AgentConfig[], DiscoverError> {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch (cause) {
		return err({ kind: "read_dir", dir, cause: toError(cause) });
	}

	const agents: AgentConfig[] = [];
	const errors: string[] = [];
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;
		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf8");
		} catch (cause) {
			errors.push(`${filePath}: could not read file: ${toError(cause).message}`);
			continue;
		}
		const parsed = parseAgentFile(filePath, content);
		if (parsed.success) agents.push(parsed.agent);
		else errors.push(...parsed.errors);
	}

	const filesByName = new Map<string, string[]>();
	for (const agent of agents) {
		const files = filesByName.get(agent.name) ?? [];
		files.push(agent.filePath);
		filesByName.set(agent.name, files);
	}
	for (const [name, files] of filesByName) {
		if (files.length > 1) errors.push(`agents.${name}: duplicate agent name in ${files.join(", ")}`);
	}
	if (errors.length) return err({ kind: "configuration", dir, errors, agents });
	if (agents.length === 0) return err({ kind: "empty", dir });
	agents.sort((a, b) => a.name.localeCompare(b.name));
	return ok(agents);
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
	const parsed = AgentFrontmatterSchema.safeParse(frontmatter);
	if (!parsed.success) {
		return {
			success: false,
			errors: parsed.error.issues.map(
				(issue) => `${filePath}:${issue.path.length ? ` ${issue.path.join(".")}:` : ""} ${issue.message}`,
			),
		};
	}
	if (!body.trim()) return { success: false, errors: [`${filePath}: system prompt must not be empty`] };
	const duplicateTools = parsed.data.tools.filter((tool, index, tools) => tools.indexOf(tool) !== index);
	if (duplicateTools.length) {
		return { success: false, errors: [`${filePath}: tools must not contain duplicates`] };
	}
	return {
		success: true,
		agent: {
			name: parsed.data.name,
			description: parsed.data.description,
			tools: parsed.data.tools,
			systemPrompt: body.trim(),
			filePath,
		},
	};
}

export function formatAgentList(agents: AgentConfig[]): string {
	return agents.map((agent) => `${agent.name}: ${agent.description}`).join("; ") || "none";
}

export function resolveAgent(
	agents: AgentConfig[],
	name: string,
): Result<AgentConfig, { requested: string; available: AgentConfig[] }> {
	const found = agents.find((agent) => agent.name === name);
	return found ? ok(found) : err({ requested: name, available: agents });
}
