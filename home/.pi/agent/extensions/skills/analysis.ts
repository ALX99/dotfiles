import {
	formatSkillsForPrompt,
	parseFrontmatter,
	type Skill,
	type SkillFrontmatter,
} from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";

const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const VALID_NAME = /^[a-z0-9-]+$/u;

// Pi's provider-independent token estimates are deliberately approximate. Keep
// the same chars-per-token heuristic used by pi-ai's faux provider so the UI
// remains useful without presenting estimates as provider billing data.
function estimateTextTokens(value: string): number {
	return Math.ceil(value.length / 4);
}

export type SkillDiagnosticSeverity = "info" | "warning" | "error";

export interface SkillDiagnostic {
	severity: SkillDiagnosticSeverity;
	message: string;
	path: string;
}

export interface SkillAnalysis {
	skill: Skill;
	body: string;
	descriptorTokens: number;
	bodyTokens: number;
	nativeLoadTokens: number;
	diagnostics: SkillDiagnostic[];
}

export interface SkillTokenSummary {
	activeDescriptorTokens: number;
	activeBodyTokens: number;
	activeNativeLoadTokens: number;
	allBodyTokens: number;
	allNativeLoadTokens: number;
}

export function escapeSkillXml(value: string): string {
	return value
		.replace(/&/gu, "&amp;")
		.replace(/</gu, "&lt;")
		.replace(/>/gu, "&gt;")
		.replace(/"/gu, "&quot;")
		.replace(/'/gu, "&apos;");
}

/** The descriptor item used by Pi's native available-skills section. */
export function formatSkillDescriptor(skill: Skill): string {
	return [
		"  <skill>",
		`    <name>${escapeSkillXml(skill.name)}</name>`,
		`    <description>${escapeSkillXml(skill.description)}</description>`,
		`    <location>${escapeSkillXml(skill.filePath)}</location>`,
		"  </skill>",
	].join("\n");
}

/** The wrapper Pi 0.84.4 uses when explicitly expanding /skill:name. */
export function formatNativeSkillBlock(skill: Skill, body: string): string {
	return `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
}

export async function inspectSkills(
	skills: readonly Skill[],
	activeTools: readonly string[],
): Promise<SkillAnalysis[]> {
	return Promise.all(skills.map((skill) => inspectSkill(skill, activeTools)));
}

export async function inspectSkill(skill: Skill, activeTools: readonly string[]): Promise<SkillAnalysis> {
	const diagnostics: SkillDiagnostic[] = [];
	let body: string | undefined;

	try {
		const raw = await readFile(skill.filePath, "utf8");
		try {
			const parsed = parseFrontmatter<SkillFrontmatter>(raw);
			body = parsed.body.trim();
			validateFrontmatter(skill, parsed.frontmatter, activeTools, diagnostics);
		} catch (error) {
			addDiagnostic(diagnostics, "error", `Could not parse frontmatter: ${errorMessage(error)}`, skill.filePath);
		}
	} catch (error) {
		addDiagnostic(diagnostics, "error", `Could not read skill file: ${errorMessage(error)}`, skill.filePath);
	}

	const normalizedBody = body ?? "";
	if (body !== undefined && normalizedBody.length === 0) {
		addDiagnostic(
			diagnostics,
			"warning",
			"Skill body is empty; explicit loading will add no instructions.",
			skill.filePath,
		);
	}

	return {
		skill,
		body: normalizedBody,
		descriptorTokens: estimateTextTokens(formatSkillDescriptor(skill)),
		bodyTokens: estimateTextTokens(normalizedBody),
		nativeLoadTokens: estimateTextTokens(formatNativeSkillBlock(skill, normalizedBody)),
		diagnostics,
	};
}

export function summarizeSkillTokens(
	analyses: readonly SkillAnalysis[],
	enabledNames: ReadonlySet<string>,
	includeDescriptors: boolean,
): SkillTokenSummary {
	const active = analyses.filter(({ skill }) => !skill.disableModelInvocation && enabledNames.has(skill.name));
	return {
		activeDescriptorTokens: includeDescriptors
			? estimateTextTokens(formatSkillsForPrompt(active.map(({ skill }) => skill)))
			: 0,
		activeBodyTokens: active.reduce((total, analysis) => total + analysis.bodyTokens, 0),
		activeNativeLoadTokens: active.reduce((total, analysis) => total + analysis.nativeLoadTokens, 0),
		allBodyTokens: analyses.reduce((total, analysis) => total + analysis.bodyTokens, 0),
		allNativeLoadTokens: analyses.reduce((total, analysis) => total + analysis.nativeLoadTokens, 0),
	};
}

export function countDiagnostics(analyses: readonly SkillAnalysis[]): {
	errors: number;
	warnings: number;
} {
	return analyses.reduce(
		(counts, analysis) => {
			for (const diagnostic of analysis.diagnostics) {
				if (diagnostic.severity === "error") counts.errors++;
				if (diagnostic.severity === "warning") counts.warnings++;
			}
			return counts;
		},
		{ errors: 0, warnings: 0 },
	);
}

function validateFrontmatter(
	skill: Skill,
	frontmatter: SkillFrontmatter,
	activeTools: readonly string[],
	diagnostics: SkillDiagnostic[],
): void {
	const declaredName = frontmatter.name;
	if (declaredName === undefined) {
		addDiagnostic(
			diagnostics,
			"info",
			`No frontmatter name; Pi uses the parent directory name "${skill.name}".`,
			skill.filePath,
		);
	} else if (typeof declaredName !== "string") {
		addDiagnostic(diagnostics, "warning", "Frontmatter name must be a string.", skill.filePath);
	}

	const description = frontmatter.description;
	if (typeof description !== "string" || description.trim().length === 0) {
		addDiagnostic(diagnostics, "error", "Description is required for Pi to load this skill.", skill.filePath);
	} else if (description.length > MAX_DESCRIPTION_LENGTH) {
		addDiagnostic(
			diagnostics,
			"warning",
			`Description exceeds ${MAX_DESCRIPTION_LENGTH} characters (${description.length}).`,
			skill.filePath,
		);
	}

	if (skill.name.length > MAX_NAME_LENGTH) {
		addDiagnostic(
			diagnostics,
			"warning",
			`Name exceeds ${MAX_NAME_LENGTH} characters (${skill.name.length}).`,
			skill.filePath,
		);
	}
	if (!VALID_NAME.test(skill.name)) {
		addDiagnostic(
			diagnostics,
			"warning",
			"Name contains invalid characters; Pi expects lowercase letters, numbers, and hyphens only.",
			skill.filePath,
		);
	}
	if (skill.name.startsWith("-") || skill.name.endsWith("-")) {
		addDiagnostic(diagnostics, "warning", "Name must not start or end with a hyphen.", skill.filePath);
	}
	if (skill.name.includes("--")) {
		addDiagnostic(diagnostics, "warning", "Name must not contain consecutive hyphens.", skill.filePath);
	}

	const disableModelInvocation = frontmatter["disable-model-invocation"];
	if (disableModelInvocation !== undefined && typeof disableModelInvocation !== "boolean") {
		addDiagnostic(
			diagnostics,
			"warning",
			"disable-model-invocation should be a boolean; Pi only treats true as manual-only.",
			skill.filePath,
		);
	}
	if (skill.disableModelInvocation) {
		addDiagnostic(
			diagnostics,
			"info",
			"Pi marks this skill manual-only; /skill:name still works, but it is hidden from model discovery.",
			skill.filePath,
		);
	}

	const allowedTools = frontmatter["allowed-tools"];
	if (allowedTools === undefined) return;
	if (typeof allowedTools !== "string") {
		addDiagnostic(diagnostics, "warning", "allowed-tools should be a space-delimited string.", skill.filePath);
		return;
	}
	const activeToolNames = new Set(activeTools);
	const unavailableTools = allowedTools.split(/\s+/u).filter((tool) => tool.length > 0 && !activeToolNames.has(tool));
	if (unavailableTools.length > 0) {
		addDiagnostic(
			diagnostics,
			"warning",
			`allowed-tools not active: ${unavailableTools.join(", ")} (Pi records this metadata but does not enforce it).`,
			skill.filePath,
		);
	}
}

function addDiagnostic(
	diagnostics: SkillDiagnostic[],
	severity: SkillDiagnosticSeverity,
	message: string,
	path: string,
): void {
	diagnostics.push({ severity, message, path });
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
