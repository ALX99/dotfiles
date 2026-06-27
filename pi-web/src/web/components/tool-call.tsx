import { useState } from "preact/hooks";
import type { ToolCallBlock } from "../state.ts";

export function ToolCall({ call }: { call: ToolCallBlock }) {
  const json =
    call.arguments !== undefined ? JSON.stringify(call.arguments, null, 2) : "";
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(json);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <div class="tool-call">
      <span class="name">{call.name}</span>
      {json ? (
        <>
          <pre>{json}</pre>
          <button class="copy" onClick={copy} title="Copy arguments">
            {copied ? "copied" : "copy"}
          </button>
        </>
      ) : null}
    </div>
  );
}
