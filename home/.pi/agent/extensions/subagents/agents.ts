/**
 * Subagent role discovery.
 *
 * Agents live in ~/.pi/agent/extensions/subagents/agents/*.md and use the
 * same YAML frontmatter as the user's other pi agents:
 *
 * ---
 * name: scout
 * description: Fast read-only codebase recon
 * tools: read, grep, find, ls, bash
 * model: optional-model-id
 * ---
 *
 * "name" is the value the parent model passes to spawn_agent(agent_type=...).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	filePath: string;
}

// ── trust boundary: agent frontmatter ──────────────────────────────
// name + description are required; tools is a comma-list, model is optional.
export const AgentFrontmatterSchema = z.object({
	name: z.string().min(1),
	description: z.string().min(1),
	tools: z.string().optional(),
	model: z.string().optional(),
});

/** Why discovery could fail. Surfaced to the caller; never silently []. */
export type DiscoverError =
	| { kind: "read_dir"; dir: string; cause: NodeJS.ErrnoException }
	| { kind: "empty"; dir: string };

const AGENTS_DIR = path.join(getAgentDir(), "extensions", "subagents", "agents");

export function agentsDir(): string {
	return AGENTS_DIR;
}

/**
 * Read every `*.md` in the agents dir, parse frontmatter, and return the
 * valid ones sorted by name. Returns Err on an unreadable dir (permission,
 * IO) or when no usable agent was found at all (so the caller can give a
 * useful error instead of a confusing "unknown type" on the first spawn).
 */
export function discoverAgents(): Result<AgentConfig[], DiscoverError> {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(AGENTS_DIR, { withFileTypes: true });
	} catch (cause) {
		return err({ kind: "read_dir", dir: AGENTS_DIR, cause: cause as NodeJS.ErrnoException });
	}

	const agents: AgentConfig[] = [];
	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(AGENTS_DIR, entry.name);
		// Per-file read/parse errors skip the file, not the whole dir — one
		// broken agent file shouldn't hide the rest.
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf8");
		} catch {
			continue;
		}

		const parsed = parseAgentFile(filePath, content);
		if (parsed) agents.push(parsed);
	}

	if (agents.length === 0) return err({ kind: "empty", dir: AGENTS_DIR });

	agents.sort((a, b) => a.name.localeCompare(b.name));
	return ok(agents);
}

function parseAgentFile(filePath: string, content: string): AgentConfig | undefined {
	const { frontmatter, body } = parseFrontmatter(content);
	const parsed = AgentFrontmatterSchema.safeParse(frontmatter);
	if (!parsed.success) return undefined;

	const fm = parsed.data;
	const tools = fm.tools
		?.split(",")
		.map((t) => t.trim())
		.filter(Boolean);

	return {
		name: fm.name.trim(),
		description: fm.description.trim(),
		tools: tools?.length ? tools : undefined,
		model: fm.model?.trim() || undefined,
		systemPrompt: body.trim(),
		filePath,
	};
}

/** One-line "name: description" list for error messages. */
export function formatAgentList(agents: AgentConfig[]): string {
	return agents.map((a) => `${a.name}: ${a.description}`).join("; ") || "none";
}

/** Find a role by name. Err carries the full list so callers can render it. */
export function resolveAgent(
	agents: AgentConfig[],
	name: string,
): Result<AgentConfig, { requested: string; available: AgentConfig[] }> {
	const found = agents.find((a) => a.name === name);
	return found ? ok(found) : err({ requested: name, available: agents });
}
