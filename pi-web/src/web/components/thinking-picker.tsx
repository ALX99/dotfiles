import { THINKING_LEVELS } from "../../shared/wire.ts";
import type { ThinkingLevel } from "../../shared/wire.ts";

export function ThinkingPicker({
  current,
  disabled,
  onChange,
}: {
  current: ThinkingLevel;
  disabled: boolean;
  onChange: (l: ThinkingLevel) => void;
}) {
  return (
    <select
      value={current}
      disabled={disabled}
      onChange={(e) => onChange(e.currentTarget.value as ThinkingLevel)}
    >
      {THINKING_LEVELS.map((l) => (
        <option key={l} value={l}>
          {l}
        </option>
      ))}
    </select>
  );
}
