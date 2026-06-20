import { h } from "/vendor/preact.js";
import { html } from "./htm.js";

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];

export function ThinkingPicker({ current, disabled, onChange }) {
  return html`
    <select
      value=${current}
      disabled=${disabled}
      onChange=${(e) => onChange(e.target.value)}
    >
      ${LEVELS.map(
        (l) => html`<option key=${l} value=${l}>${l}</option>`,
      )}
    </select>
  `;
}
