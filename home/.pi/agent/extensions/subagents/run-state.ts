import type { Usage } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./agents.ts";
import type { AgentQuestion } from "./agent-types.ts";
import type { AgentResultReference, GenerationResultLocator } from "./result-store.ts";

const MAX_RECENT_TOOLS = 10;
const MAX_ACTIVITY_CHARACTERS = 1_000;
const MAX_ARGUMENT_PREVIEW_CHARACTERS = 200;

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
	/** Bounded presentation/transport preview of the settled terminal result. */
	finalText: string;
	error?: string;
	startTime: number;
	endTime?: number;
	toolCount: number;
	recentTools: Array<{ name: string; argsPreview: string }>;
	lastMessage: string;
	lastActivityTime: number;
	/** Bounded assistant text used to render a live result before settlement. */
	liveAssistantPreview: string;
	tokens: number;
	usage: RunUsage;
	contextWindow?: number;
	resultId: string;
	result?: AgentResultReference;
	resultLocator?: GenerationResultLocator;
}

export interface RunDetails extends MutableRunData {
	agentId?: string;
	generation?: number;
	status?: RunStatus;
	pendingQuestion?: AgentQuestion;
	aborted: boolean;
}

export type ReadonlyRunDetails = Readonly<
	Omit<RunDetails, "recentTools" | "usage" | "liveAssistantPreview"> & {
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
	readonly contextWindow: number;
	readonly resultId: string;
}

export function initRunData(params: InitRunDetailsParams): MutableRunData {
	const startTime = Date.now();
	return {
		agent: params.agent.name,
		taskName: params.taskName,
		profile: params.profile,
		model: params.model,
		effectiveThinking: params.effectiveThinking,
		...(params.sessionId === undefined ? {} : { sessionId: params.sessionId }),
		...(params.sessionFile === undefined ? {} : { sessionFile: params.sessionFile }),
		finalText: "",
		startTime,
		toolCount: 0,
		recentTools: [],
		lastMessage: "",
		lastActivityTime: startTime,
		liveAssistantPreview: "",
		tokens: 0,
		usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
		contextWindow: params.contextWindow,
		resultId: params.resultId,
	};
}

export interface RunSnapshotState {
	readonly agentId?: string;
	readonly generation?: number;
	readonly status?: RunStatus;
	readonly pendingQuestion?: AgentQuestion;
}

export function snapshotRunData(details: MutableRunData, state: RunSnapshotState = {}): ReadonlyRunDetails {
	const { liveAssistantPreview: _liveAssistantPreview, ...publicDetails } = details;
	return {
		...publicDetails,
		...(state.agentId === undefined ? {} : { agentId: state.agentId }),
		...(state.generation === undefined ? {} : { generation: state.generation }),
		...(state.status === undefined ? {} : { status: state.status }),
		...(state.pendingQuestion === undefined ? {} : { pendingQuestion: state.pendingQuestion }),
		aborted: state.status === "aborted",
		recentTools: details.recentTools.map((tool) => ({ ...tool })),
		usage: { ...details.usage },
	};
}

/** Fold bounded presentation data from the native session event stream. */
export function foldSessionEvent(event: AgentSessionEvent, details: MutableRunData): void {
	details.lastActivityTime = Date.now();
	if (event.type === "tool_execution_start") {
		details.toolCount++;
		details.recentTools.push({
			name: retainedText(event.toolName, MAX_ARGUMENT_PREVIEW_CHARACTERS),
			argsPreview: argsPreview(event.args),
		});
		if (details.recentTools.length > MAX_RECENT_TOOLS) details.recentTools.shift();
		return;
	}
	if (event.type !== "message_end" || event.message.role !== "assistant") return;
	const message = event.message;
	if (message.stopReason === "error") {
		details.error = retainedText(message.errorMessage || "Subagent assistant failed.", MAX_ACTIVITY_CHARACTERS);
	} else {
		delete details.error;
	}

	const usage = message.usage;
	if (usage) {
		details.usage.input += usage.input ?? 0;
		details.usage.output += usage.output ?? 0;
		details.usage.reasoning = (details.usage.reasoning ?? 0) + (usage.reasoning ?? 0);
		details.usage.cacheRead += usage.cacheRead ?? 0;
		details.usage.cacheWrite += usage.cacheWrite ?? 0;
		details.usage.cost += usage.cost?.total ?? 0;
		details.usage.turns++;
		details.tokens =
			usage.totalTokens ?? (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
	}

	const text: string[] = [];
	for (const part of message.content) {
		if (part.type !== "text" || !part.text.trim()) continue;
		text.push(part.text);
		const activity = part.text.split("\n").find((line) => line.trim() && !line.trimStart().startsWith("```"));
		if (activity) details.lastMessage = retainedText(activity, MAX_ACTIVITY_CHARACTERS);
	}
	if (text.length > 0) details.liveAssistantPreview = retainedText(text.join("\n"), MAX_ACTIVITY_CHARACTERS);
}

function argsPreview(args: unknown): string {
	if (!isRecord(args)) return "";
	for (const key of ["path", "file_path", "command", "query", "url", "pattern", "content"]) {
		const value = args[key];
		if (typeof value === "string") return retainedText(value, MAX_ARGUMENT_PREVIEW_CHARACTERS);
	}
	return retainedText(JSON.stringify(args), MAX_ARGUMENT_PREVIEW_CHARACTERS);
}

function retainedText(value: string | undefined, maximum: number): string {
	if (!value) return "";
	const normalized = value.replace(/\s+/gu, " ").trim();
	return normalized.length <= maximum ? normalized : `${normalized.slice(0, maximum - 1)}…`;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
