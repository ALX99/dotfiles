import {
  useBridge,
} from "./bridge.ts";
import { Sidebar } from "./components/sidebar.tsx";
import { Chat } from "./components/chat.tsx";
import { Composer } from "./components/composer.tsx";
import { Toast } from "./components/toast.tsx";

export function App() {
  const { state, actions } = useBridge();
  return (
    <>
      <Sidebar state={state} actions={actions} />
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
