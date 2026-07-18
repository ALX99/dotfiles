import { clipTextAtWord } from "../_shared/terminal-text.ts";
import { isRecord } from "../_shared/json.ts";
import type { AgentConfig } from "./agents.ts";
import type { AgentEvent, WireMessage } from "./event-schema.ts";
import type { OutputSpool } from "./output-spool.ts";

const MAX_RECENT_TOOLS = 50;
const MAX_NESTED_RUNS = 8;
const MAX_NESTED_TOOLS = 8;

export interface RunUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

export type RunStatus = "starting" | "running" | "idle" | "failed" | "aborted" | "closed" | "launched";
export type NestedRunStatus = "running" | "completed" | "failed" | "aborted";

export interface NestedRunDetails {
	toolCallId: string;
	agent: string;
	taskName: string;
	depth: number;
	status: NestedRunStatus;
	toolCount: number;
	recentTools: Array<{ name: string; argsPreview: string }>;
	lastMessage: string;
	nestedRuns: NestedRunDetails[];
}

export interface RunDetails {
	agentId?: string;
	generation?: number;
	status?: RunStatus;
	agent: string;
	taskName: string;
	profile: string;
	model: string;
	effectiveThinking: string;
	sessionFile?: string;
	depth: number;
	exitCode: number;
	finalText: string;
	outputFile?: string;
	stderr: string;
	assistantError?: string;
	aborted: boolean;
	startTime: number;
	endTime?: number;
	toolCount: number;
	recentTools: Array<{ name: string; argsPreview: string }>;
	lastMessage: string;
	nestedRuns: NestedRunDetails[];
	tokens: number;
	usage: RunUsage;
	contextWindow?: number;
}

export type MutableRunState = RunDetails;
export type ReadonlyNestedRunDetails = Readonly<
	Omit<NestedRunDetails, "recentTools" | "nestedRuns"> & {
		readonly recentTools: readonly Readonly<{ name: string; argsPreview: string }>[];
		readonly nestedRuns: readonly ReadonlyNestedRunDetails[];
	}
>;
export type ReadonlyRunDetails = Readonly<
	Omit<RunDetails, "recentTools" | "nestedRuns" | "usage"> & {
		readonly recentTools: readonly Readonly<{ name: string; argsPreview: string }>[];
		readonly nestedRuns: readonly ReadonlyNestedRunDetails[];
		readonly usage: Readonly<RunUsage>;
	}
>;

export interface InitRunDetailsParams {
	readonly agent: AgentConfig;
	readonly taskName: string;
	readonly profile: string;
	readonly model: string;
	readonly effectiveThinking: string;
	readonly sessionFile?: string;
	readonly parentDepth: number;
}

export function initRunState(params: InitRunDetailsParams): MutableRunState {
	return {
		agent: params.agent.name,
		taskName: params.taskName,
		profile: params.profile,
		model: params.model,
		effectiveThinking: params.effectiveThinking,
		...(params.sessionFile === undefined ? {} : { sessionFile: params.sessionFile }),
		depth: params.parentDepth + 1,
		exitCode: 0,
		finalText: "",
		stderr: "",
		aborted: false,
		startTime: Date.now(),
		toolCount: 0,
		recentTools: [],
		lastMessage: "",
		nestedRuns: [],
		tokens: 0,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
	};
}

export function snapshotRunState(
	details: MutableRunState,
	status: RunStatus | undefined = details.status,
): ReadonlyRunDetails {
	return {
		...details,
		...(status === undefined ? {} : { status }),
		recentTools: details.recentTools.map((tool) => ({ ...tool })),
		nestedRuns: details.nestedRuns.map(snapshotNestedRun),
		usage: { ...details.usage },
	};
}

/** Fold a previously validated event. Output writes are serialized by the
 * OutputSpool and awaited before settlement is published. */
export async function foldAgentEvent(event: AgentEvent, details: MutableRunState, output: OutputSpool): Promise<void> {
	switch (event.type) {
		case "agent_start":
		case "agent_settled":
			return;
		case "message_end": {
			const message = event.message;
			if (message.role === "assistant") {
				if (message.stopReason === "error") {
					details.assistantError = message.errorMessage?.trim() || "Subagent assistant stopped with an error.";
				} else {
					delete details.assistantError;
				}
			}
			await ingestMessage(message, details, output);
			return;
		}
		case "tool_execution_start":
			if (event.toolName === "spawn_agent") {
				upsertNestedRun(details, nestedRunFromArgs(event.toolCallId, event.args, details.depth + 1));
			}
			return;
		case "tool_execution_update":
			if (event.toolName === "spawn_agent") {
				updateNestedRun(details, event.toolCallId, event.partialResult, "running");
			}
			return;
		case "tool_execution_end":
			if (event.toolName === "spawn_agent") {
				updateNestedRun(details, event.toolCallId, event.result, event.isError ? "failed" : "completed");
			}
			return;
	}
}

