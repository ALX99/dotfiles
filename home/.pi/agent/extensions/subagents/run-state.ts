import { clipText } from "../_shared/terminal-text.ts";
import { isRecord } from "../_shared/json.ts";
import type { Usage } from "@earendil-works/pi-ai";
import type { AgentConfig } from "./agents.ts";
import type { AgentQuestion } from "./agent-types.ts";
import type { AgentEvent, WireMessage } from "./event-schema.ts";
import type { AgentResultReference, GenerationResultLocator } from "./result-store.ts";

const MAX_RECENT_TOOLS = 50;
export const MAX_ARGUMENT_PREVIEW_CHARACTERS = 500;
export const MAX_RETAINED_EVENT_TEXT_CHARACTERS = 500;
export const MAX_RETAINED_IDENTITY_CHARACTERS = 200;

export interface RunUsage {
	input: number;
	output: number;
	reasoning?: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

/** Pi reports reasoning as a breakdown of output, rather than additional tokens. */
export function runUsageTotalTokens(usage: Readonly<RunUsage>): number {
	return usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

/** Convert aggregate child accounting to Pi's standard tool-result usage shape. */
export function toPiUsage(usage: Readonly<RunUsage>): Usage {
	return {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		...(usage.reasoning === undefined ? {} : { reasoning: usage.reasoning }),
		totalTokens: runUsageTotalTokens(usage),
		// Aggregate child accounting retains only total cost, so category costs
		// remain unknown instead of being invented.
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: usage.cost },
	};
}

export function sumRunUsage(usages: readonly Readonly<RunUsage>[]): RunUsage {
	return {
		input: usages.reduce((total, usage) => total + usage.input, 0),
		output: usages.reduce((total, usage) => total + usage.output, 0),
		reasoning: usages.reduce((total, usage) => total + (usage.reasoning ?? 0), 0),
		cacheRead: usages.reduce((total, usage) => total + usage.cacheRead, 0),
		cacheWrite: usages.reduce((total, usage) => total + usage.cacheWrite, 0),
		cost: usages.reduce((total, usage) => total + usage.cost, 0),
		turns: usages.reduce((total, usage) => total + usage.turns, 0),
	};
}

export type RunStatus = "starting" | "running" | "idle" | "failed" | "aborted" | "closed" | "launched";

export interface MutableRunData {
	agent: string;
	taskName: string;
	profile: string;
	model: string;
	effectiveThinking: string;
	sessionId?: string;
	sessionFile?: string;
	exitCode: number;
	/** Bounded presentation/transport preview of the settled terminal result. */
	finalText: string;
	stderr: string;
	assistantError?: string;
	startTime: number;
	endTime?: number;
	toolCount: number;
	recentTools: Array<{ name: string; argsPreview: string }>;
	lastMessage: string;
	lastAssistantText: string;
	tokens: number;
	usage: RunUsage;
	contextWindow?: number;
	resultId: string;
	result?: AgentResultReference;
	resultLocator?: GenerationResultLocator;
	omittedTelemetryRecords: number;
}

export interface RunDetails extends MutableRunData {
	agentId?: string;
	generation?: number;
	status?: RunStatus;
	pendingQuestion?: AgentQuestion;
	aborted: boolean;
}

export type ReadonlyRunDetails = Readonly<
	Omit<RunDetails, "recentTools" | "usage" | "lastAssistantText"> & {
		readonly recentTools: readonly Readonly<{ name: string; argsPreview: string }>[];
		readonly usage: Readonly<RunUsage>;
	}
>;

export interface InitRunDetailsParams {
	readonly agent: AgentConfig;
	readonly taskName: string;
	readonly profile: string;
	readonly model: string;
	readonly effectiveThinking: string;
	readonly sessionId?: string;
	readonly sessionFile?: string;
	readonly resultId: string;
}

export function initRunData(params: InitRunDetailsParams): MutableRunData {
	return {
		agent: params.agent.name,
		taskName: params.taskName,
		profile: params.profile,
		model: params.model,
		effectiveThinking: params.effectiveThinking,
		...(params.sessionId === undefined ? {} : { sessionId: params.sessionId }),
		...(params.sessionFile === undefined ? {} : { sessionFile: params.sessionFile }),
		exitCode: 0,
		finalText: "",
		stderr: "",
		startTime: Date.now(),
		toolCount: 0,
		recentTools: [],
		lastMessage: "",
		lastAssistantText: "",
		tokens: 0,
		usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
		resultId: params.resultId,
		omittedTelemetryRecords: 0,
	};
}

export interface RunSnapshotState {
	readonly agentId?: string;
	readonly generation?: number;
	readonly status?: RunStatus;
}

export function snapshotRunData(details: MutableRunData, state: RunSnapshotState = {}): ReadonlyRunDetails {
	const { lastAssistantText: _lastAssistantText, ...publicDetails } = details;
	return {
		...publicDetails,
		...(state.agentId === undefined ? {} : { agentId: state.agentId }),
		...(state.generation === undefined ? {} : { generation: state.generation }),
		...(state.status === undefined ? {} : { status: state.status }),
		aborted: state.status === "aborted",
		recentTools: details.recentTools.map((tool) => ({ ...tool })),
		usage: { ...details.usage },
	};
}

/** Fold bounded live telemetry. Canonical terminal results are captured from
 * persisted result pages only after the child settles. */
export function foldAgentEvent(event: AgentEvent, details: MutableRunData): void {
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
			ingestMessage(message, details);
			return;
		}
		case "tool_execution_start":
		case "tool_execution_update":
		case "tool_execution_end":
			return;
	}
}

function ingestMessage(msg: WireMessage, details: MutableRunData): void {
	if (msg.role !== "assistant") return;
	const usage = msg.usage;
	if (usage) {
		details.usage.turns++;
		details.usage.input += usage.input ?? 0;
		details.usage.output += usage.output ?? 0;
		details.usage.reasoning = (details.usage.reasoning ?? 0) + (usage.reasoning ?? 0);
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
			textParts.push(part.text);
			const prose = part.text.split("\n").find((line) => line.trim() && !line.trimStart().startsWith("```"));
			if (prose) details.lastMessage = retainedText(prose, MAX_RETAINED_EVENT_TEXT_CHARACTERS);
		}
	}
	if (textParts.length === 0) return;
	details.lastAssistantText = textParts.join("\n");
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
