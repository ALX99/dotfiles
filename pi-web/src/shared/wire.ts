export type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

export interface ImageContent {
  type: "image";
  data: string;
  mediaType: string;
}

export interface ModelRef {
  provider: string;
  id: string;
  name?: string;
}

export interface SessionSummary {
  path: string;
  id: string;
  name?: string;
  firstMessage?: string;
  startedAt?: number;
}

export type ClientCommand =
  | { type: "prompt"; id: string; text: string; images?: ImageContent[] }
  | { type: "abort"; id: string }
  | { type: "new_session"; id: string }
  | { type: "switch_session"; id: string; path: string }
  | { type: "set_model"; id: string; provider: string; modelId: string }
  | { type: "set_thinking_level"; id: string; level: ThinkingLevel }
  | { type: "list_sessions"; id: string }
  | { type: "list_models"; id: string }
  | { type: "get_state"; id: string };

export type ServerResponse =
  | { type: "response"; id: string; ok: true; data?: unknown }
  | { type: "response"; id: string; ok: false; error: string };

export type ServerEventType =
  | "session_start"
  | "session_before_switch"
  | "session_before_fork"
  | "session_before_compact"
  | "agent_start"
  | "agent_end"
  | "turn_start"
  | "turn_end"
  | "message_start"
  | "message_update"
  | "message_end"
  | "tool_execution_start"
  | "tool_execution_update"
  | "tool_execution_end"
  | "queue_update"
  | "compaction_start"
  | "compaction_end"
  | "extension_error";

export const SERVER_EVENT_TYPES: ReadonlySet<ServerEventType> = new Set([
  "session_start",
  "session_before_switch",
  "session_before_fork",
  "session_before_compact",
  "agent_start",
  "agent_end",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "queue_update",
  "compaction_start",
  "compaction_end",
  "extension_error",
]);

export interface ServerEvent {
  type: ServerEventType;
  [k: string]: unknown;
}

export function isServerEventType(value: unknown): value is ServerEventType {
  return typeof value === "string" && SERVER_EVENT_TYPES.has(value as ServerEventType);
}

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && THINKING_LEVELS.includes(value as ThinkingLevel);
}
