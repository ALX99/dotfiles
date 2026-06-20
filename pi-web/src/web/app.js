import { h, render } from "/vendor/preact.js";
import { html } from "./components/htm.js";
import { Chat } from "./components/chat.js";
import { SessionList } from "./components/session-list.js";
import { ModelPicker } from "./components/model-picker.js";
import { ThinkingPicker } from "./components/thinking-picker.js";

const WS_URL = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;

const state = {
  connected: false,
  messages: [],
  sessions: [],
  models: [],
  model: null,
  thinkingLevel: "medium",
  isStreaming: false,
  toast: null,
  ws: null,
  reconnectTimer: null,
  eventSeq: 0,
};

function renderApp() {
  render(
    html`
      <div id="sidebar">
        <h2>Session</h2>
        <${SessionList}
          sessions=${state.sessions}
          onNew=${onNewSession}
          onSwitch=${onSwitchSession}
        />
        <h2>Model</h2>
        <${ModelPicker}
          models=${state.models}
          current=${state.model}
          onChange=${onSetModel}
        />
        <h2>Thinking</h2>
        <${ThinkingPicker}
          current=${state.thinkingLevel}
          disabled=${state.isStreaming}
          onChange=${onSetThinking}
        />
      </div>
      <div id="chat">
        <${Chat}
          messages=${state.messages}
          isStreaming=${state.isStreaming}
          seq=${state.eventSeq}
        />
      </div>
      <div id="prompt-row">
        <textarea
          id="prompt"
          placeholder="Send a message. /commands work. Shift+Enter for newline."
          onKeyDown=${onPromptKey}
        ></textarea>
        <button onClick=${onSendPrompt} disabled=${state.isStreaming}>Send</button>
        <button onClick=${onAbort} disabled=${!state.isStreaming}>Abort</button>
      </div>
      ${state.toast ? html`<div class=${"toast " + (state.toast.kind ?? "info")}>${state.toast.text}</div>` : null}
    `,
    document.getElementById("app"),
  );
}

function showToast(text, kind = "info", ms = 3000) {
  state.toast = { text, kind };
  renderApp();
  setTimeout(() => {
    if (state.toast && state.toast.text === text) {
      state.toast = null;
      renderApp();
    }
  }, ms);
}

function sendCommand(cmd) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    showToast("Not connected", "info");
    return;
  }
  state.ws.send(JSON.stringify(cmd));
}

function onNewSession() {
  sendCommand({ type: "new_session", id: crypto.randomUUID() });
}

function onSwitchSession(path) {
  sendCommand({ type: "switch_session", id: crypto.randomUUID(), path });
}

function onSetModel(m) {
  sendCommand({
    type: "set_model",
    id: crypto.randomUUID(),
    provider: m.provider,
    modelId: m.id,
  });
}

function onSetThinking(level) {
  sendCommand({
    type: "set_thinking_level",
    id: crypto.randomUUID(),
    level,
  });
}

function onSendPrompt() {
  const el = document.getElementById("prompt");
  if (!el) return;
  const text = el.value;
  if (!text.trim()) return;
  sendCommand({ type: "prompt", id: crypto.randomUUID(), text });
  el.value = "";
  // No optimistic UI: the server's message_start event for the user
  // message will populate state.messages.
}

function onAbort() {
  sendCommand({ type: "abort", id: crypto.randomUUID() });
}

function onPromptKey(e) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    onSendPrompt();
  }
}

/* ----- WebSocket lifecycle ----- */

function connect() {
  const ws = new WebSocket(WS_URL);
  state.ws = ws;
  ws.addEventListener("open", () => {
    state.connected = true;
    state.reconnectTimer = null;
    sendCommand({ type: "get_state", id: crypto.randomUUID() });
    sendCommand({ type: "list_sessions", id: crypto.randomUUID() });
    sendCommand({ type: "list_models", id: crypto.randomUUID() });
    renderApp();
  });
  ws.addEventListener("close", () => {
    state.connected = false;
    state.isStreaming = false;
    renderApp();
    scheduleReconnect();
  });
  ws.addEventListener("error", () => {
    ws.close();
  });
  ws.addEventListener("message", (e) => onMessage(e.data));
}

function scheduleReconnect() {
  if (state.reconnectTimer) return;
  state.reconnectTimer = setTimeout(connect, 1000);
}

function onMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  if (msg.type === "response") {
    onResponse(msg);
  } else if (isEventType(msg.type)) {
    onEvent(msg);
  }
}

function onResponse(msg) {
  if (!msg.ok) {
    showToast(msg.error ?? "Error", "info");
    return;
  }
  const data = msg.data;
  if (data && Array.isArray(data.sessions)) {
    state.sessions = data.sessions;
    renderApp();
    return;
  }
  if (data && Array.isArray(data.models)) {
    state.models = data.models;
    renderApp();
    return;
  }
  if (data && "thinkingLevel" in data) {
    state.model = data.model;
    state.thinkingLevel = data.thinkingLevel;
    state.isStreaming = data.isStreaming;
    state.messages = data.messages ?? [];
    renderApp();
    return;
  }
  // Successful new_session / switch_session / set_model /
  // set_thinking_level — re-fetch get_state so the UI reflects the
  // change without waiting for the next event.
  if (data === undefined) {
    sendCommand({ type: "get_state", id: crypto.randomUUID() });
  }
}

function onEvent(msg) {
  state.eventSeq++;
  switch (msg.type) {
    case "message_start":
      upsertMessage(msg.message);
      break;
    case "message_update": {
      upsertMessage(msg.message);
      break;
    }
    case "message_end":
      upsertMessage(msg.message);
      break;
    case "agent_start":
      state.isStreaming = true;
      break;
    case "agent_end":
      state.isStreaming = false;
      break;
    case "session_start":
      sendCommand({ type: "list_sessions", id: crypto.randomUUID() });
      break;
    default:
      break;
  }
  renderApp();
}

/** Replace a message by id; append if not present. */
function upsertMessage(m) {
  if (!m || m.id === undefined) return;
  const idx = state.messages.findIndex((x) => x && x.id === m.id);
  if (idx === -1) {
    state.messages = [...state.messages, m];
  } else {
    const next = state.messages.slice();
    next[idx] = m;
    state.messages = next;
  }
}

function isEventType(t) {
  return [
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
  ].includes(t);
}

connect();
renderApp();