async function ingestMessage(msg: WireMessage, details: MutableRunState, output: OutputSpool): Promise<void> {
	if (msg.role !== "assistant") return;
	const usage = msg.usage;
	if (usage) {
		details.usage.turns++;
		details.usage.input += usage.input ?? 0;
		details.usage.output += usage.output ?? 0;
		details.usage.cacheRead += usage.cacheRead ?? 0;
		details.usage.cacheWrite += usage.cacheWrite ?? 0;
		details.usage.cost += usage.cost?.total ?? 0;
		details.tokens =
			usage.totalTokens ?? (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
	}

	const textParts: string[] = [];
	for (const part of msg.content) {
		if (part.type === "toolCall" && typeof part.name === "string") {
			details.toolCount++;
			details.recentTools.push({ name: part.name, argsPreview: argsPreview(part.arguments) });
			if (details.recentTools.length > MAX_RECENT_TOOLS) details.recentTools.shift();
		} else if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
			textParts.push(part.text.trim());
			const prose = part.text.split("\n").find((line) => line.trim() && !line.trimStart().startsWith("```"));
			if (prose) details.lastMessage = prose.trim();
		}
	}
	if (textParts.length === 0) return;
	const append = output.append(textParts.join("\n\n"));
	const preview = output.preview();
	details.finalText = preview.text;
	if (preview.outputFile) details.outputFile = preview.outputFile;
	else delete details.outputFile;
	await append;
	const completedPreview = output.preview();
	details.finalText = completedPreview.text;
	if (completedPreview.outputFile) details.outputFile = completedPreview.outputFile;
}

function snapshotNestedRun(run: NestedRunDetails): NestedRunDetails {
	return {
		...run,
		recentTools: run.recentTools.map((tool) => ({ ...tool })),
		nestedRuns: run.nestedRuns.map(snapshotNestedRun),
	};
}

function nestedRunFromArgs(toolCallId: string, args: unknown, depth: number): NestedRunDetails {
	const input = isRecord(args) ? args : {};
	const message = typeof input.message === "string" ? input.message : "(task unavailable)";
	return {
		toolCallId,
		agent: typeof input.agent === "string" && input.agent.trim() ? input.agent : "general",
		taskName:
			typeof input.task_name === "string" && input.task_name.trim() ? input.task_name : clipTextAtWord(message, 60),
		depth,
		status: "running",
		toolCount: 0,
		recentTools: [],
		lastMessage: "",
		nestedRuns: [],
	};
}

function updateNestedRun(
	details: MutableRunState,
	toolCallId: string,
	rawResult: unknown,
	fallbackStatus: NestedRunStatus,
): void {
	const existing =
		details.nestedRuns.find((run) => run.toolCallId === toolCallId) ??
		nestedRunFromArgs(toolCallId, undefined, details.depth + 1);
	upsertNestedRun(details, nestedRunFromResult(rawResult, existing, fallbackStatus));
}

function upsertNestedRun(details: MutableRunState, run: NestedRunDetails): void {
	const index = details.nestedRuns.findIndex((item) => item.toolCallId === run.toolCallId);
	if (index >= 0) details.nestedRuns[index] = run;
	else details.nestedRuns.push(run);
	while (details.nestedRuns.length > MAX_NESTED_RUNS) {
		const completedIndex = details.nestedRuns.findIndex((item) => item.status !== "running");
		details.nestedRuns.splice(completedIndex >= 0 ? completedIndex : 0, 1);
	}
}

function nestedRunFromResult(
	rawResult: unknown,
	fallback: NestedRunDetails,
	fallbackStatus: NestedRunStatus,
	remainingDepth = 3,
): NestedRunDetails {
	const rawDetails = isRecord(rawResult) && isRecord(rawResult.details) ? rawResult.details : rawResult;
	if (!isRecord(rawDetails)) return { ...fallback, status: fallbackStatus };
	const status = isNestedRunStatus(rawDetails.status)
		? rawDetails.status
		: rawDetails.aborted === true
			? "aborted"
			: typeof rawDetails.exitCode === "number" && rawDetails.exitCode !== 0
				? "failed"
				: rawDetails.endTime !== undefined
					? "completed"
					: fallbackStatus;
	return {
		toolCallId: fallback.toolCallId,
		agent: typeof rawDetails.agent === "string" ? rawDetails.agent : fallback.agent,
		taskName: typeof rawDetails.taskName === "string" ? rawDetails.taskName : fallback.taskName,
		depth: typeof rawDetails.depth === "number" ? rawDetails.depth : fallback.depth,
		status,
		toolCount: typeof rawDetails.toolCount === "number" ? rawDetails.toolCount : fallback.toolCount,
		recentTools: nestedTools(rawDetails.recentTools),
		lastMessage: typeof rawDetails.lastMessage === "string" ? rawDetails.lastMessage : fallback.lastMessage,
		nestedRuns: remainingDepth > 0 ? nestedRuns(rawDetails.nestedRuns, remainingDepth - 1) : [],
	};
}

function nestedTools(raw: unknown): Array<{ name: string; argsPreview: string }> {
	if (!Array.isArray(raw)) return [];
	return raw
		.flatMap((item) => {
			if (!isRecord(item) || typeof item.name !== "string" || typeof item.argsPreview !== "string") return [];
			return [{ name: item.name, argsPreview: item.argsPreview }];
		})
		.slice(-MAX_NESTED_TOOLS);
}

function nestedRuns(raw: unknown, remainingDepth: number): NestedRunDetails[] {
	if (!Array.isArray(raw) || remainingDepth < 0) return [];
	return raw
		.flatMap((item) => {
			if (!isRecord(item) || typeof item.toolCallId !== "string") return [];
			return [nestedRunFromResult(item, nestedRunFromArgs(item.toolCallId, undefined, 0), "running", remainingDepth)];
		})
		.slice(-MAX_NESTED_RUNS);
}

function isNestedRunStatus(value: unknown): value is NestedRunStatus {
	return value === "running" || value === "completed" || value === "failed" || value === "aborted";
}

export function argsPreview(args: unknown): string {
	if (!isRecord(args)) return "";
	for (const key of ["path", "file_path", "command", "query", "url", "pattern", "content"]) {
		const value = args[key];
		if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
	}
	return JSON.stringify(args)?.replace(/\s+/g, " ").trim() ?? "";
}
