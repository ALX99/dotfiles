import { isServerEventType, isThinkingLevel } from "./shared/wire.ts";
import type {
  ClientCommand,
  ImageContent,
  ServerEvent,
  ServerResponse,
} from "./shared/wire.ts";

export type {
  ClientCommand,
  ImageContent,
  ServerEvent,
  ServerResponse,
  ServerEventType,
  SessionSummary,
  ThinkingLevel,
} from "./shared/wire.ts";

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
      if (Array.isArray(images)) {
        cmd.images = images as ImageContent[];
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
      if (!isThinkingLevel(level)) return null;
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
  return isObject(value) && isServerEventType(value.type);
}
