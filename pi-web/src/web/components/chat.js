import { h } from "/vendor/preact.js";
import { html } from "./htm.js";
import { ToolCall } from "./tool-call.js";

export function Chat({ messages, isStreaming }) {
  return html`
    <div>
      ${messages.map((m, i) => renderMessage(m, i))}
      ${isStreaming ? html`<div class="message"><span class="role">assistant</span><span class="text">…</span></div>` : null}
    </div>
  `;
}

function renderMessage(m, key) {
  if (!m) return null;
  if (m.role === "user") {
    return html`
      <div class="message user" key=${key}>
        <div class="role">user</div>
        <div class="text">${typeof m.content === "string" ? m.content : renderBlocks(m.content)}</div>
      </div>
    `;
  }
  if (m.role === "assistant") {
    return html`
      <div class="message assistant" key=${key}>
        <div class="role">assistant</div>
        ${renderAssistant(m)}
      </div>
    `;
  }
  if (m.role === "toolResult") {
    return html`
      <div class="message" key=${key}>
        <div class="role">tool · ${m.toolName}</div>
        <div class="tool-result">${(m.content ?? []).map((c) => c.text ?? "").join("\n")}</div>
      </div>
    `;
  }
  return null;
}

function renderAssistant(m) {
  if (typeof m.content === "string") {
    return html`<div class="text">${m.content}</div>${renderAssistantError(m)}`;
  }
  if (!Array.isArray(m.content)) return null;
  const blocks = m.content.map((block, i) => {
    if (block.type === "text") {
      return html`<div class="text" key=${i}>${block.text}</div>`;
    }
    if (block.type === "thinking") {
      return html`<div class="thinking" key=${i}>${block.thinking}</div>`;
    }
    if (block.type === "toolCall") {
      return html`<${ToolCall} key=${i} call=${block} />`;
    }
    return null;
  });
  return html`<div>${blocks}${renderAssistantError(m)}</div>`;
}

function renderAssistantError(m) {
  if (m.stopReason === "error" && m.errorMessage) {
    return html`<div class="error" data-stop-reason=${m.stopReason}>${m.errorMessage}</div>`;
  }
  if (m.stopReason === "aborted") {
    return html`<div class="error" data-stop-reason=${m.stopReason}>aborted</div>`;
  }
  return null;
}

function renderBlocks(blocks) {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("\n");
}
