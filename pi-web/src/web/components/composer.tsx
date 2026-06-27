import { useEffect, useRef } from "preact/hooks";

export function Composer({
  connected,
  isStreaming,
  onSend,
  onAbort,
}: {
  connected: boolean;
  isStreaming: boolean;
  onSend: (text: string) => void;
  onAbort: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  const autogrow = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  };

  const send = () => {
    const el = ref.current;
    if (!el) return;
    const text = el.value;
    if (!text.trim()) return;
    onSend(text);
    el.value = "";
    autogrow();
  };

  useEffect(() => {
    if (connected) ref.current?.focus();
  }, [connected]);

  return (
    <div id="prompt-row">
      <textarea
        id="prompt"
        ref={ref}
        rows={1}
        placeholder="Send a message. /commands work. Shift+Enter for newline."
        onInput={autogrow}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
      />
      <button onClick={send} disabled={isStreaming}>
        Send
      </button>
      <button onClick={onAbort} disabled={!isStreaming}>
        Abort
      </button>
    </div>
  );
}
