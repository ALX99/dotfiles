import { clipText, clipTextAtWord } from "../_shared/terminal-text.ts";
import { isRecord } from "../_shared/json.ts";
import type { AgentConfig } from "./agents.ts";
import type { AgentEvent, WireMessage } from "./event-schema.ts";
import type { OutputSpool } from "./output-spool.ts";

const MAX_RECENT_TOOLS = 50;
const MAX_NESTED_RUNS = 8;
const MAX_NESTED_TOOLS = 8;
export const MAX_ARGUMENT_PREVIEW_CHARACTERS = 500;
export const MAX_RETAINED_EVENT_TEXT_CHARACTERS = 500;
export const MAX_RETAINED_IDENTITY_CHARACTERS = 200;

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

export interface MutableRunData {
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

export interface RunDetails extends MutableRunData {
	agentId?: string;
	generation?: number;
	status?: RunStatus;
	aborted: boolean;
}

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

export function initRunData(params: InitRunDetailsParams): MutableRunData {
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
		startTime: Date.now(),
		toolCount: 0,
		recentTools: [],
		lastMessage: "",
		nestedRuns: [],
		tokens: 0,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
	};
}

export interface RunSnapshotState {
	readonly agentId?: string;
	readonly generation?: number;
	readonly status?: RunStatus;
}

export function snapshotRunData(details: MutableRunData, state: RunSnapshotState = {}): ReadonlyRunDetails {
	return {
		...details,
		...(state.agentId === undefined ? {} : { agentId: state.agentId }),
		...(state.generation === undefined ? {} : { generation: state.generation }),
		...(state.status === undefined ? {} : { status: state.status }),
		aborted: state.status === "aborted",
		recentTools: details.recentTools.map((tool) => ({ ...tool })),
		nestedRuns: details.nestedRuns.map(snapshotNestedRun),
		usage: { ...details.usage },
	};
}

/** Fold a previously validated event. Output writes are serialized by the
 * OutputSpool and awaited before settlement is published. */
export async function foldAgentEvent(event: AgentEvent, details: MutableRunData, output: OutputSpool): Promise<void> {
	switch (event.type) {
		case "agent_start":
		case "agent_settled":
			return;
		case "message_end": {
			const message = event.message;
			if (message.role === "assistant") {
				if (message.stopReason === "error") {
					details.assistantError = message.errorMessage?.trim()
						? retainedText(message.errorMessage, MAX_RETAINED_EVENT_TEXT_CHARACTERS)
						: "Subagent assistant stopped with an error.";
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

async function ingestMessage(msg: WireMessage, details: MutableRunData, output: OutputSpool): Promise<void> {
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
			details.recentTools.push({
				name: retainedText(part.name, MAX_RETAINED_IDENTITY_CHARACTERS),
				argsPreview: argsPreview(part.arguments),
			});
			if (details.recentTools.length > MAX_RECENT_TOOLS) details.recentTools.shift();
		} else if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
			textParts.push(part.text.trim());
			const prose = part.text.split("\n").find((line) => line.trim() && !line.trimStart().startsWith("```"));
			if (prose) details.lastMessage = retainedText(prose, MAX_RETAINED_EVENT_TEXT_CHARACTERS);
		}
	}
	if (textParts.length === 0) return;
	const preview = await output.append(textParts.join("\n\n"));
	details.finalText = preview.text;
	if (preview.outputFile) details.outputFile = preview.outputFile;
	else delete details.outputFile;
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
		toolCallId: retainedText(toolCallId, MAX_RETAINED_IDENTITY_CHARACTERS),
		agent:
			typeof input.agent === "string" && input.agent.trim()
				? retainedText(input.agent, MAX_RETAINED_IDENTITY_CHARACTERS)
				: "general",
		taskName:
			typeof input.task_name === "string" && input.task_name.trim()
				? retainedText(input.task_name, MAX_RETAINED_EVENT_TEXT_CHARACTERS)
				: clipTextAtWord(message, 60),
		depth,
		status: "running",
		toolCount: 0,
		recentTools: [],
		lastMessage: "",
		nestedRuns: [],
	};
}

function updateNestedRun(
	details: MutableRunData,
	toolCallId: string,
	rawResult: unknown,
	fallbackStatus: NestedRunStatus,
): void {
	const retainedToolCallId = retainedText(toolCallId, MAX_RETAINED_IDENTITY_CHARACTERS);
	const existing =
		details.nestedRuns.find((run) => run.toolCallId === retainedToolCallId) ??
		nestedRunFromArgs(retainedToolCallId, undefined, details.depth + 1);
	upsertNestedRun(details, nestedRunFromResult(rawResult, existing, fallbackStatus));
}

function upsertNestedRun(details: MutableRunData, run: NestedRunDetails): void {
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
		agent:
			typeof rawDetails.agent === "string"
				? retainedText(rawDetails.agent, MAX_RETAINED_IDENTITY_CHARACTERS)
				: fallback.agent,
		taskName:
			typeof rawDetails.taskName === "string"
				? retainedText(rawDetails.taskName, MAX_RETAINED_EVENT_TEXT_CHARACTERS)
				: fallback.taskName,
		depth: typeof rawDetails.depth === "number" ? rawDetails.depth : fallback.depth,
		status,
		toolCount: typeof rawDetails.toolCount === "number" ? rawDetails.toolCount : fallback.toolCount,
		recentTools: nestedTools(rawDetails.recentTools),
		lastMessage:
			typeof rawDetails.lastMessage === "string"
				? retainedText(rawDetails.lastMessage, MAX_RETAINED_EVENT_TEXT_CHARACTERS)
				: fallback.lastMessage,
		nestedRuns: remainingDepth > 0 ? nestedRuns(rawDetails.nestedRuns, remainingDepth - 1) : [],
	};
}

function nestedTools(raw: unknown): Array<{ name: string; argsPreview: string }> {
	if (!Array.isArray(raw)) return [];
	return raw
		.flatMap((item) => {
			if (!isRecord(item) || typeof item.name !== "string" || typeof item.argsPreview !== "string") return [];
			return [
				{
					name: retainedText(item.name, MAX_RETAINED_IDENTITY_CHARACTERS),
					argsPreview: retainedText(item.argsPreview, MAX_ARGUMENT_PREVIEW_CHARACTERS),
				},
			];
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
		if (typeof value === "string") return retainedText(value, MAX_ARGUMENT_PREVIEW_CHARACTERS);
	}
	return retainedText(JSON.stringify(args) ?? "", MAX_ARGUMENT_PREVIEW_CHARACTERS);
}

function retainedText(value: string, maxCharacters: number): string {
	return clipText(value.replace(/\s+/gu, " ").trim(), maxCharacters);
}
