import {
  THINKING_LEVELS,
  isThinkingLevel,
  isServerEventType,
} from "../shared/wire.ts";
import type {
  ModelRef,
  ServerEvent,
  ServerResponse,
  SessionSummary,
  ThinkingLevel,
} from "../shared/wire.ts";

export interface TextBlock {
  type: "text";
  text: string;
}
export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
}
export interface ToolCallBlock {
  type: "toolCall";
  name: string;
  arguments?: unknown;
}
export type ContentBlock = TextBlock | ThinkingBlock | ToolCallBlock;

export interface ChatMessage {
  id?: string;
  role: "user" | "assistant" | "toolResult";
  content: string | ContentBlock[];
  toolName?: string;
  stopReason?: string;
  errorMessage?: string;
}

export interface Toast {
  id: number;
  text: string;
  kind: "info" | "error";
}

export interface AppState {
  connected: boolean;
  reconnectAttempt: number;
  messages: ChatMessage[];
  sessions: SessionSummary[];
  models: ModelRef[];
  model: ModelRef | null;
  thinkingLevel: ThinkingLevel;
  isStreaming: boolean;
  currentSessionFile: string | null;
  modelSearch: string;
  stickToBottom: boolean;
  toast: Toast | null;
}

export const initialState: AppState = {
  connected: false,
  reconnectAttempt: 0,
  messages: [],
  sessions: [],
  models: [],
  model: null,
  thinkingLevel: "medium",
  isStreaming: false,
  currentSessionFile: null,
  modelSearch: "",
  stickToBottom: true,
  toast: null,
};

export type Action =
  | { type: "ws_open" }
  | { type: "ws_close" }
  | { type: "reconnect_attempt"; attempt: number }
  | { type: "response"; msg: ServerResponse }
  | { type: "event"; msg: ServerEvent }
  | { type: "set_model_search"; value: string }
  | { type: "set_stick_to_bottom"; value: boolean }
  | { type: "show_toast"; text: string; kind: "info" | "error" }
  | { type: "dismiss_toast"; id: number };

let toastSeq = 0;

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "ws_open":
      return { ...state, connected: true, reconnectAttempt: 0 };
    case "ws_close":
      return { ...state, connected: false, isStreaming: false };
    case "reconnect_attempt":
      return { ...state, reconnectAttempt: action.attempt };
    case "set_model_search":
      return { ...state, modelSearch: action.value };
    case "set_stick_to_bottom":
      return { ...state, stickToBottom: action.value };
    case "show_toast":
      return toast(state, action.text, action.kind);
    case "dismiss_toast":
      return state.toast && state.toast.id === action.id
        ? { ...state, toast: null }
        : state;
    case "response":
      return applyResponse(state, action.msg);
    case "event":
      return applyEvent(state, action.msg);
  }
}

function applyResponse(state: AppState, msg: ServerResponse): AppState {
  if (!msg.ok) return toast(state, msg.error ?? "Error", "error");
  const data = msg.data;
  if (data === undefined || !isObject(data)) return state;
  if (Array.isArray(data.sessions)) {
    return { ...state, sessions: coerceSessions(data.sessions) };
  }
  if (Array.isArray(data.models)) {
    return { ...state, models: coerceModels(data.models) };
  }
  if (typeof data.thinkingLevel === "string") {
    return {
      ...state,
      model: coerceModel(data.model),
      thinkingLevel: isThinkingLevel(data.thinkingLevel)
        ? data.thinkingLevel
        : "medium",
      isStreaming: typeof data.isStreaming === "boolean" ? data.isStreaming : false,
      messages: Array.isArray(data.messages) ? coerceMessages(data.messages) : [],
      currentSessionFile:
        typeof data.sessionFile === "string" ? data.sessionFile : null,
    };
  }
  return state;
}

function applyEvent(state: AppState, msg: ServerEvent): AppState {
  switch (msg.type) {
    case "message_start":
    case "message_update":
    case "message_end":
      return upsertMessage(state, msg.message);
    case "agent_start":
      return { ...state, isStreaming: true };
    case "agent_end":
      return { ...state, isStreaming: false };
    default:
      return state;
  }
}

function upsertMessage(state: AppState, raw: unknown): AppState {
  const m = coerceMessage(raw);
  if (!m || m.id === undefined) return state;
  const idx = state.messages.findIndex((x) => x.id === m.id);
  if (idx === -1) return { ...state, messages: [...state.messages, m] };
  const next = state.messages.slice();
  next[idx] = m;
  return { ...state, messages: next };
}

function toast(
  state: AppState,
  text: string,
  kind: "info" | "error",
): AppState {
  toastSeq += 1;
  return { ...state, toast: { id: toastSeq, text, kind } };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function coerceModel(v: unknown): ModelRef | null {
  if (!isObject(v)) return null;
  if (typeof v.provider !== "string" || typeof v.id !== "string") return null;
  const ref: ModelRef = { provider: v.provider, id: v.id };
  if (typeof v.name === "string") ref.name = v.name;
  return ref;
}

function coerceModels(list: unknown[]): ModelRef[] {
  return list.map(coerceModel).filter((m): m is ModelRef => m !== null);
}

function coerceSession(v: unknown): SessionSummary | null {
  if (!isObject(v)) return null;
  if (typeof v.path !== "string" || typeof v.id !== "string") return null;
  const s: SessionSummary = { path: v.path, id: v.id };
  if (typeof v.name === "string") s.name = v.name;
  if (typeof v.firstMessage === "string") s.firstMessage = v.firstMessage;
  if (typeof v.startedAt === "number") s.startedAt = v.startedAt;
  return s;
}

function coerceSessions(list: unknown[]): SessionSummary[] {
  return list.map(coerceSession).filter((s): s is SessionSummary => s !== null);
}

function isContentBlock(v: unknown): v is ContentBlock {
  if (!isObject(v)) return false;
  if (v.type === "text") return typeof v.text === "string";
  if (v.type === "thinking") return typeof v.thinking === "string";
  if (v.type === "toolCall") return typeof v.name === "string";
  return false;
}

function coerceMessage(raw: unknown): ChatMessage | null {
  if (!isObject(raw)) return null;
  const role = raw.role;
  if (role !== "user" && role !== "assistant" && role !== "toolResult") {
    return null;
  }
  const content = raw.content;
  let blocks: ContentBlock[] | undefined;
  let text: string | undefined;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    blocks = content.filter(isContentBlock);
  }
  const m: ChatMessage = {
    role,
    content: text !== undefined ? text : blocks ?? [],
  };
  if (typeof raw.id === "string") m.id = raw.id;
  if (role === "toolResult" && typeof raw.toolName === "string") {
    m.toolName = raw.toolName;
  }
  if (role === "assistant") {
    if (typeof raw.stopReason === "string") m.stopReason = raw.stopReason;
    if (typeof raw.errorMessage === "string") m.errorMessage = raw.errorMessage;
  }
  return m;
}

function coerceMessages(list: unknown[]): ChatMessage[] {
  return list.map(coerceMessage).filter((m): m is ChatMessage => m !== null);
}

export { THINKING_LEVELS, isServerEventType };
