import type { ModelRef } from "../../shared/wire.ts";

function label(m: ModelRef): string {
  return m.name ?? `${m.provider}/${m.id}`;
}

export function ModelPicker({
  models,
  current,
  searchTerm,
  onSearch,
  onChange,
}: {
  models: ModelRef[];
  current: ModelRef | null;
  searchTerm: string;
  onSearch: (v: string) => void;
  onChange: (m: ModelRef) => void;
}) {
  if (models.length === 0) {
    return <div class="model-empty">(no models available)</div>;
  }

  const term = searchTerm.trim().toLowerCase();
  const filtered =
    term === ""
      ? models
      : models.filter((m) => {
          const hay = `${m.provider}/${m.id} ${m.name ?? ""}`.toLowerCase();
          return hay.includes(term);
        });

  return (
    <div class="model-picker">
      <div
        class="model-current"
        title={current ? `${current.provider}/${current.id}` : ""}
      >
        {current ? (
          label(current)
        ) : (
          <span class="dim">none selected</span>
        )}
      </div>
      <input
        type="text"
        class="model-search"
        placeholder="Search models…"
        value={searchTerm}
        onInput={(e) => onSearch(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (filtered.length > 0) onChange(filtered[0]!);
          } else if (e.key === "Escape") {
            onSearch("");
          }
        }}
      />
      <ul class="model-list">
        {filtered.length === 0 ? (
          <li class="empty">No matches</li>
        ) : (
          filtered.map((m) => (
            <li
              key={`${m.provider}/${m.id}`}
              class={
                current &&
                current.provider === m.provider &&
                current.id === m.id
                  ? "active"
                  : ""
              }
              onClick={() => onChange(m)}
              title={`${m.provider}/${m.id}`}
            >
              {label(m)}
            </li>
          ))
        )}
      </ul>
      <div class="model-count">
        {filtered.length} of {models.length}
      </div>
    </div>
  );
}
