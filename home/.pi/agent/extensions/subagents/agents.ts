/** Subagent identity and capability discovery. */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	systemPrompt: string;
	filePath: string;
}

export const AgentFrontmatterSchema = z.strictObject({
	name: z.string().trim().min(1),
	description: z.string().trim().min(1),
	tools: z.string().optional(),
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
		return err({ kind: "read_dir", dir, cause: cause as NodeJS.ErrnoException });
	}

	const agents: AgentConfig[] = [];
	const errors: string[] = [];
	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;
		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf8");
		} catch (cause) {
			errors.push(`${filePath}: could not read file: ${cause instanceof Error ? cause.message : String(cause)}`);
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

export function parseAgentFile(filePath: string, content: string):
	| { success: true; agent: AgentConfig }
	| { success: false; errors: string[] } {
	let frontmatter: Record<string, unknown>;
	let body: string;
	try {
		({ frontmatter, body } = parseFrontmatter(content));
	} catch (cause) {
		return { success: false, errors: [`${filePath}: invalid frontmatter: ${cause instanceof Error ? cause.message : String(cause)}`] };
	}
	const parsed = AgentFrontmatterSchema.safeParse(frontmatter);
	if (!parsed.success) {
		return {
			success: false,
			errors: parsed.error.issues.map((issue) => `${filePath}:${issue.path.length ? ` ${issue.path.join(".")}:` : ""} ${issue.message}`),
		};
	}
	if (!body.trim()) return { success: false, errors: [`${filePath}: system prompt must not be empty`] };
	const tools = parsed.data.tools?.split(",").map((tool) => tool.trim()).filter(Boolean);
	if (parsed.data.tools !== undefined && !tools?.length) {
		return { success: false, errors: [`${filePath}: tools must contain at least one tool when present`] };
	}
	return {
		success: true,
		agent: {
			name: parsed.data.name,
			description: parsed.data.description,
			tools,
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
