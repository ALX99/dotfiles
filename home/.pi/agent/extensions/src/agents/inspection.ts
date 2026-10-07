import { Result, Schema } from "effect";
import type { AgentSessionEvent, SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";

const AskParentInputSchema = Schema.Struct({
	message: Schema.String,
	options: Schema.optionalKey(Schema.Array(Schema.String)),
});

export type AgentActivity =
	| {
			readonly key: string;
			readonly occurredAt: number;
			readonly type: "tool_call";
			readonly tool: string;
			readonly input: string;
	  }
	| {
			readonly key: string;
			readonly occurredAt: number;
			readonly type: "tool_result";
			readonly tool: string;
			readonly content: string;
	  }
	| {
			readonly key: string;
			readonly occurredAt: number;
			readonly type: "output" | "thinking" | "session_event";
			readonly content: string;
	  }
	| {
			readonly key: string;
			readonly occurredAt: number;
			readonly type: "ask_parent";
			readonly message: string;
			readonly options?: readonly string[];
	  };

export type InspectedActivity =
	| { readonly age: string; readonly type: "tool_call"; readonly tool: string; readonly input: string }
	| { readonly age: string; readonly type: "tool_result"; readonly tool: string; readonly content: string }
	| { readonly age: string; readonly type: "output" | "thinking" | "session_event"; readonly content: string }
	| {
			readonly age: string;
			readonly type: "ask_parent";
			readonly message: string;
			readonly options?: readonly string[];
	  };

export interface AgentListing {
	readonly agent: string;
	readonly profile: string;
	readonly status: string;
}

export interface AgentInspection extends AgentListing {
	readonly cwd: string;
	readonly latest_events: readonly InspectedActivity[];
}

const MAX_ACTIVITY_TEXT = 240;
const MAX_LIVE_ACTIVITY = 40;

/** Keep only provider-exposed messages and actual tool events; never inspect private agent state. */
export function observeSessionEvent(event: AgentSessionEvent, occurredAt = Date.now()): readonly AgentActivity[] {
	if (event.type === "message_update" || event.type === "message_end") {
		return activityFromMessage(event.message);
	}
	if (event.type === "tool_execution_start") {
		return [toolCallActivity(event.toolName, event.args, event.toolCallId, occurredAt)];
	}
	if (event.type === "tool_execution_end") {
		return [
			{
				key: `tool-result:${event.toolCallId}`,
				occurredAt,
				type: "tool_result",
				tool: event.toolName,
				content: summarizeToolResult(event.result),
			},
		];
	}
	if (event.type === "entry_appended") return activityFromEntry(event.entry);
	return [];
}

/** Project the active Pi session branch and transient tool events into a small newest-first view. */
export function latestObservableActivity(
	entries: readonly SessionEntry[],
	live: readonly AgentActivity[],
	now = Date.now(),
): readonly InspectedActivity[] {
	const byKey = new Map<string, AgentActivity>();
	for (const activity of entries.flatMap(activityFromEntry)) byKey.set(activity.key, activity);
	for (const activity of live.slice(-MAX_LIVE_ACTIVITY)) byKey.set(activity.key, activity);
	return [...byKey.values()]
		.toSorted((left, right) => right.occurredAt - left.occurredAt || right.key.localeCompare(left.key))
		.slice(0, 5)
		.map((activity) => toInspectedActivity(activity, now));
}

export function listAgentRecords(
	records: readonly {
		readonly id: string;
		readonly profile: { readonly name: string };
		readonly status: string;
	}[],
): readonly AgentListing[] {
	return records.map((record) => ({ agent: record.id, profile: record.profile.name, status: record.status }));
}

export function inspectAgentRecord(
	record: {
		readonly id: string;
		readonly profile: { readonly name: string };
		readonly status: string;
		readonly cwd: string;
	},
	entries: readonly SessionEntry[],
	live: readonly AgentActivity[],
	now = Date.now(),
): AgentInspection {
	return {
		agent: record.id,
		profile: record.profile.name,
		status: record.status,
		cwd: record.cwd,
		latest_events: latestObservableActivity(entries, live, now),
	};
}

export function appendLiveActivity(
	current: readonly AgentActivity[],
	incoming: readonly AgentActivity[],
): readonly AgentActivity[] {
	if (incoming.length === 0) return current;
	const byKey = new Map(current.map((activity) => [activity.key, activity]));
	for (const activity of incoming) byKey.set(activity.key, activity);
	return [...byKey.values()].toSorted((left, right) => left.occurredAt - right.occurredAt).slice(-MAX_LIVE_ACTIVITY);
}

export function relativeAge(occurredAt: number, now: number): string {
	const seconds = Math.max(1, Math.ceil(Math.max(0, now - occurredAt) / 1_000));
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

function activityFromEntry(entry: SessionEntry): AgentActivity[] {
	if (entry.type === "message") return activityFromMessage(entry.message, timestamp(entry.timestamp));
	if (entry.type === "custom_message") {
		return [
			{
				key: `entry:${entry.id}`,
				occurredAt: timestamp(entry.timestamp),
				type: "session_event",
				content: summarizeText(typeof entry.content === "string" ? entry.content : contentText(entry.content)),
			},
		];
	}
	if (entry.type === "compaction" || entry.type === "branch_summary") {
		return [
			{
				key: `entry:${entry.id}`,
				occurredAt: timestamp(entry.timestamp),
				type: "session_event",
				content: summarizeText(entry.summary),
			},
		];
	}
	if (entry.type === "model_change") {
		return [
			{
				key: `entry:${entry.id}`,
				occurredAt: timestamp(entry.timestamp),
				type: "session_event",
				content: `Model changed to ${entry.provider}/${entry.modelId}`,
			},
		];
	}
	return [];
}

function activityFromMessage(message: SessionMessageEntry["message"], persistedAt?: number): AgentActivity[] {
	const occurredAt = persistedAt ?? message.timestamp;
	const messageTime = message.timestamp ?? occurredAt;
	if (message.role === "assistant") {
		return message.content.flatMap((block, index): AgentActivity[] => {
			if (block.type === "text" && block.text.trim().length > 0) {
				return [
					{
						key: `message:${messageTime}:assistant-text:${index}`,
						occurredAt,
						type: "output",
						content: summarizeText(block.text),
					},
				];
			}
			if (block.type === "thinking" && block.thinking.trim().length > 0) {
				return [
					{
						key: `message:${messageTime}:thinking:${index}`,
						occurredAt,
						type: "thinking",
						content: summarizeText(block.thinking),
					},
				];
			}
			if (block.type === "toolCall") {
				return [toolCallActivity(block.name, block.arguments, block.id, occurredAt)];
			}
			return [];
		});
	}
	if (message.role === "toolResult") {
		return [
			{
				key: `tool-result:${message.toolCallId}`,
				occurredAt,
				type: "tool_result",
				tool: message.toolName,
				content: summarizeText(contentText(message.content)),
			},
		];
	}
	if (message.role === "user") {
		const content = contentText(message.content);
		return content.length === 0
			? []
			: [
					{
						key: `message:${messageTime}:user`,
						occurredAt,
						type: "session_event",
						content: summarizeText(content),
					},
				];
	}
	return [];
}

function toolCallActivity(tool: string, input: unknown, toolCallId: string, occurredAt: number): AgentActivity {
	if (tool === "ask_parent") {
		const decoded = Schema.decodeUnknownResult(AskParentInputSchema)(input);
		if (Result.isSuccess(decoded)) {
			return {
				key: `tool-call:${toolCallId}`,
				occurredAt,
				type: "ask_parent",
				message: summarizeText(decoded.success.message),
				...(decoded.success.options === undefined ? {} : { options: decoded.success.options }),
			};
		}
	}
	return {
		key: `tool-call:${toolCallId}`,
		occurredAt,
		type: "tool_call",
		tool,
		input: summarizeText(JSON.stringify(input)),
	};
}

function summarizeToolResult(result: unknown): string {
	if (typeof result === "string") return summarizeText(result);
	if (result !== null && typeof result === "object" && "content" in result && Array.isArray(result.content)) {
		return summarizeText(contentText(result.content));
	}
	return summarizeText(JSON.stringify(result));
}

function contentText(content: string | readonly { readonly type: string; readonly text?: string }[]): string {
	if (typeof content === "string") return content;
	return content.flatMap((block) => (block.type === "text" && block.text !== undefined ? [block.text] : [])).join("\n");
}

function summarizeText(value: string | undefined): string {
	if (value === undefined) return "";
	const normalized = value.replace(/\s+/gu, " ").trim();
	if (normalized.length <= MAX_ACTIVITY_TEXT) return normalized;
	return `${normalized.slice(0, MAX_ACTIVITY_TEXT - 1)}…`;
}

function timestamp(value: string): number {
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

function toInspectedActivity(activity: AgentActivity, now: number): InspectedActivity {
	const age = relativeAge(activity.occurredAt, now);
	switch (activity.type) {
		case "tool_call":
			return { age, type: activity.type, tool: activity.tool, input: activity.input };
		case "tool_result":
			return { age, type: activity.type, tool: activity.tool, content: activity.content };
		case "ask_parent":
			return {
				age,
				type: activity.type,
				message: activity.message,
				...(activity.options === undefined ? {} : { options: activity.options }),
			};
		case "output":
		case "thinking":
		case "session_event":
			return { age, type: activity.type, content: activity.content };
		default:
			throw new Error("Unhandled agent activity type.");
	}
}
