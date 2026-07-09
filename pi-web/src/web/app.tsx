import {
  useBridge,
} from "./bridge.ts";
import { Chat } from "./components/chat.tsx";
import { Composer } from "./components/composer.tsx";
import { ConnectionStatus } from "./components/connection-status.tsx";
import { ModelPicker } from "./components/model-picker.tsx";
import { SessionList } from "./components/session-list.tsx";
import { ThinkingPicker } from "./components/thinking-picker.tsx";
import { Toast } from "./components/toast.tsx";

export function App() {
  const { state, actions } = useBridge();
  return (
    <>
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
      <Chat
        messages={state.messages}
        isStreaming={state.isStreaming}
        stickToBottom={state.stickToBottom}
        onStickChange={actions.setStickToBottom}
      />
      <Composer
        connected={state.connected}
        isStreaming={state.isStreaming}
        onSend={actions.sendPrompt}
        onAbort={actions.abort}
      />
      {state.toast ? (
        <Toast toast={state.toast} onDismiss={actions.dismissToast} />
      ) : null}
    </>
  );
}
