import { h } from "/vendor/preact.js";
import { html } from "./htm.js";

export function SessionList({ sessions, onNew, onSwitch }) {
  return html`
    <div>
      <button onClick=${onNew} style=${{ width: "100%", marginBottom: "8px" }}>+ New session</button>
      <ul class="session-list">
        ${sessions.length === 0
          ? html`<li>(no sessions yet)</li>`
          : sessions.map(
              (s) => html`
                <li key=${s.path} onClick=${() => onSwitch(s.path)} title=${s.path}>
                  ${s.name ?? s.id}
                </li>
              `,
            )}
      </ul>
    </div>
  `;
}
