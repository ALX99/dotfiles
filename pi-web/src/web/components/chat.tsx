import { useEffect, useRef } from "preact/hooks";
import type { ChatMessage } from "../state.ts";
import { Message } from "./message.tsx";

export function Chat({
  messages,
  isStreaming,
  stickToBottom,
  onStickChange,
}: {
  messages: ChatMessage[];
  isStreaming: boolean;
  stickToBottom: boolean;
  onStickChange: (v: boolean) => void;
}) {
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (el && stickToBottom) el.scrollTop = el.scrollHeight;
  }, [stickToBottom, messages, isStreaming]);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (nearBottom !== stickToBottom) onStickChange(nearBottom);
  };

  const toBottom = () => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
    onStickChange(true);
  };

  return (
    <main id="chat" ref={ref} onScroll={onScroll}>
      {messages.length === 0 && !isStreaming ? (
        <div class="empty-state">Send a message to start the conversation.</div>
      ) : (
        <>
          {messages.map((m, i) => (
            <Message key={m.id ?? i} m={m} />
          ))}
          {isStreaming ? (
            <div class="message">
              <span class="role">assistant</span>
              <span class="streaming-dots">
                <i />
                <i />
                <i />
              </span>
            </div>
          ) : null}
        </>
      )}
      {!stickToBottom ? (
        <button class="scroll-bottom" onClick={toBottom} title="Scroll to latest">
          ↓
        </button>
      ) : null}
    </main>
  );
}
