import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import { parseJson } from "../_shared/json.ts";

const TOKEN_PATTERN = "[0-9a-f]{64}";
const MARKER_PREFIX = "[[pi-subagent-context:v1:";
const MARKER_SUFFIX = "]]";
const EXACT_MARKER_PATTERN = new RegExp(
	`^${escapeRegExp(MARKER_PREFIX)}(${TOKEN_PATTERN})${escapeRegExp(MARKER_SUFFIX)}$`,
);
const MAX_METADATA_BYTES = 16 * 1024;
export const CONTEXT_ARTIFACT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export const ACCEPTED_CONTEXT_CUSTOM_TYPE = "subagent-context-accepted";

const ContextArtifactMetadataSchema = z.strictObject({
	version: z.literal(1),
	token: z.string().regex(new RegExp(`^${TOKEN_PATTERN}$`)),
	agentId: z.string().trim().min(1).max(128).optional(),
	parentSessionId: z.string().trim().min(1).max(128).optional(),
	generation: z.number().int().positive(),
	resultId: z.string().regex(new RegExp(`^${TOKEN_PATTERN}$`)),
	kind: z.enum(["assignment", "followup", "steer", "answer", "fallback"]),
	bytes: z.number().int().nonnegative(),
	sha256: z.string().regex(new RegExp(`^${TOKEN_PATTERN}$`)),
});

const AcceptedContextDataSchema = z.strictObject({
	version: z.literal(1),
	agentId: z.string().trim().min(1).max(128).optional(),
	agent: z.string().trim().min(1),
	profile: z.string().trim().min(1),
	parentSessionId: z.string().trim().min(1).max(128).optional(),
	generation: z.number().int().positive(),
	resultId: z.string().regex(new RegExp(`^${TOKEN_PATTERN}$`)),
	kind: ContextArtifactMetadataSchema.shape.kind,
});

export type ContextArtifactKind = z.infer<typeof ContextArtifactMetadataSchema>["kind"];
export type ContextArtifactMetadata = Readonly<z.infer<typeof ContextArtifactMetadataSchema>>;
export type AcceptedContextData = Readonly<z.infer<typeof AcceptedContextDataSchema>>;

export interface CreatedContextArtifact {
	readonly marker: string;
	readonly metadata: ContextArtifactMetadata;
}

export interface ReadContextArtifact extends CreatedContextArtifact {
	readonly content: string;
}

export function contextArtifactDirectory(agentDir = getAgentDir()): string {
	return path.join(agentDir, "subagent-artifacts", "context");
}

export async function createContextArtifact(
	content: string,
	options: {
		readonly agentId: string;
		readonly parentSessionId?: string;
		readonly generation: number;
		readonly resultId: string;
		readonly kind: ContextArtifactKind;
		readonly agentDir?: string;
	},
): Promise<CreatedContextArtifact> {
	const directory = contextArtifactDirectory(options.agentDir);
	await ensurePrivateDirectory(directory);
	const token = randomBytes(32).toString("hex");
	const metadata = ContextArtifactMetadataSchema.parse({
		version: 1,
		token,
		agentId: options.agentId,
		...(options.parentSessionId === undefined ? {} : { parentSessionId: options.parentSessionId }),
		generation: options.generation,
		resultId: options.resultId,
		kind: options.kind,
		bytes: Buffer.byteLength(content, "utf8"),
		sha256: sha256(content),
	});
	const contentPath = artifactPath(directory, token, ".context");
	const metadataPath = artifactPath(directory, token, ".json");
	try {
		await fs.promises.writeFile(contentPath, content, {
			encoding: "utf8",
			flag: "wx",
			mode: 0o600,
		});
		await fs.promises.writeFile(metadataPath, JSON.stringify(metadata), {
			encoding: "utf8",
			flag: "wx",
			mode: 0o600,
		});
	} catch (error) {
		await Promise.allSettled([
			fs.promises.rm(contentPath, { force: true }),
			fs.promises.rm(metadataPath, { force: true }),
		]);
		throw error;
	}
	return Object.freeze({ marker: formatContextMarker(token), metadata: Object.freeze(metadata) });
}

export async function readContextArtifact(marker: string, agentDir = getAgentDir()): Promise<ReadContextArtifact> {
	const token = parseContextMarker(marker);
	if (!token) throw new Error("Invalid subagent context marker.");
	const directory = contextArtifactDirectory(agentDir);
	await validatePrivateDirectory(directory);
	const metadataText = await readPrivateRegularFile(
		directory,
		artifactPath(directory, token, ".json"),
		MAX_METADATA_BYTES,
	);
	const parsedJson = parseJson(metadataText, "subagent context metadata");
	if (!parsedJson.ok) {
		throw new Error(`Invalid ${parsedJson.diagnostic.message}.`, { cause: parsedJson.diagnostic.cause });
	}
	const parsedMetadata = ContextArtifactMetadataSchema.safeParse(parsedJson.value);
	if (!parsedMetadata.success || parsedMetadata.data.token !== token) {
		throw new Error("Invalid subagent context artifact metadata.");
	}
	const content = await readPrivateRegularFile(directory, artifactPath(directory, token, ".context"));
	if (
		Buffer.byteLength(content, "utf8") !== parsedMetadata.data.bytes ||
		sha256(content) !== parsedMetadata.data.sha256
	) {
		throw new Error("Subagent context artifact failed its integrity check.");
	}
	return Object.freeze({
		marker,
		metadata: Object.freeze(parsedMetadata.data),
		content,
	});
}

