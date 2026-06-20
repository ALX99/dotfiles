import { h } from "/vendor/preact.js";
import { html } from "./htm.js";

export function ModelPicker({ models, current, onChange }) {
  return html`
    <select
      value=${current ? `${current.provider}/${current.id}` : ""}
      onChange=${(e) => {
        const v = e.target.value;
        const [provider, id] = v.split("/");
        const m = models.find((mm) => mm.provider === provider && mm.id === id);
        if (m) onChange(m);
      }}
    >
      <option value="" disabled>Select a model</option>
      ${models.map(
        (m) => html`
          <option key=${`${m.provider}/${m.id}`} value=${`${m.provider}/${m.id}`}>
            ${m.name ?? `${m.provider}/${m.id}`}
          </option>
        `,
      )}
    </select>
  `;
}
