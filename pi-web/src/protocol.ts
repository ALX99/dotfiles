// Wire protocol for pi-web.
//
// Framing: WebSocket text frames, one JSON message per frame.
// Discriminated by `type`. Client commands have required `id` (uuid v4
// string). Server responses match `id`. Server events have no `id` and
// pass through the SDK's AgentSessionEvent union as-is.

import type { ThinkingLevel, ModelThinkingLevel, ImageContent } from "@earendil-works/pi-ai";

/* ----- Client commands (browser -> server) ----- */

export type ClientCommand =
  | { type: "prompt"; id: string; text: string; images?: ImageContent[] }
  | { type: "abort"; id: string }
  | { type: "new_session"; id: string }
  | { type: "switch_session"; id: string; path: string }
  | { type: "set_model"; id: string; provider: string; modelId: string }
  | { type: "set_thinking_level"; id: string; level: ModelThinkingLevel }
  | { type: "list_sessions"; id: string }
  | { type: "list_models"; id: string }
  | { type: "get_state"; id: string };

/* ----- Server responses (server -> browser, matched by id) ----- */

export type ServerResponse =
  | { type: "response"; id: string; ok: true; data?: unknown }
  | { type: "response"; id: string; ok: false; error: string };

/* ----- Server events (server -> browser, push only) ----- */

export type ServerEvent = {
  type:
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
  [k: string]: unknown;
};

/* ----- Parsing + type guards ----- */

const THINKING_LEVELS: ReadonlySet<string> = new Set<ModelThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

function isThinkingLevel(v: string): v is ModelThinkingLevel {
  return THINKING_LEVELS.has(v);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

export function parseClientCommand(raw: unknown): ClientCommand | null {
  if (!isObject(raw)) return null;
  const { type, id } = raw;
  if (!isNonEmptyString(type) || !isNonEmptyString(id)) return null;

  switch (type) {
    case "prompt": {
      const { text, images } = raw;
      if (!isNonEmptyString(text)) return null;
      if (images !== undefined && !Array.isArray(images)) return null;
      const cmd: ClientCommand = { type: "prompt", id, text };
      if (images !== undefined) {
        (cmd as { images?: ImageContent[] }).images =
          images as ImageContent[];
      }
      return cmd;
    }
    case "abort":
      return { type: "abort", id };
    case "new_session":
      return { type: "new_session", id };
    case "switch_session": {
      const { path } = raw;
      if (!isNonEmptyString(path)) return null;
      return { type: "switch_session", id, path };
    }
    case "set_model": {
      const { provider, modelId } = raw;
      if (!isNonEmptyString(provider) || !isNonEmptyString(modelId)) {
        return null;
      }
      return { type: "set_model", id, provider, modelId };
    }
    case "set_thinking_level": {
      const { level } = raw;
      if (!isNonEmptyString(level) || !isThinkingLevel(level)) {
        return null;
      }
      return { type: "set_thinking_level", id, level };
    }
    case "list_sessions":
      return { type: "list_sessions", id };
    case "list_models":
      return { type: "list_models", id };
    case "get_state":
      return { type: "get_state", id };
    default:
      return null;
  }
}

export function isServerEvent(value: unknown): value is ServerEvent {
  if (!isObject(value)) return false;
  const { type } = value;
  if (!isNonEmptyString(type)) return false;
  const allowed: ReadonlySet<string> = new Set([
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
  return allowed.has(type);
}