export function acceptedContextData(
	metadata: ContextArtifactMetadata,
	context: { readonly agent: string; readonly profile: string; readonly parentSessionId?: string },
): AcceptedContextData {
	return Object.freeze(
		AcceptedContextDataSchema.parse({
			version: 1,
			...(metadata.agentId === undefined ? {} : { agentId: metadata.agentId }),
			agent: context.agent,
			profile: context.profile,
			...(context.parentSessionId === undefined ? {} : { parentSessionId: context.parentSessionId }),
			generation: metadata.generation,
			resultId: metadata.resultId,
			kind: metadata.kind,
		}),
	);
}

export function parseAcceptedContextData(value: unknown): AcceptedContextData | undefined {
	const parsed = AcceptedContextDataSchema.safeParse(value);
	return parsed.success ? Object.freeze(parsed.data) : undefined;
}

export async function removeContextArtifact(marker: string, agentDir = getAgentDir()): Promise<void> {
	const token = parseContextMarker(marker);
	if (!token) throw new Error("Invalid subagent context marker.");
	const directory = contextArtifactDirectory(agentDir);
	try {
		await validatePrivateDirectory(directory);
	} catch (error) {
		if (isMissing(error)) return;
		throw error;
	}
	await Promise.all([
		fs.promises.rm(artifactPath(directory, token, ".context"), { force: true }),
		fs.promises.rm(artifactPath(directory, token, ".json"), { force: true }),
	]);
}

export async function pruneStaleContextArtifacts(
	options: {
		readonly agentDir?: string;
		readonly olderThanMs?: number;
		readonly now?: number;
	} = {},
): Promise<number> {
	const olderThanMs = options.olderThanMs ?? CONTEXT_ARTIFACT_RETENTION_MS;
	if (!Number.isFinite(olderThanMs) || olderThanMs < 0) {
		throw new Error("Context artifact retention must be a nonnegative duration.");
	}
	const directory = contextArtifactDirectory(options.agentDir);
	try {
		await validatePrivateDirectory(directory);
	} catch (error) {
		if (isMissing(error)) return 0;
		throw error;
	}
	const candidates = new Map<string, string[]>();
	for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
		const match = new RegExp(`^(${TOKEN_PATTERN})\\.(?:context|json)$`).exec(entry.name);
		if (!match?.[1]) continue;
		const files = candidates.get(match[1]) ?? [];
		files.push(path.join(directory, entry.name));
		candidates.set(match[1], files);
	}
	const cutoff = (options.now ?? Date.now()) - olderThanMs;
	let pruned = 0;
	for (const [token, files] of candidates) {
		const stats = await Promise.all(
			files.map(async (filePath) => {
				const stats = await fs.promises.lstat(filePath);
				assertOwnedByCurrentUser(stats, "Subagent artifact");
				return stats;
			}),
		);
		if (stats.some((file) => file.mtimeMs > cutoff)) continue;
		await removeContextArtifact(formatContextMarker(token), options.agentDir);
		pruned++;
	}
	return pruned;
}

export function formatContextMarker(token: string): string {
	if (!new RegExp(`^${TOKEN_PATTERN}$`).test(token)) throw new Error("Invalid subagent context token.");
	return `${MARKER_PREFIX}${token}${MARKER_SUFFIX}`;
}

export function parseContextMarker(marker: string): string | undefined {
	return EXACT_MARKER_PATTERN.exec(marker)?.[1];
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
	await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
	await validatePrivateDirectory(directory);
	await fs.promises.chmod(directory, 0o700);
}

async function validatePrivateDirectory(directory: string): Promise<void> {
	const stats = await fs.promises.lstat(directory);
	if (!stats.isDirectory() || stats.isSymbolicLink()) {
		throw new Error(`Subagent artifact directory is not a trusted directory: ${directory}`);
	}
	assertOwnedByCurrentUser(stats, "Subagent artifact directory");
	if ((stats.mode & 0o077) !== 0) {
		throw new Error(`Subagent artifact directory permissions are not private: ${directory}`);
	}
}

async function readPrivateRegularFile(directory: string, filePath: string, maxBytes?: number): Promise<string> {
	assertContained(directory, filePath);
	const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
	const handle = await fs.promises.open(filePath, flags);
	try {
		const stats = await handle.stat();
		if (!stats.isFile()) throw new Error(`Subagent artifact is not a regular file: ${filePath}`);
		assertOwnedByCurrentUser(stats, "Subagent artifact");
		if ((stats.mode & 0o077) !== 0) {
			throw new Error(`Subagent artifact permissions are not private: ${filePath}`);
		}
		if (maxBytes !== undefined && stats.size > maxBytes) {
			throw new Error(`Subagent artifact metadata exceeds the ${maxBytes} byte safety limit.`);
		}
		return handle.readFile("utf8");
	} finally {
		await handle.close();
	}
}

function artifactPath(directory: string, token: string, suffix: ".context" | ".json"): string {
	if (!new RegExp(`^${TOKEN_PATTERN}$`).test(token)) throw new Error("Invalid subagent context token.");
	const filePath = path.resolve(directory, `${token}${suffix}`);
	assertContained(directory, filePath);
	return filePath;
}

function assertContained(directory: string, candidate: string): void {
	const relative = path.relative(path.resolve(directory), path.resolve(candidate));
	if (relative.startsWith("..") || path.isAbsolute(relative)) {
		throw new Error("Subagent artifact path escapes the trusted artifact directory.");
	}
}

function assertOwnedByCurrentUser(stats: fs.Stats, label: string): void {
	const uid = process.getuid?.();
	if (uid !== undefined && stats.uid !== uid) throw new Error(`${label} is not owned by the current user.`);
}

function isMissing(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function sha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function escapeRegExp(value: string): string {
	return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
