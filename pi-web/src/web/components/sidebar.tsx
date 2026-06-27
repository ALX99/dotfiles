import type { AppState } from "../state.ts";
import type { BridgeActions } from "../bridge.ts";
import { ConnectionStatus } from "./connection-status.tsx";
import { SessionList } from "./session-list.tsx";
import { ModelPicker } from "./model-picker.tsx";
import { ThinkingPicker } from "./thinking-picker.tsx";

export function Sidebar({
  state,
  actions,
}: {
  state: AppState;
  actions: BridgeActions;
}) {
  return (
    <aside id="sidebar">
      <ConnectionStatus
        connected={state.connected}
        attempt={state.reconnectAttempt}
      />
      <h2>Session</h2>
      <SessionList
        sessions={state.sessions}
        currentPath={state.currentSessionFile}
        onNew={actions.newSession}
        onSwitch={actions.switchSession}
      />
      <h2>Model</h2>
      <ModelPicker
        models={state.models}
        current={state.model}
        searchTerm={state.modelSearch}
        onSearch={actions.setModelSearch}
        onChange={actions.setModel}
      />
      <h2>Thinking</h2>
      <ThinkingPicker
        current={state.thinkingLevel}
        disabled={state.isStreaming}
        onChange={actions.setThinking}
      />
    </aside>
  );
}
