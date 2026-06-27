import { useCallback, useEffect, useMemo, useReducer, useRef } from "preact/hooks";
import { isServerEventType } from "../shared/wire.ts";
import type {
  ClientCommand,
  ModelRef,
  ServerEvent,
  ServerResponse,
  ThinkingLevel,
} from "../shared/wire.ts";
import { initialState, reducer, type AppState } from "./state.ts";

const WS_URL = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;

function uid(): string {
  return crypto.randomUUID();
}

function isResponse(v: unknown): v is ServerResponse {
  if (!isObject(v)) return false;
  return v.type === "response" && typeof v.ok === "boolean";
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export interface BridgeActions {
  sendPrompt(text: string): void;
  abort(): void;
  newSession(): void;
  switchSession(path: string): void;
  setModel(m: ModelRef): void;
  setThinking(level: ThinkingLevel): void;
  setModelSearch(value: string): void;
  setStickToBottom(value: boolean): void;
  dismissToast(id: number): void;
}

export function useBridge(): { state: AppState; actions: BridgeActions } {
  const [state, dispatch] = useReducer(reducer, initialState);
  const wsRef = useRef<WebSocket | null>(null);

  const send = useCallback((cmd: ClientCommand): void => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      dispatch({ type: "show_toast", text: "Not connected", kind: "info" });
      return;
    }
    ws.send(JSON.stringify(cmd));
  }, []);

  useEffect(() => {
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    function scheduleReconnect(): void {
      if (reconnectTimer) return;
      attempt += 1;
      const delay = Math.min(1000 * 2 ** (attempt - 1), 30000);
      dispatch({ type: "reconnect_attempt", attempt });
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
    }

    function connect(): void {
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;
      ws.addEventListener("open", () => {
        attempt = 0;
        dispatch({ type: "ws_open" });
        send({ type: "get_state", id: uid() });
        send({ type: "list_sessions", id: uid() });
        send({ type: "list_models", id: uid() });
      });
      ws.addEventListener("close", () => {
        dispatch({ type: "ws_close" });
        scheduleReconnect();
      });
      ws.addEventListener("error", () => {
        ws.close();
      });
      ws.addEventListener("message", (e: MessageEvent) => {
        const raw = typeof e.data === "string" ? e.data : "";
        let msg: unknown;
        try {
          msg = JSON.parse(raw);
        } catch {
          return;
        }
        if (isResponse(msg)) {
          dispatch({ type: "response", msg });
          if (msg.ok && msg.data === undefined) {
            send({ type: "get_state", id: uid() });
            send({ type: "list_sessions", id: uid() });
          }
          return;
        }
        if (isObject(msg) && isServerEventType(msg.type)) {
          const ev = msg as ServerEvent;
          dispatch({ type: "event", msg: ev });
          if (ev.type === "session_start") {
            send({ type: "list_sessions", id: uid() });
          }
        }
      });
    }

    connect();

    return () => {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      const ws = wsRef.current;
      if (ws) ws.close();
      wsRef.current = null;
    };
  }, [send]);

  const actions = useMemo<BridgeActions>(
    () => ({
      sendPrompt(text: string): void {
        if (!text.trim()) return;
        dispatch({ type: "set_stick_to_bottom", value: true });
        send({ type: "prompt", id: uid(), text });
      },
      abort(): void {
        send({ type: "abort", id: uid() });
      },
      newSession(): void {
        dispatch({ type: "set_stick_to_bottom", value: true });
        send({ type: "new_session", id: uid() });
      },
      switchSession(path: string): void {
        dispatch({ type: "set_stick_to_bottom", value: true });
        send({ type: "switch_session", id: uid(), path });
      },
      setModel(m: ModelRef): void {
        send({
          type: "set_model",
          id: uid(),
          provider: m.provider,
          modelId: m.id,
        });
      },
      setThinking(level: ThinkingLevel): void {
        send({ type: "set_thinking_level", id: uid(), level });
      },
      setModelSearch(value: string): void {
        dispatch({ type: "set_model_search", value });
      },
      setStickToBottom(value: boolean): void {
        dispatch({ type: "set_stick_to_bottom", value });
      },
      dismissToast(id: number): void {
        dispatch({ type: "dismiss_toast", id });
      },
    }),
    [send],
  );

  return { state, actions };
}
