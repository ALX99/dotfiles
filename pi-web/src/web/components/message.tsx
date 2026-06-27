import { renderMarkdown } from "../lib/markdown.ts";
import type { ChatMessage, ContentBlock } from "../state.ts";
import { ToolCall } from "./tool-call.tsx";

export function Markdown({ text }: { text: string }) {
  return (
    <div
      class="markdown"
      dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }}
    />
  );
}

function textOf(b: ContentBlock): string {
  return b.type === "text" ? b.text : "";
}

function renderError(m: ChatMessage) {
  if (m.stopReason === "error" && m.errorMessage) {
    return (
      <div class="error" data-stop-reason={m.stopReason}>
        {m.errorMessage}
      </div>
    );
  }
  if (m.stopReason === "aborted") {
    return <div class="error" data-stop-reason="aborted">aborted</div>;
  }
  return null;
}

function renderAssistant(m: ChatMessage) {
  if (typeof m.content === "string") {
    return (
      <>
        <div class="text">
          <Markdown text={m.content} />
        </div>
        {renderError(m)}
      </>
    );
  }
  if (!Array.isArray(m.content)) return null;
  return (
    <div>
      {m.content.map((block, i) => {
        if (block.type === "text") {
          return (
            <div class="text" key={i}>
              <Markdown text={block.text} />
            </div>
          );
        }
        if (block.type === "thinking") {
          return (
            <div class="thinking" key={i}>
              {block.thinking}
            </div>
          );
        }
        if (block.type === "toolCall") {
          return <ToolCall key={i} call={block} />;
        }
        return null;
      })}
      {renderError(m)}
    </div>
  );
}

export function Message({ m }: { m: ChatMessage }) {
  if (m.role === "user") {
    const text =
      typeof m.content === "string"
        ? m.content
        : m.content.map(textOf).join("\n");
    return (
      <div class="message user">
        <div class="role">user</div>
        <div class="text">{text}</div>
      </div>
    );
  }
  if (m.role === "assistant") {
    return (
      <div class="message assistant">
        <div class="role">assistant</div>
        {renderAssistant(m)}
      </div>
    );
  }
  const parts = Array.isArray(m.content) ? m.content : [];
  const toolText = parts.map(textOf).join("\n");
  return (
    <div class="message">
      <div class="role">tool · {m.toolName ?? "result"}</div>
      <div class="tool-result">{toolText}</div>
    </div>
  );
}
