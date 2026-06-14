/**
 * Minimal user-level subagent discovery.
 *
 * Agents live in ~/.pi/agent/agents/*.md and use simple YAML frontmatter:
 * ---
 * name: scout
 * description: Fast read-only codebase recon
 * tools: read, grep, find, ls, bash
 * model: optional-model-id
 * ---
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	filePath: string;
}

export function discoverAgents(): AgentConfig[] {
	const dir = path.join(getAgentDir(), "agents");
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}

	const agents: AgentConfig[] = [];
	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
		if (!frontmatter.name || !frontmatter.description) continue;

		const tools = frontmatter.tools
			?.split(",")
			.map((tool) => tool.trim())
			.filter(Boolean);

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: tools?.length ? tools : undefined,
			model: frontmatter.model?.trim() || undefined,
			systemPrompt: body.trim(),
			filePath,
		});
	}

	return agents.sort((a, b) => a.name.localeCompare(b.name));
}

export function formatAgentList(agents: AgentConfig[]): string {
	return agents.map((agent) => `${agent.name}: ${agent.description}`).join("; ") || "none";
}
