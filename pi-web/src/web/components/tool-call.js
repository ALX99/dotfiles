import { h } from "/vendor/preact.js";
import { html } from "./htm.js";

export function ToolCall({ call }) {
  return html`
    <div class="tool-call">
      <span class="name">${call.name}</span>
      ${call.arguments
        ? html`<pre style=${{ margin: "4px 0 0 0", whiteSpace: "pre-wrap" }}>${JSON.stringify(call.arguments, null, 2)}</pre>`
        : null}
    </div>
  `;
}
